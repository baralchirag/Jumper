import { describe, expect, it } from 'vitest';
import type { BomLine } from '@jumper/kicad-core/node';
import { FAB_LAYOUTS, isFabFile, jlcBom, jlcCpl, lcscCode, pcbwayBom, pcbwayCpl } from './fab';

const line = (p: Partial<BomLine>): BomLine => ({ references: ['R1'], quantity: 1, value: '10k', footprint: 'Resistor_SMD:R_0603_1608Metric', libId: 'Device:R', dnp: false, fields: {}, ...p });

describe('fab outputs', () => {
  it('finds LCSC codes under common field names', () => {
    expect(lcscCode({ LCSC: 'c25804' })).toBe('C25804');
    expect(lcscCode({ 'LCSC Part #': 'C7593' })).toBe('C7593');
    expect(lcscCode({ 'JLC part': 'C1' })).toBeNull();
    expect(lcscCode({ MPN: 'NE555DR' })).toBeNull();
  });

  it('writes a JLCPCB BOM without DNP lines', () => {
    const csv = jlcBom([line({ references: ['R1', 'R2'], quantity: 2, fields: { LCSC: 'C25804' } }), line({ references: ['R9'], dnp: true })]);
    expect(csv).toBe('Comment,Designator,Footprint,LCSC Part #\n10k,"R1,R2",R_0603_1608Metric,C25804\n');
  });

  it('converts a KiCad position file into a CPL', () => {
    const pos = '"Ref","Val","Package","PosX","PosY","Rot","Side"\n"C1","100n","C_0603",12.5,-30.25,90.0,"top"\n"U1","MCU","QFN",1,2,180,"bottom"\n';
    expect(jlcCpl(pos)).toBe('Designator,Mid X,Mid Y,Layer,Rotation\nC1,12.5000mm,-30.2500mm,Top,90\nU1,1.0000mm,2.0000mm,Bottom,180\n');
  });

  it('keeps only fabrication layers', () => {
    expect(isFabFile('board-F_Cu.gtl')).toBe(true);
    expect(isFabFile('board-Edge_Cuts.gm1')).toBe(true);
    expect(isFabFile('board-PTH.drl')).toBe(true);
    expect(isFabFile('board-F_Courtyard.gbr')).toBe(false);
    expect(isFabFile('board-User_3.gbr')).toBe(false);
    expect(isFabFile('board-PTH-drl_map.gbr')).toBe(false);
  });

  it('drops mounting holes from the assembly BOM', () => {
    expect(jlcBom([line({ references: ['H1'], value: 'MountingHole', libId: 'Mechanical:MountingHole', footprint: 'MountingHole:MountingHole_3.2mm' })])).toBe('Comment,Designator,Footprint,LCSC Part #\n');
  });

  it('builds a PCBWay BOM and centroid file', () => {
    const csv = pcbwayBom([line({ references: ['U1'], quantity: 1, value: 'NE555', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', fields: { MPN: 'NE555DR', Manufacturer: 'TI' } }), line({ references: ['R9'], dnp: true })]);
    expect(csv.split('\n')[1]).toBe('1,U1,1,TI,NE555DR,NE555,SOIC-8_3.9x4.9mm_P1.27mm,SMD,');
    expect(csv.trim().split('\n')).toHaveLength(2);
    expect(pcbwayCpl('Ref,Val,Package,PosX,PosY,Rot,Side\n"C1","1u","C_0603",12.5,-30.25,90,top\n')).toBe('Designator,Mid X,Mid Y,Layer,Rotation\nC1,12.5000,-30.2500,Top,90\n');
  });

  it('lays OSH Park out flat with no assembly files', () => {
    expect(FAB_LAYOUTS.oshpark).toEqual({ gerberDir: '', bom: null, cpl: null });
  });
});
