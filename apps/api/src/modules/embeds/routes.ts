// README embeds: status badges and a live picture of the board, at stable URLs that follow a branch.
//
//   ![DRC](https://jumper.example.com/api/repos/acme/board/badge.svg?check=DRC)
//   ![Board](https://jumper.example.com/api/repos/acme/board/preview.png?view=iso)
//
// Public repositories work anywhere (GitHub, docs sites). Private ones only for signed-in viewers on Jumper itself.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, artifacts, checkRuns, desc, eq, inArray, releases } from '@jumper/db';
import { CHECK_NAMES } from '@jumper/shared';
import { notFound } from '../../lib/errors';
import { gitFor, loadRepo } from '../repos/access';
import { badgeSvg, summarize } from './badge';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
const branch = z.string().max(200).regex(/^[^\0\s~^:?*[\\]+$/).optional();

/** Preview images, best first, for each view. Rendered 3D images look like the real board; the SVG is the layout drawing. */
const VIEWS: Record<string, { kind: string; name: string }[]> = {
  iso: [{ kind: 'render3d', name: 'iso-top.png' }, { kind: 'render3d', name: 'top.png' }, { kind: 'thumbnail', name: 'top.svg' }],
  top: [{ kind: 'render3d', name: 'top.png' }, { kind: 'thumbnail', name: 'top.svg' }],
  bottom: [{ kind: 'render3d', name: 'bottom.png' }, { kind: 'thumbnail', name: 'bottom.svg' }],
  drawing: [{ kind: 'thumbnail', name: 'top.svg' }],
};

const embedRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  // Public embeds must load on other sites (READMEs on GitHub, blogs): relax the site-wide same-origin resource policy.
  app.addHook('onSend', async (req, reply) => {
    if (reply.statusCode < 400 && (req as { embedPublic?: boolean }).embedPublic) reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
  });
  const markPublic = (req: object, visibility: string) => {
    if (visibility === 'public') (req as { embedPublic?: boolean }).embedPublic = true;
  };

  /** Recent commits of the branch, newest first: embeds fall back to the last commit whose checks produced something. */
  async function recentShas(repoId: string, ref: string, limit = 20): Promise<string[]> {
    return (await gitFor(ctx, repoId).log(ref, { limit })).map((c) => c.sha);
  }

  // What the embeddable viewer (/embed/owner/repo) should open: the commit a branch points at and the first
  // KiCad project's board and schematic. Public repositories only, since an embed is shown to anyone.
  app.get('/repos/:owner/:repo/embed', { schema: { params, querystring: z.object({ branch, path: z.string().max(1000).optional() }) } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    if (r.repo.visibility !== 'public' || r.repo.exportControlled) throw notFound('Only public repositories can be embedded');
    const git = gitFor(ctx, r.repo.id);
    const ref = req.query.branch ?? r.repo.defaultBranch;
    const sha = await git.resolveBranch(ref);
    if (!sha) throw notFound('Nothing has been pushed to that branch yet');
    const files = await git.lsFiles(sha);
    const wanted = req.query.path && files.includes(req.query.path) ? req.query.path : null;
    const project = wanted
      ? wanted.replace(/\.kicad_(pcb|sch)$/, '')
      : (files.find((f) => f.endsWith('.kicad_pro')) ?? files.find((f) => f.endsWith('.kicad_pcb')) ?? '').replace(/\.kicad_(pro|pcb)$/, '');
    const pcb = files.includes(`${project}.kicad_pcb`) ? `${project}.kicad_pcb` : (files.find((f) => f.endsWith('.kicad_pcb')) ?? null);
    const sch = files.includes(`${project}.kicad_sch`) ? `${project}.kicad_sch` : (files.find((f) => f.endsWith('.kicad_sch')) ?? null);
    if (!pcb && !sch) throw notFound('No KiCad board or schematic in this repository');
    return { owner: r.ns.slug, repo: r.repo.name, ref, sha, pcb, sch, description: r.repo.description };
  });

  app.get(
    '/repos/:owner/:repo/badge.svg',
    { schema: { params, querystring: z.object({ check: z.enum([...CHECK_NAMES, 'all']).default('all'), branch, label: z.string().max(40).optional() }) } },
    async (req, reply) => {
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      markPublic(req, r.repo.visibility);
      const ref = req.query.branch ?? r.repo.defaultBranch;
      const head = await gitFor(ctx, r.repo.id).resolveBranch(ref);
      const label = req.query.label ?? (req.query.check === 'all' ? 'checks' : req.query.check);
      let state = { message: 'no commits', tone: 'neutral' as const } as ReturnType<typeof summarize>;
      if (head) {
        const runs = await ctx.db
          .select({ status: checkRuns.status, conclusion: checkRuns.conclusion })
          .from(checkRuns)
          .where(and(eq(checkRuns.repoId, r.repo.id), eq(checkRuns.sha, head), ...(req.query.check === 'all' ? [] : [eq(checkRuns.name, req.query.check)])));
        state = summarize(runs);
        if (!runs.length) state = { message: 'pending', tone: 'pending' };
      }
      return reply
        .type('image/svg+xml; charset=utf-8')
        .header('Cache-Control', r.repo.visibility === 'public' ? 'public, max-age=60, s-maxage=60' : 'private, no-cache')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
        .send(badgeSvg(label, state.message, state.tone));
    },
  );

  app.get('/repos/:owner/:repo/badge/release.svg', { schema: { params } }, async (req, reply) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    markPublic(req, r.repo.visibility);
    const latest = (
      await ctx.db
        .select({ tag: releases.tag })
        .from(releases)
        .where(and(eq(releases.repoId, r.repo.id), eq(releases.draft, false), eq(releases.prerelease, false)))
        .orderBy(desc(releases.publishedAt))
        .limit(1)
    )[0];
    return reply
      .type('image/svg+xml; charset=utf-8')
      .header('Cache-Control', r.repo.visibility === 'public' ? 'public, max-age=300' : 'private, no-cache')
      .header('X-Content-Type-Options', 'nosniff')
      .send(badgeSvg('release', latest?.tag ?? 'none', latest ? 'info' : 'neutral'));
  });

  /** The board as of the branch's latest analysed commit. `.png` and `.svg` are the same endpoint; the type follows the image. */
  for (const path of ['/repos/:owner/:repo/preview', '/repos/:owner/:repo/preview.png', '/repos/:owner/:repo/preview.svg']) {
    app.get(path, { schema: { params, querystring: z.object({ view: z.enum(['iso', 'top', 'bottom', 'drawing']).default('iso'), branch }) } }, async (req, reply) => {
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      markPublic(req, r.repo.visibility);
      const shas = await recentShas(r.repo.id, req.query.branch ?? r.repo.defaultBranch);
      if (!shas.length) throw notFound('No commits yet');
      const wanted = VIEWS[req.query.view]!;
      const rows = await ctx.db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.repoId, r.repo.id), inArray(artifacts.sha, shas), inArray(artifacts.kind, [...new Set(wanted.map((w) => w.kind))])));
      // Newest commit first; within it, the best matching view.
      let pick: (typeof rows)[number] | undefined;
      for (const sha of shas) {
        const at = rows.filter((a) => a.sha === sha);
        for (const w of wanted) {
          pick = at.find((a) => a.kind === w.kind && a.name === w.name);
          if (pick) break;
        }
        if (pick) break;
      }
      if (!pick) throw notFound('No board picture yet. It appears after the checks on a commit with a PCB have finished.');
      const obj = await ctx.storage.get(pick.storageKey);
      if (!obj) throw notFound('Picture data missing');
      return reply
        .type(pick.contentType)
        .header('Content-Length', obj.size)
        .header('Cache-Control', r.repo.visibility === 'public' ? 'public, max-age=300' : 'private, max-age=60')
        .header('X-Content-Type-Options', 'nosniff')
        // Rendered SVGs are opened as images only; this neutralises any script if one is opened directly.
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox")
        .header('ETag', `"${pick.id}"`)
        .send(obj.body);
    });
  }
};

export default embedRoutes;
