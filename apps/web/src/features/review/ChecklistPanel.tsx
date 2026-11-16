import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, Trash2 } from 'lucide-react';
import type { ChecklistItemInfo } from '@jumper/shared';
import { Box, BoxHeader, Button, Checkbox, IconButton, Input, RelativeTime } from '@jumper/ui';
import { api, repoPath } from '../../shared/lib/api';
import { keys, useMe } from '../../shared/lib/queries';
import { canWrite, useRepoInfo } from '../repo/context';

/** Per-pull-request review checklist. The template comes from Settings → Review. */
export function ChecklistPanel({ number, authorId }: { number: number; authorId: string }) {
  const info = useRepoInfo();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const key = [...keys.repo(info.owner, info.name), 'checklist', number];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<ChecklistItemInfo[]>(repoPath(info.owner, info.name, `/pulls/${number}/checklist`)) });
  const [text, setText] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: [...keys.repo(info.owner, info.name), 'pull'] }).then(() => qc.invalidateQueries({ queryKey: key }));
  const toggle = useMutation({ mutationFn: (i: ChecklistItemInfo) => api.patch(repoPath(info.owner, info.name, `/pulls/${number}/checklist/${i.id}`), { done: !i.done }), onSuccess: refresh });
  const add = useMutation({
    mutationFn: () => api.post(repoPath(info.owner, info.name, `/pulls/${number}/checklist`), { text }),
    onSuccess: () => {
      setText('');
      void refresh();
    },
  });
  const del = useMutation({ mutationFn: (id: string) => api.delete(repoPath(info.owner, info.name, `/pulls/${number}/checklist/${id}`)), onSuccess: refresh });
  const items = q.data ?? [];
  const done = items.filter((i) => i.done).length;
  const editable = canWrite(info);
  const canAdd = editable || me?.id === authorId;
  if (q.isLoading || (items.length === 0 && !canAdd)) return null;
  return (
    <Box>
      <BoxHeader className="gap-2 text-sm font-medium">
        <ListChecks size={15} /> Review checklist
        {items.length > 0 && (
          <span className="ml-auto font-mono text-xs font-normal text-fg-muted">
            {done}/{items.length}
          </span>
        )}
      </BoxHeader>
      <ul className="divide-y divide-border-muted">
        {items.map((i) => (
          <li key={i.id} className="flex items-start gap-2 px-4 py-2">
            <div className="flex-1">
              <Checkbox
                label={<span className={i.done ? 'text-fg-muted line-through' : ''}>{i.text}</span>}
                hint={i.done && i.doneBy ? (
                  <>
                    checked by {i.doneBy.username} <RelativeTime date={i.doneAt!} />
                  </>
                ) : undefined}
                checked={i.done}
                disabled={!editable || toggle.isPending}
                onChange={() => toggle.mutate(i)}
              />
            </div>
            {canAdd && <IconButton label="Remove item" size="sm" icon={<Trash2 size={13} />} onClick={() => del.mutate(i.id)} />}
          </li>
        ))}
        {items.length === 0 && <li className="px-4 py-3 text-sm text-fg-muted">No items. Add the things a reviewer must confirm before merging.</li>}
      </ul>
      {canAdd && (
        <form
          className="flex gap-2 border-t border-border-muted p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) add.mutate();
          }}
        >
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a checklist item" aria-label="New checklist item" maxLength={300} />
          <Button type="submit" disabled={!text.trim()} loading={add.isPending}>
            Add
          </Button>
        </form>
      )}
    </Box>
  );
}
