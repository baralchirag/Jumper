import { useEffect, useMemo, useRef, type MouseEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { cx } from '@jumper/ui';
import { renderMarkdown, type MarkdownContext } from '../lib/markdown';

/** Markdown context for text written inside a repository (#refs link to its pull requests). */
export function useRepoMarkdownCtx(owner: string, name: string, breaks = false): MarkdownContext {
  return useMemo(() => ({ repo: { owner, name }, breaks }), [owner, name, breaks]);
}

export function Markdown({ source, className, ctx }: { source: string; className?: string; ctx?: MarkdownContext }) {
  const html = useMemo(() => renderMarkdown(source, ctx), [source, ctx]);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  // Copy buttons on code blocks (added after render so the sanitized HTML stays button-free).
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const pre of root.querySelectorAll('pre')) {
      if (pre.querySelector('.md-copy')) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'md-copy';
      b.textContent = 'Copy';
      b.addEventListener('click', () => {
        void navigator.clipboard?.writeText(pre.querySelector('code')?.textContent ?? pre.textContent ?? '').then(() => {
          b.textContent = 'Copied';
          setTimeout(() => (b.textContent = 'Copy'), 1400);
        });
      });
      pre.append(b);
    }
  }, [html]);

  // Same-origin links navigate inside the app instead of reloading the page.
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest('a');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    const href = a.getAttribute('href') ?? '';
    if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/api/')) return;
    e.preventDefault();
    void navigate({ to: href });
  };

  // HTML is sanitized by DOMPurify in renderMarkdown.
  return <div ref={ref} onClick={onClick} className={cx('markdown-body', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
