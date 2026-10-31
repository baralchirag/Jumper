import type { ReactNode } from 'react';
import { cx } from '../cx';

export interface NavItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  count?: number | null;
  active?: boolean;
  render: (props: { className: string; children: ReactNode }) => ReactNode;
}

/** GitHub-style underline tabs. Items render their own link element. */
export function UnderlineNav({ items, className, right }: { items: NavItem[]; className?: string; right?: ReactNode }) {
  return (
    <nav className={cx('flex items-end gap-1 overflow-x-auto border-b border-border', className)}>
      {items.map((it) => (
        <span key={it.key} className="relative">
          {it.render({
            className: cx(
              'flex items-center gap-2 rounded-md px-3 py-2 my-1.5 text-sm whitespace-nowrap no-underline hover:bg-neutral-muted',
              it.active ? 'font-semibold text-fg' : 'text-fg-muted',
            ),
            children: (
              <>
                {it.icon && <span className="text-fg-subtle">{it.icon}</span>}
                {it.label}
                {it.count != null && it.count > 0 && <span className="rounded-full bg-neutral-muted px-1.5 text-xs leading-5">{it.count}</span>}
              </>
            ),
          })}
          {it.active && <span className="absolute inset-x-1 -bottom-px h-0.5 rounded bg-accent-emphasis" />}
        </span>
      ))}
      {right && <div className="ml-auto pb-1.5">{right}</div>}
    </nav>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  size?: 'sm' | 'md';
  ariaLabel?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded-md border border-border bg-canvas-inset p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            'inline-flex items-center gap-1.5 rounded px-2.5 font-medium transition-colors disabled:opacity-40',
            size === 'sm' ? 'h-6 text-xs' : 'h-7 text-sm',
            value === o.value ? 'bg-canvas text-fg shadow-sm ring-1 ring-border' : 'text-fg-muted hover:text-fg',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
