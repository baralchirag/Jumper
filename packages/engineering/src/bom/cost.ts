import type { BomPricingResponse } from '@jumper/shared';

/** Build volumes shown in the cost rollup. */
export const COST_TIERS = [1, 10, 100, 1000] as const;

export interface TierSummary {
  boards: number;
  /** Cheapest in-stock supplier mix for the whole BOM. */
  bestMix: { total: number; perBoard: number; covered: number };
  suppliers: { supplier: string; total: number; perBoard: number; covered: number; enabled: boolean }[];
  /** Lines that need sourcing at all. */
  sourceable: number;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/** Condense one priced BOM into the numbers a cost table needs. Per-board prices exclude nothing: they are total ÷ boards. */
export function summarizeTier(r: Pick<BomPricingResponse, 'boards' | 'suppliers' | 'bestMix' | 'sourceable'>): TierSummary {
  const per = (total: number) => round(total / Math.max(1, r.boards));
  return {
    boards: r.boards,
    bestMix: { total: round(r.bestMix.total), perBoard: per(r.bestMix.total), covered: r.bestMix.covered },
    suppliers: r.suppliers.map((s) => ({ supplier: s.supplier, total: round(s.total), perBoard: per(s.total), covered: s.covered, enabled: s.enabled })),
    sourceable: r.sourceable,
  };
}

/** Parse "1,10,100" into a sorted, de-duplicated, bounded list of volumes. */
export function parseTiers(raw: string | undefined, max = 6): number[] {
  if (!raw) return [...COST_TIERS];
  const out = [...new Set(raw.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 100_000))].sort((a, b) => a - b);
  return out.slice(0, max);
}
