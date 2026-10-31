import type { ReactNode } from 'react';
import { cx } from '../cx';

export function Counter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex min-w-5 items-center justify-center rounded-full bg-neutral-muted px-1.5 text-xs font-medium leading-5 text-fg', className)}>
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

export function Label({ tone = 'default', children, className }: { tone?: LabelTone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 text-xs font-medium leading-5', tones[tone], className)}>
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
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium text-fg-on-emphasis', states[state])}>
      {icon}
      {children}
    </span>
  );
}
