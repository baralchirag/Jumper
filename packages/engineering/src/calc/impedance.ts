// Controlled-impedance estimates (IPC-2141 closed forms). They are good to ~±10% inside
// their validity range; use a field solver or your fab's stackup tool for sign-off.

export interface Stackup {
  /** Dielectric constant of the substrate. */
  er: number;
  /** Dielectric height to the reference plane, mm. */
  heightMm: number;
  /** Copper thickness, mm. */
  copperMm?: number;
}

export interface ImpedanceResult {
  z0: number;
  /** True when the geometry is inside the formula's validity range. */
  inRange: boolean;
  note: string | null;
}

function check(er: number, h: number, w: number) {
  if (!(er >= 1) || !(h > 0) || !(w > 0)) throw new RangeError('er ≥ 1, height > 0 and width > 0 are required');
}

/** Surface microstrip. Valid for 0.1 < w/h < 2.0 and 1 < er < 15. */
export function microstripZ0(widthMm: number, { er, heightMm: h, copperMm: t = 0.035 }: Stackup): ImpedanceResult {
  check(er, h, widthMm);
  const z0 = (87 / Math.sqrt(er + 1.41)) * Math.log((5.98 * h) / (0.8 * widthMm + t));
  const ratio = widthMm / h;
  const inRange = ratio > 0.1 && ratio < 2 && er < 15;
  return { z0, inRange, note: inRange ? null : 'Width/height ratio is outside 0.1–2.0; treat as a rough estimate.' };
}

/** Symmetric stripline; `planeSpacingMm` is the distance between the two reference planes. */
export function striplineZ0(widthMm: number, { er, heightMm: b, copperMm: t = 0.035 }: Stackup): ImpedanceResult {
  check(er, b, widthMm);
  const z0 = (60 / Math.sqrt(er)) * Math.log((4 * b) / (0.67 * Math.PI * (0.8 * widthMm + t)));
  const ratio = widthMm / b;
  const inRange = ratio < 0.35;
  return { z0, inRange, note: inRange ? null : 'Trace is wide for the plane spacing; treat as a rough estimate.' };
}

/** Edge-coupled differential microstrip: Zdiff ≈ 2·Z0·(1 − 0.48·e^(−0.96·s/h)). */
export function differentialMicrostripZ(widthMm: number, spacingMm: number, stackup: Stackup): ImpedanceResult & { zdiff: number } {
  if (!(spacingMm > 0)) throw new RangeError('spacingMm must be positive');
  const single = microstripZ0(widthMm, stackup);
  const zdiff = 2 * single.z0 * (1 - 0.48 * Math.exp((-0.96 * spacingMm) / stackup.heightMm));
  return { ...single, zdiff };
}

/** Solve for the trace width giving `target` Ω (bisection, 0.02–10 mm). */
export function widthForImpedance(target: number, stackup: Stackup, kind: 'microstrip' | 'stripline' = 'microstrip'): number | null {
  const f = (w: number) => (kind === 'microstrip' ? microstripZ0(w, stackup) : striplineZ0(w, stackup)).z0 - target;
  let lo = 0.02;
  let hi = 10;
  if (f(lo) < 0 || f(hi) > 0) return null; // z0 falls as the trace widens
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Signal propagation delay in ps/mm for a microstrip (effective permittivity approximation). */
export function microstripDelayPsPerMm(er: number): number {
  const eEff = 0.475 * er + 0.67;
  return (Math.sqrt(eEff) / 299.792458) * 1000;
}
