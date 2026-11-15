import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';

/** A panel: hairline border, small corners, no shadow. */
export function Box({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('rounded-md border border-border bg-canvas', className)} {...rest} />;
}

export function BoxHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('flex min-h-12 items-center gap-2.5 rounded-t-md border-b border-border bg-canvas-subtle px-5 py-3', className)} {...rest} />;
}

export function BoxRow({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('probe border-b border-border-muted px-5 py-3.5 transition-colors last:border-b-0 hover:bg-canvas-subtle', className)} {...rest} />;
}

/** Empty state: a quiet dashed sheet with a centred note. */
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="m-4 flex flex-col items-center rounded-lg border border-dashed border-border bg-canvas-subtle/60 px-6 py-14 text-center">
      {icon && (
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-canvas text-fg-muted shadow-subtle">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-medium tracking-tight">{title}</h3>
      {children && <div className="mt-2 max-w-md text-[15px] leading-relaxed text-fg-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
