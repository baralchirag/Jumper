import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, artifacts, eq } from '@jumper/db';
import type { Pcb } from '@jumper/kicad-core/types';
import {
  EMPTY_POLICY,
  FAB_PROFILES,
  candidateMcus,
  changelogMarkdown,
  checkFabRules,
  checkPolicy,
  computeBoardStats,
  diffPinMaps,
  findPinConflicts,
  generatePinsCsv,
  generatePinsHeader,
  generateZephyrOverlay,
  parseNetlist,
  parseTiers,
  pinAssignments,
  summarizeTier,
} from '@jumper/engineering';
import { kicadFileKind, isDesignFile } from '@jumper/shared';
import type { Ctx } from '../../context';
import { badRequest, notFound, unprocessable } from '../../lib/errors';
import { isValidRev, type GitRepo } from '../git/repo';
import { loadRepo } from '../repos/access';
import { priceBom } from '../bom/pricing';
import { collectSheets, semanticDiff } from '../code/semantic';
import { getRepoConfig } from '../_shared/repo-config';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
const rev = z.string().max(255).refine(isValidRev, 'Invalid revision');
const fileQuery = z.object({ path: z.string().min(1).max(4096), sha: rev.optional() });

async function resolve(git: GitRepo, defaultBranch: string, sha?: string): Promise<string> {
  const r = await git.resolveCommit(sha || defaultBranch);
  if (!r) throw notFound('Unknown revision');
  return r;
}

async function loadPcb(ctx: Ctx, git: GitRepo, sha: string, path: string): Promise<Pcb> {
  if (kicadFileKind(path) !== 'pcb') throw badRequest('Not a .kicad_pcb file');
  const buf = await git.readFile(sha, path, ctx.env.MAX_VIEW_BYTES);
  if (!buf) throw notFound('File not found at that revision');
  try {
    const parsed = await ctx.kicad.parse(buf.toString('utf8'), 'pcb');
    if (parsed.kind !== 'pcb') throw new Error('not a board');
    return parsed.model;
  } catch (e) {
    throw unprocessable(`Could not parse board: ${(e as Error).message}`);
  }
}

const designRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get('/repos/:owner/:repo/board-stats', { schema: { params, querystring: fileQuery } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const sha = await resolve(r.git, r.repo.defaultBranch, req.query.sha);
    return { sha, path: req.query.path, stats: computeBoardStats(await loadPcb(ctx, r.git, sha, req.query.path)) };
  });

  app.get(
    '/repos/:owner/:repo/fab-check',
    { schema: { params, querystring: fileQuery.extend({ profile: z.string().max(40).optional(), minClearanceMm: z.coerce.number().positive().max(10).optional() }) } },
    async (req) => {
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      const sha = await resolve(r.git, r.repo.defaultBranch, req.query.sha);
      const cfg = await getRepoConfig(ctx, r.repo.id);
      const ids = req.query.profile ? req.query.profile.split(',') : cfg.fabProfiles.length ? cfg.fabProfiles : Object.keys(FAB_PROFILES);
      const unknown = ids.filter((id) => !FAB_PROFILES[id]);
      if (unknown.length) throw badRequest(`Unknown fab profile(s): ${unknown.join(', ')}`);
      const stats = computeBoardStats(await loadPcb(ctx, r.git, sha, req.query.path));
      return { sha, path: req.query.path, stats, reports: ids.map((id) => ({ ...checkFabRules(stats, FAB_PROFILES[id]!, { minClearanceMm: req.query.minClearanceMm }), name: FAB_PROFILES[id]!.name })) };
    },
  );

  app.get('/repos/:owner/:repo/changelog', { schema: { params, querystring: z.object({ base: rev, head: rev }) } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const [base, head] = await Promise.all([r.git.resolveCommit(req.query.base), r.git.resolveCommit(req.query.head)]);
    if (!base || !head) throw notFound('Unknown revision');
    const files = (await r.git.diff(base, head)).filter((f) => isDesignFile(f.path));
    const limited = files.slice(0, 20);
    const diffs = [];
    for (const f of limited) {
      try {
        diffs.push({ file: f.path, diff: (await semanticDiff(ctx, r.git, base, head, f.path, f.oldPath)).diff });
      } catch {
        /* unparsable file: leave it out of the summary */
      }
    }
    return { base, head, truncated: files.length > limited.length, markdown: changelogMarkdown(`${base.slice(0, 7)}…${head.slice(0, 7)}`, diffs) };
  });

  app.get('/repos/:owner/:repo/part-policy', { schema: { params, querystring: fileQuery } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const sha = await resolve(r.git, r.repo.defaultBranch, req.query.sha);
    if (kicadFileKind(req.query.path) !== 'sch') throw badRequest('Not a .kicad_sch file');
    const sheets = await collectSheets(ctx, r.git, sha, req.query.path);
    if (!sheets.length) throw notFound('File not found at that revision');
    const bom = await ctx.kicad.bom(sheets).catch((e) => {
      throw unprocessable(`Could not read BOM: ${(e as Error).message}`);
    });
    const field = (f: Record<string, string>, ...names: string[]) => {
      for (const n of names) for (const [k, v] of Object.entries(f)) if (k.toLowerCase() === n.toLowerCase() && v) return v;
      return null;
    };
    const cfg = await getRepoConfig(ctx, r.repo.id);
    const result = checkPolicy(
      bom.filter((l) => !l.dnp).map((l) => ({ references: l.references, value: l.value, footprint: l.footprint, mpn: field(l.fields, 'MPN', 'Manufacturer_Part_Number', 'Mfr. Part #'), manufacturer: field(l.fields, 'Manufacturer', 'Mfr', 'MFR') })),
      { ...EMPTY_POLICY, ...cfg.partPolicy },
    );
    return { sha, path: req.query.path, ...result };
  });

  /** BOM cost at several build volumes (default 1, 10, 100, 1000), priced across suppliers. */
  app.get(
    '/repos/:owner/:repo/bom/cost-rollup',
    {
      schema: { params, querystring: fileQuery.extend({ tiers: z.string().max(60).optional() }) },
      // Each tier fans out to the supplier APIs.
      config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
    },
    async (req) => {
      if (!ctx.env.PRICING_ENABLED || ctx.env.AIR_GAPPED) throw notFound(ctx.env.AIR_GAPPED ? 'Supplier pricing is off: this instance does not contact outside services' : 'Supplier pricing is disabled on this instance');
      const r = await loadRepo(req, req.params.owner, req.params.repo);
      const sha = await resolve(r.git, r.repo.defaultBranch, req.query.sha);
      if (kicadFileKind(req.query.path) !== 'sch') throw badRequest('Path must be a .kicad_sch file');
      const tiers = parseTiers(req.query.tiers);
      if (!tiers.length) throw badRequest('No valid volumes in "tiers"');
      const sheets = await collectSheets(ctx, r.git, sha, req.query.path);
      if (!sheets.length) throw notFound('Schematic not found');
      const lines = await ctx.kicad.bom(sheets).catch((e: Error) => {
        throw unprocessable(`Could not parse schematic: ${e.message}`);
      });
      const config = { mouserApiKey: ctx.env.MOUSER_API_KEY, digikeyClientId: ctx.env.DIGIKEY_CLIENT_ID, digikeyClientSecret: ctx.env.DIGIKEY_CLIENT_SECRET };
      const out = [];
      for (const boards of tiers) out.push(summarizeTier({ ...(await priceBom(lines, boards, { redis: ctx.redis, config })), boards }));
      return { sha, currency: 'USD', tiers: out };
    },
  );

  // ---------- firmware pin maps (from the netlist the checks produce) ----------

  async function netlistAt(r: { repo: { id: string }; git: GitRepo }, sha: string, project?: string) {
    const rows = await ctx.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.repoId, r.repo.id), eq(artifacts.sha, sha), eq(artifacts.kind, 'netlist')));
    const a = project === undefined ? rows[0] : rows.find((x) => x.projectPath === project);
    if (!a) throw notFound('No netlist for this revision yet. Enable the netlist export in .jumper.yml and wait for the checks to finish.');
    const obj = await ctx.storage.get(a.storageKey);
    if (!obj) throw notFound('Netlist data missing');
    if (obj.size > 32 * 1024 * 1024) {
      obj.body.destroy();
      throw unprocessable('Netlist is too large');
    }
    const chunks: Buffer[] = [];
    for await (const c of obj.body) chunks.push(Buffer.from(c as Uint8Array));
    try {
      return parseNetlist(Buffer.concat(chunks).toString('utf8'));
    } catch (e) {
      throw unprocessable((e as Error).message);
    }
  }

  const pinQuery = z.object({ sha: rev.optional(), project: z.string().max(4096).optional(), mcu: z.string().max(40).optional() });

  app.get('/repos/:owner/:repo/pinmap', { schema: { params, querystring: pinQuery.extend({ format: z.enum(['json', 'header', 'zephyr', 'csv']).default('json') }) } }, async (req, reply) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const sha = await resolve(r.git, r.repo.defaultBranch, req.query.sha);
    const net = await netlistAt(r, sha, req.query.project);
    const candidates = candidateMcus(net);
    const ref = req.query.mcu ?? candidates[0]?.ref;
    if (!ref || !net.components.some((c) => c.ref === ref)) throw notFound('No microcontroller found; pass ?mcu=<reference>');
    const pins = pinAssignments(net, ref);
    switch (req.query.format) {
      case 'header':
        return reply.type('text/plain; charset=utf-8').header('X-Content-Type-Options', 'nosniff').send(generatePinsHeader(pins));
      case 'zephyr':
        return reply.type('text/plain; charset=utf-8').header('X-Content-Type-Options', 'nosniff').send(generateZephyrOverlay(pins));
      case 'csv':
        return reply.type('text/csv; charset=utf-8').header('X-Content-Type-Options', 'nosniff').send(generatePinsCsv(pins));
      default:
        return { sha, mcu: ref, candidates, pins, conflicts: findPinConflicts(pins) };
    }
  });

  app.get('/repos/:owner/:repo/pinmap/diff', { schema: { params, querystring: pinQuery.extend({ base: rev, head: rev }).omit({ sha: true }) } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const [base, head] = await Promise.all([r.git.resolveCommit(req.query.base), r.git.resolveCommit(req.query.head)]);
    if (!base || !head) throw notFound('Unknown revision');
    const [a, b] = await Promise.all([netlistAt(r, base, req.query.project), netlistAt(r, head, req.query.project)]);
    const ref = req.query.mcu ?? candidateMcus(b)[0]?.ref;
    if (!ref) throw notFound('No microcontroller found; pass ?mcu=<reference>');
    return { mcu: ref, changes: diffPinMaps(pinAssignments(a, ref), pinAssignments(b, ref)) };
  });
};

export default designRoutes;
