import type { FastifyRequest } from 'fastify';
import { auditLog } from '@pcbhub/db';

export async function audit(
  req: FastifyRequest,
  action: string,
  target?: { type: string; id: string },
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await req.server.ctx.db.insert(auditLog).values({
      actorId: req.user?.id ?? null,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      metadata,
      ip: req.ip,
    });
  } catch (e) {
    req.log.error(e, 'audit log write failed');
  }
}
