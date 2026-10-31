import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

export interface MarkdownContext {
  /** Resolve repo-relative links/images, e.g. to blob/raw URLs. */
  resolveLink?: (href: string) => string;
  resolveImage?: (src: string) => string;
}

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i;

/** Render untrusted Markdown to sanitized HTML. */
export function renderMarkdown(md: string, ctx: MarkdownContext = {}): string {
  const html = marked.parse(md, { async: false }) as string;
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  });
  if (!ctx.resolveLink && !ctx.resolveImage) return clean;
  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, 'text/html');
  const root = doc.body.firstElementChild!;
  if (ctx.resolveLink) {
    for (const a of root.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href')!;
      if (!ABSOLUTE.test(href)) a.setAttribute('href', ctx.resolveLink(href));
      if (/^https?:/i.test(href)) {
        a.setAttribute('rel', 'nofollow noopener noreferrer');
        a.setAttribute('target', '_blank');
      }
    }
  }
  if (ctx.resolveImage) {
    for (const img of root.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src')!;
      if (!ABSOLUTE.test(src)) img.setAttribute('src', ctx.resolveImage(src));
    }
  }
  return root.innerHTML;
}

export function resolveRelative(baseDir: string, href: string): string {
  const parts = (baseDir ? baseDir.split('/') : []).concat(href.split(/[?#]/)[0]!.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}
