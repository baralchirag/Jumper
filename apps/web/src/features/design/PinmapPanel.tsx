import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Box, BoxHeader, Flash, PageSpinner, Select, buttonClass } from '@jumper/ui';
import { ErrorView } from '../../shared/components/common';
import { api, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';

interface Pinmap {
  mcu: string;
  candidates: { ref: string; value: string; pins: number }[];
  pins: { pin: string; net: string }[];
  conflicts: string[];
}

/** Firmware pin map generated from the schematic netlist produced by the checks. */
export function PinmapPanel({ owner, repo, sha }: { owner: string; repo: string; sha: string }) {
  const [mcu, setMcu] = useState<string | undefined>();
  const q = useQuery({
    queryKey: [...keys.repo(owner, repo), 'pinmap', sha, mcu],
    queryFn: () => api.get<Pinmap>(repoPath(owner, repo, '/pinmap'), { sha, mcu }),
    retry: false,
  });
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorView error={q.error} title="No pin map available." />;
  const d = q.data!;
  const dl = (format: string) => `/api${repoPath(owner, repo, '/pinmap')}?sha=${sha}&mcu=${encodeURIComponent(d.mcu)}&format=${format}`;
  return (
    <Box>
      <BoxHeader className="flex-wrap gap-3 text-sm">
        <span className="font-medium">Pin map</span>
        {d.candidates.length > 1 && (
          <Select value={d.mcu} onChange={(e) => setMcu(e.target.value)} className="h-7 w-52 text-xs" aria-label="Microcontroller">
            {d.candidates.map((c) => (
              <option key={c.ref} value={c.ref}>
                {c.ref} — {c.value}
              </option>
            ))}
          </Select>
        )}
        <span className="ml-auto flex gap-1">
          {([['header', 'pins.h'], ['zephyr', 'Zephyr overlay'], ['csv', 'CSV']] as const).map(([f, label]) => (
            <a key={f} href={dl(f)} download className={buttonClass('default', 'sm')}>
              <Download size={12} /> {label}
            </a>
          ))}
        </span>
      </BoxHeader>
      {d.conflicts.map((c) => (
        <Flash key={c} tone="warning" className="m-3">
          {c}
        </Flash>
      ))}
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-canvas-subtle text-left text-xs text-fg-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Pin</th>
              <th className="px-4 py-2 font-medium">Net</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {d.pins.map((p, i) => (
              <tr key={i} className="border-t border-border-muted">
                <td className="px-4 py-1">{p.pin}</td>
                <td className="px-4 py-1">{p.net || <span className="text-fg-subtle">unconnected</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Box>
  );
}
