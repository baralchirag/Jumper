import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Bold, Code, Heading, Italic, Link2, List, ListChecks, ListOrdered, Quote, SquareCode } from 'lucide-react';
import { cx } from '@jumper/ui';
import type { MarkdownContext } from '../lib/markdown';
import { Markdown } from './Markdown';

type Action = { label: string; key?: string; icon: ReactNode; run: (sel: string) => { text: string; select?: [number, number] } };

/** Wrap or prefix the selection; `select` is relative to the inserted text. */
const wrap = (l: string, r = l, placeholder = 'text') => (sel: string) => {
  const inner = sel || placeholder;
  return { text: `${l}${inner}${r}`, select: [l.length, l.length + inner.length] as [number, number] };
};
const prefix = (p: string | ((i: number) => string)) => (sel: string) => {
  const lines = (sel || 'item').split('\n');
  const text = lines.map((ln, i) => (typeof p === 'string' ? p : p(i)) + ln).join('\n');
  return { text, select: [0, text.length] as [number, number] };
};

const ACTIONS: (Action | 'sep')[] = [
  { label: 'Heading', icon: <Heading size={14} />, run: prefix('### ') },
  { label: 'Bold', key: 'b', icon: <Bold size={14} />, run: wrap('**') },
  { label: 'Italic', key: 'i', icon: <Italic size={14} />, run: wrap('_') },
  'sep',
  { label: 'Quote', icon: <Quote size={14} />, run: prefix('> ') },
  { label: 'Inline code', key: 'e', icon: <Code size={14} />, run: wrap('`', '`', 'code') },
  { label: 'Code block', icon: <SquareCode size={14} />, run: wrap('```\n', '\n```', 'code') },
  { label: 'Link', key: 'k', icon: <Link2 size={14} />, run: (sel) => ({ text: `[${sel || 'text'}](url)`, select: sel ? [sel.length + 3, sel.length + 6] : [1, 5] }) },
  'sep',
  { label: 'Bulleted list', icon: <List size={14} />, run: prefix('- ') },
  { label: 'Numbered list', icon: <ListOrdered size={14} />, run: prefix((i) => `${i + 1}. `) },
  { label: 'Task list', icon: <ListChecks size={14} />, run: prefix('- [ ] ') },
];

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  rows = 5,
  autoFocus,
  ctx,
  id,
  onSubmit,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  ctx?: MarkdownContext;
  id?: string;
  /** Called on Ctrl/⌘+Enter. */
  onSubmit?: () => void;
  className?: string;
}) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const ta = useRef<HTMLTextAreaElement>(null);

  const apply = (a: Action) => {
    const el = ta.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const res = a.run(value.slice(s, e));
    el.focus();
    // execCommand keeps the browser's undo stack; fall back to a plain update.
    el.setSelectionRange(s, e);
    if (!document.execCommand?.('insertText', false, res.text)) onChange(value.slice(0, s) + res.text + value.slice(e));
    const [a0, a1] = res.select ?? [res.text.length, res.text.length];
    requestAnimationFrame(() => el.setSelectionRange(s + a0, s + a1));
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(ev.metaKey || ev.ctrlKey)) return;
    if (ev.key === 'Enter' && onSubmit) {
      ev.preventDefault();
      onSubmit();
      return;
    }
    const a = ACTIONS.find((x): x is Action => x !== 'sep' && x.key === ev.key.toLowerCase());
    if (a) {
      ev.preventDefault();
      apply(a);
    }
  };

  return (
    <div className={cx('rounded-sm border border-border bg-canvas focus-within:border-select', className)}>
      <div className="flex items-center gap-1 border-b border-border-muted px-1.5">
        <div role="tablist" className="flex">
          {(['write', 'preview'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cx('-mb-px border-b px-2.5 py-2 text-xs capitalize transition-colors', tab === t ? 'border-fg text-fg' : 'border-transparent text-fg-muted hover:text-fg')}
            >
              {t}
            </button>
          ))}
        </div>
        {tab === 'write' && (
          <div className="ml-auto hidden items-center sm:flex" role="toolbar" aria-label="Formatting">
            {ACTIONS.map((a, i) =>
              a === 'sep' ? (
                <span key={i} aria-hidden className="mx-1 h-4 w-px bg-border-muted" />
              ) : (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => apply(a)}
                  title={a.key ? `${a.label} (Ctrl+${a.key.toUpperCase()})` : a.label}
                  aria-label={a.label}
                  className="flex h-7 w-7 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-neutral-muted hover:text-fg"
                >
                  {a.icon}
                </button>
              ),
            )}
          </div>
        )}
      </div>
      {tab === 'write' ? (
        <textarea
          id={id}
          ref={ta}
          value={value}
          autoFocus={autoFocus}
          rows={rows}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          className="block w-full resize-y bg-transparent px-3 py-2.5 text-sm leading-relaxed text-fg placeholder:text-fg-subtle focus:outline-none"
        />
      ) : (
        <div className="px-3 py-2.5" style={{ minHeight: `${rows * 1.6 + 1.25}em` }}>
          {value.trim() ? <Markdown source={value} ctx={ctx} className="compact" /> : <span className="text-sm text-fg-subtle">Nothing to preview</span>}
        </div>
      )}
      <div className="flex items-center justify-between border-t border-border-muted px-3 py-1.5 font-mono text-[11.5px] text-fg-subtle">
        <a href="/docs/markdown" target="_blank" rel="noreferrer" className="hover:text-fg">
          Markdown supported
        </a>
        {onSubmit && <span className="hidden sm:inline">Ctrl+Enter to submit</span>}
      </div>
    </div>
  );
}
