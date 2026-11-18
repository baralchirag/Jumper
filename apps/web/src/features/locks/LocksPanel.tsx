import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, LockOpen } from 'lucide-react';
import type { LockInfo } from '@jumper/shared';
import { Box, BoxHeader, BoxRow, Button, Flash, IconButton, Input, RelativeTime, Select } from '@jumper/ui';
import { UserLink } from '../../shared/components/common';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys, useMe } from '../../shared/lib/queries';
import { canWrite, useRepoInfo } from '../repo/context';

/**
 * Locks warn teammates that a design file is being worked on. A whole-file lock also blocks merging other
 * people's changes to that file; region locks are advisory and shown in the viewer.
 */
export function LocksPanel({ path }: { path?: string }) {
  const info = useRepoInfo();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const key = [...keys.repo(info.owner, info.name), 'locks'];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<LockInfo[]>(repoPath(info.owner, info.name, '/locks')), refetchInterval: 60_000 });
  const [ttl, setTtl] = useState(120);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const lock = useMutation({
    mutationFn: () => api.post(repoPath(info.owner, info.name, '/locks'), { path, reason, ttlMinutes: ttl }),
    onSuccess: () => {
      setError(null);
      setReason('');
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const release = useMutation({ mutationFn: (id: string) => api.delete(repoPath(info.owner, info.name, `/locks/${id}`)), onSuccess: refresh });
  const locks = (q.data ?? []).filter((l) => !path || l.path === path);
  const mine = locks.find((l) => l.lockedBy.id === me?.id && !l.region);
  if (!canWrite(info) && locks.length === 0) return null;
  return (
    <Box>
      <BoxHeader className="gap-2 text-sm font-medium">
        <Lock size={14} /> {path ? 'File lock' : 'Locks'}
      </BoxHeader>
      {error && <Flash tone="danger" className="m-3">{error}</Flash>}
      {locks.map((l) => (
        <BoxRow key={l.id} className="flex items-center gap-3 text-sm">
          <Lock size={14} className="text-attention" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[13px]">{l.path}{l.region && <span className="text-fg-muted"> · region {Math.round(l.region.minX)},{Math.round(l.region.minY)}–{Math.round(l.region.maxX)},{Math.round(l.region.maxY)} mm</span>}</div>
            <div className="text-xs text-fg-muted">
              <UserLink user={l.lockedBy} avatar={false} /> · expires <RelativeTime date={l.expiresAt} />{l.reason && ` · ${l.reason}`}
            </div>
          </div>
          {(l.lockedBy.id === me?.id || info.permission === 'admin') && <IconButton label="Release lock" size="sm" icon={<LockOpen size={14} />} onClick={() => release.mutate(l.id)} />}
        </BoxRow>
      ))}
      {locks.length === 0 && <div className="px-4 py-3 text-sm text-fg-muted">Nobody is editing {path ? 'this file' : 'any file'} right now.</div>}
      {path && canWrite(info) && (
        <form
          className="flex flex-wrap gap-2 border-t border-border-muted p-3"
          onSubmit={(e) => {
            e.preventDefault();
            lock.mutate();
          }}
        >
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (optional)" className="min-w-40 flex-1" aria-label="Reason" maxLength={300} />
          <Select value={ttl} onChange={(e) => setTtl(Number(e.target.value))} className="w-36" aria-label="Lock duration">
            <option value={30}>30 minutes</option>
            <option value={120}>2 hours</option>
            <option value={480}>8 hours</option>
            <option value={1440}>1 day</option>
            <option value={10080}>1 week</option>
          </Select>
          <Button type="submit" loading={lock.isPending}>{mine ? 'Extend lock' : 'Lock file'}</Button>
        </form>
      )}
    </Box>
  );
}
