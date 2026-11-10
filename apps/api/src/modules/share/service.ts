import { and, eq, shareLinks, users, type ShareLink } from '@jumper/db';
import type { Ctx } from '../../context';
import { sha256 } from '../../lib/crypto';

export const SHARE_PREFIX = 'pcbs_';

/** Normalise a requested path and refuse anything that could escape the repository tree. */
export function cleanPath(raw: string | undefined | null): string | null {
  const p = (raw ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (p.includes('\0')) return null;
  const parts = p.split('/').filter((s) => s !== '');
  if (parts.some((s) => s === '..' || s === '.')) return null;
  return parts.join('/');
}

/** Is `path` inside the link's scope (the whole repo when scope is null/empty)? */
export function inScope(scope: string | null, path: string): boolean {
  if (!scope) return true;
  const s = scope.replace(/^\/+|\/+$/g, '');
  return path === s || path.startsWith(`${s}/`);
}

/** A folder listing is allowed on the scope itself, anything below it, or any ancestor (to navigate down to it). */
export function listingAllowed(scope: string | null, path: string): boolean {
  if (!scope) return true;
  const s = scope.replace(/^\/+|\/+$/g, '');
  return inScope(s, path) || path === '' || s.startsWith(`${path}/`);
}

export type LinkState = 'active' | 'expired' | 'revoked';
export function linkState(l: Pick<ShareLink, 'expiresAt' | 'revokedAt'>, now = new Date()): LinkState {
  if (l.revokedAt) return 'revoked';
  if (l.expiresAt && l.expiresAt <= now) return 'expired';
  return 'active';
}

/** Resolve a presented token to an active link whose creator is still allowed to share. */
export async function resolveLink(ctx: Ctx, token: string): Promise<ShareLink | null> {
  if (!token.startsWith(SHARE_PREFIX) || token.length > 200) return null;
  const row = (
    await ctx.db
      .select({ link: shareLinks, disabled: users.disabled })
      .from(shareLinks)
      .innerJoin(users, eq(users.id, shareLinks.createdBy))
      .where(and(eq(shareLinks.tokenHash, sha256(token))))
      .limit(1)
  )[0];
  if (!row || row.disabled || linkState(row.link) !== 'active') return null;
  return row.link;
}

/** Content types a shared viewer may render inline. Everything else is served as an opaque download. */
const INLINE: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  md: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  kicad_pcb: 'text/plain; charset=utf-8',
  kicad_sch: 'text/plain; charset=utf-8',
  kicad_pro: 'application/json',
  json: 'application/json',
  csv: 'text/csv; charset=utf-8',
  glb: 'model/gltf-binary',
};
export function contentTypeFor(path: string): { type: string; inline: boolean } {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const t = INLINE[ext];
  return t ? { type: t, inline: true } : { type: 'application/octet-stream', inline: false };
}
