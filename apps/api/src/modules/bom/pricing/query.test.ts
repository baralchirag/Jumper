import { describe, expect, it } from 'vitest';
import type { BomLine } from '@jumper/kicad-core/types';
import { buildQuery, normalizeCapacitance, normalizeResistance, packageOf } from './query';

const line = (p: Partial<BomLine>): BomLine => ({ references: ['R1'], quantity: 1, value: '10k', footprint: 'Resistor_SMD:R_0603_1608Metric', libId: 'Device:R', dnp: false, fields: {}, ...p });

describe('pricing queries', () => {
  it('extracts packages from footprint names', () => {
    expect(packageOf('Resistor_SMD:R_0603_1608Metric')).toBe('0603');
    expect(packageOf('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm')).toBe('SOIC-8');
    expect(packageOf('Package_TO_SOT_SMD:SOT-23-5')).toBe('SOT-23-5');
    expect(packageOf('Diode_SMD:D_SMA')).toBe('SMA');
    expect(packageOf('Connector:Foo')).toBeNull();
  });

  it('normalizes values', () => {
    expect(normalizeResistance('4.7k')).toBe('4.7kΩ');
    expect(normalizeResistance('100K')).toBe('100kΩ');
    expect(normalizeResistance('4k7')).toBe('4.7kΩ');
    expect(normalizeResistance('330')).toBe('330Ω');
    expect(normalizeCapacitance('0.1uf')).toBe('100nF');
    expect(normalizeCapacitance('10u')).toBe('10uF');
    expect(normalizeCapacitance('4u7')).toBe('4.7uF');
    expect(normalizeCapacitance('22pF')).toBe('22pF');
  });

  it('prefers part numbers and falls back to parametric search', () => {
    expect(buildQuery(line({ fields: { LCSC: 'c25804' } })).lcsc).toBe('C25804');
    expect(buildQuery(line({ value: '4.7k' })).keyword).toBe('4.7kΩ 0603');
    expect(buildQuery(line({ references: ['C3'], libId: 'Device:C', value: '0.1uf', footprint: 'Capacitor_SMD:C_0805_2012Metric' })).keyword).toBe('100nF 0805');
    const ic = buildQuery(line({ references: ['U2'], value: 'TP4056', footprint: 'Package_SO:SOIC-8', fields: { Manufacturer_Part_Number: 'TP4056-42-ESOP8' } }));
    expect(ic.mpn).toBe('TP4056-42-ESOP8');
    expect(ic.keyword).toBeNull();
    expect(buildQuery(line({ references: ['U3'], value: 'MIC5219-3.3YM5', libId: 'Regulator_Linear:MIC5219-3.3YM5', footprint: 'Package_TO_SOT_SMD:SOT-23-5' })).mpn).toBe('MIC5219-3.3YM5');
    expect(buildQuery(line({ references: ['U1'], value: 'ESP32-WROVER-E', fields: { 'Mouser Part Number': '356-ESP32WROVEREN4R8' } })).mouser).toBe('356-ESP32WROVEREN4R8');
  });

  it('classifies by library symbol and ignores LED labels', () => {
    expect(buildQuery(line({ references: ['Rprog1'], value: '3.3K' })).keyword).toBe('3.3kΩ 0603');
    expect(buildQuery(line({ references: ['LED2'], value: 'CHG', libId: 'Device:LED', footprint: 'LED_SMD:LED_0603_1608Metric' })).keyword).toBe('LED 0603');
    expect(buildQuery(line({ references: ['D5'], value: 'Red', libId: 'Device:LED', footprint: 'LED_SMD:LED_0805_2012Metric' })).keyword).toBe('LED Red 0805');
  });

  it('skips non-purchasable items', () => {
    expect(buildQuery(line({ references: ['H1'], value: 'MountingHole', libId: 'Mechanical:MountingHole', footprint: 'MountingHole:MountingHole_3.2mm_M3' })).skip).toBe(true);
    expect(buildQuery(line({ references: ['TP1'], value: 'TestPoint' })).skip).toBe(true);
  });
});
