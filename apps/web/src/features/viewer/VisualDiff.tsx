import { Suspense, lazy, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, MessageSquare, RotateCcw, SquareDashed, Trash2 } from 'lucide-react';
import type { BBox, BomChange, Change, DiffResult, ParsedDesign, Pcb, Pt } from '@jumper/kicad-core/types';
import type { CommentAnchor, CommentInfo } from '@jumper/shared';
import type { DiffOp, DiffPaint, Marker, MarkerKind } from '@jumper/viewer';
import { Avatar, Button, Flash, IconButton, RelativeTime, SegmentedControl, Spinner, cx } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { loadDesign } from './kicad';
import { keys, useMe } from '../../shared/lib/queries';
import { useResolvedTheme } from '../../shared/lib/theme';
import { CommentForm } from '../diff/Comments';
import { Markdown } from '../../shared/components/Markdown';
import { DesignViewer, type DesignSelection, type DesignViewerHandle } from './DesignViewer';
import { RepoContext, canWrite } from '../repo/context';

export interface SemanticDiffResponse {
  path: string;
  baseOid: string | null;
  headOid: string | null;
  diff: DiffResult;
  bom: BomChange[] | null;
}

/** Kept for callers that still pass object comments in; the review workspace now stores its own. */
export interface ObjectCommentDraft {
  path: string;
  commitSha: string;
  objectType: string;
  objectId: string;
  label: string;
  x: number;
  y: number;
}

type Mode = 'changes' | 'side' | 'swipe' | '3d';
type Tab = 'changes' | 'comments';
type Comment = CommentInfo & { commitSha: string; path: string };
type Target = { objectType: string; objectId: string; label: string; at: Pt; bbox: BBox | null; commitSha: string };

const Viewer3DPanel = lazy(() => import('./Viewer3DPanel').then((m) => ({ default: m.Viewer3DPanel })));

const OP_WORD: Record<DiffOp, string> = { added: 'Added', removed: 'Removed', modified: 'Changed' };
const SCH_TINT = 0xe07b39;

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number')) return `(${(v[0] as number).toFixed(3)}, ${(v[1] as number).toFixed(3)})`;
  if (typeof v === 'number') return String(Math.round(v * 1e4) / 1e4);
  if (typeof v === 'string') return v || '""';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

/** One line a reviewer can read: "Moved 1.6 mm", "470R → 1k", or the fields that changed. */
function describe(c: Change): string {
  const pos = c.fields.find((f) => f.field === 'position');
  if (pos && Array.isArray(pos.before) && Array.isArray(pos.after)) {
    const d = Math.hypot((pos.after[0] as number) - (pos.before[0] as number), (pos.after[1] as number) - (pos.before[1] as number));
    const rest = c.fields.filter((f) => f.field !== 'position').map((f) => f.field);
    return `Moved ${d.toFixed(2)} mm${rest.length ? `, ${rest.join(', ')}` : ''}`;
  }
  const value = c.fields.find((f) => f.field === 'value');
  if (value) return `${fmt(value.before)} → ${fmt(value.after)}`;
  if (c.fields.length) return c.fields.map((f) => f.field).slice(0, 4).join(', ');
  return OP_WORD[c.op as DiffOp];
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

function uuidsOf(d: ParsedDesign | null): Set<string> {
  if (!d) return new Set();
  if (d.kind === 'pcb') return new Set([...d.model.footprints.map((f) => f.uuid), ...d.model.tracks.map((t) => t.uuid), ...d.model.vias.map((v) => v.uuid), ...d.model.zones.map((z) => z.uuid)]);
  return new Set(d.model.symbols.map((s) => s.uuid).filter((u): u is string => Boolean(u)));
}

function ChangeRow({ change, onFocus, onHover, active }: { change: Change; onFocus: (c: Change) => void; onHover: (c: Change) => void; active: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <div ref={ref} data-op={change.op} className={cx('rv-row', active && 'is-on')}>
      <div className="flex items-start gap-2.5 px-3 py-2">
        <span className="rv-dot" aria-hidden />
        <button type="button" onClick={() => onFocus(change)} onMouseEnter={() => onHover(change)} className="min-w-0 flex-1 text-left" title={change.label}>
          <span className="block truncate font-mono text-[12.5px] font-medium text-fg">{change.label}</span>
          <span className="mt-0.5 block truncate text-[12.5px] text-fg-muted">
            <span className="text-fg-subtle">{change.object}</span> · {describe(change)}
          </span>
        </button>
        {change.fields.length > 0 && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Hide fields' : 'Show fields'} aria-expanded={open} className="mt-0.5 text-fg-subtle hover:text-fg">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
      </div>
      {open && (
        <table className="mb-2 ml-8 mr-3 font-mono text-[11.5px]">
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

function ThreadView({
  root,
  replies,
  stale,
  canModerate,
  meId,
  onLocate,
  onReply,
  onResolve,
  onDelete,
}: {
  root: Comment;
  replies: Comment[];
  stale: boolean;
  canModerate: boolean;
  meId: string | null;
  onLocate: () => void;
  onReply: ((body: string) => Promise<unknown>) | null;
  onResolve: (resolved: boolean) => void;
  onDelete: (c: Comment) => void;
}) {
  const [replying, setReplying] = useState(false);
  const a = root.anchor?.type === 'object' ? root.anchor : null;
  const where = a ? (a.objectType === 'region' ? 'Area' : (a.label ?? a.objectId)) : root.path;
  return (
    <div className={cx('border-b border-border px-3 py-3', root.resolved && 'opacity-70')}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onLocate} className="min-w-0 flex-1 truncate text-left font-mono text-[12.5px] font-medium hover:text-accent">
          {where}
        </button>
        {stale && <span className="text-[11.5px] text-fg-subtle" title="Written on an earlier commit; the part is still on this board">earlier commit</span>}
        {(canModerate || root.author.id === meId) && (
          <IconButton
            size="sm"
            label={root.resolved ? 'Reopen thread' : 'Resolve thread'}
            title={root.resolved ? 'Reopen' : 'Resolve'}
            icon={root.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
            onClick={() => onResolve(!root.resolved)}
          />
        )}
      </div>
      {[root, ...replies].map((c, i) => (
        <div key={c.id} className={cx('group/c mt-2.5', i > 0 && 'border-l border-border pl-3')}>
          <div className="flex items-center gap-1.5 text-[12px]">
            <Avatar name={c.author.username} src={c.author.avatarUrl} size={16} />
            <span className="font-medium">{c.author.username}</span>
            <RelativeTime date={c.createdAt} className="text-fg-subtle" />
            {(c.author.id === meId || canModerate) && (
              <button type="button" onClick={() => onDelete(c)} aria-label="Delete comment" className="ml-auto text-fg-subtle opacity-0 hover:text-danger focus:opacity-100 group-hover/c:opacity-100">
                <Trash2 size={12} />
              </button>
            )}
          </div>
          <div className="markdown-body mt-1 text-[13px]">
            <Markdown source={c.body} ctx={{ breaks: true }} />
          </div>
        </div>
      ))}
      {root.resolved ? (
        <p className="mt-2 text-[12px] text-fg-muted">Resolved</p>
      ) : onReply ? (
        replying ? (
          <div className="mt-2">
            <CommentForm autoFocus placeholder="Reply" submitLabel="Reply" onCancel={() => setReplying(false)} onSubmit={async (b) => (await onReply(b), setReplying(false))} />
          </div>
        ) : (
          <button type="button" onClick={() => setReplying(true)} className="mt-2 text-[12.5px] text-fg-muted hover:text-fg">
            Reply
          </button>
        )
      ) : null}
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
  const theme = useResolvedTheme();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const repoInfo = useContext(RepoContext);
  const semantic = useQuery({
    queryKey: [...keys.repo(owner, repo), 'semantic', baseSha, headSha, path, oldPath],
    queryFn: () => api.get<SemanticDiffResponse>(repoPath(owner, repo, '/semantic-diff'), { base: baseSha ?? undefined, head: headSha, path, oldPath: oldPath ?? undefined }),
    staleTime: Infinity,
  });
  const existedBefore = Boolean(semantic.data?.baseOid);
  const existsAfter = Boolean(semantic.data?.headOid);
  const before = useDesign(owner, repo, existedBefore ? baseSha : null, oldPath || path);
  const after = useDesign(owner, repo, existsAfter ? headSha : null, path);

  const commentsKey = [...keys.repo(owner, repo), 'commit-comments', path];
  const comments = useQuery({
    queryKey: commentsKey,
    queryFn: () => api.get<{ comments: Comment[] }>(repoPath(owner, repo, '/commit-comments'), { path }),
    staleTime: 30_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: commentsKey });
  const post = useMutation({
    mutationFn: (b: { body: string; commitSha: string; anchor?: CommentAnchor | null; inReplyTo?: string | null }) => api.post<Comment>(repoPath(owner, repo, '/commit-comments'), { path, ...b }),
    onSuccess: refresh,
  });
  const patch = useMutation({ mutationFn: (v: { id: string; resolved: boolean }) => api.patch(repoPath(owner, repo, `/commit-comments/${v.id}`), { resolved: v.resolved }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(repoPath(owner, repo, `/commit-comments/${id}`)), onSuccess: refresh });

  const [mode, setMode] = useState<Mode>('changes');
  const [tab, setTab] = useState<Tab>('changes');
  const [swipe, setSwipe] = useState(50);
  const [filter, setFilter] = useState<'all' | DiffOp>('all');
  const [active, setActive] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [areaMode, setAreaMode] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const left = useRef<DesignViewerHandle>(null);
  const right = useRef<DesignViewerHandle>(null);

  const diff = semantic.data?.diff;
  const b: ParsedDesign | null = before.data ?? null;
  const a: ParsedDesign | null = after.data ?? null;
  const isPcb = (a ?? b)?.kind === 'pcb';
  const changes = useMemo(() => (diff?.changes ?? []).filter((c) => filter === 'all' || c.op === filter), [diff, filter]);

  // Review drawing for boards: the board quiet, only the change in colour, removed parts taken from the old side.
  const ops = useMemo(() => new Map((diff?.changes ?? []).map((c) => [c.id, c.op as DiffOp])), [diff]);
  const paintFor = (side: 'before' | 'after' | 'both'): DiffPaint | null => {
    if (!isPcb) return null;
    const keep = (want: DiffOp[]) => new Map([...ops].filter(([, op]) => want.includes(op)));
    const removedFrom = b?.kind === 'pcb' ? (b.model as Pcb) : null;
    if (side === 'before') return { ops: keep(['removed', 'modified']), theme, removedFrom };
    if (side === 'after') return { ops: keep(['added', 'modified']), theme };
    return { ops, theme, removedFrom };
  };
  const paintBoth = useMemo(() => paintFor('both'), [ops, theme, b, isPcb]); // eslint-disable-line react-hooks/exhaustive-deps
  const paintBefore = useMemo(() => paintFor('before'), [ops, theme, b, isPcb]); // eslint-disable-line react-hooks/exhaustive-deps
  const paintAfter = useMemo(() => paintFor('after'), [ops, theme, isPcb]); // eslint-disable-line react-hooks/exhaustive-deps

  // Threads on this file: those written on these commits, and older ones whose part is still on the board.
  const present = useMemo(() => new Set([...uuidsOf(a), ...uuidsOf(b)]), [a, b]);
  const { threads, repliesOf } = useMemo(() => {
    const all = comments.data?.comments ?? [];
    const roots = all.filter((c) => !c.inReplyTo);
    const replies = new Map<string, Comment[]>();
    for (const c of all) if (c.inReplyTo) replies.set(c.inReplyTo, [...(replies.get(c.inReplyTo) ?? []), c]);
    const here = roots.filter((c) => {
      if (c.commitSha === headSha || c.commitSha === baseSha) return true;
      const an = c.anchor;
      return an?.type === 'object' && an.objectType !== 'region' && present.has(an.objectId);
    });
    return { threads: here, repliesOf: replies };
  }, [comments.data, headSha, baseSha, present]);
  const open = threads.filter((t) => !t.resolved);
  const shown = showResolved ? threads : open;

  const anchorMarker = (c: Comment): Marker | null => {
    const an = c.anchor;
    if (an?.type !== 'object') return null;
    if (an.bbox) return { id: c.id, kind: 'comment', bbox: { minX: an.bbox[0], minY: an.bbox[1], maxX: an.bbox[2], maxY: an.bbox[3] } };
    if (an.x !== undefined && an.y !== undefined) return { id: c.id, kind: 'comment', at: { x: an.x, y: an.y } };
    return null;
  };
  const markers = useMemo(() => {
    const out: Marker[] = [];
    // Boards show colour for every change, so only the focused one gets a box; schematics keep a box per change.
    for (const c of diff?.changes ?? []) {
      if (!c.bbox) continue;
      if (isPcb ? c.id === active : true) out.push({ id: `chg:${c.id}`, kind: c.op as MarkerKind, bbox: c.bbox });
    }
    for (const t of open) {
      const m = anchorMarker(t);
      if (m) out.push(m);
    }
    if (target) out.push(target.bbox && target.objectType === 'region' ? { id: 'target', kind: 'selection', bbox: target.bbox } : { id: 'target', kind: 'selection', at: target.at });
    return out;
  }, [diff, active, open, target, isPcb]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusBox = (bbox: BBox) => {
    left.current?.focus(bbox);
    right.current?.focus(bbox);
  };
  const focusChange = (c: Change) => {
    setActive(c.id);
    if (c.bbox) focusBox(c.bbox);
    if (c.bbox) {
      const at = { x: (c.bbox.minX + c.bbox.maxX) / 2, y: (c.bbox.minY + c.bbox.maxY) / 2 };
      setTarget({ objectType: c.object, objectId: c.id, label: c.label.slice(0, 200), at, bbox: c.bbox, commitSha: c.op === 'removed' ? (baseSha ?? headSha) : headSha });
    }
  };

  // A click on the board selects that object's change, if it has one, and makes it the comment target.
  const onSelect = (side: 'before' | 'after') => (sel: DesignSelection | null) => {
    if (!sel) return;
    const ref = 'reference' in sel ? (sel.reference as string | null) : null;
    const hit = diff?.changes.find((c) => c.id === sel.id) ?? (ref ? diff?.changes.find((c) => c.label.split(' ')[0] === ref) : undefined);
    setActive(hit?.id ?? null);
    setTarget({
      objectType: hit ? hit.object : sel.kind,
      objectId: hit ? hit.id : sel.id,
      label: (hit?.label ?? sel.label).slice(0, 200),
      at: sel.at,
      bbox: sel.bbox ?? null,
      commitSha: side === 'before' ? (baseSha ?? headSha) : headSha,
    });
    if (hit) setTab('changes');
  };

  // Drag a rectangle on the canvas to comment on an area.
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top });
  };
  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const r = e.currentTarget.getBoundingClientRect();
    setDrag({ ...drag, x1: e.clientX - r.left, y1: e.clientY - r.top });
  };
  const endDrag = () => {
    if (!drag) return;
    const v = right.current ?? left.current;
    const p0 = v?.screenToWorld(drag.x0, drag.y0);
    const p1 = v?.screenToWorld(drag.x1, drag.y1);
    setDrag(null);
    if (!p0 || !p1 || Math.abs(drag.x1 - drag.x0) < 6 || Math.abs(drag.y1 - drag.y0) < 6) return;
    const bbox = { minX: Math.min(p0.x, p1.x), minY: Math.min(p0.y, p1.y), maxX: Math.max(p0.x, p1.x), maxY: Math.max(p0.y, p1.y) };
    setTarget({ objectType: 'region', objectId: 'region', label: 'Area', at: { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 }, bbox, commitSha: headSha });
    setAreaMode(false);
    setTab('comments');
  };

  const submit = async (body: string) => {
    if (!target) return;
    const anchor: CommentAnchor = {
      type: 'object',
      path,
      commitSha: target.commitSha,
      objectType: target.objectType,
      objectId: target.objectId,
      label: target.label,
      x: target.at.x,
      y: target.at.y,
      ...(target.objectType === 'region' && target.bbox ? { bbox: [target.bbox.minX, target.bbox.minY, target.bbox.maxX, target.bbox.maxY] as [number, number, number, number] } : {}),
    };
    await post.mutateAsync({ body, commitSha: target.commitSha, anchor });
    setTarget(null);
    setTab('comments');
  };

  useEffect(() => setDrag(null), [mode]);

  if (semantic.isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-fg-muted">
        <Spinner /> Comparing the two revisions…
      </div>
    );
  }
  if (semantic.error) return <Flash tone="warning" className="m-3">The design diff is not available: {errorMessage(semantic.error)}</Flash>;
  if (!diff) return null;

  const loading = (existedBefore && before.isLoading) || (existsAfter && after.isLoading);
  const loadError = before.error || after.error;
  const s = diff.summary;
  const both = Boolean(a && b);
  const single = a ?? b;
  const canComment = Boolean(me);
  // Write access may resolve or delete anyone's thread (the server checks again); authors always may.
  const canModerate = Boolean(repoInfo && canWrite(repoInfo));

  const canvas = (h: number) => {
    if (loading) {
      return (
        <div className="flex items-center justify-center gap-2 text-sm text-fg-muted" style={{ height: h }}>
          <Spinner /> Loading both revisions…
        </div>
      );
    }
    if (loadError) return <Flash tone="danger" className="m-3">The design could not be loaded: {errorMessage(loadError)}</Flash>;
    if (mode === '3d') {
      return (
        <Suspense fallback={<div className="flex items-center justify-center gap-2 text-sm text-fg-muted" style={{ height: h }}><Spinner /> Loading 3D…</div>}>
          <div className={cx('grid', both ? 'grid-cols-2 divide-x divide-border' : 'grid-cols-1')}>
            {b?.kind === 'pcb' && (
              <div>
                <div className="rv-side-label">Before</div>
                <Viewer3DPanel pcb={b.model} height={h} />
              </div>
            )}
            {a?.kind === 'pcb' && (
              <div>
                <div className="rv-side-label">After</div>
                <Viewer3DPanel pcb={a.model} height={h} />
              </div>
            )}
          </div>
        </Suspense>
      );
    }
    if (mode === 'side' && both) {
      return (
        <div className="grid grid-cols-2 divide-x divide-border">
          <div>
            <div className="rv-side-label">Before</div>
            <DesignViewer ref={left} design={b!} diff={paintBefore} height={h} markers={markers} onViewChange={(v) => right.current?.syncView(v)} onSelect={onSelect('before')} />
          </div>
          <div>
            <div className="rv-side-label">After</div>
            <DesignViewer ref={right} design={a!} diff={paintAfter} height={h} markers={markers} onViewChange={(v) => left.current?.syncView(v)} onSelect={onSelect('after')} />
          </div>
        </div>
      );
    }
    if (mode === 'swipe' && both) {
      return (
        <div className="relative" style={{ height: h }}>
          <div className="absolute inset-0">
            <DesignViewer ref={left} bare design={b!} diff={paintBefore} height={h} markers={markers} onViewChange={(v) => right.current?.syncView(v)} />
          </div>
          <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${swipe}%)` }}>
            <DesignViewer ref={right} bare design={a!} diff={paintAfter} height={h} markers={markers} onViewChange={(v) => left.current?.syncView(v)} onSelect={onSelect('after')} />
          </div>
          <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-accent-emphasis shadow-[0_0_0_1px_#121314]" style={{ left: `${swipe}%` }} />
          <span className="rv-chip left-2">Before</span>
          <span className="rv-chip right-2">After</span>
          <input type="range" min={0} max={100} value={swipe} onChange={(e) => setSwipe(Number(e.target.value))} aria-label="Swipe position" className="absolute inset-x-6 bottom-3 accent-[var(--pcb-accent-emphasis)]" />
        </div>
      );
    }
    // Changes: one canvas, the new revision with what was removed drawn from the old one.
    const design = a ?? b!;
    return (
      <DesignViewer
        ref={right}
        design={design}
        ghost={!isPcb && both ? b : null}
        monochrome={!isPcb && both ? SCH_TINT : null}
        diff={a ? paintBoth : paintBefore}
        height={h}
        markers={markers}
        onSelect={onSelect(a ? 'after' : 'before')}
      />
    );
  };

  return (
    <div className="rv">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-canvas-subtle px-3 py-2">
        <SegmentedControl
          size="sm"
          value={mode}
          onChange={setMode}
          ariaLabel="View"
          options={[
            { value: 'changes', label: 'Changes' },
            { value: 'side', label: 'Side by side', disabled: !both },
            { value: 'swipe', label: 'Swipe', disabled: !both },
            ...(isPcb ? [{ value: '3d' as Mode, label: '3D' }] : []),
          ]}
        />
        {canComment && mode !== '3d' && (
          <Button size="sm" variant={areaMode ? 'primary' : 'default'} leadingIcon={<SquareDashed size={14} />} onClick={() => setAreaMode((v) => !v)} aria-pressed={areaMode}>
            {areaMode ? 'Drag over the board' : 'Comment on an area'}
          </Button>
        )}
        <span className="ml-auto flex items-center gap-3 text-[12.5px]">
          <span className="rv-legend" data-op="added">
            {s.added} added
          </span>
          <span className="rv-legend" data-op="removed">
            {s.removed} removed
          </span>
          <span className="rv-legend" data-op="modified">
            {s.modified} changed
          </span>
        </span>
      </div>

      <div className="flex flex-col lg:flex-row">
        <div className="relative min-w-0 flex-1">
          {single ? canvas(height) : null}
          {areaMode && mode !== '3d' && (
            <div className="absolute inset-0 z-10 cursor-crosshair" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)}>
              {drag && (
                <div
                  className="rv-area"
                  style={{ left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }}
                />
              )}
            </div>
          )}
        </div>

        <aside className="flex w-full shrink-0 flex-col border-t border-border lg:w-[340px] lg:border-l lg:border-t-0" style={{ maxHeight: height + 40 }}>
          <div role="tablist" aria-label="Review" className="flex gap-1 border-b border-border px-2">
            <button role="tab" aria-selected={tab === 'changes'} onClick={() => setTab('changes')} className="rv-tab">
              Changes <span className="rv-count">{diff.changes.length}</span>
            </button>
            <button role="tab" aria-selected={tab === 'comments'} onClick={() => setTab('comments')} className="rv-tab">
              Comments <span className="rv-count">{open.length}</span>
            </button>
          </div>

          {tab === 'changes' ? (
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="flex items-center gap-1 px-3 py-2">
                <SegmentedControl
                  size="sm"
                  value={filter}
                  onChange={setFilter}
                  ariaLabel="Show"
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'added', label: `Added ${s.added}` },
                    { value: 'removed', label: `Removed ${s.removed}` },
                    { value: 'modified', label: `Changed ${s.modified}` },
                  ]}
                />
              </div>
              {changes.length === 0 && <p className="px-4 py-6 text-center text-[12.5px] text-fg-muted">No design changes{filter !== 'all' ? ' of this kind' : ''}.</p>}
              {changes.slice(0, 1500).map((c) => (
                <ChangeRow key={`${c.object}:${c.id}`} change={c} active={active === c.id} onFocus={focusChange} onHover={(ch) => setActive(ch.id)} />
              ))}
              {changes.length > 1500 && <p className="p-2 text-center text-[12px] text-fg-muted">{changes.length - 1500} more changes not shown</p>}
              {diff.nets.length > 0 && (
                <div className="border-t border-border">
                  <p className="px-3 pb-1 pt-3 text-[12.5px] font-medium">Nets · {diff.nets.length}</p>
                  {diff.nets.slice(0, 300).map((n) => (
                    <div key={n.name} data-op={n.op} className="flex items-center gap-2.5 px-3 py-1 text-[12px]">
                      <span className="rv-dot" aria-hidden />
                      <span className="min-w-0 flex-1 truncate font-mono">{n.name}</span>
                      <span className="tabular-nums text-fg-muted" title="Routed length (mm)">
                        {n.lengthBefore.toFixed(1)} → {n.lengthAfter.toFixed(1)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {semantic.data?.bom && semantic.data.bom.length > 0 && (
                <div className="border-t border-border">
                  <p className="px-3 pb-1 pt-3 text-[12.5px] font-medium">BOM · {semantic.data.bom.length}</p>
                  {semantic.data.bom.map((bc, i) => (
                    <div key={i} data-op={bc.op} className="flex items-start gap-2.5 px-3 py-1.5 text-[12px]">
                      <span className="rv-dot" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{bc.value}</span>
                        <span className="block truncate font-mono text-[11.5px] text-fg-subtle">{bc.footprint}</span>
                      </span>
                      <span className="tabular-nums text-fg-muted">
                        {bc.quantityBefore} → {bc.quantityAfter}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              {comments.isLoading && (
                <p className="flex items-center gap-2 p-4 text-[12.5px] text-fg-muted">
                  <Spinner /> Loading comments…
                </p>
              )}
              {comments.error && <Flash tone="danger" className="m-3">{errorMessage(comments.error)}</Flash>}
              {!comments.isLoading && shown.length === 0 && (
                <div className="px-4 py-8 text-center text-[12.5px] text-fg-muted">
                  <MessageSquare size={18} className="mx-auto mb-2 text-fg-subtle" />
                  {threads.length ? 'Every thread here is resolved.' : 'No comments yet. Click a part, or comment on an area, to start one.'}
                </div>
              )}
              {shown.map((t) => (
                <ThreadView
                  key={t.id}
                  root={t}
                  replies={repliesOf.get(t.id) ?? []}
                  stale={t.commitSha !== headSha && t.commitSha !== baseSha}
                  canModerate={canModerate}
                  meId={me?.id ?? null}
                  onLocate={() => {
                    const m = anchorMarker(t);
                    if (m?.bbox) focusBox(m.bbox);
                    else if (m?.at) focusBox({ minX: m.at.x - 2, minY: m.at.y - 2, maxX: m.at.x + 2, maxY: m.at.y + 2 });
                  }}
                  onReply={canComment ? (body) => post.mutateAsync({ body, commitSha: t.commitSha, inReplyTo: t.id }) : null}
                  onResolve={(resolved) => patch.mutate({ id: t.id, resolved })}
                  onDelete={(c) => remove.mutate(c.id)}
                />
              ))}
              {threads.length > open.length && (
                <button type="button" onClick={() => setShowResolved((v) => !v)} className="w-full px-3 py-2.5 text-left text-[12.5px] text-fg-muted hover:text-fg">
                  {showResolved ? 'Hide resolved' : `Show ${threads.length - open.length} resolved`}
                </button>
              )}
            </div>
          )}

          <div className="border-t border-border bg-canvas-subtle px-3 py-3">
            {!canComment ? (
              <p className="text-[12.5px] text-fg-muted">Sign in to comment on parts and areas of this board.</p>
            ) : target ? (
              <>
                <div className="mb-1.5 flex items-center gap-2 text-[12.5px] text-fg-muted">
                  <span className="min-w-0 flex-1 truncate">
                    Comment on <span className="font-mono text-fg">{target.label}</span>
                    {target.commitSha !== headSha && ' (before)'}
                  </span>
                  <button type="button" onClick={() => setTarget(null)} className="text-fg-subtle hover:text-fg">
                    Cancel
                  </button>
                </div>
                <CommentForm key={`${target.objectId}:${target.at.x}`} placeholder="Ask about this part" submitLabel="Comment" busy={post.isPending} onSubmit={submit} />
                {post.error && <p className="mt-1 text-[12px] text-danger">{errorMessage(post.error)}</p>}
              </>
            ) : (
              <p className="text-[12.5px] text-fg-muted">Click a part on the board, or comment on an area, to start a thread.</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
