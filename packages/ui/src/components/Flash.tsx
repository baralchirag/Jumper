import type { ReactNode } from 'react';
import { cx } from '../cx';

export type FlashTone = 'info' | 'success' | 'warning' | 'danger';

const tones: Record<FlashTone, string> = {
  info: 'border-l-fg-subtle bg-canvas-subtle',
  success: 'border-l-success bg-success-subtle',
  warning: 'border-l-attention bg-attention-subtle',
  danger: 'border-l-danger bg-danger-subtle',
};

/** Annotation callout: a coloured lead line on the left, like a drawing note. */
export function Flash({ tone = 'info', icon, children, className, action }: { tone?: FlashTone; icon?: ReactNode; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx('flex items-start gap-2.5 rounded-sm border border-border-muted border-l-2 px-4 py-3 text-sm text-fg', tones[tone], className)}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}
