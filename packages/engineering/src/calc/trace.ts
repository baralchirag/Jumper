// Trace width vs. current, IPC-2221 (the formula used by most online calculators).
//   I = k * dT^0.44 * A^0.725     (I in A, dT in °C, A in mil²)
// k = 0.048 for external layers, 0.024 for internal layers.

const MIL_PER_MM = 39.3700787;
/** 1 oz/ft² copper is 34.8 µm thick. */
const OZ_TO_MM = 0.0348;

export interface TraceInput {
  /** Continuous current in amps. */
  currentA: number;
  /** Allowed temperature rise above ambient in °C. */
  tempRiseC?: number;
  /** Copper weight in oz/ft². */
  copperOz?: number;
  layer?: 'external' | 'internal';
}

export interface TraceResult {
  widthMm: number;
  crossSectionMil2: number;
  thicknessMm: number;
}

export function traceWidthForCurrent({ currentA, tempRiseC = 10, copperOz = 1, layer = 'external' }: TraceInput): TraceResult {
  if (!(currentA > 0)) throw new RangeError('currentA must be positive');
  if (!(tempRiseC > 0)) throw new RangeError('tempRiseC must be positive');
  if (!(copperOz > 0)) throw new RangeError('copperOz must be positive');
  const k = layer === 'external' ? 0.048 : 0.024;
  const area = (currentA / (k * tempRiseC ** 0.44)) ** (1 / 0.725);
  const thicknessMm = copperOz * OZ_TO_MM;
  const widthMm = area / MIL_PER_MM ** 2 / thicknessMm;
  return { widthMm, crossSectionMil2: area, thicknessMm };
}

/** Current a trace of the given width can carry for the given temperature rise. */
export function currentForTraceWidth(widthMm: number, opts: Omit<TraceInput, 'currentA'> = {}): number {
  if (!(widthMm > 0)) throw new RangeError('widthMm must be positive');
  const { tempRiseC = 10, copperOz = 1, layer = 'external' } = opts;
  const k = layer === 'external' ? 0.048 : 0.024;
  const areaMil2 = widthMm * MIL_PER_MM * (copperOz * OZ_TO_MM * MIL_PER_MM);
  return k * tempRiseC ** 0.44 * areaMil2 ** 0.725;
}

/** Resistance of a trace in ohms (copper at the given temperature). */
export function traceResistance(lengthMm: number, widthMm: number, copperOz = 1, tempC = 20): number {
  const rho20 = 1.724e-8; // Ω·m
  const rho = rho20 * (1 + 0.00393 * (tempC - 20));
  const area = widthMm * 1e-3 * copperOz * OZ_TO_MM * 1e-3;
  return (rho * lengthMm * 1e-3) / area;
}
