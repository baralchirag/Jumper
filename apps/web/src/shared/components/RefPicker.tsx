import { useState } from 'react';
import { Check, ChevronDown, GitBranch } from 'lucide-react';
import { Button, Dropdown, Input, MenuHeader } from '@jumper/ui';
import { useBranches } from '../lib/queries';

export function RefPicker({
  owner,
  repo,
  value,
  onChange,
  label,
}: {
  owner: string;
  repo: string;
  value: string;
  onChange: (ref: string) => void;
  label?: string;
}) {
  const { data: branches = [] } = useBranches(owner, repo);
  const [q, setQ] = useState('');
  const filtered = branches.filter((b) => b.name.toLowerCase().includes(q.toLowerCase()));
  const display = /^[0-9a-f]{40}$/.test(value) ? value.slice(0, 7) : value;
  return (
    <Dropdown
      width={280}
      trigger={({ toggle }) => (
        <Button size="sm" onClick={toggle} leadingIcon={<GitBranch size={14} />} trailingIcon={<ChevronDown size={12} />}>
          {label && <span className="text-fg-muted">{label}:</span>}
          <span className="max-w-40 truncate font-semibold">{display}</span>
        </Button>
      )}
    >
      {(close) => (
        <>
          <MenuHeader>Switch branch</MenuHeader>
          <div className="p-2">
            <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a branch…" className="h-7 text-xs" />
          </div>
          {filtered.map((b) => (
            <button
              key={b.name}
              onClick={() => {
                onChange(b.name);
                close();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-neutral-muted"
            >
              <span className="w-4">{b.name === value && <Check size={14} />}</span>
              <span className="min-w-0 flex-1 truncate">{b.name}</span>
              {b.isDefault && <span className="rounded-full border border-border px-1.5 text-[11.5px] text-fg-muted">default</span>}
            </button>
          ))}
          {!filtered.length && <div className="px-3 py-2 text-sm text-fg-muted">Nothing to show</div>}
        </>
      )}
    </Dropdown>
  );
}
