// Git LFS server (batch API + basic transfer) for large binaries in hardware repos: STEP models, datasheets, photos.
// https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md
//
// Objects are stored per repository under repos/<id>/lfs/, count towards the owner's storage, and uploads are refused
// up front when they would exceed the plan's storage limit (when limits are enforced).
import { createHash } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, lfsObjects, repositories, users, type Namespace, type Repository, type User } from '@jumper/db';
import { ROLE_RANK, overLimit, type RepoRole } from '@jumper/shared';
import { signToken, verifyToken } from '../../lib/secrets';
import { UNVERIFIED_MESSAGE, mustVerify } from '../auth/verify';
import { basicAuth, challenge, scopeAllows } from '../git/http';
import { findRepo, permissionFor } from '../repos/access';
import { usageFor } from '../usage/service';
import { effectivePlan } from '../referrals/service';

const LFS_TYPE = 'application/vnd.git-lfs+json';
const OID = /^[0-9a-f]{64}$/;

const batchSchema = z.object({
  operation: z.enum(['download', 'upload']),
  transfers: z.array(z.string()).optional(),
  ref: z.object({ name: z.string() }).optional(),
  objects: z.array(z.object({ oid: z.string(), size: z.number().int().min(0) })).max(1000),
  hash_algo: z.string().optional(),
});

const SSH_TOKEN_PREFIX = 'Bearer lfs1.';

interface SshLfsGrant {
  k: 'lfs';
  u: string;
  r: string;
  w: boolean;
  e: number;
}

/** A one-hour credential for one repository, handed out by `git-lfs-authenticate` over SSH. */
export function sshLfsHeader(src: Parameters<typeof signToken>[0], userId: string, repoId: string, write: boolean): string {
  const grant: SshLfsGrant = { k: 'lfs', u: userId, r: repoId, w: write, e: Math.floor(Date.now() / 1000) + 3600 };
  return `${SSH_TOKEN_PREFIX}${signToken(src, grant as unknown as Record<string, unknown>)}`;
}

export function lfsKey(repoId: string, oid: string): string {
  return `repos/${repoId}/lfs/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
}

interface LfsAccess {
  repo: Repository;
  ns: Namespace;
  user: User | null;
}

function lfsError(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).type(LFS_TYPE).send({ message, documentation_url: undefined });
}

export async function lfsRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const maxBytes = ctx.env.LFS_MAX_OBJECT_MB * 1024 * 1024;

  app.addContentTypeParser(LFS_TYPE, { parseAs: 'string', bodyLimit: 4 * 1024 * 1024 }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error, undefined);
    }
  });
  app.addContentTypeParser('application/octet-stream', { bodyLimit: maxBytes }, (_req, payload, done) => done(null, payload));

  /** Same credentials and permission rules as git over HTTPS. Returns null after replying with an error. */
  async function authorize(req: FastifyRequest<{ Params: { owner: string; repo: string } }>, reply: FastifyReply, needed: RepoRole): Promise<LfsAccess | null> {
    const header = req.headers.authorization ?? '';
    if (header.startsWith(SSH_TOKEN_PREFIX)) return authorizeSshGrant(req, reply, header.slice(SSH_TOKEN_PREFIX.length), needed);
    const auth = await basicAuth(app, req);
    if (auth === 'invalid') {
      challenge(reply, 'Invalid credentials');
      return null;
    }
    const found = await findRepo(ctx, req.params.owner, req.params.repo.replace(/\.git$/, ''));
    const permission = found ? await permissionFor(ctx, auth.user, found.repo, found.ns) : 'none';
    if (!found || permission === 'none') {
      if (auth.user) lfsError(reply, 404, 'Repository not found');
      else challenge(reply, 'Authentication required');
      return null;
    }
    if (ROLE_RANK[permission] < ROLE_RANK[needed] || !scopeAllows(auth.scopes, needed)) {
      if (auth.user) lfsError(reply, 403, 'You do not have permission to push to this repository');
      else challenge(reply, 'Authentication required');
      return null;
    }
    if (needed === 'write' && mustVerify(ctx, auth.user)) {
      lfsError(reply, 403, UNVERIFIED_MESSAGE);
      return null;
    }
    return { repo: found.repo, ns: found.ns, user: auth.user };
  }

  /** A grant from `git-lfs-authenticate`: valid for its repository and operation, and only while the user keeps access. */
  async function authorizeSshGrant(req: FastifyRequest<{ Params: { owner: string; repo: string } }>, reply: FastifyReply, token: string, needed: RepoRole): Promise<LfsAccess | null> {
    const g = verifyToken<SshLfsGrant>(ctx.env, token);
    const found = await findRepo(ctx, req.params.owner, req.params.repo.replace(/\.git$/, ''));
    if (!g || g.k !== 'lfs' || g.e < Date.now() / 1000 || !found || g.r !== found.repo.id || (needed === 'write' && !g.w)) {
      challenge(reply, 'Invalid or expired credentials');
      return null;
    }
    const user = (await ctx.db.select().from(users).where(eq(users.id, g.u)).limit(1))[0];
    const permission = user && !user.disabled ? await permissionFor(ctx, user, found.repo, found.ns) : 'none';
    if (ROLE_RANK[permission] < ROLE_RANK[needed]) {
      lfsError(reply, 403, 'You no longer have access to this repository');
      return null;
    }
    return { repo: found.repo, ns: found.ns, user: user ?? null };
  }

  /** Repositories whose objects this one may read: itself, then the repository it was forked from (and so on). */
  async function readableChain(repo: Repository): Promise<string[]> {
    const ids = [repo.id];
    let next = repo.forkOfId;
    while (next && ids.length < 10 && !ids.includes(next)) {
      ids.push(next);
      next = (await ctx.db.select({ forkOfId: repositories.forkOfId }).from(repositories).where(eq(repositories.id, next)).limit(1))[0]?.forkOfId ?? null;
    }
    return ids;
  }

  const base = (req: FastifyRequest<{ Params: { owner: string; repo: string } }>) => {
    const origin = ctx.env.PUBLIC_URL.replace(/\/$/, '');
    return `${origin}/${req.params.owner}/${req.params.repo.replace(/\.git$/, '')}.git/info/lfs`;
  };

  app.post<{ Params: { owner: string; repo: string } }>('/:owner/:repo/info/lfs/objects/batch', async (req, reply) => {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) return lfsError(reply, 422, 'Malformed batch request');
    const b = parsed.data;
    if (b.hash_algo && b.hash_algo !== 'sha256') return lfsError(reply, 409, 'Only sha256 is supported');
    if (b.transfers && !b.transfers.includes('basic')) return lfsError(reply, 422, 'Only the basic transfer adapter is supported');
    const access = await authorize(req, reply, b.operation === 'upload' ? 'write' : 'read');
    if (!access) return reply;

    const valid = b.objects.filter((o) => OID.test(o.oid));
    const chain = b.operation === 'download' ? await readableChain(access.repo) : [access.repo.id];
    const stored = valid.length
      ? await ctx.db.select().from(lfsObjects).where(and(inArray(lfsObjects.repoId, chain), inArray(lfsObjects.oid, valid.map((o) => o.oid))))
      : [];
    const have = new Map(stored.map((s) => [s.oid, s]));
    const own = new Set(stored.filter((s) => s.repoId === access.repo.id).map((s) => s.oid));

    if (b.operation === 'upload') {
      const incoming = valid.filter((o) => !own.has(o.oid) && o.size <= maxBytes).reduce((n, o) => n + o.size, 0);
      if (incoming > 0 && ctx.env.PLANS_ENFORCED) {
        const usage = await usageFor(ctx, access.repo.namespaceId);
        const plan = await effectivePlan(ctx, access.ns);
        if (overLimit('storage', usage, plan.limits, incoming)) {
          return lfsError(reply, 507, `These files would exceed the storage included in the ${plan.name} plan for ${access.ns.slug}. Free up space or ask an administrator to change the plan.`);
        }
      }
    }

    const header: Record<string, string> = req.headers.authorization ? { Authorization: req.headers.authorization } : {};
    const objects = b.objects.map((o) => {
      if (!OID.test(o.oid)) return { oid: o.oid, size: o.size, error: { code: 422, message: 'Invalid object id' } };
      const href = `${base(req)}/objects/${o.oid}`;
      if (b.operation === 'download') {
        const s = have.get(o.oid);
        if (!s) return { oid: o.oid, size: o.size, error: { code: 404, message: 'Object does not exist on the server' } };
        return { oid: o.oid, size: s.size, authenticated: true, actions: { download: { href, header, expires_in: 3600 } } };
      }
      if (o.size > maxBytes) return { oid: o.oid, size: o.size, error: { code: 422, message: `Files larger than ${ctx.env.LFS_MAX_OBJECT_MB} MB are not accepted` } };
      if (own.has(o.oid)) return { oid: o.oid, size: o.size, authenticated: true };
      return { oid: o.oid, size: o.size, authenticated: true, actions: { upload: { href, header, expires_in: 3600 }, verify: { href: `${base(req)}/verify`, header, expires_in: 3600 } } };
    });
    return reply.type(LFS_TYPE).send({ transfer: 'basic', objects, hash_algo: 'sha256' });
  });

  app.put<{ Params: { owner: string; repo: string; oid: string } }>('/:owner/:repo/info/lfs/objects/:oid', { bodyLimit: maxBytes }, async (req, reply) => {
    const access = await authorize(req, reply, 'write');
    if (!access) return reply;
    const { oid } = req.params;
    if (!OID.test(oid)) return lfsError(reply, 422, 'Invalid object id');
    const body = req.body as Readable | undefined;
    if (!body || typeof body.pipe !== 'function') return lfsError(reply, 400, 'Send the object as application/octet-stream');
    const key = lfsKey(access.repo.id, oid);
    const hash = createHash('sha256');
    let size = 0;
    const tee = new PassThrough();
    body.on('data', (c: Buffer) => {
      size += c.length;
      hash.update(c);
    });
    body.pipe(tee);
    await ctx.storage.put(key, tee, 'application/octet-stream');
    // Content-addressed: anything that does not hash to its name is rejected and removed.
    if (hash.digest('hex') !== oid) {
      await ctx.storage.deletePrefix(key).catch(() => {});
      return lfsError(reply, 422, 'The uploaded content does not match its object id');
    }
    await ctx.db.insert(lfsObjects).values({ repoId: access.repo.id, oid, size, storageKey: key, uploadedBy: access.user?.id ?? null }).onConflictDoNothing();
    return reply.code(200).send();
  });

  app.post<{ Params: { owner: string; repo: string } }>('/:owner/:repo/info/lfs/verify', async (req, reply) => {
    const access = await authorize(req, reply, 'write');
    if (!access) return reply;
    const parsed = z.object({ oid: z.string(), size: z.number().int() }).safeParse(req.body);
    if (!parsed.success) return lfsError(reply, 422, 'Malformed verify request');
    const row = (await ctx.db.select().from(lfsObjects).where(and(eq(lfsObjects.repoId, access.repo.id), eq(lfsObjects.oid, parsed.data.oid))).limit(1))[0];
    if (!row || row.size !== parsed.data.size) return lfsError(reply, 404, 'Object not found or size mismatch');
    return reply.type(LFS_TYPE).send({});
  });

  app.get<{ Params: { owner: string; repo: string; oid: string } }>('/:owner/:repo/info/lfs/objects/:oid', async (req, reply) => {
    const access = await authorize(req, reply, 'read');
    if (!access) return reply;
    const { oid } = req.params;
    if (!OID.test(oid)) return lfsError(reply, 422, 'Invalid object id');
    const row = (await ctx.db.select().from(lfsObjects).where(and(inArray(lfsObjects.repoId, await readableChain(access.repo)), eq(lfsObjects.oid, oid))).limit(1))[0];
    if (!row) return lfsError(reply, 404, 'Object does not exist on the server');
    const obj = await ctx.storage.get(row.storageKey);
    if (!obj) return lfsError(reply, 404, 'Object data missing');
    return reply.type('application/octet-stream').header('Content-Length', obj.size).header('Cache-Control', 'private, max-age=31536000, immutable').send(obj.body);
  });
}
