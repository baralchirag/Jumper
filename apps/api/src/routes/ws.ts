import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { eq, repositories, namespaces } from '@pcbhub/db';
import { EVENTS_CHANNEL, repoTopic, type PlatformEvent } from '@pcbhub/shared';
import { permissionFor } from '../services/access';

/**
 * Live updates: clients subscribe to `repo:<id>` topics and receive check,
 * push and pull-request events relayed from Redis pub/sub.
 */
export async function wsRoutes(app: FastifyInstance) {
  const subs = new Map<string, Set<WebSocket>>();
  const subscriber = app.ctx.redis.duplicate();
  // Don't block startup on Redis; ioredis re-subscribes after reconnects.
  subscriber.subscribe(EVENTS_CHANNEL).catch((e: Error) => app.log.error(e, 'redis subscribe failed'));
  subscriber.on('message', (_channel: string, message: string) => {
    let event: PlatformEvent;
    try {
      event = JSON.parse(message) as PlatformEvent;
    } catch {
      return;
    }
    const sockets = subs.get(repoTopic(event.repoId));
    if (!sockets) return;
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(message);
  });
  app.addHook('onClose', async () => {
    subscriber.disconnect();
  });

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const mine = new Set<string>();
    socket.on('message', async (raw: Buffer) => {
      let msg: { subscribe?: string; unsubscribe?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.subscribe && mine.size < 50) {
        const repoId = /^repo:([0-9a-f-]{36})$/.exec(msg.subscribe)?.[1];
        if (!repoId) return;
        const row = (
          await app.ctx.db
            .select({ repo: repositories, ns: namespaces })
            .from(repositories)
            .innerJoin(namespaces, eq(namespaces.id, repositories.namespaceId))
            .where(eq(repositories.id, repoId))
            .limit(1)
        )[0];
        if (!row || (await permissionFor(app.ctx, req.user, row.repo, row.ns)) === 'none') return;
        if (!subs.has(msg.subscribe)) subs.set(msg.subscribe, new Set());
        subs.get(msg.subscribe)!.add(socket);
        mine.add(msg.subscribe);
      }
      if (msg.unsubscribe) {
        subs.get(msg.unsubscribe)?.delete(socket);
        mine.delete(msg.unsubscribe);
      }
    });
    socket.on('close', () => {
      for (const t of mine) {
        const set = subs.get(t);
        set?.delete(socket);
        if (set && !set.size) subs.delete(t);
      }
    });
  });
}
