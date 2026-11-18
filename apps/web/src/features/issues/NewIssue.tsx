import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import type { IssueInfo } from '@jumper/shared';
import { Button, Flash, FormField, IconButton, Input, Select } from '@jumper/ui';
import { Markdown, useRepoMarkdownCtx } from '../../shared/components/Markdown';
import { MarkdownEditor } from '../../shared/components/MarkdownEditor';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';
import { canWrite, useRepoInfo } from '../repo/context';
import { kindPath, type IssueKind } from './IssuesPage';

type Loc = { type: 'part' | 'net' | 'location'; ref: string };

export function NewIssuePage({ kind }: { kind: IssueKind }) {
  const info = useRepoInfo();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const mdCtx = useRepoMarkdownCtx(info.owner, info.name);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState('');
  const [locs, setLocs] = useState<Loc[]>([]);
  const [draft, setDraft] = useState<Loc>({ type: 'part', ref: '' });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.post<IssueInfo>(repoPath(info.owner, info.name, '/issues'), {
        kind,
        title,
        body,
        labels: labels.split(',').map((l) => l.trim()).filter(Boolean),
        locations: locs,
      }),
    onSuccess: (issue) => {
      void qc.invalidateQueries({ queryKey: [...keys.repo(info.owner, info.name), 'issues'] });
      void navigate({ to: `/${info.owner}/${info.name}/${kindPath(kind)}/${issue.number}` as never });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const addLoc = () => {
    if (!draft.ref.trim()) return;
    setLocs([...locs, { ...draft, ref: draft.ref.trim() }]);
    setDraft({ ...draft, ref: '' });
  };
  return (
    <form
      className="max-w-3xl space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h1 className="headline text-[length:var(--t-l)]">{kind === 'issue' ? 'New issue' : 'New discussion'}</h1>
      {error && <Flash tone="danger">{error}</Flash>}
      <FormField label="Title" required>
        {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={256} autoFocus required />}
      </FormField>
      <FormField label="Description" hint="Markdown is supported. Mention collaborators with @username to notify them.">
        {(id) => <MarkdownEditor id={id} value={body} onChange={setBody} ctx={mdCtx} rows={9} />}
      </FormField>
      {kind === 'issue' && (
        <>
          <FormField label="Where in the design?" hint="Link the issue to parts or nets (R5, VBUS) so reviewers can find the spot quickly.">
            {(id) => (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as Loc['type'] })} className="w-32" aria-label="Kind">
                    <option value="part">Part</option>
                    <option value="net">Net</option>
                    <option value="location">Location</option>
                  </Select>
                  <Input id={id} value={draft.ref} onChange={(e) => setDraft({ ...draft, ref: e.target.value })} placeholder={draft.type === 'part' ? 'R5' : draft.type === 'net' ? 'VBUS' : 'Near the antenna'} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addLoc())} />
                  <IconButton label="Add" icon={<Plus size={14} />} variant="default" onClick={addLoc} />
                </div>
                {locs.length > 0 && (
                  <ul className="flex flex-wrap gap-2">
                    {locs.map((l, i) => (
                      <li key={i} className="flex items-center gap-1.5 rounded-sm border border-border px-2 py-0.5 text-xs">
                        <span className="text-fg-muted">{l.type}</span> <span className="font-mono">{l.ref}</span>
                        <button type="button" aria-label={`Remove ${l.ref}`} onClick={() => setLocs(locs.filter((_, j) => j !== i))}>
                          <X size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </FormField>
          {canWrite(info) && (
            <FormField label="Labels" hint="Comma-separated, e.g. bug, power, rev-b">
              {(id) => <Input id={id} value={labels} onChange={(e) => setLabels(e.target.value)} />}
            </FormField>
          )}
        </>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!title.trim()}>
          Submit {kind === 'issue' ? 'issue' : 'discussion'}
        </Button>
        <Button onClick={() => void navigate({ to: `/${info.owner}/${info.name}/${kindPath(kind)}` as never })}>Cancel</Button>
      </div>
      {body.trim() && (
        <details className="text-sm text-fg-muted">
          <summary className="cursor-pointer">Preview</summary>
          <div className="mt-2 rounded-md border border-border p-4 text-fg">
            <Markdown source={body} ctx={mdCtx} />
          </div>
        </details>
      )}
    </form>
  );
}

export const NewIssueRoute = () => <NewIssuePage kind="issue" />;
export const NewDiscussionRoute = () => <NewIssuePage kind="discussion" />;
