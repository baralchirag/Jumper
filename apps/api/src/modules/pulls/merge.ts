import { and, checkRuns, desc, eq, pullEvents, pullRequests, reviews, type PullRequest, type Repository, type User } from '@jumper/db';
import { parseJumperConfig, type MergeMethod, type Mergeability } from '@jumper/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Ctx } from '../../context';
import { GitRepo } from '../git/repo';
import { conflict } from '../../lib/errors';
import { reviewBlockers } from '../review/gates';
import { isProtectedFromDeletion } from '../protection/service';
import { diffRefs, handleRefUpdates } from '../repos/push';
import { effectivePolicy } from '../policy/service';
import { namespaces } from '@jumper/db';

export function signatureFor(user: User) {
  return { name: user.name || user.username, email: `${user.username}@users.noreply.jumper` };
}

type CheckState = Mergeability['checks'][number]['state'];

export async function checkStates(ctx: Ctx, repoId: string, sha: string, required: string[]) {
  const runs = await ctx.db.select().from(checkRuns).where(and(eq(checkRuns.repoId, repoId), eq(checkRuns.sha, sha)));
  return required.map((name) => {
    const mine = runs.filter((r) => r.name === name);
    let state: CheckState = 'missing';
    if (mine.length) {
      if (mine.some((r) => r.status === 'completed' && (r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled'))) state = 'failure';
      else if (mine.some((r) => r.status !== 'completed')) state = 'pending';
      else state = 'success';
    }
    return { name, state };
  });
}

export async function computeMergeability(ctx: Ctx, repo: Repository, git: GitRepo, pr: PullRequest): Promise<Mergeability> {
  const blockers: string[] = [];
  const [baseSha, headSha] = await Promise.all([git.resolveBranch(pr.baseRef), git.resolveBranch(pr.headRef)]);
  if (!baseSha) blockers.push(`Base branch "${pr.baseRef}" no longer exists`);
  if (!headSha) blockers.push(`Head branch "${pr.headRef}" no longer exists`);

  let conflicts: string[] = [];
  let canFastForward = false;
  if (baseSha && headSha) {
    const merged = await git.mergeTree(baseSha, headSha);
    conflicts = merged.conflicts;
    canFastForward = await git.isAncestor(baseSha, headSha);
    if (conflicts.length) blockers.push(`${conflicts.length} conflicting file(s)`);
  }

  const cfgText = headSha ? (await git.readFile(headSha, '.jumper.yml', 256 * 1024))?.toString('utf8') : null;
  const { config } = parseJumperConfig(cfgText);
  const ns = (await ctx.db.select().from(namespaces).where(eq(namespaces.id, repo.namespaceId)).limit(1))[0];
  const policy = ns ? await effectivePolicy(ctx, ns) : null;
  // The owner's required checks apply on top of the repository's own; a repository cannot opt out of them.
  const required = [...new Set([...config.required_checks, ...(policy?.requiredChecks ?? [])])];
  const minApprovals = Math.max(repo.requiredApprovals, policy?.minApprovals ?? 0);
  const checks = headSha ? await checkStates(ctx, repo.id, headSha, required) : [];
  for (const c of checks) {
    if (c.state === 'failure') blockers.push(`Required check "${c.name}" failed`);
    else if (c.state === 'pending') blockers.push(`Required check "${c.name}" is still running`);
    else if (c.state === 'missing') blockers.push(`Required check "${c.name}" has not run`);
  }

  // Latest review per reviewer counts; the author's own reviews don't.
  const all = await ctx.db.select().from(reviews).where(eq(reviews.pullId, pr.id)).orderBy(desc(reviews.createdAt));
  const latest = new Map<string, (typeof all)[number]>();
  for (const r of all) {
    if (r.authorId === pr.authorId || r.state === 'commented') continue;
    if (!latest.has(r.authorId)) latest.set(r.authorId, r);
  }
  const approvals = [...latest.values()].filter((r) => r.state === 'approved').length;
  const changesRequested = [...latest.values()].some((r) => r.state === 'changes_requested');
  if (changesRequested) blockers.push('Changes were requested');
  if (approvals < minApprovals) blockers.push(`${minApprovals - approvals} more approval(s) required`);

  blockers.push(...(await reviewBlockers(ctx, repo, git, pr, baseSha, headSha, policy?.signoffRules ?? [])));

  return {
    mergeable: blockers.length === 0,
    conflicts,
    canFastForward,
    checks,
    approvals,
    requiredApprovals: minApprovals,
    changesRequested,
    blockers,
  };
}

export async function mergePull(
  ctx: Ctx,
  repo: Repository,
  git: GitRepo,
  pr: PullRequest,
  user: User,
  opts: { method: MergeMethod; title?: string; message?: string; deleteBranch: boolean },
  log: FastifyBaseLogger,
): Promise<string> {
  if (pr.state !== 'open') throw conflict('Pull request is not open');
  const m = await computeMergeability(ctx, repo, git, pr);
  if (!m.mergeable) throw conflict('Pull request is not mergeable', { blockers: m.blockers });

  const baseSha = (await git.resolveBranch(pr.baseRef))!;
  const headSha = (await git.resolveBranch(pr.headRef))!;
  const sig = signatureFor(user);
  const title = opts.title?.trim() || (opts.method === 'squash' ? `${pr.title} (#${pr.number})` : `Merge pull request #${pr.number} from ${pr.headRef}`);
  const message = `${title}\n\n${opts.message ?? (opts.method === 'squash' ? pr.body : pr.title)}`.trim() + '\n';

  let newSha: string;
  if (opts.method === 'fast_forward') {
    if (!m.canFastForward) throw conflict('Base branch has diverged; fast-forward is not possible');
    newSha = headSha;
  } else {
    const { tree, conflicts } = await git.mergeTree(baseSha, headSha);
    if (conflicts.length || !tree) throw conflict('Merge conflicts detected', { conflicts });
    const parents = opts.method === 'squash' ? [baseSha] : [baseSha, headSha];
    newSha = await git.commitTree(tree, parents, message, sig);
  }

  const before = await git.refs();
  // CAS: fails if someone pushed to base while we were merging.
  await git.updateRef(`refs/heads/${pr.baseRef}`, newSha, baseSha);

  const now = new Date();
  await ctx.db
    .update(pullRequests)
    .set({ state: 'merged', mergeCommitSha: newSha, mergedById: user.id, mergedAt: now, closedAt: now, updatedAt: now, headSha, baseSha })
    .where(eq(pullRequests.id, pr.id));
  await ctx.db.insert(pullEvents).values({ pullId: pr.id, actorId: user.id, kind: 'merged', data: { sha: newSha, method: opts.method } });

  if (opts.deleteBranch && pr.headRef !== repo.defaultBranch && !(await isProtectedFromDeletion(ctx, repo.id, pr.headRef, false))) {
    await git.deleteRef(`refs/heads/${pr.headRef}`, headSha).catch((e) => log.warn(e, 'branch delete failed'));
  }
  const after = await git.refs();
  await handleRefUpdates(ctx, repo, diffRefs(before, after), user, log);
  await ctx.publish({ type: 'pr', repoId: repo.id, number: pr.number, action: 'merged' });
  return newSha;
}
