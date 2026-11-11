// Repository mirroring: pull from or push to a copy on GitHub, GitLab or any git host over HTTPS.
//
// A pull mirror fetches on a schedule; a push mirror sends every change made here (push, merge, web edit) and retries
// on the schedule after a failure. One of each on the same repository makes a two-way mirror. Unless `overwrite` is
// set, both directions only fast-forward and never delete branches, so when both sides changed the same branch the
// mirror reports the divergence instead of throwing work away.
import type { FastifyBaseLogger } from 'fastify';
import { and, eq, repoMirrors, repositories, sql, type RepoMirror } from '@jumper/db';
import type { MirrorInfo } from '@jumper/shared';
import type { Ctx } from '../../context';
import { decryptSecret } from '../../lib/secrets';
import { git as runGit, GitError } from '../git/exec';
import { GitRepo } from '../git/repo';
import { friendlyGitError, resolveRemote } from '../import/service';
import { repoDiskPath } from '../repos/access';
import { diffRefs, handleRefUpdates } from '../repos/push';
import { pushRefusal } from '../usage/service';

const running = new Set<string>();
const MIRROR_TIMEOUT_MS = 10 * 60_000;

export interface MirrorResult {
  ok: boolean;
  /** Refs changed here (pull) or on the remote (push). */
  updated: number;
  error: string | null;
}

/** Pull credentials out of a pasted `https://user:token@host/...` URL so they are never stored in plain text. */
export function splitCredentials(raw: string): { url: string; username: string | null; token: string | null } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { url: raw.trim(), username: null, token: null };
  }
  const username = u.username ? decodeURIComponent(u.username) : null;
  const token = u.password ? decodeURIComponent(u.password) : null;
  u.username = '';
  u.password = '';
  return { url: u.toString(), username: token ? username : null, token: token ?? (username && !token ? username : null) };
}

/** Refs git refused to move because the histories diverged, from fetch/push stderr or `push --porcelain` stdout. */
export function rejectedRefs(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split('\n')) {
    // fetch / push stderr: " ! [rejected]        main       -> main  (non-fast-forward)"
    const human = /^\s*!\s+\[rejected\]\s+\S+\s+->\s+(\S+)/.exec(line);
    // push --porcelain: "!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)"
    const porcelain = /^!\t[^:\t]+:(\S+)\t\[rejected\]/.exec(line);
    const ref = human?.[1] ?? porcelain?.[1];
    if (ref) out.push(ref.replace(/^refs\/(heads|tags)\//, ''));
  }
  return [...new Set(out)];
}

function divergedMessage(direction: 'pull' | 'push', refs: string[]): string {
  const list = refs.slice(0, 5).join(', ') + (refs.length > 5 ? ` and ${refs.length - 5} more` : '');
  return direction === 'pull'
    ? `Not updated because both copies changed: ${list}. Merge the remote changes and push, or turn on "Overwrite".`
    : `The remote has changes this copy does not: ${list}. Pull them in first, or turn on "Overwrite".`;
}

async function credentialConfig(ctx: Ctx, m: RepoMirror): Promise<string[] | 'unreadable'> {
  if (!m.secret) return [];
  const token = decryptSecret(ctx.env, m.secret);
  if (token === null) return 'unreadable';
  return ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`${m.username || 'git'}:${token}`).toString('base64')}`];
}

/** Run one mirror now. Concurrent runs of the same mirror are skipped. */
export async function runMirror(ctx: Ctx, m: RepoMirror, log?: FastifyBaseLogger): Promise<MirrorResult> {
  if (running.has(m.id)) return { ok: true, updated: 0, error: null };
  running.add(m.id);
  try {
    const result = await syncOnce(ctx, m, log);
    const now = new Date();
    await ctx.db
      .update(repoMirrors)
      .set({ lastSyncAt: now, lastError: result.error, ...(result.ok ? { lastSuccessAt: now } : {}) })
      .where(eq(repoMirrors.id, m.id));
    return result;
  } finally {
    running.delete(m.id);
  }
}

async function syncOnce(ctx: Ctx, m: RepoMirror, log?: FastifyBaseLogger): Promise<MirrorResult> {
  const repo = (await ctx.db.select().from(repositories).where(eq(repositories.id, m.repoId)).limit(1))[0];
  if (!repo) return { ok: false, updated: 0, error: 'Repository not found' };
  let target;
  try {
    target = await resolveRemote(m.url, ctx.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS);
  } catch (e) {
    return { ok: false, updated: 0, error: (e as Error).message };
  }
  const creds = await credentialConfig(ctx, m);
  if (creds === 'unreadable') return { ok: false, updated: 0, error: 'The saved access token can no longer be read (the server key changed). Enter it again.' };
  const cfg = [...target.config.flatMap((c) => ['-c', c]), ...creds];
  const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const cwd = repoDiskPath(ctx, repo.id);
  const gr = new GitRepo(cwd);
  const remote = target.url.toString();

  if (m.direction === 'pull') {
    const refusal = await pushRefusal(ctx, repo.namespaceId);
    if (refusal) return { ok: false, updated: 0, error: refusal };
    const before = await gr.refs();
    const plus = m.overwrite ? '+' : '';
    let stderr = '';
    let failed = false;
    try {
      await runGit(
        [...cfg, '-c', 'transfer.fsckObjects=true', 'fetch', '--no-progress', ...(m.overwrite ? ['--prune'] : []), '--no-write-fetch-head', '--', remote, `${plus}refs/heads/*:refs/heads/*`, `${plus}refs/tags/*:refs/tags/*`],
        { cwd, env, timeoutMs: MIRROR_TIMEOUT_MS },
      );
    } catch (e) {
      failed = true;
      stderr = e instanceof GitError ? e.stderr : String(e);
    }
    const after = await gr.refs();
    const updates = diffRefs(before, after);
    if (updates.length) {
      const fresh = (await ctx.db.select().from(repositories).where(eq(repositories.id, repo.id)).limit(1))[0] ?? repo;
      const quiet = log ?? silentLog;
      await handleRefUpdates(ctx, fresh, updates, null, quiet, { fromMirror: m.id });
    }
    if (!failed) return { ok: true, updated: updates.length, error: null };
    const rejected = rejectedRefs(stderr);
    return { ok: false, updated: updates.length, error: rejected.length ? divergedMessage('pull', rejected) : friendlyGitError(stderr) };
  }

  // push
  if (!(await gr.branches()).length) return { ok: true, updated: 0, error: null };
  let res;
  try {
    res = await runGit(
      [...cfg, 'push', '--porcelain', ...(m.overwrite ? ['--force', '--prune'] : []), '--', remote, 'refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*'],
      { cwd, env, timeoutMs: MIRROR_TIMEOUT_MS, okCodes: [0, 1] },
    );
  } catch (e) {
    return { ok: false, updated: 0, error: friendlyGitError(e instanceof GitError ? e.stderr : String(e)) };
  }
  const text = res.stdout.toString('utf8');
  const updated = text.split('\n').filter((l) => /^[ +*-]\t/.test(l)).length;
  if (res.code === 0) return { ok: true, updated, error: null };
  const rejected = rejectedRefs(`${text}\n${res.stderr}`);
  if (rejected.length) return { ok: false, updated, error: divergedMessage('push', rejected) };
  if (/\[remote rejected\]/.test(text)) return { ok: false, updated, error: 'The remote refused some branches (it may protect them). Check its branch protection settings.' };
  return { ok: false, updated, error: friendlyGitError(res.stderr) };
}

const silentLog = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, fatal() {}, child: () => silentLog, level: 'silent', silent() {} } as unknown as FastifyBaseLogger;

/** Send local changes to every push mirror of a repository. Fire and forget. */
export function triggerPushMirrors(ctx: Ctx, repoId: string, log: FastifyBaseLogger, skipMirror?: string): void {
  void (async () => {
    const rows = await ctx.db
      .select()
      .from(repoMirrors)
      .where(and(eq(repoMirrors.repoId, repoId), eq(repoMirrors.direction, 'push'), eq(repoMirrors.enabled, true)));
    for (const m of rows) {
      if (m.id === skipMirror) continue;
      await runMirror(ctx, m, log).catch((e) => log.warn(e, 'push mirror failed'));
    }
  })().catch((e) => log.warn(e, 'push mirror lookup failed'));
}

/**
 * Scheduled tick: pull mirrors whose interval has passed, and push mirrors whose last attempt failed (retried on the same
 * interval). Bounded per tick so one slow host cannot hold the scheduler.
 */
export async function syncDueMirrors(ctx: Ctx, limit = 25): Promise<{ synced: number; failed: number }> {
  const due = await ctx.db
    .select()
    .from(repoMirrors)
    .where(
      and(
        eq(repoMirrors.enabled, true),
        sql`(${repoMirrors.lastSyncAt} is null or ${repoMirrors.lastSyncAt} < now() - make_interval(mins => ${repoMirrors.intervalMinutes}))`,
        sql`(${repoMirrors.direction} = 'pull' or ${repoMirrors.lastError} is not null)`,
      ),
    )
    .orderBy(sql`${repoMirrors.lastSyncAt} asc nulls first`)
    .limit(limit);
  let failed = 0;
  for (const m of due) {
    const r = await runMirror(ctx, m).catch((e) => ({ ok: false, updated: 0, error: String(e) }));
    if (!r.ok) failed++;
  }
  return { synced: due.length, failed };
}

export function toMirrorInfo(m: RepoMirror): MirrorInfo {
  return {
    id: m.id,
    direction: m.direction,
    url: m.url,
    username: m.username,
    hasToken: Boolean(m.secret),
    overwrite: m.overwrite,
    enabled: m.enabled,
    intervalMinutes: m.intervalMinutes,
    lastSyncAt: m.lastSyncAt?.toISOString() ?? null,
    lastSuccessAt: m.lastSuccessAt?.toISOString() ?? null,
    lastError: m.lastError,
    createdAt: m.createdAt.toISOString(),
  };
}
