import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Bell, CheckCheck, GitPullRequest, Lock, MessageSquare, UserCheck } from 'lucide-react';
import type { NotificationInfo } from '@jumper/shared';
import { Box, BoxHeader, BoxRow, Button, EmptyState, PageSpinner, RelativeTime, cx } from '@jumper/ui';
import { PageContainer } from '../../shared/components/common';
import { api } from '../../shared/lib/api';
import { useMe } from '../../shared/lib/queries';

interface Feed {
  unread: number;
  items: NotificationInfo[];
}

const ICON: Record<string, React.ReactNode> = {
  mention: <AtSign size={15} />,
  assigned: <UserCheck size={15} />,
  comment: <MessageSquare size={15} />,
  review_requested: <GitPullRequest size={15} />,
  lock: <Lock size={15} />,
};

export function useNotifications(opts: { unread?: boolean } = {}) {
  const { data: me } = useMe();
  return useQuery({
    queryKey: ['notifications', opts.unread ?? false],
    enabled: Boolean(me),
    queryFn: () => api.get<Feed>('/notifications', { unread: opts.unread, limit: 50 }),
    refetchInterval: 60_000,
  });
}

/** Header bell with an unread count. */
export function NotificationBell({ className }: { className?: string }) {
  const q = useNotifications({ unread: true });
  const n = q.data?.unread ?? 0;
  return (
    <Link to="/notifications" aria-label={n ? `${n} unread notifications` : 'Notifications'} className={cx('relative inline-flex h-8 w-8 items-center justify-center rounded-sm transition-colors hover:bg-header-fg/[0.08]', className)}>
      <Bell size={16} />
      {n > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-emphasis px-1 font-mono text-[11.5px] text-fg-on-accent">{n > 99 ? '99+' : n}</span>}
    </Link>
  );
}

export function NotificationsPage() {
  const q = useNotifications();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api.post('/notifications/read', ids ? { ids } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  if (q.isLoading) return <PageSpinner />;
  const items = q.data?.items ?? [];
  return (
    <PageContainer className="max-w-3xl py-10">
      <div className="mb-5 flex items-end justify-between gap-3">
        <div>
          <h1 className="headline text-[length:var(--t-l)]">Notifications</h1>
          <p className="mt-1 text-sm text-fg-muted">Mentions, assignments and replies on repositories you can access.</p>
        </div>
        <Button leadingIcon={<CheckCheck size={14} />} disabled={!q.data?.unread} onClick={() => markRead.mutate(undefined)}>
          Mark all as read
        </Button>
      </div>
      <Box>
        <BoxHeader className="text-sm font-medium">{q.data?.unread ? `${q.data.unread} unread` : 'All caught up'}</BoxHeader>
        {items.length === 0 && <EmptyState icon={<Bell size={26} />} title="Nothing here yet">Stock and end-of-life alerts for the parts in your boards show up here.</EmptyState>}
        {items.map((n) => (
          <BoxRow
            key={n.id}
            className={cx('flex cursor-pointer items-start gap-3 py-3', !n.read && 'bg-accent-subtle/40')}
            onClick={() => {
              if (!n.read) markRead.mutate([n.id]);
              if (n.url) void navigate({ to: n.url as never });
            }}
          >
            <span className={cx('mt-0.5', n.read ? 'text-fg-subtle' : 'text-accent')}>{ICON[n.kind] ?? <Bell size={15} />}</span>
            <div className="min-w-0 flex-1">
              <div className={cx('text-sm', !n.read && 'font-medium')}>{n.title}</div>
              <div className="text-xs text-fg-muted">
                {n.repo && <span className="font-mono">{n.repo}</span>} · <RelativeTime date={n.createdAt} />
              </div>
            </div>
          </BoxRow>
        ))}
      </Box>
    </PageContainer>
  );
}
