import { mkdir, rm } from 'node:fs/promises';
import type { CommitInfo, FileDiff, RefInfo, TreeEntry } from '@pcbhub/shared';
import { git, GitError, gitText } from './exec';
import { hunksOnly, parseNumstat, parseRaw, splitPatch } from './diff-parse';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const SHA_RE = /^[0-9a-f]{40}$/;
const REV_RE = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~+-]{0,254}$/;

const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s', '%b'].join('%x00') + '%x1e';

export interface Signature {
  name: string;
  email: string;
  date?: Date;
}

const MAX_PATCH_BYTES_PER_FILE = 1024 * 1024;
const MAX_PATCH_BYTES_TOTAL = 24 * 1024 * 1024;

function parseLog(out: string): CommitInfo[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [sha, parents, an, ae, ad, cn, ce, cd, subject, body] = rec.split('\0');
      return {
        sha: sha!,
        parents: parents ? parents.split(' ') : [],
        author: { name: an ?? '', email: ae ?? '', date: ad ?? '' },
        committer: { name: cn ?? '', email: ce ?? '', date: cd ?? '' },
        subject: subject ?? '',
        body: (body ?? '').trim(),
      };
    });
}

export function isSha(s: string): boolean {
  return SHA_RE.test(s);
}

export function isValidRev(s: string): boolean {
  return REV_RE.test(s) && !s.includes('..');
}

function sigEnv(author: Signature, committer: Signature = author): Record<string, string> {
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
  };
  if (author.date) env.GIT_AUTHOR_DATE = author.date.toISOString();
  if (committer.date) env.GIT_COMMITTER_DATE = committer.date.toISOString();
  return env;
}

/** Operations on one bare repository. All inputs are validated or passed after `--`. */
export class GitRepo {
  constructor(readonly path: string) {}

  private run(args: string[], extra: Partial<Parameters<typeof git>[1]> = {}) {
    return git(args, { cwd: this.path, ...extra });
  }

  private text(args: string[], extra: Partial<Parameters<typeof git>[1]> = {}) {
    return gitText(args, { cwd: this.path, ...extra });
  }

  static async init(path: string, defaultBranch: string): Promise<GitRepo> {
    await mkdir(path, { recursive: true });
    await git(['init', '--bare', '--quiet', `--initial-branch=${defaultBranch}`, path], { cwd: path });
    const repo = new GitRepo(path);
    const config: [string, string][] = [
      ['http.receivepack', 'true'],
      ['http.uploadpack', 'true'],
      ['receive.fsckObjects', 'true'],
      ['transfer.fsckObjects', 'true'],
      ['uploadpack.allowFilter', 'true'],
      ['uploadpack.allowAnySHA1InWant', 'false'],
      ['core.logAllRefUpdates', 'false'],
      ['gc.auto', '6700'],
    ];
    for (const [k, v] of config) await repo.run(['config', k, v]);
    return repo;
  }

  async destroy(): Promise<void> {
    await rm(this.path, { recursive: true, force: true });
  }

  async isEmpty(): Promise<boolean> {
    const out = await this.text(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/heads']);
    return out.trim() === '';
  }

  async setHead(branch: string): Promise<void> {
    await this.run(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  }

  /** Snapshot of all refs (used to detect what a push changed). */
  async refs(): Promise<Map<string, string>> {
    const out = await this.text(['for-each-ref', '--format=%(objectname) %(refname)']);
    const m = new Map<string, string>();
    for (const line of out.split('\n')) {
      const i = line.indexOf(' ');
      if (i > 0) m.set(line.slice(i + 1), line.slice(0, i));
    }
    return m;
  }

  async branches(): Promise<RefInfo[]> {
    const out = await this.text(['for-each-ref', '--sort=-committerdate', '--format=%(refname:lstrip=2)%00%(objectname)', 'refs/heads']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, sha] = l.split('\0');
        return { name: name!, sha: sha! };
      });
  }

  async tags(): Promise<RefInfo[]> {
    const out = await this.text(['for-each-ref', '--sort=-creatordate', '--format=%(refname:lstrip=2)%00%(objectname)%00%(*objectname)', 'refs/tags']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, sha, peeled] = l.split('\0');
        return { name: name!, sha: peeled || sha! };
      });
  }

  /** Resolve a branch, tag or sha to a commit sha; null when unknown. */
  async resolveCommit(rev: string): Promise<string | null> {
    if (!isValidRev(rev)) return null;
    try {
      const out = await this.text(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
      const sha = out.trim();
      return isSha(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  async resolveBranch(name: string): Promise<string | null> {
    if (!isValidRev(name)) return null;
    return this.resolveCommit(`refs/heads/${name}`);
  }

  /** Type of the object at `path` in `sha` ('' is the root tree). */
  async entryType(sha: string, path: string): Promise<{ type: 'tree' | 'blob' | 'commit'; oid: string; size: number | null } | null> {
    if (!path) {
      const oid = (await this.text(['rev-parse', `${sha}^{tree}`])).trim();
      return { type: 'tree', oid, size: null };
    }
    const out = await this.text(['ls-tree', '-z', '-l', '--full-tree', sha, '--', path]);
    const rec = out.split('\0').find(Boolean);
    if (!rec) return null;
    const [meta] = rec.split('\t');
    const [, type, oid, size] = meta!.split(/\s+/);
    return { type: type as 'tree' | 'blob' | 'commit', oid: oid!, size: size === '-' ? null : Number(size) };
  }

  async tree(sha: string, path: string): Promise<TreeEntry[]> {
    const args = ['ls-tree', '-z', '-l', '--full-tree', sha];
    if (path) args.push('--', `${path.replace(/\/$/, '')}/`);
    const out = await this.text(args);
    const entries: TreeEntry[] = [];
    for (const rec of out.split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      const [mode, type, oid, size] = rec.slice(0, tab).split(/\s+/);
      const full = rec.slice(tab + 1);
      entries.push({
        name: full.slice(full.lastIndexOf('/') + 1),
        path: full,
        type: type as TreeEntry['type'],
        oid: oid!,
        size: size === '-' ? null : Number(size),
        mode: mode!,
      });
    }
    const rank = (t: string) => (t === 'tree' ? 0 : t === 'commit' ? 1 : 2);
    return entries.sort((a, b) => rank(a.type) - rank(b.type) || a.name.localeCompare(b.name));
  }

  /** Every file path in a commit (capped). */
  async lsFiles(sha: string, limit = 20000): Promise<string[]> {
    const out = await this.text(['ls-tree', '-r', '-z', '--name-only', '--full-tree', sha], { maxBuffer: 16 * 1024 * 1024 });
    return out.split('\0').filter(Boolean).slice(0, limit);
  }

  async blobSize(oid: string): Promise<number> {
    return Number((await this.text(['cat-file', '-s', oid])).trim());
  }

  async readBlob(oid: string, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
    return (await this.run(['cat-file', 'blob', oid], { maxBuffer: maxBytes })).stdout;
  }

  /** File contents at a commit, or null if absent. */
  async readFile(sha: string, path: string, maxBytes = 64 * 1024 * 1024): Promise<Buffer | null> {
    try {
      return (await this.run(['cat-file', 'blob', `${sha}:${path}`], { maxBuffer: maxBytes })).stdout;
    } catch (e) {
      if (e instanceof GitError) return null;
      throw e;
    }
  }

  async log(rev: string, opts: { path?: string; skip?: number; limit?: number; range?: boolean } = {}): Promise<CommitInfo[]> {
    const args = ['log', `--format=${LOG_FORMAT}`, `-n${opts.limit ?? 30}`, `--skip=${opts.skip ?? 0}`, '--end-of-options', rev];
    if (opts.path) args.push('--', opts.path);
    try {
      return parseLog(await this.text(args));
    } catch (e) {
      if (e instanceof GitError) return [];
      throw e;
    }
  }

  async commit(sha: string): Promise<CommitInfo | null> {
    return (await this.log(sha, { limit: 1 }))[0] ?? null;
  }

  async lastCommitFor(sha: string, path: string): Promise<CommitInfo | null> {
    return (await this.log(sha, { limit: 1, path: path || undefined }))[0] ?? null;
  }

  /** Commits reachable from head but not base, oldest first. */
  async commitsBetween(base: string, head: string, limit = 250): Promise<CommitInfo[]> {
    const out = await this.text(['log', `--format=${LOG_FORMAT}`, `-n${limit}`, '--end-of-options', `${base}..${head}`]);
    return parseLog(out).reverse();
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const r = await this.run(['merge-base', a, b], { okCodes: [0, 1] });
    const sha = r.stdout.toString().trim();
    return r.code === 0 && isSha(sha) ? sha : null;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const r = await this.run(['merge-base', '--is-ancestor', ancestor, descendant], { okCodes: [0, 1] });
    return r.code === 0;
  }

  async aheadBehind(base: string, head: string): Promise<{ ahead: number; behind: number }> {
    const out = await this.text(['rev-list', '--left-right', '--count', `${base}...${head}`]);
    const [behind, ahead] = out.trim().split(/\s+/).map(Number);
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  }

  /** File-level diff between two commits (base may be EMPTY_TREE). */
  async diff(base: string, head: string, opts: { patches?: boolean; paths?: string[] } = {}): Promise<FileDiff[]> {
    const pathArgs = opts.paths?.length ? ['--', ...opts.paths] : [];
    const [raw, numstat] = await Promise.all([
      this.text(['diff', '--raw', '-z', '-M', '--abbrev=40', '--no-color', base, head, ...pathArgs]),
      this.text(['diff', '--numstat', '-z', '-M', '--no-color', base, head, ...pathArgs]),
    ]);
    const files = parseRaw(raw);
    const stats = parseNumstat(numstat);

    let patches: string[] = [];
    let patchesOk = opts.patches !== false;
    if (patchesOk) {
      try {
        const out = await this.text(['diff', '-M', '--no-color', '--no-ext-diff', base, head, ...pathArgs], {
          maxBuffer: MAX_PATCH_BYTES_TOTAL,
        });
        patches = splitPatch(out);
        if (patches.length !== files.length) patchesOk = false;
      } catch {
        patchesOk = false;
      }
    }

    return files.map((f, i) => {
      const s = stats.get(f.path) ?? { additions: 0, deletions: 0, binary: false };
      const p = patchesOk ? patches[i] : undefined;
      const tooBig = p !== undefined && p.length > MAX_PATCH_BYTES_PER_FILE;
      return {
        ...f,
        ...s,
        patch: p !== undefined && !tooBig && !s.binary ? hunksOnly(p) : null,
        truncated: !patchesOk || tooBig,
      };
    });
  }

  /**
   * Three-way merge without a worktree (git >= 2.38).
   * Returns the merged tree or the list of conflicting paths.
   */
  async mergeTree(ours: string, theirs: string): Promise<{ tree: string; conflicts: string[] }> {
    const r = await this.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs], { okCodes: [0, 1] });
    const lines = r.stdout.toString().split('\n').filter(Boolean);
    return { tree: lines[0] ?? '', conflicts: r.code === 1 ? lines.slice(1) : [] };
  }

  async commitTree(tree: string, parents: string[], message: string, author: Signature, committer?: Signature): Promise<string> {
    const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'];
    const out = await this.text(args, { input: message, env: sigEnv(author, committer) });
    return out.trim();
  }

  /** Compare-and-swap ref update; fails if the ref moved meanwhile. */
  async updateRef(ref: string, newSha: string, oldSha?: string | null): Promise<void> {
    const args = ['update-ref', ref, newSha];
    if (oldSha !== undefined) args.push(oldSha ?? '0'.repeat(40));
    await this.run(args);
  }

  async deleteRef(ref: string, oldSha?: string): Promise<void> {
    await this.run(['update-ref', '-d', ref, ...(oldSha ? [oldSha] : [])]);
  }

  async writeBlob(content: string | Buffer): Promise<string> {
    return (await this.text(['hash-object', '-w', '--stdin'], { input: content })).trim();
  }

  async mktree(entries: { mode: string; type: 'blob' | 'tree'; oid: string; name: string }[]): Promise<string> {
    const input = entries.map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.name}`).join('\n') + '\n';
    return (await this.text(['mktree'], { input })).trim();
  }

  async sizeBytes(): Promise<number> {
    const out = await this.text(['count-objects', '-v']);
    let kib = 0;
    for (const line of out.split('\n')) {
      const [k, v] = line.split(': ');
      if (k === 'size' || k === 'size-pack') kib += Number(v) || 0;
    }
    return kib * 1024;
  }
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
