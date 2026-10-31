import type { CheckAnnotation, CheckConclusion, PcbhubConfig } from '@pcbhub/shared';

interface KicadItem {
  description?: string;
  pos?: { x: number; y: number };
  uuid?: string;
}

interface KicadViolation {
  type?: string;
  description?: string;
  severity?: string;
  excluded?: boolean;
  items?: KicadItem[];
}

export interface Evaluation {
  conclusion: CheckConclusion;
  summary: string;
  counts: { error: number; warning: number; ignored: number };
  annotations: CheckAnnotation[];
}

const MAX_ANNOTATIONS = 2000;

function toAnnotation(v: KicadViolation, severity: 'error' | 'warning', extra: Partial<CheckAnnotation> = {}): CheckAnnotation {
  const first = v.items?.find((i) => i.pos);
  return {
    severity,
    type: v.type ?? 'unknown',
    message: v.description ?? v.type ?? 'Violation',
    x: first?.pos?.x,
    y: first?.pos?.y,
    items: (v.items ?? []).slice(0, 10).map((i) => ({ description: i.description ?? '', uuid: i.uuid, x: i.pos?.x, y: i.pos?.y })),
    ...extra,
  };
}

function evaluate(
  violations: { v: KicadViolation; extra?: Partial<CheckAnnotation>; forceError?: boolean }[],
  overrides: Record<string, string>,
  failOn: 'error' | 'warning' | 'never',
  noun: string,
): Evaluation {
  const counts = { error: 0, warning: 0, ignored: 0 };
  const annotations: CheckAnnotation[] = [];
  for (const { v, extra, forceError } of violations) {
    if (v.excluded) {
      counts.ignored++;
      continue;
    }
    const override = v.type ? overrides[v.type] : undefined;
    let sev: string = override ?? (forceError ? 'error' : (v.severity ?? 'error'));
    if (sev === 'ignore' || sev === 'exclusion') {
      counts.ignored++;
      continue;
    }
    if (sev !== 'warning') sev = 'error';
    counts[sev as 'error' | 'warning']++;
    if (annotations.length < MAX_ANNOTATIONS) annotations.push(toAnnotation(v, sev as 'error' | 'warning', extra));
  }
  const failed = failOn === 'error' ? counts.error > 0 : failOn === 'warning' ? counts.error + counts.warning > 0 : false;
  const total = counts.error + counts.warning;
  const conclusion: CheckConclusion = failed ? 'failure' : total > 0 ? 'neutral' : 'success';
  const parts = [`${counts.error} error${counts.error === 1 ? '' : 's'}`, `${counts.warning} warning${counts.warning === 1 ? '' : 's'}`];
  if (counts.ignored) parts.push(`${counts.ignored} ignored`);
  const summary = total === 0 ? `No ${noun} violations${counts.ignored ? ` (${counts.ignored} ignored)` : ''}` : parts.join(', ');
  return { conclusion, summary, counts, annotations };
}

export function evaluateErc(report: unknown, config: PcbhubConfig): Evaluation {
  const r = report as { sheets?: { path?: string; violations?: KicadViolation[] }[] };
  const list = (r.sheets ?? []).flatMap((s) => (s.violations ?? []).map((v) => ({ v, extra: { sheet: s.path } })));
  return evaluate(list, config.severity_overrides.erc, config.checks.erc.fail_on, 'ERC');
}

export function evaluateDrc(report: unknown, config: PcbhubConfig): Evaluation {
  const r = report as { violations?: KicadViolation[]; unconnected_items?: KicadViolation[]; schematic_parity?: KicadViolation[] };
  const cfg = config.checks.drc;
  const list = [
    ...(r.violations ?? []).map((v) => ({ v })),
    ...(r.unconnected_items ?? []).map((v) => ({ v: { ...v, type: v.type ?? 'unconnected_items' }, forceError: cfg.fail_on_unconnected })),
    ...(cfg.schematic_parity ? (r.schematic_parity ?? []).map((v) => ({ v: { ...v, type: v.type ?? 'schematic_parity' } })) : []),
  ];
  return evaluate(list, config.severity_overrides.drc, cfg.fail_on, 'DRC');
}
