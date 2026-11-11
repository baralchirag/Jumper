import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, sshKeys, type SshKey } from '@jumper/db';
import { addSshKeySchema, type SshKeyInfo } from '@jumper/shared';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { audit } from '../audit/audit';
import { requireScope, requireUser } from '../auth/plugin';
import { parsePublicKey } from './keys';

const MAX_KEYS = 50;

function toInfo(k: SshKey): SshKeyInfo {
  return { id: k.id, title: k.title, keyType: k.keyType, fingerprint: k.fingerprint, lastUsedAt: k.lastUsedAt?.toISOString() ?? null, createdAt: k.createdAt.toISOString() };
}

/** Lives at /api; mixes per-user routes with the public SSH connection info. */
const sshRoutes: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.ctx;

  /** How to connect, for the settings page and first-push guide. */
  app.get('/ssh', async () => {
    if (!ctx.env.SSH_ENABLED) return { enabled: false as const };
    return {
      enabled: true as const,
      host: ctx.env.SSH_PUBLIC_HOST ?? new URL(ctx.env.PUBLIC_URL).hostname,
      port: ctx.env.SSH_PUBLIC_PORT ?? ctx.env.SSH_PORT,
      hostKeyFingerprint: ctx.sshHostKeyFingerprint ?? null,
    };
  });

  app.get('/user/ssh-keys', async (req): Promise<SshKeyInfo[]> => {
    const user = requireUser(req);
    const rows = await ctx.db.select().from(sshKeys).where(eq(sshKeys.userId, user.id)).orderBy(desc(sshKeys.createdAt));
    return rows.map(toInfo);
  });

  app.post('/user/ssh-keys', { schema: { body: addSshKeySchema }, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req): Promise<SshKeyInfo> => {
    const user = requireUser(req);
    requireScope(req, 'admin');
    let parsed;
    try {
      parsed = parsePublicKey(req.body.key);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    const existing = await ctx.db.select({ id: sshKeys.id, userId: sshKeys.userId }).from(sshKeys).where(eq(sshKeys.fingerprint, parsed.fingerprint)).limit(1);
    // One key, one account: otherwise a push could not be attributed. Do not say whose account has it.
    if (existing[0]) throw conflict(existing[0].userId === user.id ? 'You have already added this key' : 'This key is already in use. Use a different key for each account.');
    const count = await ctx.db.select({ id: sshKeys.id }).from(sshKeys).where(eq(sshKeys.userId, user.id));
    if (count.length >= MAX_KEYS) throw badRequest(`An account can have at most ${MAX_KEYS} SSH keys`);
    const [row] = await ctx.db
      .insert(sshKeys)
      .values({ userId: user.id, title: req.body.title || parsed.comment || parsed.keyType, keyType: parsed.keyType, publicKey: parsed.blob, fingerprint: parsed.fingerprint })
      .returning();
    await audit(req, 'ssh_key.add', { type: 'user', id: user.id }, { fingerprint: parsed.fingerprint, title: row!.title });
    return toInfo(row!);
  });

  app.delete('/user/ssh-keys/:id', { schema: { params: z.object({ id: z.uuid() }) } }, async (req) => {
    const user = requireUser(req);
    requireScope(req, 'admin');
    const [row] = await ctx.db.delete(sshKeys).where(and(eq(sshKeys.id, req.params.id), eq(sshKeys.userId, user.id))).returning();
    if (!row) throw notFound('Key not found');
    await audit(req, 'ssh_key.delete', { type: 'user', id: user.id }, { fingerprint: row.fingerprint });
    return { ok: true };
  });
};

export default sshRoutes;
