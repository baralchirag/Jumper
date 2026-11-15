import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../cx';

export interface NavItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  count?: number | null;
  active?: boolean;
  render: (props: { className: string; children: ReactNode }) => ReactNode;
}

/**
 * Tabs with one shared orange rail that slides between items ("route like a trace").
 * Items render their own link element.
 */
export function UnderlineNav({ items, className, right }: { items: NavItem[]; className?: string; right?: ReactNode }) {
  const navRef = useRef<HTMLElement>(null);
  const refs = useRef(new Map<string, HTMLSpanElement>());
  const [rail, setRail] = useState<{ x: number; w: number } | null>(null);
  const activeKey = items.find((i) => i.active)?.key;

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const el = activeKey ? refs.current.get(activeKey) : undefined;
      setRail(el ? { x: el.offsetLeft, w: el.offsetWidth } : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [activeKey, items.length]);

  return (
    <nav ref={navRef} className={cx('relative flex items-end gap-0.5 overflow-x-auto border-b border-border [scrollbar-width:none]', className)}>
      {items.map((it) => (
        <span
          key={it.key}
          ref={(el) => {
            if (el) refs.current.set(it.key, el);
            else refs.current.delete(it.key);
          }}
          className="relative"
        >
          {it.render({
            className: cx(
              'group/tab relative flex items-center gap-2 px-4 py-3.5 text-sm whitespace-nowrap no-underline transition-colors',
              it.active ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg',
            ),
            children: (
              <>
                {it.icon && (
                  <span className={cx('transition-colors', it.active ? 'text-accent' : 'text-fg-subtle group-hover/tab:text-fg')}>{it.icon}</span>
                )}
                {it.label}
                {it.count != null && it.count > 0 && (
                  <span className="rounded-sm bg-neutral-muted px-1.5 font-mono text-xs leading-5 tabular-nums text-fg-muted">{it.count}</span>
                )}
                {!it.active && (
                  <span
                    aria-hidden
                    className="absolute inset-x-4 -bottom-px h-px origin-left scale-x-0 bg-fg-subtle transition-transform duration-300 ease-[var(--ease-route)] group-hover/tab:scale-x-100"
                  />
                )}
              </>
            ),
          })}
        </span>
      ))}
      {rail && (
        <span
          aria-hidden
          className="pointer-events-none absolute -bottom-px left-0 h-0.5 bg-select transition-[translate,width] duration-300 ease-[var(--ease-route)]"
          style={{ translate: `${rail.x}px 0`, width: rail.w }}
        />
      )}
      {right && <div className="ml-auto pb-1.5 pl-3">{right}</div>}
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
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded-md bg-canvas-inset p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            'inline-flex items-center gap-1.5 rounded-md px-3 font-medium transition-[background-color,color,box-shadow] disabled:opacity-40',
            size === 'sm' ? 'h-7 text-[13px]' : 'h-8 text-sm',
            value === o.value ? 'bg-canvas text-fg ring-1 ring-border' : 'text-fg-muted hover:text-fg',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
