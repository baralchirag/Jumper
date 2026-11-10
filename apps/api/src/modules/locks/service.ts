import type { Region } from '@jumper/db';

/** Two locks conflict when they cover the same file and their regions intersect (null = whole file). */
export function locksConflict(a: { path: string; region: Region | null }, b: { path: string; region: Region | null }): boolean {
  if (a.path !== b.path) return false;
  if (!a.region || !b.region) return true;
  return a.region.minX < b.region.maxX && b.region.minX < a.region.maxX && a.region.minY < b.region.maxY && b.region.minY < a.region.maxY;
}

/** jsonb does not preserve key order, so compare by value. */
export function sameRegion(a: Region | null, b: Region | null): boolean {
  if (!a || !b) return a === b;
  return a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;
}
