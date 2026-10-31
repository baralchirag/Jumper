import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';

export function Box({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('rounded-md border border-border bg-canvas', className)} {...rest} />;
}

export function BoxHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('flex items-center gap-2 rounded-t-md border-b border-border bg-canvas-subtle px-4 py-2.5', className)} {...rest} />;
}

export function BoxRow({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('border-b border-border-muted px-4 py-2 last:border-b-0 hover:bg-canvas-subtle', className)} {...rest} />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && <div className="mb-3 text-fg-subtle">{icon}</div>}
      <h3 className="text-lg font-semibold">{title}</h3>
      {children && <div className="mt-1 max-w-md text-fg-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
