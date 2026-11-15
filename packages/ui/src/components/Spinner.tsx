import { cx } from '../cx';

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={cx('animate-spin', className)} role="status" aria-label="Loading">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.5" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="var(--pcb-trace)" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

/** Page-level loading: a trace being routed across a short track, with a mono caption. */
export function PageSpinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center justify-center gap-3 py-20 text-fg-muted">
      <svg width="120" height="16" viewBox="0 0 120 16" fill="none" aria-hidden className="overflow-visible">
        <path d="M2 12 H40 L48 4 H118" stroke="var(--pcb-border)" strokeWidth="1.5" />
        <path d="M2 12 H40 L48 4 H118" stroke="var(--pcb-trace)" strokeWidth="1.5" pathLength={100} className="pcb-loading-trace" />
        <rect x="0" y="10" width="4" height="4" fill="var(--pcb-fg-subtle)" />
        <rect x="116" y="2" width="4" height="4" fill="var(--pcb-fg-subtle)" />
      </svg>
      <span className="font-mono text-xs uppercase tracking-[0.08em]">{label}</span>
      <style>{`.pcb-loading-trace{stroke-dasharray:24 100;animation:pcb-route 1.3s cubic-bezier(.6,0,.4,1) infinite}@keyframes pcb-route{from{stroke-dashoffset:24}to{stroke-dashoffset:-100}}@media (prefers-reduced-motion:reduce){.pcb-loading-trace{animation:none;stroke-dasharray:none}}`}</style>
    </div>
  );
}
