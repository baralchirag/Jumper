import { Fragment, useMemo, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { CommentInfo } from '@jumper/shared';
import { cx } from '@jumper/ui';
import { parseHunks } from './diff';
import { CommentCard, CommentForm } from './Comments';

export interface LineCommentTarget {
  line: number;
  side: 'old' | 'new';
}

/** Unified text diff with optional inline line comments. */
export function DiffView({
  patch,
  comments = [],
  onComment,
  maxLines = 3000,
}: {
  patch: string;
  comments?: CommentInfo[];
  onComment?: (target: LineCommentTarget, body: string) => Promise<unknown>;
  maxLines?: number;
}) {
  const lines = useMemo(() => parseHunks(patch), [patch]);
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? lines : lines.slice(0, maxLines);

  const byLine = useMemo(() => {
    const m = new Map<string, CommentInfo[]>();
    for (const c of comments) {
      if (c.anchor?.type !== 'line') continue;
      const k = `${c.anchor.side}:${c.anchor.line}`;
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return m;
  }, [comments]);

  return (
    <div className="overflow-x-auto font-mono text-xs">
      <table className="w-full border-collapse">
        <tbody>
          {visible.map((l, i) => {
            if (l.type === 'hunk') {
              return (
                <tr key={i} className="bg-diff-hunk text-fg-muted">
                  <td colSpan={3} className="px-3 py-1">
                    {l.text}
                  </td>
                </tr>
              );
            }
            const side: 'old' | 'new' = l.type === 'del' ? 'old' : 'new';
            const lineNo = side === 'old' ? l.oldNo! : l.newNo!;
            const key = `${side}:${lineNo}`;
            const thread = byLine.get(key);
            return (
              <Fragment key={i}>
                <tr className={cx('group', l.type === 'add' && 'bg-diff-add', l.type === 'del' && 'bg-diff-del')}>
                  <td className={cx('w-12 select-none border-r border-border-muted px-2 text-right text-fg-subtle', l.type === 'del' && 'bg-diff-del-num')}>{l.oldNo ?? ''}</td>
                  <td className={cx('relative w-12 select-none border-r border-border-muted px-2 text-right text-fg-subtle', l.type === 'add' && 'bg-diff-add-num')}>
                    {onComment && (
                      <button
                        aria-label="Comment on this line"
                        onClick={() => setOpen(open === key ? null : key)}
                        className="absolute -left-1 top-0 hidden rounded bg-accent-emphasis p-0.5 text-white group-hover:block"
                      >
                        <MessageSquarePlus size={12} />
                      </button>
                    )}
                    {l.newNo ?? ''}
                  </td>
                  <td className="whitespace-pre px-3 py-px">
                    <span className="select-none text-fg-subtle">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
                    {l.text}
                  </td>
                </tr>
                {(thread || open === key) && (
                  <tr>
                    <td colSpan={3} className="border-y border-border bg-canvas-subtle px-4 py-2 font-sans">
                      <div className="max-w-3xl space-y-2">
                        {thread?.map((c) => <CommentCard key={c.id} comment={c} compact />)}
                        {open === key && onComment && (
                          <CommentForm
                            autoFocus
                            onCancel={() => setOpen(null)}
                            onSubmit={async (body) => {
                              await onComment({ line: lineNo, side }, body);
                              setOpen(null);
                            }}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {!showAll && lines.length > maxLines && (
        <button onClick={() => setShowAll(true)} className="w-full border-t border-border bg-canvas-subtle py-2 font-sans text-sm text-accent hover:underline">
          Show {lines.length - maxLines} more lines
        </button>
      )}
    </div>
  );
}
