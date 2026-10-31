import { useState } from 'react';
import { ChevronDown, ChevronRight, CircuitBoard, FileCode } from 'lucide-react';
import type { CommentInfo, FileDiff } from '@pcbhub/shared';
import { isDesignFile } from '@pcbhub/shared';
import { Box, Button, Counter, SegmentedControl, cx } from '@pcbhub/ui';
import { DiffView, type LineCommentTarget } from './DiffView';
import { VisualDiff, type ObjectCommentDraft } from './VisualDiff';
import { FileIcon } from './common';

const STATUS_STYLE: Record<FileDiff['status'], string> = {
  added: 'text-success',
  deleted: 'text-danger',
  modified: 'text-attention',
  renamed: 'text-fg-muted',
  copied: 'text-fg-muted',
  type_changed: 'text-fg-muted',
};

function DiffStat({ add, del }: { add: number; del: number }) {
  const total = add + del || 1;
  const greens = Math.round((add / total) * 5);
  return (
    <span className="flex items-center gap-1.5 font-mono text-xs">
      <span className="text-success">+{add}</span>
      <span className="text-danger">−{del}</span>
      <span className="flex gap-px">
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className={cx('h-2 w-2 rounded-[1px]', i < greens ? 'bg-success-emphasis' : add + del ? 'bg-danger-emphasis' : 'bg-neutral-muted')} />
        ))}
      </span>
    </span>
  );
}

function FileCard({
  file,
  owner,
  repo,
  baseSha,
  headSha,
  comments,
  onLineComment,
  onObjectComment,
  defaultOpen,
}: {
  file: FileDiff;
  owner: string;
  repo: string;
  baseSha: string | null;
  headSha: string;
  comments: CommentInfo[];
  onLineComment?: (path: string, t: LineCommentTarget, body: string) => Promise<unknown>;
  onObjectComment?: (d: ObjectCommentDraft, body: string) => Promise<unknown>;
  defaultOpen: boolean;
}) {
  const design = isDesignFile(file.path);
  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<'visual' | 'source'>(design ? 'visual' : 'source');
  const mine = comments.filter((c) => c.anchor?.path === file.path);

  return (
    <Box id={`file-${file.path}`} className="scroll-mt-20 overflow-hidden">
      <div className="sticky top-14 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-canvas-subtle px-3 py-2">
        <button onClick={() => setOpen((o) => !o)} aria-label={open ? 'Collapse file' : 'Expand file'} className="text-fg-muted hover:text-fg">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <DiffStat add={file.additions} del={file.deletions} />
        <FileIcon name={file.path} type="blob" />
        <span className="min-w-0 truncate font-mono text-sm">
          {file.oldPath && file.oldPath !== file.path && <span className="text-fg-muted">{file.oldPath} → </span>}
          {file.path}
        </span>
        <span className={cx('text-xs capitalize', STATUS_STYLE[file.status])}>{file.status.replace('_', ' ')}</span>
        {mine.length > 0 && <Counter>{mine.length}</Counter>}
        {design && open && (
          <span className="ml-auto">
            <SegmentedControl
              size="sm"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'visual', label: 'Visual', icon: <CircuitBoard size={12} /> },
                { value: 'source', label: 'Source', icon: <FileCode size={12} /> },
              ]}
            />
          </span>
        )}
      </div>
      {open && tab === 'visual' && design && (
        <VisualDiff
          owner={owner}
          repo={repo}
          path={file.path}
          oldPath={file.oldPath}
          baseSha={file.status === 'added' ? null : baseSha}
          headSha={headSha}
          comments={mine}
          onObjectComment={onObjectComment}
        />
      )}
      {open && tab === 'source' && (
        <>
          {file.binary && <div className="p-4 text-sm text-fg-muted">Binary file not shown.</div>}
          {!file.binary && file.patch === null && <div className="p-4 text-sm text-fg-muted">Diff too large to display{design ? '; use the visual diff instead' : ''}.</div>}
          {!file.binary && file.patch !== null && file.patch === '' && <div className="p-4 text-sm text-fg-muted">No textual changes (mode or rename only).</div>}
          {!file.binary && file.patch && (
            <DiffView patch={file.patch} comments={mine} onComment={onLineComment ? (t, body) => onLineComment(file.path, t, body) : undefined} />
          )}
        </>
      )}
    </Box>
  );
}

export function FilesChanged({
  owner,
  repo,
  files,
  baseSha,
  headSha,
  comments = [],
  onLineComment,
  onObjectComment,
}: {
  owner: string;
  repo: string;
  files: FileDiff[];
  baseSha: string | null;
  headSha: string;
  comments?: CommentInfo[];
  onLineComment?: (path: string, t: LineCommentTarget, body: string) => Promise<unknown>;
  onObjectComment?: (d: ObjectCommentDraft, body: string) => Promise<unknown>;
}) {
  const [expandAll, setExpandAll] = useState(0);
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const designs = files.filter((f) => isDesignFile(f.path));
  // Each visual diff uses WebGL contexts; only open the first design file automatically.
  const firstDesign = designs[0]?.path;

  if (!files.length) return <div className="py-10 text-center text-fg-muted">No files changed.</div>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>
          <strong>{files.length}</strong> file{files.length === 1 ? '' : 's'} changed
          {designs.length > 0 && <span className="text-fg-muted"> · {designs.length} design file{designs.length === 1 ? '' : 's'}</span>}
        </span>
        <DiffStat add={adds} del={dels} />
        <Button size="sm" className="ml-auto" onClick={() => setExpandAll((n) => n + 1)}>
          Expand all text diffs
        </Button>
      </div>
      <details className="rounded-md border border-border text-sm">
        <summary className="cursor-pointer px-3 py-2 text-fg-muted">File list</summary>
        <ul className="border-t border-border-muted px-3 py-2">
          {files.map((f) => (
            <li key={f.path}>
              <a href={`#file-${f.path}`} className="link-muted font-mono text-xs">
                {f.path}
              </a>
            </li>
          ))}
        </ul>
      </details>
      {files.map((f) => (
        <FileCard
          key={`${f.path}-${expandAll}`}
          file={f}
          owner={owner}
          repo={repo}
          baseSha={baseSha}
          headSha={headSha}
          comments={comments}
          onLineComment={onLineComment}
          onObjectComment={onObjectComment}
          defaultOpen={isDesignFile(f.path) ? f.path === firstDesign && expandAll === 0 : expandAll > 0 || files.length <= 30}
        />
      ))}
    </div>
  );
}
