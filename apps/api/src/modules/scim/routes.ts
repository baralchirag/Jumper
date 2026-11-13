// SCIM 2.0 (RFC 7643/7644) so a company directory (Okta, Entra ID, JumpCloud, ...) creates, updates and deactivates
// accounts here by itself. Users map to accounts; Groups map to organizations, whose membership the directory can manage.
// Deleting a user through SCIM deactivates the account and signs it out; nothing they made is removed.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, namespaces, orgMembers, organizations, scimTokens, sessions, personalAccessTokens, sql, users, type User } from '@jumper/db';
import { sha256 } from '../../lib/crypto';
import { HttpError } from '../../lib/errors';
import { audit } from '../audit/audit';
import { createUser } from '../auth/routes';
import { SCIM_TOKEN_PREFIX } from '../instance/routes';
import { hasFeature } from '../license/license';
import { findNamespace } from '../repos/access';
import { assertOrgSeat } from '../usage/service';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

class ScimError extends HttpError {
  constructor(status: number, detail: string, readonly scimType?: string) {
    super(status, 'scim', detail);
  }
}

type Json = Record<string, unknown>;

/** `userName eq "ada"` style filters: the only form directories use to look someone up before creating them. */
export function parseFilter(filter: string | undefined): { attr: string; value: string } | null {
  if (!filter) return null;
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(filter);
  if (!m) throw new ScimError(400, 'Only filters of the form `attribute eq "value"` are supported', 'invalidFilter');
  return { attr: m[1]!.toLowerCase(), value: m[2]!.replace(/\\(.)/g, '$1') };
}

function primaryEmail(body: Json): string | null {
  const emails = Array.isArray(body.emails) ? (body.emails as Json[]) : [];
  const pick = emails.find((e) => e.primary === true) ?? emails[0];
  const v = typeof pick?.value === 'string' ? pick.value : typeof body.userName === 'string' && body.userName.includes('@') ? body.userName : null;
  return v ? v.trim().toLowerCase() : null;
}

function displayName(body: Json): string | null {
  if (typeof body.displayName === 'string' && body.displayName.trim()) return body.displayName.trim().slice(0, 100);
  const n = body.name as Json | undefined;
  if (n && typeof n.formatted === 'string' && n.formatted.trim()) return n.formatted.trim().slice(0, 100);
  const parts = [n?.givenName, n?.familyName].filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return parts.length ? parts.join(' ').slice(0, 100) : null;
}

const scimRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const base = () => `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/api/scim/v2`;

  app.addContentTypeParser('application/scim+json', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new ScimError(400, 'The request body is not valid JSON', 'invalidSyntax'));
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : ((err as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500) app.log.error(err);
    return reply
      .code(status)
      .type('application/scim+json')
      .send({ schemas: [ERROR], status: String(status), detail: status >= 500 ? 'Something went wrong' : (err as Error).message, ...(err instanceof ScimError && err.scimType ? { scimType: err.scimType } : {}) });
  });

  app.addHook('onRequest', async (req) => {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ', 2);
    if (!/^bearer$/i.test(scheme ?? '') || !token?.startsWith(SCIM_TOKEN_PREFIX)) throw new ScimError(401, 'A provisioning token is required. Create one in Admin, Directory sync.');
    const row = (await ctx.db.select().from(scimTokens).where(eq(scimTokens.tokenHash, sha256(token))).limit(1))[0];
    if (!row) throw new ScimError(401, 'That provisioning token is not valid');
    if (!(await hasFeature(ctx, null, 'scim'))) throw new ScimError(403, 'SCIM provisioning is part of Enterprise and is not included in this instance\'s licence');
    void ctx.db.update(scimTokens).set({ lastUsedAt: new Date() }).where(eq(scimTokens.id, row.id)).catch(() => {});
  });

  const send = (reply: FastifyReply, body: unknown, status = 200) => reply.code(status).type('application/scim+json').send(body);

  const toScimUser = (u: User): Json => ({
    schemas: [USER_SCHEMA],
    id: u.id,
    externalId: u.externalId ?? undefined,
    userName: u.username,
    displayName: u.name ?? u.username,
    name: { formatted: u.name ?? u.username },
    emails: [{ value: u.email, primary: true }],
    active: !u.disabled,
    meta: { resourceType: 'User', created: u.createdAt.toISOString(), lastModified: u.updatedAt.toISOString(), location: `${base()}/Users/${u.id}` },
  });

  const findUser = async (id: string): Promise<User> => {
    const u = /^[0-9a-f-]{36}$/i.test(id) ? (await ctx.db.select().from(users).where(eq(users.id, id)).limit(1))[0] : undefined;
    if (!u || u.username === 'ghost') throw new ScimError(404, `User ${id} not found`);
    return u;
  };

  /** Deactivating signs the person out everywhere and stops their tokens; reactivating does not restore sessions. */
  const setActive = async (req: FastifyRequest, u: User, active: boolean): Promise<void> => {
    if (active === !u.disabled) return;
    if (!active && u.isAdmin) {
      const [{ n }] = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.isAdmin, true), eq(users.disabled, false)))) as [{ n: number }];
      if (n <= 1) throw new ScimError(409, 'The last administrator cannot be deactivated through the directory');
    }
    await ctx.db.update(users).set({ disabled: !active, updatedAt: new Date() }).where(eq(users.id, u.id));
    if (!active) {
      await ctx.db.delete(sessions).where(eq(sessions.userId, u.id));
      await ctx.db.delete(personalAccessTokens).where(eq(personalAccessTokens.userId, u.id));
    }
    await audit(req, active ? 'scim.user.activate' : 'scim.user.deactivate', { type: 'user', id: u.id }, { username: u.username });
  };

  const pageParams = (q: Json) => ({ start: Math.max(1, Number(q.startIndex) || 1), count: Math.min(200, Math.max(0, q.count === undefined ? 100 : Number(q.count) || 0)) });

  // ---------- discovery ----------

  app.get('/ServiceProviderConfig', async (_req, reply) =>
    send(reply, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'A provisioning token created in Admin, Directory sync', primary: true }],
      meta: { resourceType: 'ServiceProviderConfig', location: `${base()}/ServiceProviderConfig` },
    }),
  );

  app.get('/ResourceTypes', async (_req, reply) =>
    send(reply, {
      schemas: [LIST],
      totalResults: 2,
      Resources: [
        { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER_SCHEMA },
        { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP_SCHEMA },
      ],
    }),
  );

  app.get('/Schemas', async (_req, reply) =>
    send(reply, {
      schemas: [LIST],
      totalResults: 2,
      Resources: [
        { id: USER_SCHEMA, name: 'User', attributes: ['userName', 'externalId', 'displayName', 'name', 'emails', 'active'].map((name) => ({ name, mutability: 'readWrite' })) },
        { id: GROUP_SCHEMA, name: 'Group', attributes: [{ name: 'displayName', mutability: 'readOnly' }, { name: 'members', mutability: 'readWrite' }] },
      ],
    }),
  );

  // ---------- users ----------

  app.get('/Users', async (req, reply) => {
    const q = req.query as Json;
    const f = parseFilter(typeof q.filter === 'string' ? q.filter : undefined);
    const { start, count } = pageParams(q);
    const where =
      f === null
        ? sql`${users.username} <> 'ghost'`
        : f.attr === 'username'
          ? sql`lower(${users.username}) = lower(${f.value})`
          : f.attr === 'externalid'
            ? eq(users.externalId, f.value)
            : f.attr === 'emails.value' || f.attr === 'emails'
              ? sql`lower(${users.email}) = lower(${f.value})`
              : null;
    if (where === null) throw new ScimError(400, `Filtering on ${f!.attr} is not supported`, 'invalidFilter');
    const [{ n }] = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(users).where(where)) as [{ n: number }];
    const rows = count ? await ctx.db.select().from(users).where(where).orderBy(users.createdAt).limit(count).offset(start - 1) : [];
    return send(reply, { schemas: [LIST], totalResults: n, startIndex: start, itemsPerPage: rows.length, Resources: rows.map(toScimUser) });
  });

  app.get('/Users/:id', async (req, reply) => send(reply, toScimUser(await findUser((req.params as { id: string }).id))));

  app.post('/Users', async (req, reply) => {
    const body = (req.body ?? {}) as Json;
    const email = primaryEmail(body);
    if (typeof body.userName !== 'string' || !body.userName.trim()) throw new ScimError(400, 'userName is required', 'invalidValue');
    if (!email) throw new ScimError(400, 'An email address is required (emails[0].value)', 'invalidValue');
    const existing = (await ctx.db.select().from(users).where(sql`lower(${users.email}) = lower(${email})`).limit(1))[0];
    if (existing) throw new ScimError(409, `An account for ${email} already exists`, 'uniqueness');
    // Directories often use the email address as userName; ours must be a short handle.
    const wanted = body.userName.split('@')[0]!.replace(/[^a-zA-Z0-9-]/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 35) || 'user';
    let username = wanted.length < 2 ? `${wanted}-user` : wanted;
    for (let i = 2; await findNamespace(ctx, username); i++) username = `${wanted}-${i}`;
    const user = await createUser(ctx, { username, email, passwordHash: null, name: displayName(body), emailVerified: true, externalId: typeof body.externalId === 'string' ? body.externalId : null, scimManaged: true }).catch((e) => {
      throw e instanceof HttpError ? new ScimError(e.statusCode, e.message, e.statusCode === 409 ? 'uniqueness' : undefined) : e;
    });
    await audit(req, 'scim.user.create', { type: 'user', id: user.id }, { username });
    if (body.active === false) await setActive(req, user, false);
    return send(reply.header('Location', `${base()}/Users/${user.id}`), toScimUser((await findUser(user.id))), 201);
  });

  const applyAttributes = async (req: FastifyRequest, u: User, body: Json): Promise<void> => {
    const set: Partial<User> = {};
    const name = displayName(body);
    if (name && name !== u.name) set.name = name;
    if (typeof body.externalId === 'string' && body.externalId !== u.externalId) set.externalId = body.externalId;
    const email = primaryEmail(body);
    if (email && email !== u.email.toLowerCase()) {
      const taken = (await ctx.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${email})`).limit(1))[0];
      if (taken && taken.id !== u.id) throw new ScimError(409, `Another account already uses ${email}`, 'uniqueness');
      set.email = email;
      set.emailVerifiedAt = new Date();
    }
    if (Object.keys(set).length) await ctx.db.update(users).set({ ...set, scimManaged: true, updatedAt: new Date() }).where(eq(users.id, u.id));
    if (typeof body.active === 'boolean') await setActive(req, u, body.active);
  };

  app.put('/Users/:id', async (req, reply) => {
    const u = await findUser((req.params as { id: string }).id);
    await applyAttributes(req, u, (req.body ?? {}) as Json);
    return send(reply, toScimUser(await findUser(u.id)));
  });

  app.patch('/Users/:id', async (req, reply) => {
    const u = await findUser((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { schemas?: string[]; Operations?: { op?: string; path?: string; value?: unknown }[] };
    if (!body.schemas?.includes(PATCH) || !Array.isArray(body.Operations)) throw new ScimError(400, 'Expected a PatchOp message', 'invalidSyntax');
    const merged: Json = {};
    for (const op of body.Operations) {
      const kind = (op.op ?? '').toLowerCase();
      if (kind !== 'replace' && kind !== 'add') continue;
      if (!op.path && op.value && typeof op.value === 'object') Object.assign(merged, op.value as Json);
      else if (op.path) {
        const path = op.path.toLowerCase();
        // Entra ID sends "active" as the strings "True" / "False".
        if (path === 'active') merged.active = typeof op.value === 'string' ? op.value.toLowerCase() === 'true' : Boolean(op.value);
        else if (path === 'displayname') merged.displayName = op.value;
        else if (path === 'externalid') merged.externalId = op.value;
        else if (path === 'name.formatted') merged.name = { formatted: op.value };
        else if (path.startsWith('emails')) merged.emails = [{ value: typeof op.value === 'string' ? op.value : ((op.value as Json[] | undefined)?.[0]?.value ?? null), primary: true }];
      }
    }
    if (typeof merged.active === 'string') merged.active = (merged.active as string).toLowerCase() === 'true';
    await applyAttributes(req, u, merged);
    return send(reply, toScimUser(await findUser(u.id)));
  });

  app.delete('/Users/:id', async (req, reply) => {
    const u = await findUser((req.params as { id: string }).id);
    await setActive(req, u, false);
    return reply.code(204).send();
  });

  // ---------- groups (organizations) ----------

  const toGroup = async (ns: { slug: string; orgId: string | null }, org: { id: string; name: string; createdAt: Date }): Promise<Json> => {
    const members = await ctx.db.select({ id: users.id, username: users.username }).from(orgMembers).innerJoin(users, eq(users.id, orgMembers.userId)).where(eq(orgMembers.orgId, org.id));
    return {
      schemas: [GROUP_SCHEMA],
      id: org.id,
      displayName: ns.slug,
      members: members.map((m) => ({ value: m.id, display: m.username, $ref: `${base()}/Users/${m.id}` })),
      meta: { resourceType: 'Group', created: org.createdAt.toISOString(), location: `${base()}/Groups/${org.id}` },
    };
  };

  const findGroup = async (id: string) => {
    const row = /^[0-9a-f-]{36}$/i.test(id)
      ? (await ctx.db.select({ org: organizations, ns: namespaces }).from(organizations).innerJoin(namespaces, eq(namespaces.orgId, organizations.id)).where(eq(organizations.id, id)).limit(1))[0]
      : undefined;
    if (!row) throw new ScimError(404, `Group ${id} not found`);
    return row;
  };

  app.get('/Groups', async (req, reply) => {
    const q = req.query as Json;
    const f = parseFilter(typeof q.filter === 'string' ? q.filter : undefined);
    if (f && f.attr !== 'displayname') throw new ScimError(400, `Filtering on ${f.attr} is not supported`, 'invalidFilter');
    const rows = await ctx.db
      .select({ org: organizations, ns: namespaces })
      .from(organizations)
      .innerJoin(namespaces, eq(namespaces.orgId, organizations.id))
      .where(f ? sql`lower(${namespaces.slug}) = lower(${f.value})` : undefined)
      .orderBy(namespaces.slug)
      .limit(200);
    return send(reply, { schemas: [LIST], totalResults: rows.length, startIndex: 1, itemsPerPage: rows.length, Resources: await Promise.all(rows.map((r) => toGroup(r.ns, r.org))) });
  });

  app.get('/Groups/:id', async (req, reply) => {
    const g = await findGroup((req.params as { id: string }).id);
    return send(reply, await toGroup(g.ns, g.org));
  });

  app.post('/Groups', async () => {
    throw new ScimError(501, 'Organizations are created in Jumper; the directory manages who belongs to them');
  });

  const addMember = async (g: Awaited<ReturnType<typeof findGroup>>, userId: string) => {
    const u = await findUser(userId);
    await assertOrgSeat(ctx, g.ns, u.id).catch((e: Error) => {
      throw new ScimError(409, e.message);
    });
    await ctx.db.insert(orgMembers).values({ orgId: g.org.id, userId: u.id, role: 'member' }).onConflictDoNothing();
  };

  const removeMember = async (g: Awaited<ReturnType<typeof findGroup>>, userId: string) => {
    const owners = await ctx.db.select({ userId: orgMembers.userId }).from(orgMembers).where(and(eq(orgMembers.orgId, g.org.id), eq(orgMembers.role, 'owner')));
    // The directory never removes the last owner: an organization nobody can run helps no one.
    if (owners.length === 1 && owners[0]!.userId === userId) return;
    await ctx.db.delete(orgMembers).where(and(eq(orgMembers.orgId, g.org.id), eq(orgMembers.userId, userId)));
  };

  app.patch('/Groups/:id', async (req, reply) => {
    const g = await findGroup((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { Operations?: { op?: string; path?: string; value?: unknown }[] };
    if (!Array.isArray(body.Operations)) throw new ScimError(400, 'Expected a PatchOp message', 'invalidSyntax');
    for (const op of body.Operations) {
      const kind = (op.op ?? '').toLowerCase();
      const path = (op.path ?? '').toLowerCase();
      const values = (Array.isArray(op.value) ? op.value : op.value && typeof op.value === 'object' && Array.isArray((op.value as Json).members) ? ((op.value as Json).members as unknown[]) : []) as { value?: string }[];
      const ids = values.map((v) => v.value).filter((v): v is string => typeof v === 'string');
      if (kind === 'add' && (path === 'members' || !path)) for (const id of ids) await addMember(g, id);
      else if (kind === 'remove' && path.startsWith('members')) {
        const one = /members\[value eq "([^"]+)"\]/i.exec(op.path ?? '')?.[1];
        for (const id of one ? [one] : ids) await removeMember(g, id);
      } else if (kind === 'replace' && (path === 'members' || !path) && ids.length) {
        const current = (await ctx.db.select({ userId: orgMembers.userId }).from(orgMembers).where(eq(orgMembers.orgId, g.org.id))).map((m) => m.userId);
        for (const id of ids.filter((x) => !current.includes(x))) await addMember(g, id);
        for (const id of current.filter((x) => !ids.includes(x))) await removeMember(g, id);
      }
    }
    await audit(req, 'scim.group.update', { type: 'org', id: g.org.id }, { operations: body.Operations.length }, undefined, g.ns.id);
    return send(reply, await toGroup(g.ns, g.org));
  });
};

export default scimRoutes;
