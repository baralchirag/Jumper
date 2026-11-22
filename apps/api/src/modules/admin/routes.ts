import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditLog, desc, eq, sql, users } from '@jumper/db';
import type { AdminOverview, AdminTableInfo, AdminTablePage } from '@jumper/shared';
import { requireUser } from '../auth/plugin';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { createResetToken, resetUrl } from '../auth/reset-routes';
import { deleteUserAccount, deletionPreview, GHOST_USERNAME } from '../user/deletion';
import { audit } from '../audit/audit';
import { toUserSummary } from '../repos/serialize';

/**
 * Columns that hold secrets. They are listed but their values are never sent. Anything whose name looks like a
 * secret is hidden by rule, so a new table can't leak by being forgotten here; the list adds columns the rule misses.
 */
const HIDDEN: Record<string, string[]> = {
  sessions: ['id'],
  sso_connections: ['config'],
  instance_settings: ['value'],
};
const SECRET_NAME = /(secret|token|hash|password|totp|recovery|private_key|api_key)/i;

const isHidden = (table: string, column: string) => SECRET_NAME.test(column) || (HIDDEN[table]?.includes(column) ?? false);

/** Cap long cell values so a jsonb blob or a log cannot blow up the response. */
function clip(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return v.length > 600 ? `${v.slice(0, 600)}… (${v.length} chars)` : v;
  if (Buffer.isBuffer(v)) return `<${v.length} bytes>`;
  if (v && typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 600 ? `${s.slice(0, 600)}… (${s.length} chars)` : v;
  }
  return v;
}

/** Instance administration: web session of an admin only, never API tokens. */
export async function adminOnly(req: FastifyRequest): Promise<void> {
  const allow = req.server.ctx.env.adminAllowedIps;
  if (allow.length > 0 && !allow.includes(req.ip)) throw forbidden('Administration is not available from this network');
  const user = requireUser(req);
  if (req.authMethod === 'token') throw forbidden('Use the web session for administration');
  if (!user.isAdmin) throw forbidden('Administrators only');
}

const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  app.addHook('onRequest', adminOnly);

  async function columnsByTable() {
    const rows = (await ctx.db.execute(sql`
      select table_name, column_name, data_type, udt_name, is_nullable
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position
    `)) as unknown as { table_name: string; column_name: string; data_type: string; udt_name: string; is_nullable: string }[];
    const m = new Map<string, AdminTableInfo['columns']>();
    for (const r of rows) {
      const type = r.data_type === 'USER-DEFINED' ? r.udt_name : r.data_type === 'ARRAY' ? `${r.udt_name.replace(/^_/, '')}[]` : r.data_type;
      m.set(r.table_name, [...(m.get(r.table_name) ?? []), { name: r.column_name, type, nullable: r.is_nullable === 'YES', hidden: isHidden(r.table_name, r.column_name) }]);
    }
    return m;
  }

  app.get('/overview', async (): Promise<AdminOverview> => {
    const [c] = (await ctx.db.execute(sql`
      select
        (select count(*)::int from users) as users,
        (select count(*)::int from organizations) as orgs,
        (select count(*)::int from repositories) as repos,
        (select count(*)::int from check_runs) as checks,
        (select count(*)::int from artifacts) as artifacts,
        (select count(*)::int from sessions where expires_at > now()) as sessions,
        (select coalesce(sum(size), 0)::bigint from artifacts) as storage_bytes,
        (select coalesce(sum(size_bytes), 0)::bigint from repositories) as repo_bytes,
        pg_database_size(current_database())::bigint as db_bytes,
        version() as pg_version
    `)) as unknown as Record<string, number | string>[];
    const checks = (await ctx.db.execute(sql`
      select status::text as status, conclusion::text as conclusion, count(*)::int as n from check_runs group by 1, 2 order by 3 desc
    `)) as unknown as { status: string; conclusion: string | null; n: number }[];
    const recent = await ctx.db.select().from(users).orderBy(desc(users.createdAt)).limit(8);
    const log = await ctx.db
      .select({ a: auditLog, u: users })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .orderBy(desc(auditLog.createdAt))
      .limit(12);
    return {
      counts: {
        users: Number(c!.users),
        orgs: Number(c!.orgs),
        repos: Number(c!.repos),
        checks: Number(c!.checks),
        artifacts: Number(c!.artifacts),
        sessions: Number(c!.sessions),
      },
      checks: [...checks],
      storageBytes: Number(c!.storage_bytes),
      repoBytes: Number(c!.repo_bytes),
      dbBytes: Number(c!.db_bytes),
      recentUsers: recent.map((u) => ({ ...toUserSummary(u), createdAt: u.createdAt.toISOString(), isAdmin: u.isAdmin, disabled: u.disabled })),
      recentAudit: log.map(({ a, u }) => ({
        id: a.id,
        action: a.action,
        targetType: a.targetType,
        targetId: a.targetId,
        metadata: a.metadata,
        ip: a.ip,
        createdAt: a.createdAt.toISOString(),
        actor: u ? toUserSummary(u) : null,
      })),
      version: { node: process.version, postgres: String(c!.pg_version).split(' ').slice(0, 2).join(' ') },
    };
  });

  app.get('/tables', async (): Promise<AdminTableInfo[]> => {
    const cols = await columnsByTable();
    const stats = (await ctx.db.execute(sql`
      select c.relname as name, greatest(c.reltuples, 0)::bigint as estimate, pg_total_relation_size(c.oid)::bigint as bytes
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    `)) as unknown as { name: string; estimate: string; bytes: string }[];
    const out: AdminTableInfo[] = [];
    for (const s of stats) {
      // Exact counts are cheap at self-hosted scale and avoid the "-1 before ANALYZE" estimate.
      const [{ n }] = (await ctx.db.execute(sql`select count(*)::int as n from ${sql.identifier(s.name)}`)) as unknown as [{ n: number }];
      out.push({ name: s.name, rows: n, bytes: Number(s.bytes), columns: cols.get(s.name) ?? [] });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  });

  app.get(
    '/tables/:name',
    {
      schema: {
        params: z.object({ name: z.string().max(63) }),
        querystring: z.object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
          q: z.string().max(200).optional(),
          sort: z.string().max(63).optional(),
          dir: z.enum(['asc', 'desc']).default('desc'),
        }),
      },
    },
    async (req): Promise<AdminTablePage> => {
      const cols = (await columnsByTable()).get(req.params.name);
      if (!cols) throw notFound('No such table');
      const { page, pageSize, q, dir } = req.query;
      const sortCol = req.query.sort ?? (cols.some((c) => c.name === 'created_at') ? 'created_at' : (cols.find((c) => !c.hidden) ?? cols[0]!).name);
      // Sorting by a hidden column would leak the order of secret values; it is refused like an unknown one.
      if (!cols.some((c) => c.name === sortCol && !c.hidden)) throw badRequest('Unknown sort column');
      const t = sql.identifier(req.params.name);
      // Search matches any visible column's text form.
      const visible = cols.filter((c) => !c.hidden);
      const where = q
        ? sql`where (${sql.join(
            visible.map((c) => sql`${sql.identifier(c.name)}::text ilike ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'}`),
            sql` or `,
          )})`
        : sql``;
      const [{ n }] = (await ctx.db.execute(sql`select count(*)::int as n from ${t} ${where}`)) as unknown as [{ n: number }];
      const rows = (await ctx.db.execute(
        sql`select * from ${t} ${where} order by ${sql.identifier(sortCol)} ${dir === 'asc' ? sql`asc` : sql`desc`} nulls last limit ${pageSize} offset ${(page - 1) * pageSize}`,
      )) as unknown as Record<string, unknown>[];
      return {
        table: req.params.name,
        columns: cols.map((c) => ({ name: c.name, type: c.type, hidden: c.hidden })),
        rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c.name, c.hidden ? null : clip(r[c.name])]))),
        total: n,
        page,
        pageSize,
      };
    },
  );

  app.get('/users', { schema: { querystring: z.object({ q: z.string().max(100).optional() }) } }, async (req) => {
    const q = req.query.q?.trim();
    const rows = (await ctx.db.execute(sql`
      select u.id, u.username, u.name, u.avatar_url, u.email, u.is_admin, u.disabled, u.email_verified_at, u.created_at, u.export_cleared, u.totp_enabled_at, u.scim_managed,
        (select count(*)::int from repositories r join namespaces n on n.id = r.namespace_id where n.user_id = u.id) as repos,
        (select max(s.created_at) from sessions s where s.user_id = u.id) as last_sign_in
      from users u
      ${q ? sql`where u.username ilike ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'} or u.email ilike ${'%' + q.replace(/[%_\\]/g, '\\$&') + '%'}` : sql``}
      order by u.created_at desc
      limit 200
    `)) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      username: r.username as string,
      name: (r.name as string | null) ?? null,
      avatarUrl: (r.avatar_url as string | null) ?? null,
      email: r.email as string,
      isAdmin: r.is_admin as boolean,
      disabled: r.disabled as boolean,
      emailVerified: r.email_verified_at !== null,
      exportCleared: r.export_cleared as boolean,
      twoFactor: r.totp_enabled_at !== null,
      scimManaged: r.scim_managed as boolean,
      repos: r.repos as number,
      createdAt: new Date(r.created_at as string).toISOString(),
      lastSignIn: r.last_sign_in ? new Date(r.last_sign_in as string).toISOString() : null,
    }));
  });

  app.patch(
    '/users/:id',
    { schema: { params: z.object({ id: z.uuid() }), body: z.object({ isAdmin: z.boolean().optional(), disabled: z.boolean().optional(), emailVerified: z.boolean().optional() }) } },
    async (req) => {
      const me = requireUser(req);
      if (req.params.id === me.id) throw badRequest('You cannot change your own admin status');
      const { emailVerified, ...rest } = req.body;
      const [u] = await ctx.db
        .update(users)
        .set({ ...rest, ...(emailVerified === undefined ? {} : { emailVerifiedAt: emailVerified ? new Date() : null }), updatedAt: new Date() })
        .where(eq(users.id, req.params.id))
        .returning();
      if (!u) throw notFound();
      await audit(req, 'admin.user_update', { type: 'user', id: u.id }, req.body);
      return { ...toUserSummary(u), isAdmin: u.isAdmin, disabled: u.disabled, emailVerified: u.emailVerifiedAt !== null };
    },
  );

  // For instances without email: hand the user a one-time reset link yourself.
  app.post('/users/:id/reset-link', { schema: { params: z.object({ id: z.uuid() }) } }, async (req) => {
    const target = (await ctx.db.select().from(users).where(eq(users.id, req.params.id)).limit(1))[0];
    if (!target || target.username === GHOST_USERNAME) throw notFound();
    const token = await createResetToken(ctx, target);
    await audit(req, 'admin.reset_link', { type: 'user', id: target.id }, { username: target.username });
    return { url: resetUrl(ctx, token), expiresInMinutes: 60 };
  });

  // Permanently remove another account (spam, departed staff). Same rules and cleanup as self-service deletion.
  app.delete('/users/:id', { schema: { params: z.object({ id: z.uuid() }) } }, async (req) => {
    const me = requireUser(req);
    if (req.params.id === me.id) throw badRequest('Delete your own account from Settings → Account');
    const target = (await ctx.db.select().from(users).where(eq(users.id, req.params.id)).limit(1))[0];
    if (!target) throw notFound();
    if (target.username === GHOST_USERNAME) throw badRequest('The ghost account holds content from deleted users and cannot be deleted');
    const preview = await deletionPreview(ctx, target);
    if (preview.soleOwnerOrgs.length) {
      throw conflict(`${target.username} is the only owner of ${preview.soleOwnerOrgs.map((o) => o.slug).join(', ')}. Add another owner or delete the organization first.`, { orgs: preview.soleOwnerOrgs });
    }
    await audit(req, 'admin.user_delete', { type: 'user', id: target.id }, { username: target.username, repos: preview.ownedRepos.length });
    const res = await deleteUserAccount(ctx, target);
    return { ok: true, repos: res.repos };
  });
};

export default adminRoutes;
