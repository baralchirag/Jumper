import { describe, expect, it } from 'vitest';
import type { Pcb } from '@jumper/kicad-core/types';
import { FAB_PROFILES, checkFabRules, computeBoardStats } from '../index';

const pt = (x: number, y: number) => ({ x, y });
const pcb = (over: Partial<Pcb> = {}): Pcb => ({
  version: '20240108', generator: 'pcbnew', thickness: 1.6,
  layers: [{ ordinal: 0, name: 'F.Cu', kind: 'signal', userName: null }, { ordinal: 31, name: 'B.Cu', kind: 'signal', userName: null }, { ordinal: 44, name: 'Edge.Cuts', kind: 'user', userName: null }],
  nets: [{ id: 0, name: '' }, { id: 1, name: 'GND' }],
  footprints: [], tracks: [], vias: [], zones: [],
  graphics: [
    { type: 'rect', start: pt(0, 0), end: pt(50, 30), uuid: null, layer: 'Edge.Cuts', width: 0.1, fill: false },
  ],
  texts: [], bbox: null, ...over,
});
const track = (width: number, a = pt(0, 0), b = pt(10, 0)) => ({ uuid: 't', start: a, end: b, mid: null, width, layer: 'F.Cu', net: 1, locked: false });

describe('board stats', () => {
  it('measures size, layers, tracks and vias', () => {
    const s = computeBoardStats(pcb({ tracks: [track(0.2), track(0.15, pt(0, 0), pt(0, 5))], vias: [{ uuid: 'v', at: pt(1, 1), size: 0.6, drill: 0.3, layers: ['F.Cu', 'B.Cu'], net: 1, viaType: 'through', locked: false }] }));
    expect(s.copperLayers).toBe(2);
    expect(s.widthMm).toBe(50);
    expect(s.heightMm).toBe(30);
    expect(s.minTrackWidthMm).toBe(0.15);
    expect(s.totalTrackLengthMm).toBe(15);
    expect(s.minAnnularRingMm).toBeCloseTo(0.15, 6);
    expect(s.minViaDrillMm).toBe(0.3);
  });
  it('handles an empty board without NaN', () => {
    const s = computeBoardStats(pcb({ graphics: [] }));
    expect(s.minTrackWidthMm).toBeNull();
    expect(s.widthMm).toBeNull();
    expect(s.totalTrackLengthMm).toBe(0);
  });
  it('measures arc tracks (quarter circle r=10)', () => {
    const r = 10;
    const a = { ...track(0.2, pt(r, 0), pt(0, r)), mid: pt(r * Math.SQRT1_2, r * Math.SQRT1_2) };
    expect(computeBoardStats(pcb({ tracks: [a] })).totalTrackLengthMm).toBeCloseTo((Math.PI * r) / 2, 1);
  });
});

describe('fab rules', () => {
  it('flags a 0.1 mm track for JLCPCB but not PCBWay', () => {
    const s = computeBoardStats(pcb({ tracks: [track(0.1)] }));
    expect(checkFabRules(s, FAB_PROFILES.jlcpcb!, { minClearanceMm: 0.2 }).issues.map((i) => i.rule)).toContain('track-width');
    expect(checkFabRules(s, FAB_PROFILES.pcbway!, { minClearanceMm: 0.2 }).ok).toBe(true);
  });
  it('rejects too many layers for OSH Park', () => {
    const layers = Array.from({ length: 6 }, (_, i) => ({ ordinal: i, name: `In${i}.Cu`, kind: 'signal', userName: null }));
    const s = computeBoardStats(pcb({ layers }));
    expect(checkFabRules(s, FAB_PROFILES.oshpark!, { minClearanceMm: 1 }).ok).toBe(false);
  });
  it('warns when clearance was not supplied', () => {
    const r = checkFabRules(computeBoardStats(pcb()), FAB_PROFILES.jlcpcb!);
    expect(r.ok).toBe(true);
    expect(r.issues[0]?.severity).toBe('warning');
  });
});
