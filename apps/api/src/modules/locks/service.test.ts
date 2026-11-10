import { describe, expect, it } from 'vitest';
import { locksConflict } from './service';

const r = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });
describe('locksConflict', () => {
  it('whole-file locks conflict with everything on that file', () => {
    expect(locksConflict({ path: 'a', region: null }, { path: 'a', region: r(0, 0, 1, 1) })).toBe(true);
    expect(locksConflict({ path: 'a', region: null }, { path: 'b', region: null })).toBe(false);
  });
  it('regions conflict only when they overlap with positive area', () => {
    expect(locksConflict({ path: 'a', region: r(0, 0, 10, 10) }, { path: 'a', region: r(5, 5, 15, 15) })).toBe(true);
    expect(locksConflict({ path: 'a', region: r(0, 0, 10, 10) }, { path: 'a', region: r(10, 0, 20, 10) })).toBe(false);
    expect(locksConflict({ path: 'a', region: r(0, 0, 10, 10) }, { path: 'a', region: r(20, 20, 30, 30) })).toBe(false);
  });
});

import { sameRegion } from './service';
describe('sameRegion', () => {
  it('compares by value regardless of key order', () => {
    const a = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    expect(sameRegion(a, { maxY: 1, maxX: 1, minY: 0, minX: 0 })).toBe(true);
    expect(sameRegion(a, null)).toBe(false);
    expect(sameRegion(null, null)).toBe(true);
  });
});
