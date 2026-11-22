import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  and,
  desc,
  eq,
  inArray,
  namespaces,
  orgMembers,
  organizations,
  customRoles,
  repoCollaborators,
  repositories,
  sql,
  users,
  type Repository,
  type User,
} from '@jumper/db';
import { KICAD_GITIGNORE, collaboratorSchema, createRepoSchema, pinsSchema, updateRepoSchema, type NamespaceInfo, type RepoInfo } from '@jumper/shared';
import { requireScope, requireUser } from '../auth/plugin';
import { GitRepo } from '../git/repo';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { purgeRepoData } from './purge';
import { SAMPLE_PROJECT, SAMPLE_README } from './sample';
import { accessesFor, canManageNamespace, findNamespace, findRepo, loadRepo, repoDiskPath } from './access';
import { accessDenial } from '../policy/service';
import { audit } from '../audit/audit';
import { assertRepoNotHeld, holdOnRepo } from '../legal/holds';
import { findTemplate, templateInfos } from './templates';
import { resolveRoleRef } from '../roles/service';
import { signatureFor } from '../git/signature';
import { enqueueAnalysis } from './push';
import { toRepoInfo, toUserSummary } from './serialize';
import type { Ctx } from '../../context';

/** Write a path → content map as a git tree (folders included) and return its id. */
async function writeTree(git: GitRepo, files: Record<string, string>): Promise<string> {
  type Node = { blobs: Map<string, string>; dirs: Map<string, Node> };
  const root: Node = { blobs: new Map(), dirs: new Map() };
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/');
    let n = root;
    for (const d of parts.slice(0, -1)) {
      if (!n.dirs.has(d)) n.dirs.set(d, { blobs: new Map(), dirs: new Map() });
      n = n.dirs.get(d)!;
    }
    n.blobs.set(parts.at(-1)!, await git.writeBlob(content));
  }
  const write = async (n: Node): Promise<string> => {
    const entries: { mode: string; type: 'blob' | 'tree'; oid: string; name: string }[] = [];
    for (const [name, oid] of n.blobs) entries.push({ mode: '100644', type: 'blob', oid, name });
    for (const [name, child] of n.dirs) entries.push({ mode: '040000', type: 'tree', oid: await write(child), name });
    return git.mktree(entries);
  };
  return write(root);
}

const SAMPLE_CONFIG = `# Jumper project configuration
# Every option: https://<your Jumper>/docs/jumper-yml
checks:
  erc: { enabled: true, fail_on: error }
  drc: { enabled: true, fail_on: error, schematic_parity: true }
  bom: { enabled: true }
outputs:
  svg: true
  glb: true
  gerbers: true
`;

/** `kind`: `readme` for an empty project, `sample` for the example board, or the id of a starter template. */
async function initialCommit(git: GitRepo, user: User, repo: Repository, owner: string, kind: string): Promise<void> {
  const template = findTemplate(kind);
  if (template) {
    // Templates bring their own README and .jumper.yml; files may sit in folders.
    const files: Record<string, string> = { '.gitignore': KICAD_GITIGNORE, ...template.files };
    const sha = await git.commitTree(await writeTree(git, files), [], `Start from the ${template.name} template\n`, signatureFor(user));
    await git.updateRef(`refs/heads/${repo.defaultBranch}`, sha, null);
    return;
  }
  const sample = kind === 'sample';
  const readme = sample
    ? SAMPLE_README
    : `# ${repo.name}\n\n${repo.description || 'A KiCad hardware project.'}\n\n` +
      `Clone it and add your KiCad project:\n\n\`\`\`sh\ngit clone <clone-url>\ncd ${repo.name}\n# copy your .kicad_pro / .kicad_sch / .kicad_pcb files here\ngit add . && git commit -m "Add design" && git push\n\`\`\`\n\n` +
      `Owned by ${owner}.\n`;
  const entries = [
    { mode: '100644', type: 'blob' as const, oid: await git.writeBlob(KICAD_GITIGNORE), name: '.gitignore' },
    { mode: '100644', type: 'blob' as const, oid: await git.writeBlob(SAMPLE_CONFIG), name: '.jumper.yml' },
    { mode: '100644', type: 'blob' as const, oid: await git.writeBlob(readme), name: 'README.md' },
  ];
  if (sample) {
    for (const [name, text] of Object.entries(SAMPLE_PROJECT)) entries.push({ mode: '100644', type: 'blob' as const, oid: await git.writeBlob(text), name });
    entries.sort((x, y) => (x.name < y.name ? -1 : 1));
  }
  const tree = await git.mktree(entries);
  const sha = await git.commitTree(tree, [], sample ? 'Add the example board\n' : 'Initial commit\n', signatureFor(user));
  await git.updateRef(`refs/heads/${repo.defaultBranch}`, sha, null);
}

/**
 * SQL condition for repositories `viewer` may read, for queries joining `repositories` and `namespaces`.
 * null for site admins (everything). Keep every listing and search on this one definition.
 */
export async function repoAccessCondition(ctx: Ctx, viewer: User | null) {
  // Export-controlled repositories are hidden from everyone without clearance, administrators included.
  const exportOk = viewer?.exportCleared ? sql`true` : sql`${repositories.exportControlled} = false`;
  if (viewer?.isAdmin) return exportOk;
  const uid = viewer?.id ?? '00000000-0000-0000-0000-000000000000';
  // Organizations whose rules (two-factor, address, session age, single sign-on) hold this session back:
  // their private repositories are left out, exactly as `accessFor` would decide one by one.
  const held: string[] = [];
  if (viewer) {
    const orgs = await ctx.db.select({ ns: namespaces }).from(orgMembers).innerJoin(namespaces, eq(namespaces.orgId, orgMembers.orgId)).where(eq(orgMembers.userId, viewer.id));
    for (const { ns } of orgs) if (await accessDenial(ctx, viewer, ns)) held.push(ns.id);
  }
  const notHeld = held.length ? sql`${repositories.namespaceId} not in (${sql.join(held.map((h) => sql`${h}`), sql`, `)})` : sql`true`;
  return sql`(${exportOk} and (
      ${repositories.visibility} = 'public'
      or ${namespaces.userId} = ${uid}
      or (${notHeld} and (
        exists (select 1 from ${repoCollaborators} c where c.repo_id = ${repositories.id} and c.user_id = ${uid})
        or exists (select 1 from ${orgMembers} m where m.org_id = ${namespaces.orgId} and m.user_id = ${uid})
      ))
    ))`;
}

/** Repos visible to `viewer`, optionally restricted to one namespace. */
export async function visibleRepos(
  ctx: Ctx,
  viewer: User | null,
  opts: { namespaceId?: string; q?: string; limit?: number; ids?: string[]; publicOnly?: boolean } = {},
): Promise<RepoInfo[]> {
  const conds = [];
  if (opts.ids) conds.push(opts.ids.length ? inArray(repositories.id, opts.ids) : sql`false`);
  if (opts.publicOnly) conds.push(sql`${repositories.visibility} = 'public'`);
  if (opts.namespaceId) conds.push(eq(repositories.namespaceId, opts.namespaceId));
  if (opts.q) {
    conds.push(
      sql`(to_tsvector('simple', ${repositories.name} || ' ' || ${repositories.description}) @@ plainto_tsquery('simple', ${opts.q})
           or ${repositories.name} ilike ${'%' + opts.q.replace(/[%_\\]/g, '\\$&') + '%'})`,
    );
  }
  conds.push(await repoAccessCondition(ctx, viewer));
  const rows = await ctx.db
    .select({
      repo: repositories,
      ns: namespaces,
    })
    .from(repositories)
    .innerJoin(namespaces, eq(namespaces.id, repositories.namespaceId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(sql`coalesce(${repositories.pushedAt}, ${repositories.createdAt})`))
    .limit(opts.limit ?? 100);
  const access = await accessesFor(ctx, viewer, rows);
  return rows.flatMap((r, i) => (access[i]!.permission === 'none' ? [] : [toRepoInfo(ctx, r.repo, r.ns, access[i]!.permission, { access: access[i]! })]));
}

const params = z.object({ owner: z.string().max(100), repo: z.string().max(100) });

const repoRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.get('/templates', async () => templateInfos());

  app.get('/namespaces/:owner', { schema: { params: z.object({ owner: z.string().max(100) }) } }, async (req): Promise<NamespaceInfo> => {
    const ns = await findNamespace(ctx, req.params.owner);
    if (!ns) throw notFound('User or organization not found');
    const repos = await visibleRepos(ctx, req.user, { namespaceId: ns.id });
    const byId = new Map(repos.map((r) => [r.id, r]));
    const pinned = ns.pinnedRepoIds.map((id) => byId.get(id)).filter((r): r is RepoInfo => Boolean(r));
    // Counts public work only, so it reads the same for every visitor.
    const stats = { repos: repos.filter((r) => r.visibility === 'public').length };
    if (ns.kind === 'user') {
      const u = (await ctx.db.select().from(users).where(eq(users.id, ns.userId!)).limit(1))[0]!;
      return {
        slug: ns.slug,
        kind: 'user',
        name: u.name,
        bio: u.bio,
        avatarUrl: u.avatarUrl,
        website: u.website,
        location: u.location,
        company: u.company,
        pronouns: u.pronouns,
        createdAt: u.createdAt.toISOString(),
        repos,
        pinned,
        stats,
      };
    }
    const org = (await ctx.db.select().from(organizations).where(eq(organizations.id, ns.orgId!)).limit(1))[0]!;
    const members = await ctx.db
      .select({ user: users, role: orgMembers.role })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(eq(orgMembers.orgId, org.id));
    return {
      slug: ns.slug,
      kind: 'org',
      name: org.name,
      bio: org.description,
      avatarUrl: org.avatarUrl,
      createdAt: org.createdAt.toISOString(),
      repos,
      pinned,
      stats,
      members: members.map((m) => ({ ...toUserSummary(m.user), role: m.role })),
    };
  });

  // Pin up to six repositories to the top of a profile, in order. Only the owner's own repositories can be pinned.
  app.put('/namespaces/:owner/pins', { schema: { params: z.object({ owner: z.string().max(100) }), body: pinsSchema } }, async (req) => {
    const user = requireUser(req);
    const ns = await findNamespace(ctx, req.params.owner);
    if (!ns) throw notFound('User or organization not found');
    if (!(await canManageNamespace(ctx, user, ns))) throw forbidden();
    const names = [...new Set(req.body.repos.map((n) => n.toLowerCase()))];
    const rows = names.length ? await ctx.db.select({ id: repositories.id, name: repositories.name }).from(repositories).where(and(eq(repositories.namespaceId, ns.id), inArray(sql`lower(${repositories.name})`, names))) : [];
    const ids = names.map((n) => rows.find((r) => r.name.toLowerCase() === n)?.id).filter((x): x is string => Boolean(x));
    if (ids.length !== names.length) throw badRequest(`Not a repository of ${ns.slug}: ${names.filter((n) => !rows.some((r) => r.name.toLowerCase() === n)).join(', ')}`);
    await ctx.db.update(namespaces).set({ pinnedRepoIds: ids }).where(eq(namespaces.id, ns.id));
    return { ok: true };
  });

  app.get(
    '/repos',
    {
      schema: {
        querystring: z.object({
          q: z.string().max(200).optional(),
          mine: z.stringbool().optional(),
        }),
      },
    },
    async (req) => {
    if (req.query.mine) {
      const user = requireUser(req);
      const all = await visibleRepos(ctx, user, { limit: 200 });
      return all.filter((r) => r.permission !== 'read' || r.owner.toLowerCase() === user.username.toLowerCase());
    }
    return visibleRepos(ctx, req.user, { q: req.query.q, limit: 50 });
    },
  );

  app.post('/repos', { schema: { body: createRepoSchema } }, async (req) => {
    const user = requireUser(req);
    requireScope(req, 'repo:write');
    const ownerSlug = req.body.owner || user.username;
    const ns = await findNamespace(ctx, ownerSlug);
    if (!ns) throw notFound('Owner not found');
    if (!(await canManageNamespace(ctx, user, ns))) throw forbidden('You cannot create repositories for this owner');
    if (await findRepo(ctx, ns.slug, req.body.name)) throw conflict('A repository with that name already exists');
    if (req.body.template && !findTemplate(req.body.template)) throw badRequest('Unknown template');

    const [repo] = await ctx.db
      .insert(repositories)
      .values({ namespaceId: ns.id, name: req.body.name, description: req.body.description, visibility: req.body.visibility })
      .returning();
    const git = await GitRepo.init(repoDiskPath(ctx, repo!.id), repo!.defaultBranch).catch(async (e) => {
      await ctx.db.delete(repositories).where(eq(repositories.id, repo!.id));
      throw e;
    });
    let current = repo!;
    const start = req.body.template ?? (req.body.sample ? 'sample' : req.body.initReadme ? 'readme' : null);
    if (start) {
      await initialCommit(git, user, repo!, ns.slug, start);
      const [updated] = await ctx.db.update(repositories).set({ pushedAt: new Date() }).where(eq(repositories.id, repo!.id)).returning();
      current = updated!;
      const sha = await git.resolveBranch(repo!.defaultBranch);
      if (sha) await enqueueAnalysis(ctx, repo!.id, sha, repo!.defaultBranch).catch((e) => req.log.warn(e, 'enqueue failed'));
    }
    await audit(req, 'repo.create', { type: 'repo', id: repo!.id }, { name: `${ns.slug}/${repo!.name}` });
    return toRepoInfo(ctx, current, ns, 'admin', { isEmpty: !start });
  });

  // Fill an empty repository from its own page: a starter README (plus .gitignore and .jumper.yml), or the example board.
  app.post(
    '/repos/:owner/:repo/initialize',
    { schema: { params, body: z.object({ kind: z.string().max(40) }) } },
    async (req) => {
      const user = requireUser(req);
      requireScope(req, 'repo:write');
      const r = await loadRepo(req, req.params.owner, req.params.repo, 'write');
      if (!(await r.git.isEmpty())) throw conflict('This repository already has commits');
      if (req.body.kind !== 'readme' && req.body.kind !== 'sample' && !findTemplate(req.body.kind)) throw badRequest('Unknown template');
      // updateRef with a null old value fails if a push landed in the meantime, so a real push always wins.
      await initialCommit(r.git, user, r.repo, r.ns.slug, req.body.kind);
      const [updated] = await ctx.db.update(repositories).set({ pushedAt: new Date() }).where(eq(repositories.id, r.repo.id)).returning();
      const sha = await r.git.resolveBranch(r.repo.defaultBranch);
      if (sha) await enqueueAnalysis(ctx, r.repo.id, sha, r.repo.defaultBranch).catch((e) => req.log.warn(e, 'enqueue failed'));
      await audit(req, 'repo.initialize', { type: 'repo', id: r.repo.id }, { kind: req.body.kind });
      return toRepoInfo(ctx, updated!, r.ns, r.permission, { isEmpty: false });
    },
  );

  app.get('/repos/:owner/:repo', { schema: { params } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo);
    return toRepoInfo(ctx, r.repo, r.ns, r.permission, { isEmpty: await r.git.isEmpty(), access: r, legalHold: Boolean(await holdOnRepo(ctx, r.repo)) });
  });

  app.patch('/repos/:owner/:repo', { schema: { params, body: updateRepoSchema } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const patch: Partial<Repository> = { updatedAt: new Date() };
    const b = req.body;
    if (b.name && b.name.toLowerCase() !== r.repo.name.toLowerCase()) {
      if (await findRepo(ctx, r.ns.slug, b.name)) throw conflict('A repository with that name already exists');
    }
    if (b.name) patch.name = b.name;
    if (b.description !== undefined) patch.description = b.description;
    if (b.visibility) patch.visibility = b.visibility;
    if (b.exportControlled !== undefined && b.exportControlled !== r.repo.exportControlled) {
      // Marking is an administrator's decision (they also decide who is cleared), and it cannot be undone by the owner.
      if (!req.user?.isAdmin) throw forbidden('Only an instance administrator can change the export-control flag');
      patch.exportControlled = b.exportControlled;
    }
    if ((patch.exportControlled ?? r.repo.exportControlled) && (patch.visibility ?? r.repo.visibility) === 'public') {
      if (b.visibility === 'public') throw badRequest('An export-controlled repository cannot be public');
      patch.visibility = 'private';
    }
    if (b.requiredApprovals !== undefined) patch.requiredApprovals = b.requiredApprovals;
    if (b.defaultBranch) {
      if (!(await r.git.resolveBranch(b.defaultBranch))) throw badRequest('Branch does not exist');
      await r.git.setHead(b.defaultBranch);
      patch.defaultBranch = b.defaultBranch;
    }
    const [updated] = await ctx.db.update(repositories).set(patch).where(eq(repositories.id, r.repo.id)).returning();
    await audit(req, 'repo.update', { type: 'repo', id: r.repo.id }, b);
    return toRepoInfo(ctx, updated!, r.ns, r.permission);
  });

  app.delete('/repos/:owner/:repo', { schema: { params } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    await assertRepoNotHeld(ctx, r.repo);
    await ctx.db.delete(repositories).where(eq(repositories.id, r.repo.id));
    await purgeRepoData(ctx, [r.repo.id]);
    await audit(req, 'repo.delete', { type: 'repo', id: r.repo.id }, { name: `${r.ns.slug}/${r.repo.name}` });
    return { ok: true };
  });

  // ---------- collaborators ----------

  app.get('/repos/:owner/:repo/collaborators', { schema: { params } }, async (req) => {
    const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
    const rows = await ctx.db
      .select({ user: users, role: repoCollaborators.role, custom: customRoles })
      .from(repoCollaborators)
      .innerJoin(users, eq(users.id, repoCollaborators.userId))
      .leftJoin(customRoles, eq(customRoles.id, repoCollaborators.customRoleId))
      .where(eq(repoCollaborators.repoId, r.repo.id));
    return rows.map((x) => ({ ...toUserSummary(x.user), role: x.custom ? x.custom.base : x.role, customRole: x.custom ? { id: x.custom.id, name: x.custom.name } : null }));
  });

  app.put(
    '/repos/:owner/:repo/collaborators/:username',
    { schema: { params: params.extend({ username: z.string().max(100) }), body: collaboratorSchema } },
    async (req) => {
      const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
      const target = (await ctx.db.select().from(users).where(sql`lower(${users.username}) = lower(${req.params.username})`).limit(1))[0];
      if (!target) throw notFound('User not found');
      if (r.repo.exportControlled && !target.exportCleared) throw badRequest(`${target.username} is not cleared for export-controlled work. An administrator has to clear them first.`);
      const grant = await resolveRoleRef(ctx, r.ns, req.body.role);
      await ctx.db
        .insert(repoCollaborators)
        .values({ repoId: r.repo.id, userId: target.id, ...grant })
        .onConflictDoUpdate({ target: [repoCollaborators.repoId, repoCollaborators.userId], set: grant });
      await audit(req, 'repo.collaborator.set', { type: 'repo', id: r.repo.id }, { user: target.username, role: req.body.role });
      return { ok: true };
    },
  );

  app.delete(
    '/repos/:owner/:repo/collaborators/:username',
    { schema: { params: params.extend({ username: z.string().max(100) }) } },
    async (req) => {
      const r = await loadRepo(req, req.params.owner, req.params.repo, 'admin');
      const target = (await ctx.db.select().from(users).where(sql`lower(${users.username}) = lower(${req.params.username})`).limit(1))[0];
      if (!target) throw notFound('User not found');
      await ctx.db.delete(repoCollaborators).where(and(eq(repoCollaborators.repoId, r.repo.id), eq(repoCollaborators.userId, target.id)));
      await audit(req, 'repo.collaborator.remove', { type: 'repo', id: r.repo.id }, { user: target.username });
      return { ok: true };
    },
  );
};

export default repoRoutes;
