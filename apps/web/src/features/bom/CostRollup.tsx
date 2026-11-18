import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Coins } from 'lucide-react';
import { Box, BoxHeader, Button, Flash } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';

interface Tier {
  boards: number;
  bestMix: { total: number; perBoard: number; covered: number };
  suppliers: { supplier: string; total: number; perBoard: number; covered: number; enabled: boolean }[];
  sourceable: number;
}

const usd = (n: number) => `$${n.toFixed(n < 10 ? 3 : 2)}`;

/** Cost per board at several build volumes. Fetched on demand because it queries every supplier once per volume. */
export function CostRollup({ owner, repo, sha, path }: { owner: string; repo: string; sha: string; path: string }) {
  const [started, setStarted] = useState(false);
  const run = useMutation({
    mutationFn: () => api.get<{ tiers: Tier[] }>(repoPath(owner, repo, '/bom/cost-rollup'), { path, sha }),
    onMutate: () => setStarted(true),
  });
  const tiers = run.data?.tiers ?? [];
  const suppliers = [...new Set(tiers.flatMap((t) => t.suppliers.filter((s) => s.enabled).map((s) => s.supplier)))];
  return (
    <Box>
      <BoxHeader className="gap-2 text-sm font-medium">
        <Coins size={14} /> Cost by volume
        {!started && (
          <Button size="sm" className="ml-auto" onClick={() => run.mutate()}>
            Compare 1 / 10 / 100 / 1000 boards
          </Button>
        )}
      </BoxHeader>
      {run.isPending && <p className="p-4 text-sm text-fg-muted">Fetching prices from suppliers…</p>}
      {run.error && <Flash tone="danger" className="m-3">{errorMessage(run.error)}</Flash>}
      {tiers.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-canvas-subtle text-left text-xs text-fg-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Boards</th>
                <th className="px-4 py-2 font-medium">Best mix / board</th>
                <th className="px-4 py-2 font-medium">Best mix total</th>
                {suppliers.map((s) => (
                  <th key={s} className="px-4 py-2 font-medium">
                    {s} / board
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {tiers.map((t) => (
                <tr key={t.boards} className="border-t border-border-muted">
                  <td className="px-4 py-1.5">{t.boards.toLocaleString()}</td>
                  <td className="px-4 font-semibold">{usd(t.bestMix.perBoard)}</td>
                  <td className="px-4">{usd(t.bestMix.total)}</td>
                  {suppliers.map((s) => {
                    const x = t.suppliers.find((y) => y.supplier === s);
                    return (
                      <td key={s} className="px-4 text-fg-muted" title={x ? `${x.covered}/${t.sourceable} lines in stock` : undefined}>
                        {x && x.covered > 0 ? usd(x.perBoard) : '–'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-2 text-xs text-fg-muted">
            Prices honour each supplier's minimum order quantity and price breaks, so unit cost falls at volume. Totals cover only lines a supplier has in stock; lines nobody stocks are excluded.
          </p>
        </div>
      )}
    </Box>
  );
}
