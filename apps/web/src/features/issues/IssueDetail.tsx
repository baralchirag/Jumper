import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleDot, MapPin, Pencil, Trash2 } from 'lucide-react';
import type { IssueCommentInfo, IssueInfo, MilestoneInfo } from '@jumper/shared';
import { Box, BoxHeader, Button, Flash, IconButton, Input, Label, PageSpinner, RelativeTime, Select } from '@jumper/ui';
import { ErrorView, UserLink } from '../../shared/components/common';
import { Markdown, useRepoMarkdownCtx } from '../../shared/components/Markdown';
import { MarkdownEditor } from '../../shared/components/MarkdownEditor';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys, useMe } from '../../shared/lib/queries';
import { canWrite, useRepoInfo } from '../repo/context';
import { StateIcon, kindPath, useIssueNumber, type IssueKind } from './IssuesPage';

interface Detail {
  issue: IssueInfo;
  comments: IssueCommentInfo[];
}

function CommentBox({ author, date, body, mdCtx, actions }: { author: IssueInfo['author']; date: string; body: string; mdCtx: ReturnType<typeof useRepoMarkdownCtx>; actions?: React.ReactNode }) {
  return (
    <Box>
      <BoxHeader className="gap-2 text-sm">
        <UserLink user={author} />
        <span className="text-fg-muted">
          commented <RelativeTime date={date} />
        </span>
        <span className="ml-auto flex">{actions}</span>
      </BoxHeader>
      <div className="p-4">{body.trim() ? <Markdown source={body} ctx={mdCtx} /> : <em className="text-fg-muted">No description provided.</em>}</div>
    </Box>
  );
}

function Triage({ issue }: { issue: IssueInfo }) {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const key = [...keys.repo(info.owner, info.name), 'issue', issue.number];
  const milestones = useQuery({ queryKey: [...keys.repo(info.owner, info.name), 'milestones'], queryFn: () => api.get<MilestoneInfo[]>(repoPath(info.owner, info.name, '/milestones')) });
  const [labels, setLabels] = useState(issue.labels.join(', '));
  const [assignee, setAssignee] = useState(issue.assignee?.username ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(repoPath(info.owner, info.name, `/issues/${issue.number}`), body),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: keys.repo(info.owner, info.name) });
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <div className="space-y-5 text-sm">
      {error && <Flash tone="danger">{error}</Flash>}
      <section>
        <h3 className="mb-1.5 text-xs font-medium text-fg-muted">Assignee</h3>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ assignee: assignee.trim() || null });
          }}
        >
          <Input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="username" aria-label="Assignee" />
          <Button type="submit" size="sm">
            Set
          </Button>
        </form>
      </section>
      <section>
        <h3 className="mb-1.5 text-xs font-medium text-fg-muted">Labels</h3>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ labels: labels.split(',').map((l) => l.trim()).filter(Boolean) });
          }}
        >
          <Input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="bug, power, rev-b" aria-label="Labels" />
          <Button type="submit" size="sm">
            Set
          </Button>
        </form>
      </section>
      {issue.kind === 'issue' && (
        <section>
          <h3 className="mb-1.5 text-xs font-medium text-fg-muted">Milestone</h3>
          <Select value={issue.milestone?.id ?? ''} onChange={(e) => save.mutate({ milestoneId: e.target.value || null })} aria-label="Milestone">
            <option value="">No milestone</option>
            {milestones.data?.filter((m) => m.state === 'open' || m.id === issue.milestone?.id).map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </Select>
        </section>
      )}
    </div>
  );
}

export function IssueDetailPage({ kind }: { kind: IssueKind }) {
  const info = useRepoInfo();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const number = useIssueNumber();
  const mdCtx = useRepoMarkdownCtx(info.owner, info.name);
  const key = [...keys.repo(info.owner, info.name), 'issue', number];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<Detail>(repoPath(info.owner, info.name, `/issues/${number}`)) });
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: '', body: '' });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: [...keys.repo(info.owner, info.name), 'issues'] });
  };
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(repoPath(info.owner, info.name, `/issues/${number}`), body),
    onSuccess: () => {
      setError(null);
      setEditing(false);
      refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const post = useMutation({
    mutationFn: () => api.post(repoPath(info.owner, info.name, `/issues/${number}/comments`), { body: comment }),
    onSuccess: () => {
      setComment('');
      setError(null);
      refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(repoPath(info.owner, info.name, `/issue-comments/${id}`)),
    onSuccess: refresh,
  });

  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} />;
  const { issue, comments } = q.data!;
  const mine = me?.id === issue.author.id;
  const triage = canWrite(info);
  const closedLabel = issue.kind === 'discussion' ? 'Close discussion' : 'Close issue';
  const base = `/${info.owner}/${info.name}/${kindPath(kind)}`;

  return (
    <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-w-0 space-y-4">
        {editing ? (
          <div className="space-y-2">
            <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Title" />
            <MarkdownEditor value={draft.body} onChange={(v) => setDraft({ ...draft, body: v })} ctx={mdCtx} rows={8} />
            <div className="flex gap-2">
              <Button variant="primary" loading={patch.isPending} onClick={() => patch.mutate(draft)}>
                Save
              </Button>
              <Button onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <header>
            <div className="flex items-start gap-3">
              <h1 className="headline flex-1 text-[length:var(--t-l)]">
                {issue.title} <span className="font-normal text-fg-subtle">#{issue.number}</span>
              </h1>
              {(mine || triage) && (
                <IconButton
                  label="Edit"
                  icon={<Pencil size={14} />}
                  onClick={() => {
                    setDraft({ title: issue.title, body: issue.body });
                    setEditing(true);
                  }}
                />
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
              <span className={`inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-[13px] font-medium text-white ${issue.state === 'open' ? 'bg-success-emphasis' : 'bg-done'}`}>
                <StateIcon issue={issue} size={14} /> {issue.state === 'open' ? 'Open' : 'Closed'}
              </span>
              <span>
                {issue.author.username} opened this <RelativeTime date={issue.createdAt} /> · {comments.length} comment{comments.length === 1 ? '' : 's'}
              </span>
            </div>
          </header>
        )}
        {error && <Flash tone="danger">{error}</Flash>}

        {!editing && <CommentBox author={issue.author} date={issue.createdAt} body={issue.body} mdCtx={mdCtx} />}
        {issue.locations.length > 0 && (
          <Box>
            <BoxHeader className="text-sm font-medium">
              <MapPin size={14} /> Linked to the design
            </BoxHeader>
            <ul className="space-y-1 p-3 text-sm">
              {issue.locations.map((l, i) => (
                <li key={i} className="flex items-center gap-2">
                  <Label>{l.type}</Label>
                  <span className="font-mono">{l.ref}</span>
                  {l.type === 'location' && l.x !== undefined && l.file && (
                    <Link to="/$owner/$repo/blob/$ref/$" params={{ owner: info.owner, repo: info.name, ref: info.defaultBranch, _splat: l.file }} search={{ x: l.x, y: l.y }} className="link text-xs">
                      Show on board
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </Box>
        )}

        {comments.map((c) => (
          <CommentBox
            key={c.id}
            author={c.author}
            date={c.createdAt}
            body={c.body}
            mdCtx={mdCtx}
            actions={
              (me?.id === c.author.id || info.permission === 'admin') && (
                <IconButton label="Delete comment" size="sm" icon={<Trash2 size={13} />} onClick={() => confirm('Delete this comment?') && del.mutate(c.id)} />
              )
            }
          />
        ))}

        {me ? (
          <Box className="p-4">
            <MarkdownEditor value={comment} onChange={setComment} ctx={mdCtx} placeholder="Leave a comment. Mention people with @username." onSubmit={() => comment.trim() && post.mutate()} />
            <div className="mt-3 flex justify-end gap-2">
              {(mine || triage) && (
                <Button
                  onClick={() => patch.mutate({ state: issue.state === 'open' ? 'closed' : 'open' })}
                  leadingIcon={issue.state === 'open' ? <CircleCheck size={14} /> : <CircleDot size={14} />}
                >
                  {issue.state === 'open' ? closedLabel : 'Reopen'}
                </Button>
              )}
              <Button variant="primary" disabled={!comment.trim()} loading={post.isPending} onClick={() => post.mutate()}>
                Comment
              </Button>
            </div>
          </Box>
        ) : (
          <Flash action={<Link to="/login" search={{ redirect: `${base}/${number}` }} className="link">Sign in</Link>}>Sign in to join the conversation.</Flash>
        )}
        <button className="link text-sm" onClick={() => void navigate({ to: `${base}` as never })}>
          ← Back to {kind === 'issue' ? 'issues' : 'discussions'}
        </button>
      </div>

      <aside className="space-y-5">
        <Box className="p-4">
          {triage ? <Triage issue={issue} /> : (
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-fg-muted">Assignee</dt>
                <dd>{issue.assignee?.username ?? 'Nobody'}</dd>
              </div>
              <div>
                <dt className="text-xs text-fg-muted">Labels</dt>
                <dd className="flex flex-wrap gap-1">{issue.labels.length ? issue.labels.map((l) => <Label key={l}>{l}</Label>) : 'None'}</dd>
              </div>
              {issue.kind === 'issue' && (
                <div>
                  <dt className="text-xs text-fg-muted">Milestone</dt>
                  <dd>{issue.milestone?.title ?? 'None'}</dd>
                </div>
              )}
            </dl>
          )}
        </Box>
      </aside>
    </div>
  );
}

export const IssueRoute = () => <IssueDetailPage kind="issue" />;
export const DiscussionRoute = () => <IssueDetailPage kind="discussion" />;
