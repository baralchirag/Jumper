import { describe, expect, it } from 'vitest';
import { arcPoints, padOutline, pointInPolygon, rotate } from './geometry';
import { symbolTransform } from './sch';

describe('geometry', () => {
  it('rotates counter-clockwise on a y-down screen', () => {
    const p = rotate({ x: 1, y: 0 }, 90);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(-1);
  });

  it('samples arcs through their midpoint', () => {
    const pts = arcPoints({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 });
    expect(pts[0]).toEqual({ x: 1, y: 0 });
    const mid = pts[Math.floor(pts.length / 2)]!;
    expect(mid.y).toBeGreaterThan(0.9);
    expect(pts.at(-1)!.x).toBeCloseTo(-1);
  });

  it('builds pad outlines', () => {
    const rect = padOutline('rect', 2, 1, 0);
    expect(rect).toHaveLength(4);
    expect(pointInPolygon({ x: 0.9, y: 0.4 }, rect)).toBe(true);
    expect(pointInPolygon({ x: 1.1, y: 0 }, rect)).toBe(false);
  });

  it('maps library (y-up) coordinates to sheet coordinates', () => {
    const base = { uuid: '', libId: '', libName: null, unit: 1, bodyStyle: 1, inBom: true, onBoard: true, dnp: false, reference: '', value: '', footprint: '', properties: [] };
    const up = symbolTransform({ ...base, at: { x: 100, y: 50 }, rotation: 0, mirror: null });
    expect(up({ x: 0, y: 2.54 })).toEqual({ x: 100, y: 47.46 });
    const rot = symbolTransform({ ...base, at: { x: 0, y: 0 }, rotation: 90, mirror: null });
    const p = rot({ x: 1, y: 0 });
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(-1);
    const mir = symbolTransform({ ...base, at: { x: 0, y: 0 }, rotation: 0, mirror: 'y' });
    expect(mir({ x: 1, y: 0 }).x).toBeCloseTo(-1);
  });
});
