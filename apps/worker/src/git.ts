import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './process';

const GIT_ENV = { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };

export function repoPath(reposDir: string, repoId: string): string {
  return join(reposDir, `${repoId}.git`);
}

async function git(repo: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const r = await run('git', args, { cwd: repo, env: GIT_ENV, timeoutMs });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

export async function parents(repo: string, sha: string): Promise<string[]> {
  const out = await git(repo, ['rev-list', '--parents', '-n1', sha]);
  return out.trim().split(' ').slice(1);
}

export async function listFiles(repo: string, sha: string): Promise<{ path: string; size: number; mode: string }[]> {
  const out = await git(repo, ['ls-tree', '-r', '-l', '-z', '--full-tree', sha]);
  return out
    .split('\0')
    .filter(Boolean)
    .map((rec) => {
      const tab = rec.indexOf('\t');
      const [mode, , , size] = rec.slice(0, tab).split(/\s+/);
      return { path: rec.slice(tab + 1), size: Number(size) || 0, mode: mode! };
    });
}

/** File contents at a commit, or null if absent / larger than maxBytes. */
export function readFile(repo: string, sha: string, path: string, maxBytes = 64 * 1024 * 1024): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git', ['cat-file', 'blob', `${sha}:${path}`], { cwd: repo, env: GIT_ENV });
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        tooBig = true;
        child.kill('SIGKILL');
      } else chunks.push(c);
    });
    child.on('close', (code) => resolve(code === 0 && !tooBig ? Buffer.concat(chunks).toString('utf8') : null));
    child.on('error', () => resolve(null));
  });
}

/**
 * Materialize a commit into `dest` (regular files only). Symlinks and
 * submodules are skipped so tools never follow links out of the checkout.
 */
export async function checkout(repo: string, sha: string, dest: string, maxBytes: number): Promise<void> {
  const files = await listFiles(repo, sha);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > maxBytes) throw new Error(`Checkout too large (${total} bytes > ${maxBytes})`);
  const regular = files.filter((f) => f.mode === '100644' || f.mode === '100755').map((f) => f.path);
  await mkdir(dest, { recursive: true });
  if (!regular.length) return;

  // git archive with explicit pathspecs -> tar extraction in dest.
  const archive = spawn('git', ['archive', '--format=tar', sha, '--', ...regular.map((p) => `:(literal)${p}`)], { cwd: repo, env: GIT_ENV });
  const tar = await run('tar', ['-x', '--no-same-owner', '--no-same-permissions', '-C', dest], {
    env: GIT_ENV,
    timeoutMs: 5 * 60_000,
    input: archive.stdout,
  });
  if (tar.code !== 0) throw new Error(`checkout failed: ${tar.stderr.trim()}`);
}
