import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, MessageSquarePlus } from 'lucide-react';
import type { BBox, BomChange, Change, DiffResult, ParsedDesign } from '@jumper/kicad-core/types';
import type { CommentInfo } from '@jumper/shared';
import type { Marker, MarkerKind } from '@jumper/viewer';
import { Button, Flash, Label, SegmentedControl, Spinner, cx } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { loadDesign } from './kicad';
import { keys } from '../../shared/lib/queries';
import { CommentCard, CommentForm } from '../pulls/Comments';
import { DesignViewer, type DesignSelection, type DesignViewerHandle } from './DesignViewer';

export interface SemanticDiffResponse {
  path: string;
  baseOid: string | null;
  headOid: string | null;
  diff: DiffResult;
  bom: BomChange[] | null;
}

export interface ObjectCommentDraft {
  path: string;
  commitSha: string;
  objectType: string;
  objectId: string;
  label: string;
  x: number;
  y: number;
}

type Mode = 'side' | 'overlay' | 'swipe' | '3d';

const Viewer3DPanel = lazy(() => import('./Viewer3DPanel').then((m) => ({ default: m.Viewer3DPanel })));

const OP_TONE = { added: 'success', removed: 'danger', modified: 'attention' } as const;
const ACCENT_TINT = 0xe07b39;

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number')) return `(${(v[0] as number).toFixed(3)}, ${(v[1] as number).toFixed(3)})`;
  if (typeof v === 'number') return String(Math.round(v * 1e4) / 1e4);
  if (typeof v === 'string') return v || '""';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

function useDesign(owner: string, repo: string, sha: string | null, path: string | null) {
  return useQuery({
    queryKey: ['design', owner, repo, sha, path],
    queryFn: () => loadDesign(owner, repo, sha!, path!),
    enabled: Boolean(sha && path),
    staleTime: Infinity,
    retry: false,
  });
}

function ChangeRow({ change, onFocus, active }: { change: Change; onFocus: (c: Change) => void; active: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('border-b border-border-muted text-xs', active && 'bg-accent-subtle')}>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        {change.fields.length > 0 ? (
          <button onClick={() => setOpen((o) => !o)} aria-label="Toggle details" className="text-fg-subtle hover:text-fg">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-3" />
        )}
        <Label tone={OP_TONE[change.op]} className="!px-1.5 !text-[11.5px] uppercase">
          {change.op[0]}
        </Label>
        <button onClick={() => onFocus(change)} disabled={!change.bbox} className="min-w-0 flex-1 truncate text-left hover:text-accent disabled:hover:text-fg" title={change.label}>
          <span className="text-fg-subtle">{change.object}</span> {change.label}
        </button>
      </div>
      {open && (
        <table className="mb-1.5 ml-7 mr-2 font-mono text-xs">
          <tbody>
            {change.fields.map((f) => (
              <tr key={f.field} className="align-top">
                <td className="pr-2 text-fg-muted">{f.field}</td>
                <td className="text-danger line-through decoration-danger/40">{fmt(f.before)}</td>
                <td className="px-1 text-fg-subtle">→</td>
                <td className="text-success">{fmt(f.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function VisualDiff({
  owner,
  repo,
  path,
  oldPath,
  baseSha,
  headSha,
  comments = [],
  onObjectComment,
  height = 620,
}: {
  owner: string;
  repo: string;
  path: string;
  oldPath?: string | null;
  baseSha: string | null;
  headSha: string;
  comments?: CommentInfo[];
  onObjectComment?: (draft: ObjectCommentDraft, body: string) => Promise<unknown>;
  height?: number;
}) {
  const semantic = useQuery({
    queryKey: [...keys.repo(owner, repo), 'semantic', baseSha, headSha, path, oldPath],
    queryFn: () => api.get<SemanticDiffResponse>(repoPath(owner, repo, '/semantic-diff'), { base: baseSha ?? undefined, head: headSha, path, oldPath: oldPath ?? undefined }),
    staleTime: Infinity,
  });
  const existedBefore = Boolean(semantic.data?.baseOid);
  const existsAfter = Boolean(semantic.data?.headOid);
  const before = useDesign(owner, repo, existedBefore ? baseSha : null, oldPath || path);
  const after = useDesign(owner, repo, existsAfter ? headSha : null, path);

  const [mode, setMode] = useState<Mode>('side');
  const [tint, setTint] = useState(true);
  const [swipe, setSwipe] = useState(50);
  const [filter, setFilter] = useState<'all' | 'added' | 'removed' | 'modified'>('all');
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<ObjectCommentDraft | null>(null);
  const left = useRef<DesignViewerHandle>(null);
  const right = useRef<DesignViewerHandle>(null);

  const diff = semantic.data?.diff;
  const changes = useMemo(() => (diff?.changes ?? []).filter((c) => filter === 'all' || c.op === filter), [diff, filter]);

  const markersFor = (side: 'before' | 'after'): Marker[] => {
    const out: Marker[] = [];
    for (const c of diff?.changes ?? []) {
      if (!c.bbox) continue;
      if (side === 'before' && c.op === 'added') continue;
      if (side === 'after' && c.op === 'removed') continue;
      out.push({ id: `${c.object}:${c.id}`, kind: c.op as MarkerKind, bbox: c.bbox });
    }
    for (const cm of comments) {
      const a = cm.anchor;
      if (a?.type === 'object' && a.x !== undefined && a.y !== undefined) {
        const onAfter = a.commitSha === headSha;
        if ((side === 'after') === onAfter || mode === 'overlay') out.push({ id: cm.id, kind: 'comment', at: { x: a.x, y: a.y } });
      }
    }
    return out;
  };
  const beforeMarkers = useMemo(() => markersFor('before'), [diff, comments, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const afterMarkers = useMemo(() => markersFor('after'), [diff, comments, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const focus = (bbox: BBox, id?: string) => {
    left.current?.focus(bbox);
    right.current?.focus(bbox);
    if (id) setActive(id);
  };

  useEffect(() => setDraft(null), [mode]);

  if (semantic.isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-fg-muted">
        <Spinner /> Computing semantic diff…
      </div>
    );
  }
  if (semantic.error) return <Flash tone="warning" className="m-3">Semantic diff unavailable: {errorMessage(semantic.error)}</Flash>;
  if (!diff) return null;

  const loading = (existedBefore && before.isLoading) || (existsAfter && after.isLoading);
  const loadError = before.error || after.error;
  const b: ParsedDesign | null = before.data ?? null;
  const a: ParsedDesign | null = after.data ?? null;

  const commentAction = (side: 'before' | 'after') =>
    onObjectComment
      ? (sel: DesignSelection) => (
          <Button
            size="sm"
            variant="invisible"
            leadingIcon={<MessageSquarePlus size={12} />}
            onClick={() =>
              setDraft({
                path,
                commitSha: side === 'after' ? headSha : baseSha!,
                objectType: sel.kind,
                objectId: sel.id,
                label: sel.label.slice(0, 200),
                x: sel.at.x,
                y: sel.at.y,
              })
            }
          >
            Comment
          </Button>
        )
      : undefined;

  const objectComments = comments.filter((c) => c.anchor?.type === 'object');
  // Added/deleted files have only one side to show.
  const view: Mode | 'single' = a && b ? mode : 'single';
  const s = diff.summary;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-canvas-subtle px-3 py-2">
        <SegmentedControl
          size="sm"
          value={mode}
          onChange={setMode}
          ariaLabel="Diff mode"
          options={[
            { value: 'side', label: 'Side by side', disabled: !a || !b },
            { value: 'overlay', label: 'Overlay', disabled: !a || !b },
            { value: 'swipe', label: 'Swipe', disabled: !a || !b },
            ...((a ?? b)?.kind === 'pcb' ? [{ value: '3d' as Mode, label: '3D' }] : []),
          ]}
        />
        {mode === 'overlay' && (
          <label className="flex items-center gap-1.5 text-xs text-fg-muted">
            <input type="checkbox" checked={tint} onChange={(e) => setTint(e.target.checked)} /> Tint changes (before = grey)
          </label>
        )}
        {mode === 'swipe' && <input type="range" min={0} max={100} value={swipe} onChange={(e) => setSwipe(Number(e.target.value))} className="w-48 accent-[var(--pcb-accent-emphasis)]" aria-label="Swipe position" />}
        <span className="ml-auto flex items-center gap-2 text-xs">
          <span className="text-success">+{s.added}</span>
          <span className="text-danger">−{s.removed}</span>
          <span className="text-attention">~{s.modified}</span>
        </span>
      </div>

      <div className="flex flex-col lg:flex-row">
        <div className="min-w-0 flex-1">
          {loading && (
            <div className="flex items-center justify-center gap-2 text-sm text-fg-muted" style={{ height }}>
              <Spinner /> Loading designs…
            </div>
          )}
          {!loading && loadError && <Flash tone="danger" className="m-3">Could not load design: {errorMessage(loadError)}</Flash>}
          {!loading && !loadError && (
            <>
              {(view === 'side' || (view === 'single' && mode !== '3d')) && (
                <div className={cx('grid', a && b ? 'grid-cols-2 divide-x divide-border' : 'grid-cols-1')}>
                  {b && (
                    <div>
                      <div className="border-b border-border bg-danger-subtle px-3 py-1 text-xs font-semibold text-danger">Before</div>
                      <DesignViewer
                        ref={left}
                        design={b}
                        height={height}
                        markers={beforeMarkers}
                        onViewChange={(v) => right.current?.syncView(v)}
                        selectionAction={commentAction('before')}
                      />
                    </div>
                  )}
                  {a && (
                    <div>
                      <div className="border-b border-border bg-success-subtle px-3 py-1 text-xs font-semibold text-success">After</div>
                      <DesignViewer
                        ref={right}
                        design={a}
                        height={height}
                        markers={afterMarkers}
                        onViewChange={(v) => left.current?.syncView(v)}
                        selectionAction={commentAction('after')}
                      />
                    </div>
                  )}
                </div>
              )}
              {mode === '3d' && (
                <Suspense fallback={<div className="flex items-center justify-center gap-2 text-sm text-fg-muted" style={{ height }}><Spinner /> Loading 3D…</div>}>
                  <div className={cx('grid', a && b ? 'grid-cols-2 divide-x divide-border' : 'grid-cols-1')}>
                    {b?.kind === 'pcb' && (
                      <div>
                        <div className="border-b border-border bg-danger-subtle px-3 py-1 text-xs font-semibold text-danger">Before</div>
                        <Viewer3DPanel pcb={b.model} height={height} />
                      </div>
                    )}
                    {a?.kind === 'pcb' && (
                      <div>
                        <div className="border-b border-border bg-success-subtle px-3 py-1 text-xs font-semibold text-success">After</div>
                        <Viewer3DPanel pcb={a.model} height={height} />
                      </div>
                    )}
                  </div>
                </Suspense>
              )}
              {view === 'overlay' && a && (
                <DesignViewer ref={right} design={a} ghost={b} monochrome={tint && b ? ACCENT_TINT : null} height={height} markers={afterMarkers} selectionAction={commentAction('after')} />
              )}
              {view === 'swipe' && a && b && (
                <div className="relative" style={{ height }}>
                  <div className="absolute inset-0">
                    <DesignViewer ref={left} bare design={b} height={height} markers={beforeMarkers} onViewChange={(v) => right.current?.syncView(v)} />
                  </div>
                  <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${swipe}%)` }}>
                    <DesignViewer ref={right} bare design={a} height={height} markers={afterMarkers} onViewChange={(v) => left.current?.syncView(v)} />
                  </div>
                  <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-accent-emphasis" style={{ left: `${swipe}%` }} />
                  <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 text-xs text-white">Before</span>
                  <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-1.5 text-xs text-white">After</span>
                </div>
              )}
            </>
          )}
          {draft && onObjectComment && (
            <div className="border-t border-border bg-canvas-subtle p-3">
              <div className="mb-2 text-xs text-fg-muted">
                Commenting on <strong className="text-fg">{draft.label}</strong> ({draft.commitSha === headSha ? 'after' : 'before'})
              </div>
              <CommentForm
                autoFocus
                onCancel={() => setDraft(null)}
                onSubmit={async (body) => {
                  await onObjectComment(draft, body);
                  setDraft(null);
                }}
              />
            </div>
          )}
        </div>

        <aside className="w-full shrink-0 border-t border-border lg:w-80 lg:border-l lg:border-t-0">
          <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
            <SegmentedControl
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: `All ${diff.changes.length}` },
                { value: 'added', label: `+${s.added}` },
                { value: 'removed', label: `−${s.removed}` },
                { value: 'modified', label: `~${s.modified}` },
              ]}
            />
          </div>
          <div className="overflow-auto" style={{ maxHeight: height - 10 }}>
            {changes.length === 0 && <div className="p-4 text-center text-xs text-fg-muted">No design changes{filter !== 'all' ? ' of this type' : ''}.</div>}
            {changes.slice(0, 1500).map((c) => (
              <ChangeRow key={`${c.object}:${c.id}`} change={c} active={active === `${c.object}:${c.id}`} onFocus={(ch) => ch.bbox && focus(ch.bbox, `${ch.object}:${ch.id}`)} />
            ))}
            {changes.length > 1500 && <div className="p-2 text-center text-xs text-fg-muted">{changes.length - 1500} more changes not shown</div>}
            {diff.nets.length > 0 && (
              <div className="border-t border-border">
                <div className="bg-canvas-subtle px-2 py-1 text-xs font-semibold text-fg-muted">Nets ({diff.nets.length})</div>
                {diff.nets.slice(0, 300).map((n) => (
                  <div key={n.name} className="flex items-center gap-2 border-b border-border-muted px-2 py-1 text-xs">
                    <Label tone={OP_TONE[n.op]} className="!px-1.5 !text-[11.5px] uppercase">
                      {n.op[0]}
                    </Label>
                    <span className="min-w-0 flex-1 truncate font-mono">{n.name}</span>
                    <span className="text-fg-muted tabular-nums" title="Routed length (mm)">
                      {n.lengthBefore.toFixed(1)}→{n.lengthAfter.toFixed(1)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {semantic.data?.bom && semantic.data.bom.length > 0 && (
              <div className="border-t border-border">
                <div className="bg-canvas-subtle px-2 py-1 text-xs font-semibold text-fg-muted">BOM changes ({semantic.data.bom.length})</div>
                {semantic.data.bom.map((bc, i) => (
                  <div key={i} className="border-b border-border-muted px-2 py-1 text-xs">
                    <div className="flex items-center gap-2">
                      <Label tone={OP_TONE[bc.op]} className="!px-1.5 !text-[11.5px] uppercase">
                        {bc.op[0]}
                      </Label>
                      <span className="truncate">{bc.value}</span>
                      <span className="ml-auto tabular-nums text-fg-muted">
                        {bc.quantityBefore}→{bc.quantityAfter}
                      </span>
                    </div>
                    <div className="truncate font-mono text-[11.5px] text-fg-subtle">{bc.footprint}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      {objectComments.length > 0 && (
        <div className="space-y-2 border-t border-border bg-canvas-subtle p-3">
          {objectComments.map((c) => (
            <CommentCard
              key={c.id}
              comment={c}
              compact
              onLocate={(cm) => {
                const an = cm.anchor;
                if (an?.type === 'object' && an.x !== undefined && an.y !== undefined) focus({ minX: an.x - 1, minY: an.y - 1, maxX: an.x + 1, maxY: an.y + 1 });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
