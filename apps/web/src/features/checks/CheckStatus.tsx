import { CircleCheck, CircleDot, CircleMinus, CircleX, Clock } from 'lucide-react';
import type { CheckRunInfo } from '@jumper/shared';
import { cx } from '@jumper/ui';

export type Rollup = 'success' | 'failure' | 'pending' | 'neutral' | 'none';

export function runState(r: Pick<CheckRunInfo, 'status' | 'conclusion'>): Rollup {
  if (r.status !== 'completed') return 'pending';
  if (r.conclusion === 'success') return 'success';
  if (r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled') return 'failure';
  return 'neutral';
}

export function rollup(runs: CheckRunInfo[] | undefined): Rollup {
  if (!runs?.length) return 'none';
  const states = runs.map(runState);
  if (states.includes('failure')) return 'failure';
  if (states.includes('pending')) return 'pending';
  if (states.every((s) => s === 'neutral')) return 'neutral';
  return 'success';
}

export function CheckIcon({ state, size = 16, className }: { state: Rollup; size?: number; className?: string }) {
  switch (state) {
    case 'success':
      return <CircleCheck size={size} className={cx('text-success', className)} aria-label="Passed" />;
    case 'failure':
      return <CircleX size={size} className={cx('text-danger', className)} aria-label="Failed" />;
    case 'pending':
      return <Clock size={size} className={cx('animate-pulse text-attention', className)} aria-label="Running" />;
    case 'neutral':
      return <CircleMinus size={size} className={cx('text-fg-subtle', className)} aria-label="Neutral" />;
    default:
      return <CircleDot size={size} className={cx('text-fg-subtle', className)} aria-label="No checks" />;
  }
}
