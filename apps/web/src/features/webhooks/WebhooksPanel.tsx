import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { WEBHOOK_EVENTS, type WebhookDeliveryInfo, type WebhookInfo } from '@jumper/shared';
import { Box, BoxRow, Button, CopyButton, Flash, FormField, IconButton, Input, Label, RelativeTime, Checkbox } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';
import { useRepoInfo } from '../repo/context';

const EVENT_HELP: Record<(typeof WEBHOOK_EVENTS)[number], string> = {
  push: 'Commits pushed to any branch',
  check: 'A check (ERC, DRC, renders…) finished',
};

function Deliveries({ id }: { id: string }) {
  const info = useRepoInfo();
  const q = useQuery({ queryKey: [...keys.repo(info.owner, info.name), 'hook-deliveries', id], queryFn: () => api.get<WebhookDeliveryInfo[]>(repoPath(info.owner, info.name, `/hooks/${id}/deliveries`)) });
  if (!q.data?.length) return <p className="px-4 pb-3 text-xs text-fg-muted">No deliveries yet.</p>;
  return (
    <ul className="mx-4 mb-3 divide-y divide-border-muted rounded-sm border border-border-muted text-xs">
      {q.data.slice(0, 8).map((d) => (
        <li key={d.id} className="flex items-center gap-3 px-3 py-1.5">
          <Label tone={d.status && d.status < 300 ? 'success' : 'danger'}>{d.status ?? 'error'}</Label>
          <span className="font-mono">{d.event}</span>
          <span className="truncate text-fg-muted">{d.error}</span>
          <span className="ml-auto text-fg-muted">
            {d.durationMs !== null && `${d.durationMs} ms · `}
            <RelativeTime date={d.createdAt} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function WebhooksPanel() {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const key = [...keys.repo(info.owner, info.name), 'hooks'];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<WebhookInfo[]>(repoPath(info.owner, info.name, '/hooks')) });
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([...WEBHOOK_EVENTS]);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [pingMsg, setPingMsg] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string; secret: string }>(repoPath(info.owner, info.name, '/hooks'), { url, events }),
    onSuccess: (r) => {
      setSecret(r.secret);
      setUrl('');
      setError(null);
      void refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const toggle = useMutation({ mutationFn: (h: WebhookInfo) => api.patch(repoPath(info.owner, info.name, `/hooks/${h.id}`), { active: !h.active }), onSuccess: refresh });
  const del = useMutation({ mutationFn: (id: string) => api.delete(repoPath(info.owner, info.name, `/hooks/${id}`)), onSuccess: refresh });
  const ping = useMutation({
    mutationFn: (id: string) => api.post<{ status: number | null; error: string | null }>(repoPath(info.owner, info.name, `/hooks/${id}/ping`)),
    onSuccess: (r, id) => {
      setPingMsg(r.status ? `Ping answered with HTTP ${r.status}.` : `Ping failed: ${r.error}`);
      void qc.invalidateQueries({ queryKey: [...keys.repo(info.owner, info.name), 'hook-deliveries', id] });
    },
  });
  return (
    <div className="max-w-3xl space-y-6">
      {secret && (
        <Flash tone="success" action={<CopyButton value={secret} label="Copy secret" />}>
          Webhook created. Signing secret (shown once): <code className="font-mono">{secret}</code>
        </Flash>
      )}
      {pingMsg && <Flash>{pingMsg}</Flash>}
      <Box>
        {q.data?.length === 0 && <div className="p-4 text-sm text-fg-muted">No webhooks. Add one to notify your CI, chat or order system when something happens.</div>}
        {q.data?.map((h) => (
          <div key={h.id} className="border-b border-border-muted last:border-b-0">
            <BoxRow className="flex items-center gap-3 border-b-0">
              <WebhookIcon size={16} className={h.active ? 'text-accent' : 'text-fg-subtle'} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px]">{h.url}</div>
                <div className="text-xs text-fg-muted">
                  {h.events.join(', ')}
                  {h.lastDelivery && (
                    <>
                      {' · last: '}
                      {h.lastDelivery.status ?? h.lastDelivery.error} <RelativeTime date={h.lastDelivery.at} />
                    </>
                  )}
                </div>
              </div>
              <button className="link text-xs" onClick={() => setOpen(open === h.id ? null : h.id)}>
                Deliveries
              </button>
              <Button size="sm" leadingIcon={<Send size={12} />} loading={ping.isPending && ping.variables === h.id} onClick={() => ping.mutate(h.id)}>
                Ping
              </Button>
              <Button size="sm" onClick={() => toggle.mutate(h)}>
                {h.active ? 'Disable' : 'Enable'}
              </Button>
              <IconButton label="Delete webhook" size="sm" icon={<Trash2 size={14} />} onClick={() => confirm('Delete this webhook?') && del.mutate(h.id)} />
            </BoxRow>
            {open === h.id && <Deliveries id={h.id} />}
          </div>
        ))}
      </Box>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {error && <Flash tone="danger">{error}</Flash>}
        <FormField label="Payload URL" required hint="Must be a public https:// address. Each request carries an X-Jumper-Signature-256 header (HMAC-SHA256 of the body).">
          {(id) => <Input id={id} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/jumper" required />}
        </FormField>
        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium">Events</legend>
          {WEBHOOK_EVENTS.map((ev) => (
            <Checkbox
              key={ev}
              label={ev}
              hint={EVENT_HELP[ev]}
              checked={events.includes(ev)}
              onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))}
            />
          ))}
        </fieldset>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!url || events.length === 0}>
          Add webhook
        </Button>
      </form>
    </div>
  );
}
