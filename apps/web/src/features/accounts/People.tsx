import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { FollowList, NamespaceInfo } from '@jumper/shared';
import { Avatar, Button, Dialog, Spinner, buttonClass } from '@jumper/ui';
import { api, errorMessage } from '../../shared/lib/api';
import { useMe } from '../../shared/lib/queries';

type Stats = { followers: number; following: number; viewerFollows: boolean };

/** Follow / Unfollow for a user. Signed-out visitors get a sign-in link that comes back here. */
export function FollowButton({ username, following, size = 'sm', onChange }: { username: string; following: boolean; size?: 'sm' | 'md'; onChange?: (s: Stats) => void }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => (following ? api.delete<Stats>(`/user/following/${encodeURIComponent(username)}`) : api.put<Stats>(`/user/following/${encodeURIComponent(username)}`)),
    onSuccess: (s) => {
      setError(null);
      onChange?.(s);
      qc.setQueryData<NamespaceInfo>(['namespace', username.toLowerCase()], (ns) => (ns ? { ...ns, ...s } : ns));
      void qc.invalidateQueries({ queryKey: ['people'] });
      if (me) void qc.invalidateQueries({ queryKey: ['namespace', me.username.toLowerCase()] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  if (!me) {
    return (
      <Link to="/login" search={{ redirect: `/${username}` }} className={buttonClass('default', size)}>
        Follow
      </Link>
    );
  }
  if (me.username.toLowerCase() === username.toLowerCase()) return null;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button variant={following ? 'default' : 'primary'} size={size} loading={m.isPending} onClick={() => m.mutate()} aria-pressed={following}>
        {following ? 'Following' : 'Follow'}
      </Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}

/** The followers or following list of a user, in a dialog, loaded 50 at a time. */
export function PeopleDialog({ username, kind, open, onClose }: { username: string; kind: 'followers' | 'following'; open: boolean; onClose: () => void }) {
  const q = useInfiniteQuery({
    queryKey: ['people', username.toLowerCase(), kind],
    queryFn: ({ pageParam }) => api.get<FollowList>(`/users/${encodeURIComponent(username)}/${kind}`, { page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage ?? undefined,
    enabled: open,
  });
  const people = q.data?.pages.flatMap((p) => p.users) ?? [];
  return (
    <Dialog open={open} onClose={onClose} title={kind === 'followers' ? `Followers of ${username}` : `People ${username} follows`}>
      {q.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : people.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-muted">{kind === 'followers' ? 'No followers yet.' : 'Not following anyone yet.'}</p>
      ) : (
        <ul className="-mx-1 max-h-[60vh] min-w-[min(28rem,80vw)] overflow-auto">
          {people.map((p) => (
            <li key={p.id} className="flex items-center gap-3 border-b border-border-muted px-1 py-3 last:border-b-0">
              <Avatar name={p.username} src={p.avatarUrl} size={36} />
              <Link to="/$owner" params={{ owner: p.username }} onClick={onClose} className="min-w-0 flex-1 no-underline">
                <span className="block truncate text-sm font-medium text-fg">{p.name || p.username}</span>
                <span className="block truncate text-[13px] text-fg-muted">{p.bio || `@${p.username}`}</span>
              </Link>
              <FollowButton username={p.username} following={p.viewerFollows} />
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <Button size="sm" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Show more
          </Button>
        </div>
      )}
    </Dialog>
  );
}
