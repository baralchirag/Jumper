import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { highlightToHtml } from './highlight';

marked.setOptions({ gfm: true, breaks: false });

export interface MarkdownContext {
  /** Resolve repo-relative links/images, e.g. to blob/raw URLs. */
  resolveLink?: (href: string) => string;
  resolveImage?: (src: string) => string;
  /** Repository the text belongs to. */
  repo?: { owner: string; name: string };
  /** Treat single newlines as line breaks (comments), like GitHub. */
  breaks?: boolean;
}

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i;

const EMOJI: Record<string, string> = {
  '+1': '👍', '-1': '👎', thumbsup: '👍', thumbsdown: '👎', tada: '🎉', rocket: '🚀', fire: '🔥', bug: '🐛', sparkles: '✨',
  warning: '⚠️', x: '❌', white_check_mark: '✅', heavy_check_mark: '✔️', zap: '⚡', wrench: '🔧', hammer: '🔨', gear: '⚙️',
  memo: '📝', package: '📦', eyes: '👀', heart: '❤️', star: '⭐', bulb: '💡', lock: '🔒', construction: '🚧', boom: '💥',
  battery: '🔋', electric_plug: '🔌', mag: '🔍', link: '🔗', pushpin: '📌', calendar: '📅', smile: '😄', thinking: '🤔',
  ok_hand: '👌', clap: '👏', pray: '🙏', point_right: '👉', no_entry: '⛔', recycle: '♻️', satellite: '📡', microscope: '🔬',
};

const ALERTS: Record<string, string> = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

export interface TocEntry {
  depth: number;
  text: string;
  id: string;
}

/** Headings in document order with the ids `renderMarkdown` gives them. */
export function markdownToc(md: string): TocEntry[] {
  const seen = new Map<string, number>();
  const out: TocEntry[] = [];
  for (const t of marked.lexer(md)) {
    if (t.type !== 'heading') continue;
    const text = (t as { text: string }).text.replace(/[`*_~]|\[([^\]]*)\]\([^)]*\)/g, '$1');
    out.push({ depth: (t as { depth: number }).depth, text, id: uniqueId(slugify(text), seen) });
  }
  return out;
}

function uniqueId(base: string, seen: Map<string, number>): string {
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return `md-${n ? `${base}-${n}` : base}`;
}

/** Walk text nodes outside code/links and replace matches with nodes. */
function replaceText(root: Element, re: RegExp, make: (m: RegExpExecArray, doc: Document) => Node | null) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('code, pre, a, kbd') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.data;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let last = 0;
    const frag = doc.createDocumentFragment();
    let changed = false;
    while ((m = re.exec(text))) {
      const made = make(m, doc);
      if (!made) continue;
      changed = true;
      frag.append(text.slice(last, m.index), made);
      last = m.index + m[0].length;
    }
    if (!changed) continue;
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

/** Render untrusted Markdown to sanitized HTML (GitHub-flavoured, with alerts, task lists, anchors and highlighting). */
export function renderMarkdown(md: string, ctx: MarkdownContext = {}): string {
  const html = marked.parse(md, { async: false, breaks: ctx.breaks ?? false }) as string;
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'object', 'embed', 'select', 'textarea'],
    FORBID_ATTR: ['style'],
    ADD_ATTR: ['align'],
  });
  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, 'text/html');
  const root = doc.body.firstElementChild!;

  // Task lists: only disabled checkboxes survive.
  for (const input of root.querySelectorAll('input')) {
    if (input.getAttribute('type') !== 'checkbox') {
      input.remove();
      continue;
    }
    const checked = input.hasAttribute('checked');
    for (const a of [...input.attributes]) input.removeAttribute(a.name);
    input.setAttribute('type', 'checkbox');
    input.setAttribute('disabled', '');
    if (checked) input.setAttribute('checked', '');
    input.closest('li')?.classList.add('task-list-item');
    input.closest('ul, ol')?.classList.add('contains-task-list');
  }

  // GitHub alerts: > [!NOTE] …
  for (const bq of root.querySelectorAll('blockquote')) {
    const p = bq.firstElementChild;
    if (p?.tagName !== 'P') continue;
    const m = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(p.textContent ?? '');
    if (!m) continue;
    const kind = m[1]!.toUpperCase();
    // Strip the marker from the first text node (and a following <br>).
    const first = p.firstChild;
    if (first?.nodeType === Node.TEXT_NODE) first.textContent = first.textContent!.replace(/^\s*\[![A-Z]+\]\s*/i, '');
    if (p.firstChild?.nodeName === 'BR') p.firstChild.remove();
    if (!p.textContent?.trim() && !p.querySelector('img')) p.remove();
    const div = doc.createElement('div');
    div.className = `markdown-alert markdown-alert-${kind.toLowerCase()}`;
    const title = doc.createElement('p');
    title.className = 'markdown-alert-title';
    title.textContent = ALERTS[kind]!;
    div.append(title, ...bq.childNodes);
    bq.replaceWith(div);
  }

  // Heading anchors, prefixed so ids never clobber DOM globals.
  const seen = new Map<string, number>();
  for (const h of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const id = uniqueId(slugify(h.textContent ?? ''), seen);
    h.id = id;
    const a = doc.createElement('a');
    a.className = 'anchor';
    a.href = `#${id}`;
    a.setAttribute('aria-label', 'Link to this section');
    a.textContent = '#';
    h.prepend(a);
  }

  // Fenced code: syntax highlighting.
  for (const code of root.querySelectorAll('pre > code')) {
    const lang = /language-([\w+-]+)/.exec(code.className)?.[1];
    const pre = code.parentElement!;
    if (lang) pre.setAttribute('data-lang', lang);
    const out = lang ? highlightToHtml(code.textContent ?? '', lang) : null;
    if (out !== null) code.innerHTML = out;
  }

  // Emoji shortcodes, @mentions and #references.
  replaceText(root, /:([a-z0-9_+-]+):/g, (m, d) => (EMOJI[m[1]!] ? d.createTextNode(EMOJI[m[1]!]!) : null));
  replaceText(root, /(^|[^\w/@])@([a-zA-Z0-9][a-zA-Z0-9-]{0,38})\b/g, (m, d) => {
    const frag = d.createDocumentFragment();
    const a = d.createElement('a');
    a.className = 'mention';
    a.href = `/${m[2]}`;
    a.textContent = `@${m[2]}`;
    frag.append(m[1]!, a);
    return frag;
  });

  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')!;
    if (ctx.resolveLink && !ABSOLUTE.test(href)) a.setAttribute('href', ctx.resolveLink(href));
    if (/^https?:/i.test(href)) {
      a.setAttribute('rel', 'nofollow noopener noreferrer');
      a.setAttribute('target', '_blank');
    }
  }
  if (ctx.resolveImage) {
    for (const img of root.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src')!;
      if (!ABSOLUTE.test(src)) img.setAttribute('src', ctx.resolveImage(src));
    }
  }
  for (const img of root.querySelectorAll('img')) img.setAttribute('loading', 'lazy');
  for (const t of root.querySelectorAll('table')) {
    const wrap = doc.createElement('div');
    wrap.className = 'table-wrap';
    t.replaceWith(wrap);
    wrap.append(t);
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
