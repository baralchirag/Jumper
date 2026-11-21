import { rm } from 'node:fs/promises';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq, repoMirrors, repositories } from '@jumper/db';
import { repoNameSchema } from '@jumper/shared';
import { requireScope, requireUser } from '../auth/plugin';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { audit } from '../audit/audit';
import { encryptSecret } from '../../lib/secrets';
import { git as runGit, GitError } from '../git/exec';
import { GitRepo } from '../git/repo';
import { canManageNamespace, findNamespace, findRepo, repoDiskPath } from '../repos/access';
import { enqueueAnalysis } from '../repos/push';
import { toRepoInfo } from '../repos/serialize';
import { friendlyGitError, parseDefaultBranch, repoNameFromUrl, resolveRemote } from './service';
import { failImport, finishImport, startImport } from './jobs';

/** How long the request waits for a copy before answering and letting it finish in the background. */
const importWaitMs = () => Number(process.env.IMPORT_WAIT_MS ?? 8000);

const importSchema = z.object({
  url: z.string().trim().min(8).max(2000),
  owner: z.string().max(100).optional(),
  name: repoNameSchema.optional(),
  description: z.string().max(350).default(''),
  visibility: z.enum(['public', 'private']).default('private'),
  /** For private source repositories. Used for this one request and never stored. */
  username: z.string().max(200).optional(),
  token: z.string().max(500).optional(),
  /**
   * Keep the copy in sync after importing: `pull` fetches new commits from the source on a schedule, `two-way` also
   * pushes changes made here back to it. The token is then stored encrypted; without mirroring it is never stored.
   */
  mirror: z.enum(['none', 'pull', 'two-way']).default('none'),
});

const importRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  /** Copy an existing git repository (all branches and tags) into a new Jumper repository. */
  app.post('/repos/import', { schema: { body: importSchema }, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req) => {
    const user = requireUser(req);
    requireScope(req, 'repo:write');
    const b = req.body;
    const ns = await findNamespace(ctx, b.owner ?? user.username);
    if (!ns) throw notFound('Owner not found');
    if (!(await canManageNamespace(ctx, user, ns))) throw forbidden('You cannot create repositories for this owner');

    const target = await resolveRemote(b.url, ctx.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS);
    const name = b.name ?? repoNameFromUrl(target.url);
    if (!name || !repoNameSchema.safeParse(name).success) throw badRequest('Could not work out a repository name from that URL; enter one');
    if (await findRepo(ctx, ns.slug, name)) throw conflict(`${ns.slug} already has a repository called ${name}`);

    // Everything passed with -c lives only for this process: nothing, including a token, is written to disk.
    const cfg = target.config.flatMap((c) => ['-c', c]);
    if (b.token) cfg.push('-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`${b.username || 'git'}:${b.token}`).toString('base64')}`);
    const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    const remote = target.url.toString();

    // 1. Look before copying: reachable, allowed, and not empty.
    let head: ReturnType<typeof parseDefaultBranch>;
    try {
      const out = await runGit([...cfg, 'ls-remote', '--symref', '--', remote, 'HEAD'], { cwd: ctx.env.reposDir, env, timeoutMs: 30_000 });
      head = parseDefaultBranch(out.stdout.toString('utf8'));
    } catch (e) {
      throw badRequest(friendlyGitError(e instanceof GitError ? e.stderr : String(e)));
    }
    if (head.empty) throw badRequest('That repository has no commits to import');

    // 2. Copy into a new bare repository. The request waits a few seconds; a bigger copy carries on after the
    //    response (the page can be closed) and the repository page follows it.
    const [repo] = await ctx.db
      .insert(repositories)
      .values({ namespaceId: ns.id, name, description: b.description, visibility: b.visibility })
      .returning();
    const dest = repoDiskPath(ctx, repo!.id);
    const source = `${target.url.host}${target.url.pathname}`.replace(/\.git$/, '');
    const cleanup = async () => {
      await ctx.db.delete(repositories).where(eq(repositories.id, repo!.id));
      await rm(dest, { recursive: true, force: true }).catch(() => {});
    };
    startImport(repo!.id, source);

    const copy = async () => {
      const gr = await GitRepo.init(dest, repo!.defaultBranch);
      await runGit([...cfg, '-c', 'transfer.fsckObjects=true', 'fetch', '--quiet', '--prune', '--', remote, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], {
        cwd: dest,
        env,
        timeoutMs: ctx.env.IMPORT_TIMEOUT_MS,
      });
      const size = await gr.sizeBytes();
      if (size > ctx.env.IMPORT_MAX_MB * 1024 * 1024) throw badRequest(`That repository is larger than this server allows importing (${ctx.env.IMPORT_MAX_MB} MB)`);
      const branches = await gr.branches();
      if (!branches.length) throw badRequest('That repository has no branches to import');
      const defaultBranch = head.branch && branches.some((x) => x.name === head.branch) ? head.branch : branches[0]!.name;
      await gr.setHead(defaultBranch);
      const [updated] = await ctx.db.update(repositories).set({ defaultBranch, pushedAt: new Date(), sizeBytes: size }).where(eq(repositories.id, repo!.id)).returning();
      const sha = await gr.resolveBranch(defaultBranch);
      if (sha) await enqueueAnalysis(ctx, repo!.id, sha, defaultBranch).catch((e) => req.log.warn(e, 'enqueue failed'));
      if (b.mirror !== 'none') {
        const base = {
          repoId: repo!.id,
          url: remote,
          username: b.token ? b.username || null : null,
          secret: b.token ? encryptSecret(ctx.env, b.token) : null,
          intervalMinutes: Math.max(60, ctx.env.MIRROR_MIN_INTERVAL_MINUTES),
          createdBy: user.id,
          lastSyncAt: new Date(),
          lastSuccessAt: new Date(),
        };
        await ctx.db.insert(repoMirrors).values(b.mirror === 'two-way' ? [{ ...base, direction: 'pull' as const }, { ...base, direction: 'push' as const }] : [{ ...base, direction: 'pull' as const }]);
      }
      await audit(req, 'repo.import', { type: 'repo', id: repo!.id }, { from: `${target.url.protocol}//${target.url.host}${target.url.pathname}`, to: `${ns.slug}/${name}`, branches: branches.length, mirror: b.mirror });
      finishImport(repo!.id);
      return updated!;
    };
    const userFacing = (e: unknown) => (e instanceof Error && 'statusCode' in e ? e : badRequest(friendlyGitError(e instanceof GitError ? e.stderr : String(e))));

    const job = copy();
    const waited = await Promise.race([job.then((r) => ({ done: true as const, repo: r }), (e: unknown) => ({ done: true as const, error: e })), new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), importWaitMs()).unref())]);
    if (waited.done) {
      if ('error' in waited) {
        finishImport(repo!.id);
        await cleanup();
        throw userFacing(waited.error);
      }
      return toRepoInfo(ctx, waited.repo, ns, 'admin', { isEmpty: false });
    }
    // Still copying: answer now and let it finish on its own. A failure leaves an empty repository with the reason.
    job.catch(async (e: unknown) => {
      req.log.warn({ err: e, repo: repo!.id }, 'background import failed');
      failImport(repo!.id, userFacing(e).message);
      await rm(dest, { recursive: true, force: true }).catch(() => {});
      await GitRepo.init(dest, repo!.defaultBranch).catch(() => {});
    });
    return toRepoInfo(ctx, repo!, ns, 'admin', { isEmpty: true });
  });
};

export default importRoutes;
