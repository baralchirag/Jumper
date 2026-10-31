import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../cx';

/** Lightweight dropdown: click to open, closes on outside click or Escape. */
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
          style={{ width }}
          className={cx(
            'absolute z-50 mt-1 max-h-96 overflow-auto rounded-md border border-border bg-canvas-overlay py-1 shadow-overlay',
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
      className={cx(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-neutral-muted',
        active && 'font-semibold',
        danger ? 'text-danger' : 'text-fg',
      )}
    >
      {icon && <span className="w-4 shrink-0 text-fg-muted">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

export function MenuHeader({ children }: { children: ReactNode }) {
  return <div className="border-b border-border-muted px-3 pb-1.5 pt-1 text-xs font-semibold text-fg-muted">{children}</div>;
}
