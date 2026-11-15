import { describe, expect, it } from 'vitest';
import type { Graphic, Pcb } from '@jumper/kicad-core/types';
import { buildBoard3D, outlineLoops } from './board3d';

const line = (x1: number, y1: number, x2: number, y2: number): Graphic => ({ type: 'line', start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, uuid: null, layer: 'Edge.Cuts', width: 0.1, fill: false });

describe('board3d', () => {
  it('chains unordered, reversed edge segments into a closed loop', () => {
    const loops = outlineLoops([line(0, 0, 10, 0), line(10, 10, 10, 0), line(0, 10, 10, 10), line(0, 0, 0, 10)]);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
  });

  it('keeps closed shapes (cutouts) as separate loops', () => {
    const circle: Graphic = { type: 'circle', center: { x: 5, y: 5 }, end: { x: 6, y: 5 }, uuid: null, layer: 'Edge.Cuts', width: 0.1, fill: false };
    expect(outlineLoops([line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0), circle])).toHaveLength(2);
  });

  it('builds a board with substrate and component bodies', () => {
    const pcb: Pcb = {
      version: null, generator: null, thickness: 1.6, layers: [], nets: [], tracks: [], vias: [], zones: [], texts: [], bbox: null,
      graphics: [line(0, 0, 20, 0), line(20, 0, 20, 10), line(20, 10, 0, 10), line(0, 10, 0, 0)],
      footprints: [
        {
          uuid: 'f', libId: 'Resistor_SMD:R_0603_1608Metric', reference: 'R1', value: '10k', at: { x: 5, y: 5 }, rotation: 0, layer: 'F.Cu', locked: false, attrs: ['smd'], properties: {}, texts: [], models: [], bbox: null,
          graphics: [],
          pads: [
            { number: '1', kind: 'smd', shape: 'roundrect', at: { x: 4.2, y: 5 }, rotation: 0, size: { x: 0.8, y: 0.9 }, drill: null, layers: ['F.Cu', 'F.Mask', 'F.Paste'], net: 0, netName: '', roundrectRratio: 0.25, polygons: [], uuid: null },
            { number: '2', kind: 'smd', shape: 'roundrect', at: { x: 5.8, y: 5 }, rotation: 0, size: { x: 0.8, y: 0.9 }, drill: null, layers: ['F.Cu', 'F.Mask', 'F.Paste'], net: 0, netName: '', roundrectRratio: 0.25, polygons: [], uuid: null },
          ],
        },
      ],
    };
    const g = buildBoard3D(pcb);
    expect(g.children.length).toBeGreaterThan(1);
    expect(g.getObjectByName('components')?.children).toHaveLength(1);
  });
});
