import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import type { BomLine } from '@pcbhub/kicad-core/types';
import { Button, Input, Label } from '@pcbhub/ui';

function toCsv(lines: BomLine[]): string {
  const extra = [...new Set(lines.flatMap((l) => Object.keys(l.fields)))].sort();
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [
    ['References', 'Quantity', 'Value', 'Footprint', 'DNP', ...extra].join(','),
    ...lines.map((l) => [l.references.join(' '), String(l.quantity), l.value, l.footprint, l.dnp ? 'DNP' : '', ...extra.map((k) => l.fields[k] ?? '')].map(esc).join(',')),
  ].join('\n');
}

export function BomTable({ lines, filename = 'bom.csv' }: { lines: BomLine[]; filename?: string }) {
  const [q, setQ] = useState('');
  const extra = useMemo(() => [...new Set(lines.flatMap((l) => Object.keys(l.fields)))].filter((k) => k !== 'Description').sort(), [lines]);
  const filtered = useMemo(() => {
    const s = q.toLowerCase();
    return s ? lines.filter((l) => [l.value, l.footprint, ...l.references, ...Object.values(l.fields)].some((v) => v.toLowerCase().includes(s))) : lines;
  }, [lines, q]);
  const parts = lines.filter((l) => !l.dnp).reduce((n, l) => n + l.quantity, 0);

  const download = () => {
    const blob = new Blob([toCsv(lines)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-canvas-subtle px-3 py-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter parts…" className="h-7 max-w-xs text-xs" />
        <span className="text-xs text-fg-muted">
          {lines.length} lines · {parts} parts
        </span>
        <Button size="sm" className="ml-auto" leadingIcon={<Download size={14} />} onClick={download}>
          CSV
        </Button>
      </div>
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-canvas-subtle text-left text-xs text-fg-muted">
            <tr>
              <th className="px-3 py-2 font-semibold">References</th>
              <th className="px-3 py-2 text-right font-semibold">Qty</th>
              <th className="px-3 py-2 font-semibold">Value</th>
              <th className="px-3 py-2 font-semibold">Footprint</th>
              {extra.map((k) => (
                <th key={k} className="px-3 py-2 font-semibold">
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((l) => (
              <tr key={l.references.join(',')} className="border-t border-border-muted hover:bg-canvas-subtle">
                <td className="max-w-xs px-3 py-1.5 font-mono text-xs">
                  {l.references.join(', ')} {l.dnp && <Label tone="danger">DNP</Label>}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{l.quantity}</td>
                <td className="px-3 py-1.5">{l.value}</td>
                <td className="px-3 py-1.5 font-mono text-xs text-fg-muted">{l.footprint}</td>
                {extra.map((k) => (
                  <td key={k} className="px-3 py-1.5 text-xs">
                    {l.fields[k] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
