import type { ReactNode } from 'react';
import { cx } from '../cx';

export function Counter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex min-w-5 items-center justify-center rounded-sm bg-neutral-muted px-1.5 font-mono text-xs leading-5 text-fg-muted tabular-nums', className)}>
      {children}
    </span>
  );
}

export type LabelTone = 'default' | 'accent' | 'success' | 'danger' | 'attention' | 'done';

const tones: Record<LabelTone, string> = {
  default: 'border-border text-fg-muted',
  accent: 'border-accent-muted text-accent',
  success: 'border-success/40 text-success',
  danger: 'border-danger/40 text-danger',
  attention: 'border-attention/40 text-attention',
  done: 'border-done/40 text-done',
};

/** Mono tag, like a silkscreen label. */
export function Label({ tone = 'default', children, className }: { tone?: LabelTone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-sm border px-1.5 font-mono text-[11.5px] font-medium uppercase leading-[18px] tracking-[0.04em]', tones[tone], className)}>
      {children}
    </span>
  );
}

const states = {
  open: 'bg-success-emphasis',
  merged: 'bg-done',
  closed: 'bg-danger-emphasis',
} as const;

export function StateBadge({ state, icon, children }: { state: keyof typeof states; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-[13px] font-medium text-fg-on-emphasis', states[state], state === 'merged' && 'text-canvas')}>
      {icon}
      {children}
    </span>
  );
}
