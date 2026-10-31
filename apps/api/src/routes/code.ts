import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  basename,
  isReadme,
  isSafeRepoPath,
  kicadFileKind,
  type BlobResponse,
  type CommitDetail,
  type CompareResponse,
  type RefInfo,
  type TreeResponse,
} from '@pcbhub/shared';
import { EMPTY_TREE, isBinary, type GitRepo } from '../git/repo';
import { badRequest, conflict, notFound } from '../lib/errors';
import { loadRepo } from '../services/access';
import { audit } from '../services/audit';
import { collectSheets, semanticDiff } from '../services/semantic';
import { diffRefs, handleRefUpdates } from '../services/push';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
const pathSchema = z
  .string()
  .max(4096)
  .default('')
  .transform((p) => p.replace(/^\/+|\/+$/g, ''))
  .refine((p) => p === '' || isSafeRepoPath(p), 'Invalid path');
const refQuery = z.object({ ref: z.string().max(255).optional(), path: pathSchema });

const MAX_TEXT_VIEW = 2 * 1024 * 1024;
const MAX_README = 512 * 1024;

async function resolveRef(git: GitRepo, ref: string | undefined, fallback: string): Promise<{ ref: string; sha: string }> {
  const name = ref || fallback;
  const sha = await git.resolveCommit(name);
  if (!sha) throw notFound(`Unknown revision "${name}"`);
  return { ref: name, sha };
}

const codeRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get('/repos/:owner/:repo/branches', { schema: { params } }, async (req): Promise<RefInfo[]> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const branches = await r.git.branches();
    const defaultSha = branches.find((b) => b.name === r.repo.defaultBranch)?.sha;
    return Promise.all(
      branches.slice(0, 200).map(async (b) => ({
        ...b,
        isDefault: b.name === r.repo.defaultBranch,
        lastCommit: (await r.git.commit(b.sha)) ?? undefined,
        aheadBehind: defaultSha && b.name !== r.repo.defaultBranch ? await r.git.aheadBehind(defaultSha, b.sha).catch(() => null) : null,
      })),
    );
  });

  app.delete('/repos/:owner/:repo/branches/*', { schema: { params: params.extend({ '*': z.string().max(255) }) } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'write');
    const name = req.params['*'];
    if (name === r.repo.defaultBranch) throw conflict('The default branch cannot be deleted');
    const sha = await r.git.resolveBranch(name);
    if (!sha) throw notFound('Branch not found');
    const before = await r.git.refs();
    await r.git.deleteRef(`refs/heads/${name}`, sha);
    const after = await r.git.refs();
    await handleRefUpdates(ctx, r.repo, diffRefs(before, after), req.user, req.log);
    await audit(req, 'branch.delete', { type: 'repo', id: r.repo.id }, { branch: name, sha });
    return { ok: true };
  });

  app.get('/repos/:owner/:repo/tags', { schema: { params } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    return r.git.tags();
  });

  app.get('/repos/:owner/:repo/tree', { schema: { params, querystring: refQuery } }, async (req): Promise<TreeResponse> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const { ref, sha } = await resolveRef(r.git, req.query.ref, r.repo.defaultBranch);
    const path = req.query.path;
    const entry = await r.git.entryType(sha, path);
    if (!entry) throw notFound('Path not found');
    if (entry.type !== 'tree') throw badRequest('Path is not a directory');
    const [entries, lastCommit] = await Promise.all([r.git.tree(sha, path), r.git.lastCommitFor(sha, path)]);
    let readme: TreeResponse['readme'] = null;
    const readmeEntry = entries.find((e) => e.type === 'blob' && isReadme(e.name));
    if (readmeEntry && (readmeEntry.size ?? 0) <= MAX_README) {
      readme = { path: readmeEntry.path, text: (await r.git.readBlob(readmeEntry.oid, MAX_README)).toString('utf8') };
    }
    return { ref, sha, path, entries, lastCommit, readme };
  });

  app.get('/repos/:owner/:repo/blob', { schema: { params, querystring: refQuery } }, async (req): Promise<BlobResponse> => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const { ref, sha } = await resolveRef(r.git, req.query.ref, r.repo.defaultBranch);
    const path = req.query.path;
    const entry = path ? await r.git.entryType(sha, path) : null;
    if (!entry || entry.type !== 'blob') throw notFound('File not found');
    const size = entry.size ?? (await r.git.blobSize(entry.oid));
    const head = await r.git.readBlob(entry.oid, Math.min(size, MAX_TEXT_VIEW) + 1).catch(() => Buffer.alloc(0));
    const binary = isBinary(head);
    const truncated = size > MAX_TEXT_VIEW;
    return {
      ref,
      sha,
      path,
      oid: entry.oid,
      size,
      binary,
      truncated,
      text: binary || truncated ? null : head.toString('utf8'),
    };
  });

  app.get('/repos/:owner/:repo/raw', { schema: { params, querystring: refQuery } }, async (req, reply) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const { sha } = await resolveRef(r.git, req.query.ref, r.repo.defaultBranch);
    const path = req.query.path;
    const entry = path ? await r.git.entryType(sha, path) : null;
    if (!entry || entry.type !== 'blob') throw notFound('File not found');
    const size = entry.size ?? 0;
    if (size > ctx.env.MAX_VIEW_BYTES) throw badRequest('File too large to serve');
    const buf = await r.git.readBlob(entry.oid, ctx.env.MAX_VIEW_BYTES);
    // Never let user content render as HTML/SVG on our origin.
    const lower = path.toLowerCase();
    const image = /\.(png|jpe?g|gif|webp)$/.exec(lower)?.[1];
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', `private, max-age=${/^[0-9a-f]{40}$/.test(req.query.ref ?? '') ? 31536000 : 60}`)
      .header('ETag', `"${entry.oid}"`)
      .header('Content-Disposition', `inline; filename="${encodeURIComponent(basename(path))}"`);
    if (image) reply.type(`image/${image === 'jpg' ? 'jpeg' : image}`);
    else reply.type(isBinary(buf) ? 'application/octet-stream' : 'text/plain; charset=utf-8');
    return reply.send(buf);
  });

  app.get(
    '/repos/:owner/:repo/commits',
    {
      schema: {
        params,
        querystring: z.object({ ref: z.string().max(255).optional(), path: pathSchema, page: z.coerce.number().int().min(1).max(10000).default(1) }),
      },
    },
    async (req) => {
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      const { sha } = await resolveRef(r.git, req.query.ref, r.repo.defaultBranch);
      const perPage = 30;
      const commits = await r.git.log(sha, { path: req.query.path || undefined, skip: (req.query.page - 1) * perPage, limit: perPage + 1 });
      return { commits: commits.slice(0, perPage), hasMore: commits.length > perPage };
    },
  );

  app.get(
    '/repos/:owner/:repo/commits/:sha',
    { schema: { params: params.extend({ sha: z.string().max(255) }) } },
    async (req): Promise<CommitDetail> => {
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      const sha = await r.git.resolveCommit(req.params.sha);
      if (!sha) throw notFound('Commit not found');
      const commit = (await r.git.commit(sha))!;
      const files = await r.git.diff(commit.parents[0] ?? EMPTY_TREE, sha);
      return { commit, files };
    },
  );

  app.get(
    '/repos/:owner/:repo/compare',
    { schema: { params, querystring: z.object({ base: z.string().max(255), head: z.string().max(255) }) } },
    async (req): Promise<CompareResponse> => {
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      const [baseSha, headSha] = await Promise.all([r.git.resolveCommit(req.query.base), r.git.resolveCommit(req.query.head)]);
      if (!baseSha || !headSha) throw notFound('Unknown revision');
      const mergeBase = await r.git.mergeBase(baseSha, headSha);
      const from = mergeBase ?? EMPTY_TREE;
      const [commits, files] = await Promise.all([
        mergeBase ? r.git.commitsBetween(mergeBase, headSha) : r.git.log(headSha, { limit: 250 }),
        r.git.diff(from, headSha),
      ]);
      return { base: req.query.base, head: req.query.head, baseSha, headSha, mergeBase, commits, files };
    },
  );

  app.get(
    '/repos/:owner/:repo/semantic-diff',
    {
      schema: {
        params,
        querystring: z.object({
          base: z.string().max(255).optional(),
          head: z.string().max(255),
          path: pathSchema,
          oldPath: pathSchema.optional(),
        }),
      },
    },
    async (req) => {
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      const headSha = await r.git.resolveCommit(req.query.head);
      if (!headSha) throw notFound('Unknown head revision');
      const baseSha = req.query.base ? await r.git.resolveCommit(req.query.base) : null;
      if (req.query.base && !baseSha) throw notFound('Unknown base revision');
      return semanticDiff(ctx, r.git, baseSha, headSha, req.query.path, req.query.oldPath);
    },
  );

  app.get('/repos/:owner/:repo/bom', { schema: { params, querystring: refQuery } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const { sha } = await resolveRef(r.git, req.query.ref, r.repo.defaultBranch);
    if (kicadFileKind(req.query.path) !== 'sch') throw badRequest('Path must be a .kicad_sch file');
    const sheets = await collectSheets(ctx, r.git, sha, req.query.path);
    if (!sheets.length) throw notFound('Schematic not found');
    try {
      return { sha, sheets: sheets.length, lines: await ctx.kicad.bom(sheets) };
    } catch (e) {
      throw badRequest(`Could not parse schematic: ${(e as Error).message}`);
    }
  });

  /** Design files at a revision, used by the repository overview. */
  app.get('/repos/:owner/:repo/designs', { schema: { params, querystring: refQuery } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const { sha } = await resolveRef(r.git, req.query.ref, r.repo.defaultBranch);
    const out = await r.git.lsFiles(sha);
    return out.filter((p) => kicadFileKind(p) === 'pcb' || kicadFileKind(p) === 'sch' || kicadFileKind(p) === 'project').slice(0, 500);
  });
};

export default codeRoutes;
