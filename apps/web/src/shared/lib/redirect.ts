/**
 * Where to go after signing in: only paths on this site. Browsers read "/\evil.com" (and tabs or newlines inside it)
 * as "//evil.com", so checking the first characters is not enough: resolve it and compare origins.
 */
export function safeRedirect(r: string | undefined | null, origin: string = typeof window === 'undefined' ? 'http://localhost' : window.location.origin): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this guards against
  if (!r || !r.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(r)) return '/';
  try {
    const u = new URL(r, origin);
    return u.origin === new URL(origin).origin ? `${u.pathname}${u.search}${u.hash}` : '/';
  } catch {
    return '/';
  }
}
