import { describe, expect, it } from 'vitest';
import { currentForTraceWidth, differentialMicrostripZ, microstripZ0, powerBudget, striplineZ0, traceResistance, traceWidthForCurrent, widthForImpedance } from '../index';

describe('trace width (IPC-2221)', () => {
  it('matches the published value for 1 A, 10 °C, 1 oz external (~0.30 mm)', () => {
    const { widthMm } = traceWidthForCurrent({ currentA: 1 });
    expect(widthMm).toBeGreaterThan(0.25);
    expect(widthMm).toBeLessThan(0.35);
  });
  it('internal layers need to be wider than external', () => {
    expect(traceWidthForCurrent({ currentA: 2, layer: 'internal' }).widthMm).toBeGreaterThan(traceWidthForCurrent({ currentA: 2 }).widthMm);
  });
  it('round-trips width and current', () => {
    const { widthMm } = traceWidthForCurrent({ currentA: 3, tempRiseC: 20, copperOz: 2 });
    expect(currentForTraceWidth(widthMm, { tempRiseC: 20, copperOz: 2 })).toBeCloseTo(3, 6);
  });
  it('rejects nonsense input', () => {
    expect(() => traceWidthForCurrent({ currentA: 0 })).toThrow(RangeError);
    expect(() => traceWidthForCurrent({ currentA: -1 })).toThrow(RangeError);
    expect(() => currentForTraceWidth(0)).toThrow(RangeError);
  });
  it('computes copper resistance (10 mm x 0.25 mm, 1 oz ~ 20 mΩ)', () => {
    expect(traceResistance(10, 0.25)).toBeCloseTo(0.02, 2);
  });
});

describe('impedance', () => {
  const fr4 = { er: 4.3, heightMm: 0.2 };
  it('a ~0.35 mm trace over 0.2 mm FR4 is near 50 Ω', () => {
    const w = widthForImpedance(50, fr4)!;
    expect(w).toBeGreaterThan(0.25);
    expect(w).toBeLessThan(0.45);
    expect(microstripZ0(w, fr4).z0).toBeCloseTo(50, 1);
  });
  it('flags geometry outside the validity range', () => {
    expect(microstripZ0(5, fr4).inRange).toBe(false);
  });
  it('stripline is lower impedance than microstrip at equal geometry', () => {
    expect(striplineZ0(0.15, { er: 4.3, heightMm: 0.4 }).z0).toBeLessThan(microstripZ0(0.15, { er: 4.3, heightMm: 0.4 }).z0 + 40);
  });
  it('closer coupling lowers differential impedance', () => {
    expect(differentialMicrostripZ(0.2, 0.1, fr4).zdiff).toBeLessThan(differentialMicrostripZ(0.2, 0.5, fr4).zdiff);
  });
  it('returns null for an unreachable target', () => {
    expect(widthForImpedance(500, fr4)).toBeNull();
  });
  it('rejects invalid stackups', () => {
    expect(() => microstripZ0(0.2, { er: 0.5, heightMm: 0.2 })).toThrow(RangeError);
  });
});

describe('power budget', () => {
  it('sums loads through regulators and flags overloads', () => {
    const r = powerBudget([
      { name: '5V', voltage: 5, capacityMa: 1000, parent: null, loads: [{ name: 'fan', typMa: 100, maxMa: 150 }] },
      { name: '3V3', voltage: 3.3, capacityMa: 300, parent: '5V', linear: true, loads: [{ name: 'mcu', typMa: 80, maxMa: 200 }, { name: 'radio', typMa: 50, maxMa: 150 }] },
    ]);
    const rail33 = r.rails.find((x) => x.name === '3V3')!;
    expect(rail33.maxMa).toBe(350);
    expect(rail33.overloaded).toBe(true);
    expect(rail33.regulatorLossMw).toBeCloseTo((5 - 3.3) * 350, 6);
    expect(r.rails.find((x) => x.name === '5V')!.maxMa).toBe(150 + 350);
    expect(r.issues.some((i) => i.includes('3V3 is overloaded'))).toBe(true);
  });
  it('detects dependency loops without hanging', () => {
    const r = powerBudget([
      { name: 'A', voltage: 5, capacityMa: null, parent: 'B', loads: [] },
      { name: 'B', voltage: 3, capacityMa: null, parent: 'A', loads: [] },
    ]);
    expect(r.issues.some((i) => i.includes('loop'))).toBe(true);
  });
  it('reports unknown parents', () => {
    expect(powerBudget([{ name: 'X', voltage: 3, capacityMa: null, parent: 'nope', loads: [] }]).issues[0]).toMatch(/unknown parent/);
  });
});
