import type { Readable } from 'node:stream';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, inArray, releaseAssets, releases, sql, users, type Release, type ReleaseAsset } from '@jumper/db';
import { createReleaseSchema, updateReleaseSchema, type ReleaseAssetKind, type ReleaseInfo } from '@jumper/shared';
import { contentTypeFor } from '@jumper/storage';
import type { Ctx } from '../../context';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { audit } from '../audit/audit';
import { can, gitFor, loadRepo, requireCap, type RepoCtx } from '../repos/access';
import { requireUser } from '../auth/plugin';
import { assertRepoNotHeld } from '../legal/holds';
import { approvalStates, isApproved, requirementFor, signoffsFor, verifiedRecords, writeReleaseRecord } from './approval';
import { releaseSignoffs, type User } from '@jumper/db';
import { toUserSummary } from '../repos/serialize';
import { pushRefusal } from '../usage/service';
import { assetsFor, attachGenerated, releaseStorageKey, type MissingAsset } from './service';

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });
const idParams = params.extend({ id: z.uuid() });
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_ASSETS = 50;

function assetUrl(r: RepoCtx, a: ReleaseAsset): string {
  return `/api/repos/${r.ns.slug}/${r.repo.name}/releases/assets/${a.id}/download`;
}

async function serialize(ctx: Ctx, r: RepoCtx, rows: Release[], missing = new Map<string, MissingAsset[]>(), viewer: User | null = null): Promise<ReleaseInfo[]> {
  const approval = await approvalStates(ctx, r, rows, viewer);
  const assets = await assetsFor(ctx, rows.map((x) => x.id));
  const authorIds = [...new Set(rows.map((x) => x.createdBy).filter((x): x is string => Boolean(x)))];
  const authors = authorIds.length ? await ctx.db.select().from(users).where(inArray(users.id, authorIds)) : [];
  const latest = (
    await ctx.db
      .select({ id: releases.id })
      .from(releases)
      .where(and(eq(releases.repoId, r.repo.id), eq(releases.draft, false), eq(releases.prerelease, false)))
      .orderBy(desc(releases.publishedAt))
      .limit(1)
  )[0]?.id;
  return rows.map((x) => {
    const author = authors.find((u) => u.id === x.createdBy);
    return {
      id: x.id,
      tag: x.tag,
      name: x.name || x.tag,
      body: x.body,
      sha: x.sha,
      draft: x.draft,
      prerelease: x.prerelease,
      latest: x.id === latest,
      author: author ? toUserSummary(author) : null,
      createdAt: x.createdAt.toISOString(),
      publishedAt: x.publishedAt?.toISOString() ?? null,
      assets: (assets.get(x.id) ?? []).map((a) => ({ id: a.id, name: a.name, kind: a.kind as ReleaseAssetKind, size: a.size, contentType: a.contentType, downloadCount: a.downloadCount, url: assetUrl(r, a) })),
      missing: missing.get(x.id) ?? [],
      approval: approval.get(x.id) ?? null,
      recordDigest: x.recordDigest,
    };
  });
}

const releaseRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  type Loaded = RepoCtx & { seesDrafts?: boolean };
  /** Publishing, editing and deleting releases needs the `release` capability (Committer, or a custom role with it). */
  const loadForRelease = async (req: Parameters<typeof loadRepo>[0], owner: string, repo: string): Promise<Loaded> => {
    const r = await loadRepo(req, owner, repo, 'read');
    requireUser(req);
    requireCap(r, 'release');
    return r;
  };
  const loadWithDrafts = async (req: Parameters<typeof loadRepo>[0], owner: string, repo: string): Promise<Loaded> => {
    const r: Loaded = await loadRepo(req, owner, repo);
    if (req.user && !can(r, 'release')) {
      const need = await requirementFor(ctx, r);
      r.seesDrafts = Boolean(need?.approvers.some((a) => a.id === req.user!.id));
    }
    return r;
  };

  // Raw uploads: the file body is streamed to storage, never buffered whole.
  app.addContentTypeParser('application/octet-stream', { bodyLimit: MAX_UPLOAD_BYTES }, (_req, payload, done) => done(null, payload));

  // Drafts are visible to people who can publish releases, and to the named approvers who have to sign them off.
  const canWrite = (r: Loaded) => can(r, 'release') || r.seesDrafts === true;

  const findRelease = async (r: Loaded, id: string) => {
    const row = (await ctx.db.select().from(releases).where(and(eq(releases.id, id), eq(releases.repoId, r.repo.id))).limit(1))[0];
    if (!row || (row.draft && !canWrite(r))) throw notFound('Release not found');
    return row;
  };

  /** Attach generated files that were not ready before, and report what is still missing. */
  const refresh = async (r: Loaded, rows: Release[]) => {
    const missing = new Map<string, MissingAsset[]>();
    for (const x of rows) {
      const m = await attachGenerated(ctx, x, r.repo.name).catch(() => []);
      if (m.length) missing.set(x.id, m);
    }
    return missing;
  };

  app.get('/repos/:owner/:repo/releases', { schema: { params, querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }) } }, async (req): Promise<ReleaseInfo[]> => {
    const r = await loadWithDrafts(req, req.params.owner, req.params.repo);
    const rows = await ctx.db
      .select()
      .from(releases)
      .where(and(eq(releases.repoId, r.repo.id), canWrite(r) ? undefined : eq(releases.draft, false)))
      .orderBy(desc(releases.createdAt))
      .limit(req.query.limit);
    return serialize(ctx, r, rows, await refresh(r, rows), req.user);
  });

  app.get('/repos/:owner/:repo/releases/latest', { schema: { params } }, async (req): Promise<ReleaseInfo> => {
    const r = await loadWithDrafts(req, req.params.owner, req.params.repo);
    const row = (
      await ctx.db
        .select()
        .from(releases)
        .where(and(eq(releases.repoId, r.repo.id), eq(releases.draft, false), eq(releases.prerelease, false)))
        .orderBy(desc(releases.publishedAt))
        .limit(1)
    )[0];
    if (!row) throw notFound('No releases yet');
    return (await serialize(ctx, r, [row], await refresh(r, [row]), req.user))[0]!;
  });

  app.get('/repos/:owner/:repo/releases/tags/*', { schema: { params: params.extend({ '*': z.string().min(1).max(200) }) } }, async (req): Promise<ReleaseInfo> => {
    const r = await loadWithDrafts(req, req.params.owner, req.params.repo);
    const row = (await ctx.db.select().from(releases).where(and(eq(releases.repoId, r.repo.id), eq(releases.tag, req.params['*']))).limit(1))[0];
    if (!row || (row.draft && !canWrite(r))) throw notFound('Release not found');
    return (await serialize(ctx, r, [row], await refresh(r, [row]), req.user))[0]!;
  });

  app.post('/repos/:owner/:repo/releases', { schema: { params, body: createReleaseSchema } }, async (req): Promise<ReleaseInfo> => {
    const r = await loadForRelease(req, req.params.owner, req.params.repo);
    const b = req.body;
    const git = gitFor(ctx, r.repo.id);
    if ((await ctx.db.select({ id: releases.id }).from(releases).where(and(eq(releases.repoId, r.repo.id), eq(releases.tag, b.tag))).limit(1)).length) {
      throw conflict(`A release for ${b.tag} already exists`);
    }
    const existing = (await git.tags()).find((t) => t.name === b.tag);
    let sha: string;
    if (existing) {
      sha = existing.sha;
    } else {
      const target = b.target || r.repo.defaultBranch;
      const resolved = (await git.resolveBranch(target)) ?? (await git.resolveCommit(target));
      if (!resolved) throw badRequest(`Could not find the branch or commit "${target}"`);
      sha = resolved;
      await git.updateRef(`refs/tags/${b.tag}`, sha, null);
    }
    // With release approval in force a release starts as a draft and is published once the named people have approved it.
    const needsApproval = (await requirementFor(ctx, r)) !== null;
    const draft = b.draft || needsApproval;
    const [row] = await ctx.db
      .insert(releases)
      .values({ repoId: r.repo.id, tag: b.tag, name: b.name, body: b.body, sha, draft, prerelease: b.prerelease, assetKinds: b.assets, createdBy: req.user!.id, publishedAt: draft ? null : new Date() })
      .returning();
    await audit(req, 'release.create', { type: 'repo', id: r.repo.id }, { tag: b.tag, sha, createdTag: !existing, awaitingApproval: needsApproval && !b.draft });
    const missing = await refresh(r, [row!]);
    if (!draft) await writeReleaseRecord(ctx, r, row!).catch((e) => req.log.error(e, 'release record failed'));
    const fresh = (await ctx.db.select().from(releases).where(eq(releases.id, row!.id)).limit(1))[0]!;
    return (await serialize(ctx, r, [fresh], missing, req.user))[0]!;
  });

  app.patch('/repos/:owner/:repo/releases/:id', { schema: { params: idParams, body: updateReleaseSchema } }, async (req): Promise<ReleaseInfo> => {
    const r = await loadForRelease(req, req.params.owner, req.params.repo);
    const row = await findRelease(r, req.params.id);
    const b = req.body;
    const publishing = b.draft === false && row.draft;
    if (publishing) {
      const need = await requirementFor(ctx, r);
      if (need && !isApproved(row, (await signoffsFor(ctx, [row.id])).get(row.id) ?? [], need)) {
        throw conflict(`This release needs ${need.required} approval(s) from ${need.approvers.map((a) => a.username).join(', ')} before it can be published`);
      }
    }
    // A published release is what was sent to the fab: it cannot quietly go back to being a draft once it has a record.
    if (b.draft === true && !row.draft && row.recordDigest) throw conflict('A published release with a release record cannot be turned back into a draft');
    const [updated] = await ctx.db
      .update(releases)
      .set({ ...b, ...(publishing ? { publishedAt: new Date() } : {}), ...(b.draft === true ? { publishedAt: null } : {}) })
      .where(eq(releases.id, row.id))
      .returning();
    await audit(req, 'release.update', { type: 'repo', id: r.repo.id }, { tag: row.tag, fields: Object.keys(b) });
    if (publishing) {
      await attachGenerated(ctx, updated!, r.repo.name).catch(() => []);
      await writeReleaseRecord(ctx, r, updated!).catch((e) => req.log.error(e, 'release record failed'));
      const fresh = (await ctx.db.select().from(releases).where(eq(releases.id, row.id)).limit(1))[0]!;
      return (await serialize(ctx, r, [fresh], undefined, req.user))[0]!;
    }
    return (await serialize(ctx, r, [updated!], undefined, req.user))[0]!;
  });

  app.delete('/repos/:owner/:repo/releases/:id', { schema: { params: idParams, querystring: z.object({ deleteTag: z.stringbool().default(false) }) } }, async (req) => {
    const r = await loadForRelease(req, req.params.owner, req.params.repo);
    const row = await findRelease(r, req.params.id);
    await assertRepoNotHeld(ctx, r.repo);
    await ctx.db.delete(releases).where(eq(releases.id, row.id));
    await ctx.storage.deletePrefix(`repos/${r.repo.id}/releases/${row.id}/`).catch((e) => req.log.warn(e, 'release file cleanup failed'));
    if (req.query.deleteTag) await gitFor(ctx, r.repo.id).deleteRef(`refs/tags/${row.tag}`).catch(() => {});
    await audit(req, 'release.delete', { type: 'repo', id: r.repo.id }, { tag: row.tag, deletedTag: req.query.deleteTag });
    return { ok: true };
  });

  app.post('/repos/:owner/:repo/releases/:id/refresh', { schema: { params: idParams } }, async (req): Promise<ReleaseInfo> => {
    const r = await loadForRelease(req, req.params.owner, req.params.repo);
    const row = await findRelease(r, req.params.id);
    return (await serialize(ctx, r, [row], await refresh(r, [row]), req.user))[0]!;
  });

  // A named approver records a decision on the commit the release points at. Decisions are never edited: a changed
  // mind is a new entry, and the record keeps them all.
  app.post(
    '/repos/:owner/:repo/releases/:id/signoff',
    { schema: { params: idParams, body: z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().trim().max(2000).default('') }) } },
    async (req): Promise<ReleaseInfo> => {
      const user = requireUser(req);
      const r = await loadWithDrafts(req, req.params.owner, req.params.repo);
      const row = await findRelease(r, req.params.id);
      const need = await requirementFor(ctx, r);
      if (!need) throw badRequest('Releases of this repository do not need approval');
      if (!need.approvers.some((a) => a.id === user.id)) throw forbidden('Only the named release approvers can sign off a release');
      if (user.id === row.createdBy) throw forbidden('The person who created a release cannot approve it');
      if (!row.draft) throw conflict('This release is already published');
      await ctx.db.insert(releaseSignoffs).values({ releaseId: row.id, userId: user.id, decision: req.body.decision, comment: req.body.comment, sha: row.sha });
      await audit(req, `release.${req.body.decision}`, { type: 'repo', id: r.repo.id }, { tag: row.tag, sha: row.sha });
      return (await serialize(ctx, r, [row], undefined, user))[0]!;
    },
  );

  /** The release records of a repository, each checked against its digest, signature and the record before it. */
  app.get('/repos/:owner/:repo/release-records', { schema: { params, querystring: z.object({ tag: z.string().max(200).optional() }) } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    const all = await verifiedRecords(ctx, r.repo.id);
    return req.query.tag ? all.filter((x) => x.record.tag === req.query.tag) : all;
  });

  /** Attach your own file (assembly drawing, test report, firmware...): PUT the raw bytes. */
  app.put(
    '/repos/:owner/:repo/releases/:id/assets/:name',
    { schema: { params: idParams.extend({ name: z.string().min(1).max(200).regex(/^[^/\\\0]+$/, 'File names cannot contain slashes') }) }, bodyLimit: MAX_UPLOAD_BYTES },
    async (req): Promise<ReleaseInfo> => {
      const r = await loadForRelease(req, req.params.owner, req.params.repo);
      const row = await findRelease(r, req.params.id);
      const body = req.body as Readable | undefined;
      if (!body || typeof (body as Readable).pipe !== 'function') throw badRequest('Send the file as the request body with Content-Type: application/octet-stream');
      const refusal = await pushRefusal(ctx, r.repo.namespaceId);
      if (refusal) throw badRequest(refusal);
      const count = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(releaseAssets).where(eq(releaseAssets.releaseId, row.id));
      if ((count[0]?.n ?? 0) >= MAX_ASSETS) throw badRequest(`A release can have at most ${MAX_ASSETS} files`);
      const name = req.params.name.trim();
      if ((await ctx.db.select({ id: releaseAssets.id }).from(releaseAssets).where(and(eq(releaseAssets.releaseId, row.id), eq(releaseAssets.name, name))).limit(1)).length) {
        throw conflict(`This release already has a file called ${name}`);
      }
      const key = releaseStorageKey(r.repo.id, row.id, name);
      let size = 0;
      body.on('data', (c: Buffer) => (size += c.length));
      const type = contentTypeFor(name);
      await ctx.storage.put(key, body, type);
      if (size === 0) {
        await ctx.storage.deletePrefix(key).catch(() => {});
        throw badRequest('The file is empty');
      }
      await ctx.db.insert(releaseAssets).values({ releaseId: row.id, name, kind: 'upload', size, contentType: type, storageKey: key });
      await audit(req, 'release.asset_upload', { type: 'repo', id: r.repo.id }, { tag: row.tag, name, size });
      return (await serialize(ctx, r, [row], undefined, req.user))[0]!;
    },
  );

  app.delete('/repos/:owner/:repo/releases/:id/assets/:assetId', { schema: { params: idParams.extend({ assetId: z.uuid() }) } }, async (req) => {
    const r = await loadForRelease(req, req.params.owner, req.params.repo);
    const row = await findRelease(r, req.params.id);
    const [a] = await ctx.db.delete(releaseAssets).where(and(eq(releaseAssets.id, req.params.assetId), eq(releaseAssets.releaseId, row.id))).returning();
    if (!a) throw notFound('File not found');
    await ctx.storage.deletePrefix(a.storageKey).catch(() => {});
    // A removed generated file must not come straight back on the next read.
    if (a.kind !== 'upload') await ctx.db.update(releases).set({ assetKinds: row.assetKinds.filter((k) => k !== a.kind) }).where(eq(releases.id, row.id));
    await audit(req, 'release.asset_delete', { type: 'repo', id: r.repo.id }, { tag: row.tag, name: a.name });
    return { ok: true };
  });

  const sendAsset = async (r: RepoCtx, a: ReleaseAsset, reply: import('fastify').FastifyReply) => {
    const obj = await ctx.storage.get(a.storageKey);
    if (!obj) throw notFound('File data missing');
    void ctx.db.update(releaseAssets).set({ downloadCount: sql`${releaseAssets.downloadCount} + 1` }).where(eq(releaseAssets.id, a.id)).catch(() => {});
    return reply
      .type(a.contentType || 'application/octet-stream')
      .header('Content-Length', obj.size)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', r.repo.visibility === 'public' ? 'public, max-age=300' : 'private, max-age=300')
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(a.name)}"`)
      .send(obj.body);
  };

  app.get('/repos/:owner/:repo/releases/assets/:assetId/download', { schema: { params: params.extend({ assetId: z.uuid() }) } }, async (req, reply) => {
    const r = await loadWithDrafts(req, req.params.owner, req.params.repo);
    const row = (
      await ctx.db
        .select({ a: releaseAssets, draft: releases.draft })
        .from(releaseAssets)
        .innerJoin(releases, eq(releases.id, releaseAssets.releaseId))
        .where(and(eq(releaseAssets.id, req.params.assetId), eq(releases.repoId, r.repo.id)))
        .limit(1)
    )[0];
    if (!row || (row.draft && !canWrite(r))) throw notFound('File not found');
    return sendAsset(r, row.a, reply);
  });

  /**
   * Stable link to a file of the latest release, for READMEs and fab-house order pages:
   * /releases/latest/download/gerbers.zip matches "board-v1.2-gerbers.zip".
   */
  app.get('/repos/:owner/:repo/releases/latest/download/:name', { schema: { params: params.extend({ name: z.string().min(1).max(200) }) } }, async (req, reply) => {
    const r = await loadWithDrafts(req, req.params.owner, req.params.repo);
    const latest = (
      await ctx.db
        .select()
        .from(releases)
        .where(and(eq(releases.repoId, r.repo.id), eq(releases.draft, false), eq(releases.prerelease, false)))
        .orderBy(desc(releases.publishedAt))
        .limit(1)
    )[0];
    if (!latest) throw notFound('No releases yet');
    await attachGenerated(ctx, latest, r.repo.name).catch(() => []);
    const files = await ctx.db.select().from(releaseAssets).where(eq(releaseAssets.releaseId, latest.id));
    const want = req.params.name;
    const a = files.find((f) => f.name === want) ?? files.find((f) => f.name.endsWith(`-${want}`));
    if (!a) throw notFound(`The latest release has no file matching ${want}`);
    return sendAsset(r, a, reply);
  });
};

export default releaseRoutes;
