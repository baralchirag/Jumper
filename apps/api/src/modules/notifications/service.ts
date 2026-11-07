import { and, eq, inArray, notifications, repoFollows, sql, users, type Namespace, type Repository } from '@jumper/db';
import type { Ctx } from '../../context';
import { mailEnabled, sendMail } from '../mail/mailer';
import { permissionFor } from '../repos/access';

const MENTION = /(?:^|[^A-Za-z0-9_@/])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![A-Za-z0-9-])/g;

/** Unique, lower-cased usernames mentioned in a text. Fenced and inline code is ignored. */
export function parseMentions(text: string): string[] {
  const stripped = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  return [...new Set([...stripped.matchAll(MENTION)].map((m) => m[1]!.toLowerCase()))];
}

export interface NotifyInput {
  repo: Repository;
  ns: Namespace;
  /** null for things nobody did: scheduled stock alerts. */
  actorId: string | null;
  kind: 'mention' | 'assigned' | 'comment' | 'review_requested' | 'lock' | 'stock';
  title: string;
  url: string;
  recipients: string[];
}

/** Insert notifications, skipping the actor and anyone who cannot read the repository (no leaks from private repos). */
export async function notify(ctx: Ctx, input: NotifyInput): Promise<number> {
  const ids = [...new Set(input.recipients)].filter((id) => id !== input.actorId);
  if (!ids.length) return 0;
  const rows = await ctx.db.select().from(users).where(and(inArray(users.id, ids), eq(users.disabled, false)));
  const allowed: string[] = [];
  for (const u of rows) if ((await permissionFor(ctx, u, input.repo, input.ns)) !== 'none') allowed.push(u.id);
  if (!allowed.length) return 0;
  await ctx.db.insert(notifications).values(
    allowed.map((userId) => ({ userId, repoId: input.repo.id, kind: input.kind, title: input.title.slice(0, 300), url: input.url, actorId: input.actorId })),
  );
  if (mailEnabled(ctx.env)) {
    for (const u of rows) {
      if (!allowed.includes(u.id) || !u.notifyEmail) continue;
      // An unconfirmed address may belong to someone else: never mail it when the instance requires confirmation.
      if (ctx.env.emailVerificationRequired && !u.emailVerifiedAt) continue;
      // Fire and forget: a mail outage must never fail the comment, assignment or review that caused it.
      void sendMail(ctx.env, {
        to: u.email,
        subject: input.title.slice(0, 200),
        text: `${input.title}\n\n${ctx.env.PUBLIC_URL.replace(/\/$/, '')}${input.url}\n\nYou are receiving this because of activity on ${input.ns.slug}/${input.repo.name}.\nTurn these emails off in Settings, Account, Email notifications.\n`,
      }).catch(() => {});
    }
  }
  return allowed.length;
}

export async function notifyMentions(ctx: Ctx, repo: Repository, ns: Namespace, actorId: string, body: string, title: string, url: string): Promise<number> {
  const names = parseMentions(body);
  if (!names.length) return 0;
  const found = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) in (${sql.join(names.slice(0, 20).map((n) => sql`${n}`), sql`, `)})`);
  return notify(ctx, { repo, ns, actorId, kind: 'mention', title, url, recipients: found.map((f) => f.id) });
}

export async function followers(ctx: Ctx, repoId: string): Promise<string[]> {
  return (await ctx.db.select({ id: repoFollows.userId }).from(repoFollows).where(eq(repoFollows.repoId, repoId))).map((r) => r.id);
}
