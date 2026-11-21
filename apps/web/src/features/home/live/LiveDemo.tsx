import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, MessageSquare } from 'lucide-react';
import type { Change, DiffResult, Footprint, ParsedDesign, Pcb } from '@jumper/kicad-core/types';
import type { DiffOp, DiffPaint, LookName, Marker } from '@jumper/viewer';
import { cx } from '@jumper/ui';
import { DesignViewer, type DesignSelection, type DesignViewerHandle } from '../../viewer/DesignViewer';
import { useResolvedTheme } from '../../../shared/lib/theme';
import demoUrl from './assets/demo.json.gz?url';

/**
 * The homepage's review window: two real revisions of a real board (RoyalBlue54L Feather, CERN-OHL-P-2.0), parsed and
 * diffed by the same Rust core the server runs (ahead of time, by scripts/hero-board/pack.mjs, so nobody waits for a
 * parse), drawn by the app's own viewer in the colours KiCad renders the board, the change in solid colour over it. The comment thread is
 * an example and says so; comments a visitor adds stay in their browser.
 */

interface Packed {
  a: ParsedDesign;
  b: ParsedDesign;
  diff: DiffResult;
}

/** Gunzip the packed demo. A host may already have decoded it (Content-Encoding), so check the gzip magic first. */
async function unpack(res: Response): Promise<Packed> {
  if (!res.ok) throw new Error(`demo data: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const gz = buf[0] === 0x1f && buf[1] === 0x8b;
  const text = gz ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text() : new TextDecoder().decode(buf);
  return JSON.parse(text) as Packed;
}

// One download per page view, started as soon as the homepage renders the window.
let pending: Promise<Packed> | null = null;
export function loadLiveData(): Promise<Packed> {
  pending ??= fetch(demoUrl).then(unpack);
  pending.catch(() => (pending = null));
  return pending;
}

function useLiveData() {
  const [data, setData] = useState<Packed | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadLiveData().then(
      (d) => !cancelled && setData(d),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return { data, error };
}

/** The board in the colours KiCad renders it (LOOKS in @jumper/viewer); `kicad` and `paper` are the alternatives. */
const LOOK: LookName = 'board';

type View = 'before' | 'changes' | 'after';
type Tab = 'changes' | 'comments';

const HEIGHT = 560;
const PHONE_HEIGHT = 380;
const canvasHeight = () => (typeof window !== 'undefined' && window.innerWidth < 768 ? PHONE_HEIGHT : HEIGHT);
const OP_WORD: Record<DiffOp, string> = { added: 'Added', removed: 'Removed', modified: 'Changed' };

interface Row {
  change: Change;
  ref: string;
  what: string;
  part: string | null;
}

interface Thread {
  id: string;
  ref: string;
  /** Where the pin goes, for threads on tracks and vias (parts are found by reference). */
  at?: { x: number; y: number };
  example: boolean;
  messages: { who: string; body: string }[];
}

const EXAMPLE_THREAD: Thread = {
  id: 'example',
  ref: 'R6',
  example: true,
  messages: [
    { who: 'Reviewer', body: 'R6 went from 470R to 1k. The status LED will be about half as bright at 3.3 V. Intended?' },
    { who: 'Designer', body: 'Yes. It was too bright behind the enclosure window, and it saves about 2 mA.' },
  ],
};

const refOf = (c: Change) => c.label.split(' ')[0] ?? c.label;

function describe(c: Change): string {
  const pos = c.fields.find((f) => f.field === 'position');
  if (pos && Array.isArray(pos.before) && Array.isArray(pos.after)) {
    const d = Math.hypot((pos.after[0] as number) - (pos.before[0] as number), (pos.after[1] as number) - (pos.before[1] as number));
    return `Moved ${d.toFixed(1)} mm`;
  }
  const value = c.fields.find((f) => f.field === 'value');
  if (value) return `${String(value.before)} → ${String(value.after)}`;
  if (c.fields.length) return c.fields.map((f) => f.field).slice(0, 3).join(', ');
  return OP_WORD[c.op];
}

const pcbOf = (d: ParsedDesign): Pcb | null => (d.kind === 'pcb' ? d.model : null);

export function LiveDemo() {
  const { data, error } = useLiveData();
  return data ? <ReviewWindow data={data} /> : <ReviewSkeleton error={error} />;
}

/** The window's own frame while the board data arrives: no spinner, no progress text. */
function ReviewSkeleton({ error }: { error: string | null }) {
  return (
    <div className="lp-rv" aria-busy={!error}>
      <div className="lp-rv-bar">
        <span className="font-mono text-[12.5px] text-[var(--lp-muted)]">RoyalBlue54L-Feather.kicad_pcb</span>
      </div>
      <div className="lp-rv-body">
        <div className="lp-live-shimmer relative" style={{ height: canvasHeight() }}>
          {error && <p className="absolute inset-0 flex items-center justify-center p-6 text-sm text-[var(--lp-muted)]">The board could not load in this browser: {error}</p>}
        </div>
        <div className="lp-rv-side" />
      </div>
    </div>
  );
}

function ReviewWindow({ data }: { data: Packed }) {
  const theme = useResolvedTheme();
  const viewer = useRef<DesignViewerHandle>(null);
  const [height] = useState(canvasHeight);
  const [view, setView] = useState<View>('changes');
  const [tab, setTab] = useState<Tab>('changes');
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ ref: string; label: string; at: { x: number; y: number }; bbox: DesignSelection['bbox']; net?: string | null } | null>(null);
  const [threads, setThreads] = useState<Thread[]>([EXAMPLE_THREAD]);
  const [draft, setDraft] = useState('');

  const a = pcbOf(data.a)!;
  const b = pcbOf(data.b)!;
  const changes = data.diff.changes;

  const footprint = (c: Change): Footprint | undefined => (c.op === 'removed' ? a : b).footprints.find((f) => f.uuid === c.id);
  const rows: Row[] = useMemo(
    () =>
      changes
        .filter((c) => c.object === 'footprint')
        .map((c) => {
          const fp = footprint(c);
          return { change: c, ref: refOf(c), what: describe(c), part: fp ? fp.value : null };
        }),
    [changes], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const routing = changes.filter((c) => c.object !== 'footprint');

  const ops = useMemo(() => new Map(changes.map((c) => [c.id, c.op as DiffOp])), [changes]);
  const paint: DiffPaint = useMemo(() => {
    const keep = (want: DiffOp[]) => new Map([...ops].filter(([, op]) => want.includes(op)));
    if (view === 'before') return { ops: keep(['removed', 'modified']), theme, removedFrom: a, look: LOOK };
    if (view === 'after') return { ops: keep(['added', 'modified']), theme, look: LOOK };
    return { ops, theme, removedFrom: a, look: LOOK };
  }, [ops, view, theme, a]);
  const design = view === 'before' ? data.a : data.b;

  const byRef = (ref: string) => [...b.footprints, ...a.footprints].find((f) => f.reference === ref);
  const markers: Marker[] = useMemo(() => {
    const m: Marker[] = [];
    for (const t of threads) {
      const at = t.at ?? byRef(t.ref)?.at;
      if (at) m.push({ id: `thread:${t.id}`, kind: 'comment', at });
    }
    const focus = changes.find((c) => c.id === active);
    if (focus?.bbox) m.push({ id: 'focus', kind: focus.op as DiffOp, bbox: focus.bbox });
    return m;
  }, [threads, active, changes]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusChange = (c: Change) => {
    setActive(c.id);
    if (c.bbox) viewer.current?.focus(c.bbox);
    const ref = refOf(c);
    const fp = byRef(ref);
    if (c.object === 'footprint' && fp?.bbox) setSelected({ ref, label: `${ref} · ${fp.value}`, at: fp.at, bbox: fp.bbox });
  };

  // A click on the board selects that part's change, if it has one, and makes whatever was clicked the comment target.
  // Clicking a track, via or pad also lights up its whole net.
  const onSelect = (sel: DesignSelection | null) => {
    if (!sel) return setSelected(null);
    const ref = 'reference' in sel ? sel.reference : null;
    const net = 'net' in sel ? (sel.net as string | null) : null;
    const hit = changes.find((c) => c.id === sel.id) ?? (ref ? changes.find((c) => c.object === 'footprint' && refOf(c) === ref) : undefined);
    setActive(hit?.id ?? null);
    if (sel.kind === 'footprint' && ref) {
      const fp = byRef(ref);
      if (fp?.bbox) return setSelected({ ref, label: `${ref} · ${fp.value}`, at: fp.at, bbox: fp.bbox, net: null });
    }
    const label = sel.label.replace(/\s+/g, ' ').slice(0, 80);
    setSelected({ ref: sel.kind === 'pad' && ref ? ref : label, label, at: sel.at, bbox: sel.bbox, net });
  };

  const post = () => {
    const body = draft.trim();
    if (!body || !selected) return;
    setThreads((ts) => {
      const existing = ts.find((t) => t.ref === selected.ref && !t.example);
      if (existing) return ts.map((t) => (t === existing ? { ...t, messages: [...t.messages, { who: 'You', body }] } : t));
      return [...ts, { id: `local-${Date.now()}`, ref: selected.ref, at: selected.at, example: false, messages: [{ who: 'You', body }] }];
    });
    setDraft('');
  };

  const openThread = (t: Thread) => {
    const fp = byRef(t.ref);
    if (!fp && t.at) {
      viewer.current?.focus({ minX: t.at.x - 2, minY: t.at.y - 2, maxX: t.at.x + 2, maxY: t.at.y + 2 });
      return;
    }
    if (fp?.bbox) {
      viewer.current?.focus(fp.bbox);
      setSelected({ ref: t.ref, label: `${t.ref} · ${fp.value}`, at: fp.at, bbox: fp.bbox });
      const c = changes.find((x) => x.object === 'footprint' && refOf(x) === t.ref);
      setActive(c?.id ?? null);
    }
  };

  const counts = { added: 0, removed: 0, modified: 0 };
  for (const r of rows) counts[r.change.op as DiffOp]++;

  return (
    <div className="lp-rv">
      <div className="lp-rv-bar">
        <span className="lp-rv-file truncate font-mono text-[12.5px]">
          RoyalBlue54L-Feather.kicad_pcb <span className="text-[var(--lp-muted)]">· Rev A → Rev B</span>
        </span>
        <div role="radiogroup" aria-label="Revision" className="lp-rv-seg ml-auto">
          {(
            [
              ['before', 'Rev A'],
              ['changes', 'Changes'],
              ['after', 'Rev B'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={view === id} onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="lp-rv-body">
        <div className="relative min-w-0">
          <DesignViewer ref={viewer} bare design={design} diff={paint} markers={markers} height={height} onSelect={onSelect} />
          <div className="lp-rv-legend" aria-hidden>
            <span data-op="added">Added</span>
            <span data-op="removed">Removed</span>
            <span data-op="modified">Changed</span>
          </div>
          <button type="button" className="lp-rv-fit" onClick={() => viewer.current?.fit()} aria-label="Show the whole board" title="Show the whole board">
            <Maximize2 size={15} />
          </button>
        </div>

        <aside className="lp-rv-side">
          <div role="tablist" aria-label="Review" className="lp-rv-tabs">
            <button role="tab" aria-selected={tab === 'changes'} onClick={() => setTab('changes')}>
              Changes <span className="lp-rv-count">{rows.length}</span>
            </button>
            <button role="tab" aria-selected={tab === 'comments'} onClick={() => setTab('comments')}>
              Comments <span className="lp-rv-count">{threads.length}</span>
            </button>
          </div>

          {tab === 'changes' ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <p className="px-4 pb-2 pt-3 text-[13px] text-[var(--lp-muted)]">
                {counts.added} added · {counts.removed} removed · {counts.modified} changed, matched by KiCad UUID.
              </p>
              <ul>
                {rows.map((r) => (
                  <li key={r.change.id}>
                    <button
                      type="button"
                      data-op={r.change.op}
                      aria-pressed={active === r.change.id}
                      onClick={() => focusChange(r.change)}
                      onMouseEnter={() => setActive(r.change.id)}
                      className={cx('lp-rv-row', active === r.change.id && 'is-on')}
                    >
                      <span className="lp-rv-dot" aria-hidden />
                      <span className="min-w-0">
                        <span className="flex items-baseline gap-2">
                          <span className="font-mono text-[13px] font-medium">{r.ref}</span>
                          <span className="truncate text-[13px] text-[var(--lp-muted)]">{r.part}</span>
                        </span>
                        <span className="mt-0.5 block text-[13.5px]">{r.what}</span>
                      </span>
                      {threads.some((t) => t.ref === r.ref) && <MessageSquare size={14} className="ml-auto shrink-0 text-[var(--lp-muted)]" aria-label="Has comments" />}
                    </button>
                  </li>
                ))}
              </ul>
              {routing.length > 0 && (
                <div className="border-t border-[var(--lp-line)] px-4 py-3">
                  <p className="text-[13px] font-medium">Routing</p>
                  <ul className="mt-1">
                    {routing.map((c) => (
                      <li key={c.id}>
                        <button type="button" data-op={c.op} onClick={() => focusChange(c)} className="lp-rv-mini">
                          <span className="lp-rv-dot" aria-hidden />
                          <span className="truncate">{c.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {threads.map((t) => (
                <div key={t.id} className="lp-rv-thread">
                  <button type="button" onClick={() => openThread(t)} className="flex w-full items-baseline gap-2 text-left">
                    <span className="font-mono text-[13px] font-medium">{t.ref}</span>
                    <span className="text-[12.5px] text-[var(--lp-muted)]">{t.example ? 'Example thread' : 'Only in your browser'}</span>
                  </button>
                  {t.messages.map((m, i) => (
                    <div key={i} className={cx('mt-3', i > 0 && 'border-l border-[var(--lp-line)] pl-3')}>
                      <p className="text-[12.5px] font-medium">{m.who}</p>
                      <p className="mt-0.5 text-[13.5px] leading-relaxed">{m.body}</p>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className="lp-rv-compose">
            {selected ? (
              <>
                {selected.net && (
                  <p className="mb-2 flex items-center gap-2 text-[12.5px] text-[var(--lp-muted)]">
                    <span className="lp-rv-net" aria-hidden />
                    Net <span className="font-mono text-[var(--lp-ink)]">{selected.net}</span> highlighted
                  </p>
                )}
                <label htmlFor="lp-rv-draft" className="block truncate text-[12.5px] text-[var(--lp-muted)]">
                  Comment on <span className="font-mono text-[var(--lp-ink)]">{selected.label}</span>
                </label>
                <div className="mt-1.5 flex gap-2">
                  <input
                    id="lp-rv-draft"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (post(), setTab('comments'))}
                    placeholder="Ask about this part"
                    className="lp-rv-input"
                  />
                  <button
                    type="button"
                    disabled={!draft.trim()}
                    onClick={() => {
                      post();
                      setTab('comments');
                    }}
                    className="lp-rv-send"
                  >
                    Comment
                  </button>
                </div>
              </>
            ) : (
              <p className="text-[13px] text-[var(--lp-muted)]">Click a part to comment on it, or a track to follow its net.</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
