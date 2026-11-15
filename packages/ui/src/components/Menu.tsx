import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../cx';

/** Lightweight dropdown: click to open, closes on outside click or Escape. Unfolds from the trigger edge. */
export function Dropdown({
  trigger,
  children,
  align = 'left',
  width = 260,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-block">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          style={{ width, maxWidth: 'calc(100vw - 1.5rem)' }}
          className={cx(
            'pop-enter absolute z-50 mt-1.5 max-h-96 overflow-auto rounded-lg border border-border bg-canvas-overlay py-1 text-fg shadow-overlay',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, active, danger, icon }: { children: ReactNode; onClick?: () => void; active?: boolean; danger?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active || undefined}
      className={cx(
        'probe group/mi flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-neutral-muted focus-visible:bg-neutral-muted focus-visible:outline-none',
        active && 'font-medium',
        danger ? 'text-danger' : 'text-fg',
      )}
    >
      {icon && <span className={cx('w-4 shrink-0', active ? 'text-accent' : 'text-fg-subtle group-hover/mi:text-fg')}>{icon}</span>}
      <span className="probe-shift min-w-0 flex-1 truncate">{children}</span>
      {active && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-emphasis" />}
    </button>
  );
}

export function MenuHeader({ children }: { children: ReactNode }) {
  return <div className="label-mono px-3 pb-1.5 pt-2">{children}</div>;
}
