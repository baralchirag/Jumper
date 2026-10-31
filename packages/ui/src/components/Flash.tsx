import type { ReactNode } from 'react';
import { cx } from '../cx';

export type FlashTone = 'info' | 'success' | 'warning' | 'danger';

const tones: Record<FlashTone, string> = {
  info: 'border-border bg-canvas-subtle text-fg',
  success: 'border-success/30 bg-success-subtle text-fg',
  warning: 'border-attention/30 bg-attention-subtle text-fg',
  danger: 'border-danger/30 bg-danger-subtle text-fg',
};

export function Flash({ tone = 'info', icon, children, className, action }: { tone?: FlashTone; icon?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('flex items-start gap-2 rounded-md border px-4 py-3 text-sm', tones[tone], className)}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}
