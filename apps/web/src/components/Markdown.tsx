import { useMemo } from 'react';
import { cx } from '@pcbhub/ui';
import { renderMarkdown, type MarkdownContext } from '../lib/markdown';

export function Markdown({ source, className, ctx }: { source: string; className?: string; ctx?: MarkdownContext }) {
  const html = useMemo(() => renderMarkdown(source, ctx), [source, ctx]);
  // HTML is sanitized by DOMPurify in renderMarkdown.
  return <div className={cx('markdown-body', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
