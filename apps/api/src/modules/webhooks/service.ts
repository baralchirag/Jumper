import { createHmac } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { and, eq, namespaces, repositories, sql, webhookDeliveries, webhooks, type Webhook } from '@jumper/db';
import type { PlatformEvent, WebhookEvent } from '@jumper/shared';
import type { Ctx } from '../../context';
import { assertWebhookUrl, isPrivateAddress } from './ssrf';

export const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

export function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export interface DeliveryResult {
  status: number | null;
  error: string | null;
  durationMs: number;
}

/**
 * POST `body` to `url`. DNS results are validated at connect time (not just at registration), which defeats
 * DNS-rebinding; redirects are never followed; the response is capped and discarded.
 */
export function post(url: string, body: string, headers: Record<string, string>, allowPrivate: boolean): Promise<DeliveryResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = assertWebhookUrl(url, allowPrivate);
    } catch (e) {
      return resolve({ status: null, error: (e as Error).message, durationMs: 0 });
    }
    const lib = u.protocol === 'https:' ? https : http;
    const done = (r: Omit<DeliveryResult, 'durationMs'>) => resolve({ ...r, durationMs: Date.now() - started });
    const req = lib.request(
      u,
      {
        method: 'POST',
        timeout: TIMEOUT_MS,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'Jumper-Hookshot', ...headers },
        lookup: (host, opts, cb) => {
          dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
            if (err) return (cb as (e: Error | null, a?: unknown, f?: number) => void)(err);
            const list = addrs as dns.LookupAddress[];
            const bad = !allowPrivate && list.find((a) => isPrivateAddress(a.address));
            if (bad || list.length === 0) return (cb as (e: Error | null) => void)(new Error('Destination resolves to a non-public address'));
            if ((opts as { all?: boolean }).all) return (cb as (e: null, a: dns.LookupAddress[]) => void)(null, list);
            (cb as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family);
          });
        },
      },
      (res) => {
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) res.destroy();
        });
        res.on('end', () => done({ status: res.statusCode ?? null, error: null }));
        res.on('close', () => done({ status: res.statusCode ?? null, error: null }));
        res.on('error', () => done({ status: res.statusCode ?? null, error: null }));
      },
    );
    req.on('timeout', () => {
      done({ status: null, error: 'Timed out' });
      req.destroy();
    });
    req.on('error', (e) => done({ status: null, error: e.message.slice(0, 300) }));
    req.end(body);
  });
}

export async function deliver(ctx: Ctx, hook: Webhook, event: string, payload: Record<string, unknown>): Promise<DeliveryResult> {
  const id = crypto.randomUUID();
  const body = JSON.stringify({ event, delivery: id, ...payload });
  const result = await post(
    hook.url,
    body,
    { 'x-jumper-event': event, 'x-jumper-delivery': id, 'x-jumper-signature-256': sign(hook.secret, body) },
    ctx.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS,
  );
  await ctx.db.insert(webhookDeliveries).values({ id, webhookId: hook.id, event, payload: JSON.parse(body), status: result.status, error: result.error, durationMs: result.durationMs }).catch(() => {});
  // Keep the log bounded: only the newest 100 deliveries per hook.
  await ctx.db.execute(sql`delete from webhook_deliveries where webhook_id = ${hook.id} and id not in (select id from webhook_deliveries where webhook_id = ${hook.id} order by created_at desc limit 100)`).catch(() => {});
  return result;
}

/** Map an internal event to a webhook event name; null when it should not be sent. */
export function toWebhookEvent(e: PlatformEvent): WebhookEvent | null {
  switch (e.type) {
    case 'push':
      return 'push';
    case 'pr':
      return 'pull_request';
    case 'check':
      return e.status === 'completed' ? 'check' : null;
    case 'issue':
      return e.action === 'commented' ? 'issue_comment' : 'issues';
  }
}

export async function dispatch(ctx: Ctx, e: PlatformEvent): Promise<void> {
  const name = toWebhookEvent(e);
  if (!name) return;
  const hooks = await ctx.db.select().from(webhooks).where(and(eq(webhooks.repoId, e.repoId), eq(webhooks.active, true)));
  const targets = hooks.filter((h) => h.events.includes(name));
  if (!targets.length) return;
  const repo = (
    await ctx.db
      .select({ name: repositories.name, owner: namespaces.slug, visibility: repositories.visibility })
      .from(repositories)
      .innerJoin(namespaces, eq(namespaces.id, repositories.namespaceId))
      .where(eq(repositories.id, e.repoId))
      .limit(1)
  )[0];
  if (!repo) return;
  const payload = { repository: { fullName: `${repo.owner}/${repo.name}`, owner: repo.owner, name: repo.name, private: repo.visibility === 'private' }, ...eventFields(e) };
  await Promise.allSettled(targets.map((h) => deliver(ctx, h, name, payload)));
}

function eventFields(e: PlatformEvent): Record<string, unknown> {
  switch (e.type) {
    case 'push':
      return { ref: e.ref, before: e.before, after: e.after };
    case 'pr':
      return { action: e.action, number: e.number };
    case 'issue':
      return { action: e.action, number: e.number };
    case 'check':
      return { sha: e.sha, name: e.name, projectPath: e.projectPath, conclusion: e.conclusion };
  }
}
