import { useState, type ReactNode } from 'react';
import { CheckCheck, Crosshair, Trash2 } from 'lucide-react';
import type { CommentInfo } from '@pcbhub/shared';
import { Avatar, Button, IconButton, RelativeTime, SegmentedControl, Textarea, cx } from '@pcbhub/ui';
import { Markdown } from './Markdown';
import { UserLink } from './common';

export function CommentForm({
  onSubmit,
  placeholder = 'Leave a comment',
  submitLabel = 'Comment',
  onCancel,
  extra,
  autoFocus,
  busy,
}: {
  onSubmit: (body: string) => Promise<unknown> | void;
  placeholder?: string;
  submitLabel?: string;
  onCancel?: () => void;
  extra?: ReactNode;
  autoFocus?: boolean;
  busy?: boolean;
}) {
  const [body, setBody] = useState('');
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [sending, setSending] = useState(false);
  const submit = async () => {
    if (!body.trim()) return;
    setSending(true);
    try {
      await onSubmit(body);
      setBody('');
      setTab('write');
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="rounded-md border border-border bg-canvas">
      <div className="flex items-center gap-2 border-b border-border bg-canvas-subtle px-2 py-1.5">
        <SegmentedControl
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'write', label: 'Write' },
            { value: 'preview', label: 'Preview' },
          ]}
        />
        <span className="ml-auto text-xs text-fg-subtle">Markdown supported</span>
      </div>
      <div className="p-2">
        {tab === 'write' ? (
          <Textarea
            value={body}
            autoFocus={autoFocus}
            onChange={(e) => setBody(e.target.value)}
            placeholder={placeholder}
            rows={4}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
            }}
          />
        ) : (
          <div className="min-h-24 px-2 py-1">{body.trim() ? <Markdown source={body} /> : <span className="text-fg-subtle">Nothing to preview</span>}</div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-2 pb-2">
        {extra}
        {onCancel && (
          <Button size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => void submit()} loading={sending || busy} disabled={!body.trim()}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

export function anchorLabel(c: CommentInfo): string | null {
  const a = c.anchor;
  if (!a) return null;
  if (a.type === 'line') return `${a.path}:${a.line}`;
  return `${a.label ?? a.objectType} in ${a.path.split('/').pop()}`;
}

export function CommentCard({
  comment,
  canModerate,
  meId,
  onDelete,
  onResolve,
  onLocate,
  compact,
}: {
  comment: CommentInfo;
  canModerate?: boolean;
  meId?: string;
  onDelete?: (c: CommentInfo) => void;
  onResolve?: (c: CommentInfo, resolved: boolean) => void;
  onLocate?: (c: CommentInfo) => void;
  compact?: boolean;
}) {
  const where = anchorLabel(comment);
  return (
    <div className={cx('rounded-md border border-border bg-canvas', comment.resolved && 'opacity-70')}>
      <div className="flex flex-wrap items-center gap-2 rounded-t-md border-b border-border bg-canvas-subtle px-3 py-1.5 text-sm">
        {!compact && <Avatar name={comment.author.username} src={comment.author.avatarUrl} size={20} />}
        <UserLink user={comment.author} avatar={false} />
        <span className="text-fg-muted">
          commented <RelativeTime date={comment.createdAt} />
        </span>
        {where && (
          <button onClick={() => onLocate?.(comment)} className="inline-flex items-center gap-1 rounded bg-neutral-muted px-1.5 font-mono text-xs text-fg-muted hover:text-accent" disabled={!onLocate}>
            <Crosshair size={11} /> {where}
          </button>
        )}
        {comment.resolved && <span className="text-xs text-success">Resolved</span>}
        <span className="ml-auto flex items-center gap-1">
          {onResolve && comment.anchor && (
            <IconButton label={comment.resolved ? 'Unresolve' : 'Resolve'} size="sm" icon={<CheckCheck size={14} />} onClick={() => onResolve(comment, !comment.resolved)} />
          )}
          {onDelete && (canModerate || comment.author.id === meId) && (
            <IconButton label="Delete comment" size="sm" icon={<Trash2 size={14} />} onClick={() => onDelete(comment)} />
          )}
        </span>
      </div>
      <div className="px-3 py-2">
        <Markdown source={comment.body} />
      </div>
    </div>
  );
}
