import type { BoardStats } from './stats';
import type { FabProfile } from './profiles';

export interface FabIssue {
  rule: string;
  severity: 'error' | 'warning';
  message: string;
  actual: number | null;
  limit: number;
}

export interface FabReport {
  profile: string;
  ok: boolean;
  issues: FabIssue[];
}

/** `minClearanceMm` comes from the DRC rules of the board; it is not derivable from the parsed model. */
export function checkFabRules(stats: BoardStats, profile: FabProfile, opts: { minClearanceMm?: number | null } = {}): FabReport {
  const issues: FabIssue[] = [];
  const atLeast = (rule: string, label: string, actual: number | null, limit: number, severity: 'error' | 'warning' = 'error') => {
    if (actual !== null && actual + 1e-9 < limit) issues.push({ rule, severity, message: `${label} ${actual} mm is below the ${limit} mm minimum`, actual, limit });
  };
  const atMost = (rule: string, label: string, actual: number | null, limit: number) => {
    if (actual !== null && actual > limit) issues.push({ rule, severity: 'error', message: `${label} ${actual} exceeds the maximum of ${limit}`, actual, limit });
  };
  atLeast('track-width', 'Narrowest track', stats.minTrackWidthMm, profile.minTrackWidthMm);
  atLeast('clearance', 'Minimum clearance', opts.minClearanceMm ?? null, profile.minClearanceMm);
  atLeast('via-drill', 'Smallest via drill', stats.minViaDrillMm, profile.minViaDrillMm);
  atLeast('via-diameter', 'Smallest via diameter', stats.minViaDiameterMm, profile.minViaDiameterMm);
  atLeast('hole-drill', 'Smallest hole', stats.minHoleDrillMm, profile.minHoleDrillMm);
  atLeast('annular-ring', 'Smallest annular ring', stats.minAnnularRingMm === null ? null : Math.round(stats.minAnnularRingMm * 1000) / 1000, profile.minAnnularRingMm);
  atMost('layers', 'Copper layer count', stats.copperLayers, profile.maxCopperLayers);
  atMost('board-width', 'Board width', stats.widthMm, profile.maxWidthMm);
  atMost('board-height', 'Board height', stats.heightMm, profile.maxHeightMm);
  atLeast('board-width-min', 'Board width', stats.widthMm, profile.minWidthMm);
  atLeast('board-height-min', 'Board height', stats.heightMm, profile.minHeightMm);
  if (stats.boardThicknessMm !== null && !profile.thicknessesMm.some((t) => Math.abs(t - stats.boardThicknessMm!) < 0.01)) {
    issues.push({ rule: 'thickness', severity: 'warning', message: `Board thickness ${stats.boardThicknessMm} mm is not a standard option (${profile.thicknessesMm.join(', ')} mm)`, actual: stats.boardThicknessMm, limit: profile.thicknessesMm[0]! });
  }
  if (opts.minClearanceMm == null) {
    issues.push({ rule: 'clearance', severity: 'warning', message: 'Minimum clearance was not checked (needs the board DRC rules); run DRC against this fab’s rules', actual: null, limit: profile.minClearanceMm });
  }
  return { profile: profile.id, ok: !issues.some((i) => i.severity === 'error'), issues };
}
