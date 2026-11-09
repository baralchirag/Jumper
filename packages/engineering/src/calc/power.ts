// Power budget: rails with a regulator/source capacity and the loads hanging off them.

export interface Load {
  name: string;
  /** Typical and maximum current draw in mA. */
  typMa: number;
  maxMa: number;
}

export interface Rail {
  name: string;
  voltage: number;
  /** Current the source can deliver, mA. Null when unknown. */
  capacityMa: number | null;
  /** Rail this one is derived from (regulator input); null for primary sources. */
  parent: string | null;
  /** Regulator efficiency 0–1 for switching converters; linear regulators use `linear: true`. */
  efficiency?: number;
  linear?: boolean;
  loads: Load[];
}

export interface RailReport {
  name: string;
  voltage: number;
  typMa: number;
  maxMa: number;
  capacityMa: number | null;
  /** Remaining headroom at max load, mA. */
  marginMa: number | null;
  overloaded: boolean;
  /** Dissipation in the regulator feeding this rail at max load, mW. */
  regulatorLossMw: number;
}

export interface BudgetReport {
  rails: RailReport[];
  totalTypMw: number;
  totalMaxMw: number;
  issues: string[];
}

export function powerBudget(rails: Rail[]): BudgetReport {
  const byName = new Map(rails.map((r) => [r.name, r]));
  const issues: string[] = [];
  const own = new Map<string, { typ: number; max: number }>();
  for (const r of rails) own.set(r.name, { typ: r.loads.reduce((s, l) => s + l.typMa, 0), max: r.loads.reduce((s, l) => s + l.maxMa, 0) });

  // Reflect child rails into their parents (input current of the regulator).
  const total = new Map<string, { typ: number; max: number; loss: number }>();
  const resolve = (name: string, seen: Set<string>): { typ: number; max: number; loss: number } => {
    const cached = total.get(name);
    if (cached) return cached;
    if (seen.has(name)) {
      issues.push(`Rail dependency loop through ${name}`);
      return { typ: 0, max: 0, loss: 0 };
    }
    seen.add(name);
    const rail = byName.get(name)!;
    const sum = { ...own.get(name)!, loss: 0 };
    for (const child of rails.filter((c) => c.parent === name)) {
      const c = resolve(child.name, seen);
      const ratio = child.linear ? 1 : child.voltage / (rail.voltage * (child.efficiency ?? 0.85));
      sum.typ += c.typ * ratio;
      sum.max += c.max * ratio;
    }
    total.set(name, sum);
    return sum;
  };

  const reports: RailReport[] = rails.map((r) => {
    if (r.parent && !byName.has(r.parent)) issues.push(`${r.name}: unknown parent rail ${r.parent}`);
    const t = resolve(r.name, new Set());
    const parent = r.parent ? byName.get(r.parent) : undefined;
    // Child rail's own demand (not the reflected input current) sets the regulator loss.
    const out = own.get(r.name)!;
    const childDemand = rails.filter((c) => c.parent === r.name);
    const outMax = out.max + childDemand.reduce((s, c) => s + (total.get(c.name)?.max ?? 0) * (c.linear ? 1 : c.voltage / (r.voltage * (c.efficiency ?? 0.85))), 0);
    let loss = 0;
    if (parent) {
      loss = r.linear ? Math.max(0, parent.voltage - r.voltage) * outMax : r.voltage * outMax * (1 / (r.efficiency ?? 0.85) - 1);
    }
    const margin = r.capacityMa === null ? null : r.capacityMa - outMax;
    const overloaded = margin !== null && margin < 0;
    if (overloaded) issues.push(`${r.name} is overloaded by ${(-margin).toFixed(0)} mA at maximum load`);
    return { name: r.name, voltage: r.voltage, typMa: t.typ, maxMa: outMax, capacityMa: r.capacityMa, marginMa: margin, overloaded, regulatorLossMw: loss };
  });

  const roots = rails.filter((r) => !r.parent || !byName.has(r.parent));
  const mw = (key: 'typ' | 'max') => roots.reduce((s, r) => s + r.voltage * (total.get(r.name)?.[key] ?? 0), 0);
  return { rails: reports, totalTypMw: mw('typ'), totalMaxMw: mw('max'), issues };
}
