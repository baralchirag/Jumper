import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Plus } from 'lucide-react';
import type { RepoInfo } from '@jumper/shared';
import { Avatar, PageSpinner, buttonClass, cx } from '@jumper/ui';
import { BoardDiff, BOARD, CHANGES } from './diff/BoardDiff';
import revB from './diff/assets/rev-b.webp';
import renderMeta from './diff/assets/changes.json';
import glbUrl from './live/assets/rev-b.glb?url';
import board3dPoster from './live/assets/board-3d.webp';
import type { Pcb } from '@jumper/kicad-core/types';
import { RepoList } from '../../shared/components/RepoList';
import { PageContainer } from '../../shared/components/common';
import { api } from '../../shared/lib/api';
import { useMe, wasSignedIn } from '../../shared/lib/queries';

/** What every commit gets; each links to the page in the docs that explains it. */
const EVERY_COMMIT = [
  { title: 'Visual diff', body: 'Parts, tracks, vias and zones are matched between commits by their KiCad UUID. Whatever was added, removed or changed is drawn in colour.', slug: 'design-analysis' },
  { title: 'ERC and DRC', body: 'kicad-cli checks every schematic and board. Click a violation to jump to where it is.', slug: 'design-analysis' },
  { title: 'Parts and prices', body: 'Each part priced, with stock, from LCSC and JLCPCB. Parts that are out of stock or can’t be found are listed first.', slug: 'design-analysis' },
  { title: 'Fab files', body: 'Gerbers, drill, pick-and-place and BOM, zipped the way JLCPCB, PCBWay or OSH Park ask for them.', slug: 'jumper-yml' },
] as const;

const STEPS = [
  { title: 'Connect a repository', body: 'Paste its GitHub URL. Private repositories need a read-only token. Jumper pulls new commits by itself, and your team keeps using git as before.' },
  { title: 'Open a commit', body: 'ERC, DRC and the parts list usually arrive within a minute. Renders, the 3D model and fab files follow.' },
  { title: 'Order the boards', body: 'Download the fab package from Outputs and upload it on the fab’s order page.' },
] as const;

// The review window brings the WebGL viewer: its code arrives right after the hero paints.
const LiveDemo = lazy(() => import('./live/LiveDemo').then((m) => ({ default: m.LiveDemo })));
const Viewer3DPanel = lazy(() => import('../viewer/Viewer3DPanel').then((m) => ({ default: m.Viewer3DPanel })));

function LiveSlot() {
  // Start the demo as soon as the hero has painted, not when it scrolls into view: by the time a visitor reaches it,
  // its ~1 MB of board data is already here.
  const [go, setGo] = useState(false);
  useEffect(() => {
    const w = window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    // After the review window, warm the 3D section: its code and kicad-cli's model, so it is ready on arrival.
    const warm3d = () => {
      void import('../viewer/Viewer3DPanel');
      void fetch(glbUrl).catch(() => undefined);
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setGo(true), { timeout: 800 });
      const id2 = w.requestIdleCallback(warm3d, { timeout: 4000 });
      return () => (w.cancelIdleCallback?.(id), w.cancelIdleCallback?.(id2));
    }
    const t = setTimeout(() => setGo(true), 200);
    const t2 = setTimeout(warm3d, 2500);
    return () => (clearTimeout(t), clearTimeout(t2));
  }, []);
  const frame = <div className="lp-rv lp-live-shimmer" style={{ height: 609 }} aria-hidden />;
  return <div>{go ? <Suspense fallback={frame}><LiveDemo /></Suspense> : frame}</div>;
}

/** Fires once when the element comes within `margin` of the viewport. */
function useNear<T extends HTMLElement>(margin = '400px') {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setNear(true), { rootMargin: `${margin} 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [near, margin]);
  return [ref, near] as const;
}

/** kicad-cli's 3D export of Rev B, with KiCad's part models, turning slowly until someone grabs it. */
function Board3D() {
  const [ref, near] = useNear<HTMLDivElement>('1200px');
  const [pcb, setPcb] = useState<Pcb | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!near) return;
    let off = false;
    void import('./live/LiveDemo')
      .then((m) => m.loadLiveData())
      .then((d) => !off && d.b.kind === 'pcb' && setPcb(d.b.model))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [near]);
  return (
    <div ref={ref} className="lp-3d">
      {/* A still of the same view, so the section is never empty; the live board fades in over it. */}
      <img src={board3dPoster} alt="" aria-hidden className={cx('lp-3d-poster', live && 'is-gone')} />
      {near && pcb && (
        <Suspense fallback={null}>
          <div className={cx('lp-3d-live', live && 'is-on')}>
            <Viewer3DPanel glbUrl={glbUrl} pcb={pcb} height={460} minimal onReady={() => setLive(true)} />
          </div>
        </Suspense>
      )}
      <p className="lp-3d-hint">Drag to turn it over</p>
    </div>
  );
}

/** A crop of KiCad's real render of Rev B around R6, with the area a reviewer selected and their thread. */
function AnnotatedPart() {
  const r6 = renderMeta.changes.find((c) => c.id === 'r6')!.box;
  const d1 = renderMeta.changes.find((c) => c.id === 'd1')!.box;
  const ratio = renderMeta.height / renderMeta.width;
  // Frame the crop on R6 and D1 together, about a quarter of the board wide.
  const span = 0.26;
  const cx = (Math.min(r6[0]!, d1[0]!) + Math.max(r6[2]!, d1[2]!)) / 2;
  const cy = (Math.min(r6[1]!, d1[1]!) + Math.max(r6[3]!, d1[3]!)) / 2;
  const scale = 1 / span;
  const aspect = 4 / 3; // crop width : height
  const left = 50 - cx * scale * 100;
  const top = 50 - cy * scale * ratio * aspect * 100;
  const box = (b: number[]) => ({
    left: `${left + b[0]! * scale * 100}%`,
    top: `${top + b[1]! * scale * ratio * aspect * 100}%`,
    width: `${(b[2]! - b[0]!) * scale * 100}%`,
    height: `${(b[3]! - b[1]!) * scale * ratio * aspect * 100}%`,
  });
  const pad = 0.012;
  const sel = [r6[0]! - pad, r6[1]! - pad / ratio / 2, r6[2]! + pad, r6[3]! + pad / ratio / 2];
  return (
    <figure className="lp-ann">
      <div className="lp-ann-crop" style={{ aspectRatio: '4 / 3' }}>
        <img src={revB} alt="KiCad render of the RoyalBlue54L Feather, close up on the status LED D1 and its resistor R6" style={{ position: 'absolute', width: `${scale * 100}%`, maxWidth: 'none', left: `${left}%`, top: `${top}%` }} />
        <span className="lp-ann-sel" style={box(sel)}>
          <span className="lp-ann-tag">R6</span>
        </span>
      </div>
      <div className="lp-ann-thread">
        <p className="flex items-baseline justify-between gap-3 text-[12.5px] text-[var(--lp-muted)]">
          <span>
            <span className="font-mono font-medium text-[var(--lp-ink)]">R6</span> · 470R → 1k
          </span>
          <span>Example thread</span>
        </p>
        <div className="mt-3">
          <p className="text-[12.5px] font-medium">Reviewer</p>
          <p className="mt-0.5 text-[14px] leading-relaxed">The status LED will be about half as bright at 3.3 V. Intended?</p>
        </div>
        <div className="mt-3 border-l border-[var(--lp-line)] pl-3">
          <p className="text-[12.5px] font-medium">Designer</p>
          <p className="mt-0.5 text-[14px] leading-relaxed">Yes, it was too bright behind the window. Resolving.</p>
        </div>
        <p className="lp-ann-resolved">Resolved on Rev B</p>
      </div>
    </figure>
  );
}

function PrimaryCta({ className, label = 'Connect a repository' }: { className?: string; label?: string }) {
  return (
    <Link to="/signup" className={cx('lp-cta group/cta', className)}>
      <span className="roll">
        <span>{label}</span>
        <span aria-hidden>{label}</span>
      </span>
      <ArrowUpRight size={18} aria-hidden className="arrow-travel" />
    </Link>
  );
}

function Landing() {
  const [position, setPosition] = useState(0);

  return (
    <div className="lp">
      {/* The review window, first: a real board, the change in colour, the list beside it, a thread on a part. */}
      <section className="lp-wrap pb-20 pt-14 md:pb-28 md:pt-20">
        <div className="grid items-end gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
          <h1 className="lp-title font-title">Board diffs for KiCad.</h1>
          <div className="lg:pb-3">
            <p className="text-pretty text-[17px] leading-relaxed text-[var(--lp-muted)]">
              Connect a GitHub repository and Jumper draws each commit’s schematic and board, colours what changed, and runs ERC and DRC. Your team comments on the parts themselves.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
              <PrimaryCta />
              <Link to="/docs/$slug" params={{ slug: 'quick-start' }} className="lp-link text-[15px]">
                How it works
              </Link>
            </div>
          </div>
        </div>

        <div className="mt-12 md:mt-16">
          <LiveSlot />
          <p className="mt-4 text-[13px] text-[var(--lp-muted)]">
            A real board: {BOARD.name} by {BOARD.author}, <span className="whitespace-nowrap">{BOARD.license}</span> (
            <a href={BOARD.url} target="_blank" rel="noreferrer" className="lp-link">
              source
            </a>
            ). We made Rev B for this page: D1 moved, R6 changed, J4 removed, SW3, TP12 and TP13 added. Click around; nothing here is saved.
          </p>
        </div>
      </section>

      {/* Comments live on the board. */}
      <section aria-labelledby="comment-h" className="border-t border-[var(--lp-line)]">
        <div className="lp-wrap grid gap-x-16 gap-y-10 py-20 md:py-28 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-center">
          <div>
            <h2 id="comment-h" className="lp-h2">
              Comments go on the part.
            </h2>
            <p className="mt-5 text-[16px] leading-relaxed text-[var(--lp-muted)]">
              Click a part, or drag a box over an area, and write. The comment is tied to the part’s KiCad UUID, so it stays on R6 in later commits even after R6 moves. Resolve it once it’s answered.
            </p>
          </div>
          <AnnotatedPart />
        </div>
      </section>

      {/* Board previews: KiCad's own renders, then the 3D board. */}
      <section aria-labelledby="render-h" className="border-t border-[var(--lp-line)]">
        <div className="lp-wrap py-20 md:py-28">
          <div className="mb-10 grid gap-x-12 gap-y-4 md:mb-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-end">
            <h2 id="render-h" className="lp-h2">
              KiCad’s own renders of each commit.
            </h2>
            <p className="text-[15px] leading-relaxed text-[var(--lp-muted)]">
              Jumper runs kicad-cli on every push and keeps the front, back and angled views. Drag across the image to compare Rev A with Rev B.
            </p>
          </div>
          <BoardDiff position={position} onChange={setPosition} />
          <p className="mt-4 text-[13px] text-[var(--lp-muted)]">
            Both images come straight from kicad-cli, unedited. {CHANGES.length} changes between them.
          </p>

          <div className="mt-16 grid gap-x-16 gap-y-8 md:mt-24 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-center">
            <Board3D />
            <div>
              <h3 className="text-[clamp(1.4rem,1.1rem+1vw,1.9rem)] font-medium leading-tight tracking-[-0.025em]">A 3D model you can turn over.</h3>
              <p className="mt-4 text-[15px] leading-relaxed text-[var(--lp-muted)]">
                Exported by kicad-cli with the 3D models from your libraries. Drag it to check the underside before you order. In the app, click any part to see its value, footprint and nets.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* What every commit gets, set as type rather than cards. */}
      <section aria-labelledby="every-h" className="border-t border-[var(--lp-line)]">
        <div className="lp-wrap py-16 md:py-20">
          <h2 id="every-h" className="mb-8 text-[clamp(1.5rem,1.2rem+1vw,2rem)] font-medium tracking-[-0.02em]">
            What each commit gets
          </h2>
          <ul className="grid border-l border-t border-[var(--lp-line)] sm:grid-cols-2 lg:grid-cols-4">
            {EVERY_COMMIT.map((f) => (
              <li key={f.title} className="border-b border-r border-[var(--lp-line)]">
                <Link to="/docs/$slug" params={{ slug: f.slug }} className="lp-every group/every">
                  <span className="flex items-center justify-between text-[19px] font-medium tracking-[-0.01em]">
                    {f.title}
                    <ArrowUpRight size={18} aria-hidden className="lp-row-arrow" />
                  </span>
                  <span className="mt-3 block text-[14px] leading-relaxed text-[var(--lp-muted)]">{f.body}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Close: the three steps as one finished wipe, on a field of the accent colour. */}
      <section aria-labelledby="close-h" className="lp-close">
        <div className="lp-wrap pb-16 pt-20 md:pb-20 md:pt-28">
          <h2 id="close-h" className="sr-only">
            How to start
          </h2>
          <ol className="lp-steps">
            {STEPS.map((step, i) => (
              <li key={step.title} className="lp-step">
                <span aria-hidden className="lp-step-node">
                  {i === STEPS.length - 1 ? <span className="lp-step-handle" /> : <span className="lp-step-tick" />}
                </span>
                <span className="font-mono text-[12.5px] tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="lp-step-title">{step.title}</h3>
                <p className="mt-4 max-w-[22rem] text-[15px] leading-relaxed">{step.body}</p>
              </li>
            ))}
          </ol>

          <div className="mt-16 flex flex-wrap items-center justify-between gap-x-10 gap-y-8 border-t border-[var(--lp-ink)] pt-8 md:mt-24">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
              <PrimaryCta className="lp-cta-ink" />
              <Link to="/login" className="lp-link text-[15px]">
                Sign in
              </Link>
            </div>
            <p className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>KiCad 8 and 9</span>
              <span>GitHub, GitLab and any git host</span>
            </p>
          </div>
        </div>
      </section>

      <style>{LANDING_CSS}</style>
    </div>
  );
}

const LANDING_CSS = `
.lp {
  /* Landing names for the shared tokens (packages/ui/src/styles.css), so the page follows the theme. */
  --lp-paper: var(--pcb-page);
  --lp-ink: var(--pcb-fg);
  --lp-muted: var(--pcb-fg-muted);
  --lp-line: var(--pcb-border);
  --lp-accent: var(--pcb-accent-emphasis);
  --lp-accent-ink: var(--pcb-select);
  --lp-edge: #121314;
  --lp-tick-on: var(--pcb-select);
  background: var(--lp-paper);
  color: var(--lp-ink);
}
.lp ::selection { background: var(--lp-accent); color: var(--lp-edge); }
.lp :focus-visible { outline: 2px solid var(--lp-ink); outline-offset: 3px; }
.lp-wrap { width: 100%; max-width: 1320px; margin-inline: auto; padding-inline: 20px; }
@media (min-width: 768px) { .lp-wrap { padding-inline: 40px; } }
.lp-title { font-size: clamp(3.4rem, 1.1rem + 7.4vw, 8.75rem); font-weight: 500; line-height: .9; letter-spacing: -0.04em; margin-left: -0.05em; }

.lp-cta { display: inline-flex; align-items: center; gap: 12px; height: 48px; padding: 0 16px 0 20px; border-radius: 4px;
  background: var(--lp-accent); color: var(--lp-edge); font-size: 15px; font-weight: 500; text-decoration: none;
  transition: background-color .25s var(--ease-route), color .25s var(--ease-route); }
.lp-cta:hover { background: var(--lp-ink); color: var(--lp-paper); }
.lp-link { color: inherit; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 4px;
  text-decoration-color: color-mix(in srgb, currentColor 35%, transparent); transition: text-decoration-color .2s; }
.lp-link:hover { text-decoration-color: currentColor; }

/* The wipe */
.lp-seam { width: 0; }
.lp-seam::before { content: ''; position: absolute; inset: -6px 0; left: -2px; width: 4px; background: var(--lp-accent); box-shadow: 0 0 0 1px var(--lp-edge); }
.lp-ring { border: 2px solid var(--lp-accent); border-radius: 6px; box-shadow: 0 0 0 1.5px var(--lp-edge), inset 0 0 0 1.5px var(--lp-edge); opacity: 0; transform: scale(1.6);
  transition: opacity .35s var(--ease-route), transform .5s var(--ease-route); pointer-events: none; }
.lp-ring.is-on { opacity: 1; transform: scale(1); }
.lp-ring-tag { position: absolute; left: -3.5px; box-shadow: 0 0 0 1.5px var(--lp-edge); bottom: calc(100% + 4px); padding: 1px 6px; border-radius: 3px;
  background: var(--lp-accent); color: var(--lp-edge); font: 500 12px/18px "JetBrains Mono Variable", ui-monospace, monospace; white-space: nowrap; }
.lp { --lp-add: #1f883d; --lp-del: #cf222e; --lp-mod: var(--lp-accent); }
.lp-ring[data-kind='added'] { border-color: var(--lp-add); background: color-mix(in srgb, var(--lp-add) 16%, transparent); }
.lp-ring[data-kind='removed'] { border-color: var(--lp-del); background: color-mix(in srgb, var(--lp-del) 18%, transparent);
  background-image: repeating-linear-gradient(135deg, color-mix(in srgb, var(--lp-del) 30%, transparent) 0 2px, transparent 2px 7px); }
.lp-ring[data-kind='added'] .lp-ring-tag { background: var(--lp-add); color: #fff; }
.lp-ring[data-kind='removed'] .lp-ring-tag { background: var(--lp-del); color: #fff; bottom: auto; top: calc(100% + 4px); }
.lp-tick { background: var(--lp-muted); transition: background-color .2s; }
.lp-tick.is-on { background: var(--lp-tick-on); width: 3px; height: 16px; }
.lp-tick.is-on[data-kind='added'] { background: var(--lp-add); }
.lp-tick.is-on[data-kind='removed'] { background: var(--lp-del); }
.lp-wipe { -webkit-appearance: none; appearance: none; height: 44px; margin: 0; background: transparent; cursor: ew-resize; }
.lp-wipe::-webkit-slider-runnable-track { height: 44px; background: transparent; }
.lp-wipe::-moz-range-track { height: 44px; background: transparent; }
.lp-wipe::-webkit-slider-thumb { -webkit-appearance: none; width: 26px; height: 26px; margin-top: 9px; border-radius: 50%;
  background: var(--lp-accent); border: 2px solid var(--lp-edge); box-shadow: 0 0 0 4px var(--lp-paper); }
.lp-wipe::-moz-range-thumb { width: 22px; height: 22px; border-radius: 50%; background: var(--lp-accent); border: 2px solid var(--lp-edge); box-shadow: 0 0 0 4px var(--lp-paper); }
.lp-wipe:focus-visible { outline: none; }
.lp-wipe:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px var(--lp-paper), 0 0 0 6px var(--lp-ink); }
.lp-wipe:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 4px var(--lp-paper), 0 0 0 6px var(--lp-ink); }

/* What every commit gets */
.lp-every { display: block; height: 100%; padding: 22px 22px 26px; color: var(--lp-ink); text-decoration: none; transition: background-color .3s var(--ease-route); }
.lp-every:hover { background: color-mix(in srgb, var(--lp-ink) 4%, transparent); }
.lp-row-arrow { color: var(--lp-muted); transition: color .25s, translate .3s var(--ease-route); }
.lp-every:hover .lp-row-arrow { color: var(--lp-accent-ink); translate: 3px -3px; }

/* Review window: the app's own viewer in review mode, the change list and threads beside it. */
.lp-h2 { font-size: clamp(1.9rem, 1.2rem + 2.2vw, 3.25rem); font-weight: 500; line-height: 1.02; letter-spacing: -0.03em; text-wrap: balance; }
.lp-live-shimmer { background: linear-gradient(100deg, var(--pcb-canvas) 40%, color-mix(in srgb, var(--pcb-canvas) 92%, var(--lp-ink)) 50%, var(--pcb-canvas) 60%) 0 0 / 300% 100%; animation: lp-shimmer 1.6s linear infinite; }
@keyframes lp-shimmer { from { background-position: 100% 0; } to { background-position: 0 0; } }
@media (prefers-reduced-motion: reduce) { .lp-live-shimmer { animation: none; } }
.lp-rv { border: 1px solid var(--lp-line); border-radius: 8px; overflow: hidden; background: var(--pcb-canvas); box-shadow: 0 24px 48px -36px rgba(0,0,0,.4); }
.lp-rv-file { min-width: 0; }
@media (max-width: 640px) { .lp-rv-file { display: none; } .lp-rv-seg { margin-left: 0 !important; width: 100%; } .lp-rv-seg button { flex: 1; } }
.lp-rv-bar { display: flex; align-items: center; gap: 16px; height: 48px; padding: 0 8px 0 16px; border-bottom: 1px solid var(--lp-line); background: var(--pcb-canvas-subtle); }
.lp-rv-seg { display: inline-flex; padding: 3px; border-radius: 6px; background: color-mix(in srgb, var(--lp-ink) 7%, transparent); }
.lp-rv-seg button { height: 30px; padding: 0 12px; white-space: nowrap; border-radius: 4px; font-size: 13.5px; font-weight: 500; color: var(--lp-muted); transition: color .2s, background-color .2s; }
.lp-rv-seg button:hover { color: var(--lp-ink); }
.lp-rv-seg button[aria-checked='true'] { background: var(--pcb-canvas); color: var(--lp-ink); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.lp-rv-body { display: grid; }
@media (min-width: 1024px) { .lp-rv-body { grid-template-columns: minmax(0, 1fr) 340px; } }
.lp-rv-side { display: flex; flex-direction: column; min-height: 0; border-top: 1px solid var(--lp-line); background: var(--pcb-canvas); }
@media (min-width: 1024px) { .lp-rv-side { height: 560px; border-top: 0; border-left: 1px solid var(--lp-line); } }
@media (max-width: 1023px) { .lp-rv-side { max-height: 520px; } }
.lp-rv-tabs { display: flex; gap: 4px; padding: 0 8px; border-bottom: 1px solid var(--lp-line); }
.lp-rv-tabs button { position: relative; height: 44px; padding: 0 10px; font-size: 14px; font-weight: 500; color: var(--lp-muted); }
.lp-rv-tabs button[aria-selected='true'] { color: var(--lp-ink); }
.lp-rv-tabs button[aria-selected='true']::after { content: ''; position: absolute; left: 8px; right: 8px; bottom: -1px; height: 2px; background: var(--lp-accent-ink); }
.lp-rv-count { margin-left: 4px; padding: 0 6px; border-radius: 9px; font: 500 11.5px/18px "JetBrains Mono Variable", ui-monospace, monospace; background: color-mix(in srgb, var(--lp-ink) 8%, transparent); }
/* The homepage board's change colours (LOOKS.board in @jumper/viewer). */
.lp { --rv-add: #5be37d; --rv-del: #ff5a5f; --rv-mod: #ff8f3a; --rv-net: #ffffff; }
.lp-rv-row { display: flex; align-items: flex-start; gap: 12px; width: 100%; padding: 11px 16px; text-align: left; border-bottom: 1px solid var(--lp-line); transition: background-color .15s; }
.lp-rv-row:hover { background: color-mix(in srgb, var(--lp-ink) 4%, transparent); }
.lp-rv-row.is-on { background: color-mix(in srgb, var(--rv-mod) 14%, transparent); }
.lp-rv-row[data-op='added'].is-on { background: color-mix(in srgb, var(--rv-add) 12%, transparent); }
.lp-rv-row[data-op='removed'].is-on { background: color-mix(in srgb, var(--rv-del) 10%, transparent); }
.lp-rv-dot { flex: none; width: 9px; height: 9px; margin-top: 5px; border-radius: 2px; background: var(--rv-mod); box-shadow: 0 0 0 1px color-mix(in srgb, #121314 25%, transparent); }
[data-op='added'] > .lp-rv-dot { background: var(--rv-add); }
[data-op='removed'] > .lp-rv-dot { background: var(--rv-del); }
.lp-rv-mini { display: flex; align-items: center; gap: 10px; width: 100%; padding: 5px 0; text-align: left; font: 500 12.5px/1.4 "JetBrains Mono Variable", ui-monospace, monospace; color: var(--lp-muted); }
.lp-rv-mini:hover { color: var(--lp-ink); }
.lp-rv-mini .lp-rv-dot { margin-top: 0; }
.lp-rv-net { width: 14px; height: 4px; border-radius: 2px; background: var(--rv-net); box-shadow: 0 0 0 1px rgb(0 0 0 / .35); }
.lp-rv-thread { padding: 14px 16px 16px; border-bottom: 1px solid var(--lp-line); }
.lp-rv-compose { padding: 12px 16px 14px; border-top: 1px solid var(--lp-line); background: var(--pcb-canvas-subtle); }
.lp-rv-input { flex: 1; min-width: 0; height: 34px; padding: 0 10px; border: 1px solid var(--lp-line); border-radius: 6px; background: var(--pcb-canvas); font-size: 14px; color: var(--lp-ink); }
.lp-rv-input:focus { outline: none; border-color: var(--lp-accent-ink); }
.lp-rv-send { height: 34px; padding: 0 12px; border-radius: 4px; background: var(--lp-accent); color: var(--lp-edge); font-size: 13.5px; font-weight: 500; }
.lp-rv-send:disabled { opacity: .45; }
.lp-rv-legend { position: absolute; left: 12px; bottom: 12px; display: flex; gap: 14px; padding: 6px 10px; border-radius: 4px; background: color-mix(in srgb, var(--pcb-canvas) 88%, transparent); font-size: 12.5px; color: var(--lp-muted); pointer-events: none; }
.lp-rv-legend span { display: inline-flex; align-items: center; gap: 6px; }
.lp-rv-legend span::before { content: ''; width: 9px; height: 9px; border-radius: 2px; background: var(--rv-mod); }
.lp-rv-legend [data-op='added']::before { background: var(--rv-add); }
.lp-rv-legend [data-op='removed']::before { background: var(--rv-del); }
.lp-rv-fit { position: absolute; right: 12px; top: 12px; display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid var(--lp-line); border-radius: 6px; background: var(--pcb-canvas); color: var(--lp-muted); }
.lp-rv-fit:hover { color: var(--lp-ink); }

/* Comment on the part: a crop of KiCad's render, the selected area, the thread. */
.lp-ann { position: relative; display: grid; gap: 0; }
@media (min-width: 768px) { .lp-ann { grid-template-columns: minmax(0, 1fr) 300px; align-items: center; } }
.lp-ann-crop { position: relative; overflow: hidden; border-radius: 8px; background: #0c2340; }
.lp-ann-sel { position: absolute; border: 2px solid var(--lp-accent); border-radius: 4px; background: color-mix(in srgb, var(--lp-accent) 14%, transparent); box-shadow: 0 0 0 1.5px var(--lp-edge), inset 0 0 0 1.5px var(--lp-edge); }
.lp-ann-tag { position: absolute; left: -2px; bottom: calc(100% + 6px); padding: 1px 7px; border-radius: 3px; background: var(--lp-accent); color: var(--lp-edge); box-shadow: 0 0 0 1.5px var(--lp-edge); font: 500 12px/18px "JetBrains Mono Variable", ui-monospace, monospace; }
.lp-ann-thread { position: relative; padding: 18px 20px 20px; border: 1px solid var(--lp-line); border-radius: 8px; background: var(--pcb-canvas); box-shadow: 0 30px 60px -40px rgba(0,0,0,.45); }
@media (min-width: 768px) { .lp-ann-thread { margin-left: -48px; } }
@media (max-width: 767px) { .lp-ann-thread { margin: -28px 12px 0; } }
.lp-ann-resolved { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--lp-line); font-size: 12.5px; color: var(--lp-muted); display: flex; align-items: center; gap: 8px; }
.lp-ann-resolved::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--rv-add); }

/* 3D */
.lp-3d { position: relative; min-height: 460px; border-radius: 8px; background: radial-gradient(120% 90% at 50% 40%, var(--pcb-canvas) 0%, var(--pcb-canvas-subtle) 70%); border: 1px solid var(--lp-line); overflow: hidden; }
.lp-3d-poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; transition: opacity .6s var(--ease-route); }
.lp-3d-poster.is-gone { opacity: 0; }
.lp-3d-live { position: relative; opacity: 0; transition: opacity .6s var(--ease-route); }
.lp-3d-live.is-on { opacity: 1; }
.lp-3d-hint { position: absolute; left: 16px; bottom: 14px; font-size: 12.5px; color: var(--lp-muted); pointer-events: none; }

/* Close: a field of the accent colour, ink on top. */
.lp-close { --lp-ink: #121314; --lp-paper: #f1f2ef; --lp-muted: #3d3f42; background: var(--lp-accent); color: var(--lp-ink); }
.lp-cta-ink { background: var(--lp-ink); color: var(--lp-accent); }
.lp-cta-ink:hover { background: var(--lp-paper); color: var(--lp-ink); }
.lp-close :focus-visible { outline-color: var(--lp-ink); }
.lp-steps { position: relative; display: grid; gap: 48px; }
@media (min-width: 900px) {
  .lp-steps { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 40px; }
  .lp-steps::before { content: ''; position: absolute; left: 0; right: 0; top: 13px; height: 2px; background: var(--lp-ink); }
}
.lp-step { position: relative; display: flex; flex-direction: column; }
.lp-step-node { display: none; }
@media (min-width: 900px) { .lp-step-node { position: relative; display: flex; align-items: center; height: 28px; margin-bottom: 28px; } }
.lp-step-tick { display: block; width: 3px; height: 18px; background: var(--lp-ink); }
.lp-step-handle { display: block; width: 28px; height: 28px; border-radius: 50%; background: var(--lp-ink); box-shadow: 0 0 0 5px var(--lp-accent); }
@media (min-width: 900px) { .lp-step:last-child .lp-step-node { justify-content: flex-end; } }
.lp-step-title { margin-top: 14px; font-size: clamp(2.5rem, 1.3rem + 3.2vw, 4.5rem); font-weight: 500; line-height: .98; letter-spacing: -0.035em; }

@media (prefers-reduced-motion: reduce) {
  .lp-ring { transform: none; }
}
`;

type Context = { kind: 'user' | 'org'; slug: string; name: string; role?: 'owner' | 'member' };

const CONTEXT_KEY = 'jumper-workbench-context';

/** Signed-in home: your repositories (or an organization's) and how to get the first board online. */
export function HomePage() {
  const { data: me, isLoading } = useMe();
  const [ctxSlug, setCtxSlug] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CONTEXT_KEY);
    } catch {
      return null;
    }
  });
  const mine = useQuery({ queryKey: ['repos', 'mine'], queryFn: () => api.get<RepoInfo[]>('/repos', { mine: true }), enabled: Boolean(me) });
  const [filter, setFilter] = useState('');

  // Visitors who were not signed in last time get the landing at once instead of waiting on /auth/me.
  if (isLoading && wasSignedIn()) return <PageSpinner />;
  if (!me) return <Landing />;

  const contexts: Context[] = [{ kind: 'user', slug: me.username, name: me.name || me.username }, ...me.orgs.map((o) => ({ kind: 'org' as const, slug: o.slug, name: o.name || o.slug, role: o.role }))];
  const context = contexts.find((c) => c.slug.toLowerCase() === ctxSlug?.toLowerCase()) ?? contexts[0]!;
  const choose = (slug: string) => {
    setCtxSlug(slug);
    try {
      localStorage.setItem(CONTEXT_KEY, slug);
    } catch {
      /* the choice just will not survive a reload */
    }
  };
  const repos = (mine.data ?? []).filter((r) => r.owner.toLowerCase() === context.slug.toLowerCase());
  const shown = filter ? repos.filter((r) => `${r.name} ${r.description ?? ''}`.toLowerCase().includes(filter.toLowerCase())) : repos;
  const empty = mine.isSuccess && repos.length === 0;

  return (
    <PageContainer className="max-w-[1280px] py-10 md:py-12">
      <header className="mb-10 flex flex-wrap items-end justify-between gap-x-6 gap-y-5">
        <div className="min-w-0">
          <h1 className="headline text-[clamp(2rem,1.4rem+1.6vw,2.75rem)]">Workbench</h1>
          {contexts.length > 1 ? (
            <div role="radiogroup" aria-label="Show the workbench for" className="mt-4 flex flex-wrap gap-1.5">
              {contexts.map((c) => (
                <button
                  key={c.slug}
                  type="button"
                  role="radio"
                  aria-checked={c.slug === context.slug}
                  onClick={() => choose(c.slug)}
                  className="inline-flex h-8 items-center gap-2 rounded-sm border border-border px-2.5 text-[13px] text-fg-muted transition-colors hover:text-fg aria-checked:border-select aria-checked:text-fg"
                >
                  <Avatar name={c.slug} size={16} square={c.kind === 'org'} />
                  {c.kind === 'user' ? 'Personal' : c.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[15px] text-fg-muted">Your boards, checked on every commit.</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {context.kind === 'org' && (
            <>
              <Link to="/$owner" params={{ owner: context.slug }} className={buttonClass('default', 'md')}>
                Profile
              </Link>
              {context.role === 'owner' && (
                <Link to="/organizations/$org/settings" params={{ org: context.slug }} className={buttonClass('default', 'md')}>
                  Settings
                </Link>
              )}
            </>
          )}
          <Link to="/new" search={{ owner: context.slug }} className={buttonClass('accent', 'md')}>
            <Plus size={15} aria-hidden /> New repository
          </Link>
        </div>
      </header>

      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-14">
        <section aria-labelledby="mine-h" className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-3 pb-3">
            <h2 id="mine-h" className="flex items-baseline gap-3 text-lg font-medium">
              {context.kind === 'user' ? 'Your repositories' : `${context.name} repositories`}
              <span className="text-[13px] font-normal tabular-nums text-fg-muted">{mine.isSuccess ? repos.length : ''}</span>
            </h2>
            {repos.length > 5 && (
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Find a repository"
                aria-label="Find a repository"
                className="h-8 w-56 rounded-sm border border-border bg-canvas px-2.5 text-[13px] placeholder:text-fg-subtle focus:border-select focus:outline-none"
              />
            )}
          </div>
          {mine.isLoading ? (
            <PageSpinner />
          ) : empty ? (
            <FirstBoard org={context.kind === 'org' ? context.slug : undefined} />
          ) : (
            <RepoList repos={shown} showOwner={false} empty={`Nothing matches “${filter}”.`} />
          )}
        </section>

        <aside className="flex flex-col gap-6">
          <section aria-labelledby="gh-h" className="rounded-md border border-border p-5">
            <h2 id="gh-h" className="text-[15px] font-medium">Keep working on GitHub</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">
              Connect a GitHub repository and Jumper follows it: every new commit gets ERC, DRC, a BOM with live prices, a visual diff and a fab package.
            </p>
            <Link to="/new" search={{ owner: context.slug }} className={buttonClass('default', 'sm', 'mt-4')}>
              Connect a repository
            </Link>
          </section>
          <section aria-labelledby="plugin-h" className="rounded-md border border-border p-5">
            <h2 id="plugin-h" className="text-[15px] font-medium">Push from KiCad</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">The Jumper plugin commits and pushes from inside KiCad, and opens the diff in your browser.</p>
            <Link to="/docs/$slug" params={{ slug: 'kicad-plugin' }} className="link mt-3 inline-block text-[13px]">
              Get the plugin
            </Link>
          </section>
        </aside>
      </div>
    </PageContainer>
  );
}

/** Empty workbench: the three steps to a first board online, for you or for an organization. */
function FirstBoard({ org }: { org?: string }) {
  const steps = [
    { t: 'Create a repository', d: 'One per board or product. Start empty, from a starter template, or import an existing git repository.', to: '/new', cta: 'New repository' },
    { t: 'Create an access token', d: 'Git over HTTPS uses a token as the password. SSH keys and the KiCad plugin work too.', to: '/settings/tokens', cta: 'Create token' },
    { t: 'Push your KiCad project', d: 'Then open the repository to see the schematic, the board, its checks and its BOM.', to: '/docs/quick-start', cta: 'Read the guide' },
  ];
  return (
    <ol className="border-y border-border">
      {steps.map((x, i) => (
        <li key={x.t} className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border-muted py-5 last:border-b-0">
          <span className="w-6 font-mono text-sm tabular-nums text-fg-subtle">{i + 1}</span>
          <div className="min-w-0 flex-1 basis-64">
            <div className="font-medium">{x.t}</div>
            <div className="mt-1 text-sm leading-relaxed text-fg-muted">{x.d}</div>
          </div>
          {i === 0 ? (
            <Link to="/new" search={org ? { owner: org } : {}} className={buttonClass('primary', 'sm')}>
              {x.cta}
            </Link>
          ) : (
            <Link to={x.to} className={buttonClass('default', 'sm')}>
              {x.cta}
            </Link>
          )}
        </li>
      ))}
    </ol>
  );
}
