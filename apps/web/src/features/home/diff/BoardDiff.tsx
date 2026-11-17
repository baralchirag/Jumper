import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { cx } from '@jumper/ui';
import meta from './assets/changes.json';
import revA from './assets/rev-a.webp';
import revB from './assets/rev-b.webp';

/**
 * Two kicad-cli renders of the same real board (RoyalBlue54L Feather): Rev A as KiCad ships it, Rev B an
 * example change built by scripts/hero-board/diff.py. Rev B is revealed from the left up to `position`
 * (0–100); a change counts as shown once the wipe has passed its centre.
 */

export type Change = (typeof meta.changes)[number];
export const CHANGES: Change[] = meta.changes;
export const BOARD = meta.board;

export const centre = (c: Change) => ((c.box[0]! + c.box[2]!) / 2) * 100;
export const isShown = (c: Change, position: number) => position >= centre(c);

const KIND_LABEL: Record<string, string> = { added: 'Added', removed: 'Removed', moved: 'Moved', changed: 'Changed' };
export const kindLabel = (c: Change) => KIND_LABEL[c.kind] ?? c.kind;

export function BoardDiff({ position, onChange }: { position: number; onChange: (p: number) => void }) {
  const boardRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const shown = CHANGES.filter((c) => isShown(c, position)).length;

  // One authored moment: on first view the wipe travels across the board and settles past the last change.
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    let start = 0;
    const from = 0;
    const to = 100;
    const ms = 2200;
    const tick = (now: number) => {
      if (dragging.current) return;
      start ||= now;
      const k = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      onChange(from + (to - from) * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    const t = window.setTimeout(() => (raf = requestAnimationFrame(tick)), 450);
    return () => {
      window.clearTimeout(t);
      cancelAnimationFrame(raf);
    };
    // Run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fromPointer = (e: ReactPointerEvent) => {
    const r = boardRef.current!.getBoundingClientRect();
    onChange(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
  };

  return (
    <div>
      <div
        ref={boardRef}
        className="relative cursor-ew-resize select-none"
        style={{ aspectRatio: `${meta.width} / ${meta.height}`, touchAction: 'pan-y' }}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => dragging.current && fromPointer(e)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        role="img"
        aria-label={`${BOARD.name}, wiped from Rev A to Rev B: Rev B left of the handle, Rev A right of it. ${shown} of ${CHANGES.length} changes shown.`}
      >
        <img src={revA} alt="" draggable={false} className="absolute inset-0 h-full w-full" />
        <img src={revB} alt="" draggable={false} className="absolute inset-0 h-full w-full" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }} />

        {CHANGES.map((c) => {
          const on = isShown(c, position);
          const [x0, y0, x1, y1] = c.box as [number, number, number, number];
          return (
            <div
              key={c.id}
              aria-hidden
              data-kind={c.kind}
              className={cx('lp-ring absolute', on && 'is-on')}
              style={{ left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` }}
            >
              <span className="lp-ring-tag">{c.ref}</span>
            </div>
          );
        })}

        <div aria-hidden className="lp-seam absolute inset-y-0" style={{ left: `${position}%` }} />
      </div>

      <div className="relative mt-5">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--lp-ink)]" />
        {CHANGES.map((c) => (
          <span
            key={c.id}
            aria-hidden
            data-kind={c.kind}
            className={cx('lp-tick pointer-events-none absolute top-1/2 h-3 w-px -translate-y-1/2', isShown(c, position) && 'is-on')}
            style={{ left: `${centre(c)}%` }}
          />
        ))}
        <input
          type="range"
          min={0}
          max={100}
          step={0.5}
          value={position}
          onChange={(e) => {
            dragging.current = true;
            onChange(Number(e.target.value));
          }}
          aria-label="Compare Rev A and Rev B"
          aria-valuetext={`${Math.round(position)}% Rev B, ${shown} of ${CHANGES.length} changes shown`}
          className="lp-wipe relative block w-full"
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-[12.5px] text-[var(--lp-muted)] sm:grid-cols-3">
        <span>Rev A<span className="hidden sm:inline"> · as shipped</span></span>
        <span className="order-last col-span-2 text-center tabular-nums text-[var(--lp-ink)] sm:order-none sm:col-span-1" aria-live="polite">
          {shown} of {CHANGES.length} changes shown
        </span>
        <span className="text-right">Rev B · example<span className="hidden sm:inline"> change</span></span>
      </div>
    </div>
  );
}
