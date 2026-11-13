import type { FastifyRequest } from 'fastify';
import { auditLog } from '@jumper/db';

export async function audit(
  req: FastifyRequest,
  action: string,
  target?: { type: string; id: string },
  metadata: Record<string, unknown> = {},
  /** Actor when `req.user` is not set yet (sign-in, registration). */
  actorId?: string,
  /** Owner the event belongs to, when it is not a repository event (those are matched by repository). */
  namespaceId?: string | null,
): Promise<void> {
  try {
    await req.server.ctx.db.insert(auditLog).values({
      actorId: actorId ?? req.user?.id ?? null,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      metadata,
      ip: req.ip,
      namespaceId: namespaceId ?? null,
    });
  } catch (e) {
    req.log.error(e, 'audit log write failed');
  }
}
