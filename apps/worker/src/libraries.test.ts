import { describe, expect, it } from 'vitest';
import { libraryReport, librarySummary, parseLibTable, symbolIds } from './libraries';

const SCH = `(kicad_sch (version 20231120)
  (lib_symbols
    (symbol "Device:R" (property "Value" "R (generic)") (symbol "R_0_1"))
    (symbol "MyParts:LDO_3V3" (property "Value" "LDO"))
  )
  (symbol (lib_id "Device:R") (at 10 10 0) (property "Footprint" "Resistor_SMD:R_0603_1608Metric"))
  (symbol (lib_id "Device:R") (at 20 10 0) (property "Footprint" "Resistor_SMD:R_0603_1608Metric"))
  (symbol (lib_id "MyParts:LDO_3V3") (at 30 10 0) (property "Footprint" "MyFootprints:SOT-223"))
  (symbol (lib_id "Laptop_Only:Sensor") (at 40 10 0) (property "Footprint" ""))
  (sheet (at 0 0) (size 10 10) (property "Sheetname" "Power") (property "Sheetfile" "power.kicad_sch"))
  (sheet (at 0 0) (size 10 10) (property "Sheetname" "USB") (property "Sheetfile" "usb.kicad_sch"))
)`;

const SYM_TABLE = `(sym_lib_table
  (version 7)
  (lib (name "MyParts")(type "KiCad")(uri "\${KIPRJMOD}/libs/MyParts.kicad_sym")(options "")(descr "Our parts (verified)"))
  (lib (name "Gone")(type "KiCad")(uri "\${KIPRJMOD}/libs/Gone.kicad_sym")(options "")(descr ""))
)`;
const FP_TABLE = `(fp_lib_table (lib (name "MyFootprints")(type "KiCad")(uri "\${KIPRJMOD}/libs/MyFootprints.pretty")(options "")(descr "")))`;
const BOARD = `(kicad_pcb (footprint "Resistor_SMD:R_0603_1608Metric" (at 1 1)) (footprint "MyFootprints:SOT-223" (at 2 2)) (footprint "Desk:Logo" (at 3 3)))`;

describe('library report', () => {
  it('parses lib tables, including descriptions with parentheses', () => {
    expect(parseLibTable(SYM_TABLE)).toEqual([
      { name: 'MyParts', type: 'KiCad', uri: '${KIPRJMOD}/libs/MyParts.kicad_sym' },
      { name: 'Gone', type: 'KiCad', uri: '${KIPRJMOD}/libs/Gone.kicad_sym' },
    ]);
  });

  it('counts placed symbols, not embedded definitions', () => {
    expect(symbolIds(SCH)).toEqual(['Device:R', 'Device:R', 'MyParts:LDO_3V3', 'Laptop_Only:Sensor']);
  });

  it('classifies project, standard and missing libraries, and finds missing sheets', () => {
    const r = libraryReport({
      projectDir: 'hw',
      schematics: [{ path: 'hw/main.kicad_sch', text: SCH }],
      board: BOARD,
      symLibTable: SYM_TABLE,
      fpLibTable: FP_TABLE,
      repoFiles: new Set(['hw/main.kicad_sch', 'hw/power.kicad_sch', 'hw/libs/MyParts.kicad_sym', 'hw/libs/MyFootprints.pretty/SOT-223.kicad_mod']),
      standardSymbols: new Set(['Device', 'Power']),
      standardFootprints: new Set(['Resistor_SMD']),
      missingModels: ['${KIPRJMOD}/3d/custom.step'],
    });
    expect(r.symbols.map((l) => [l.nickname, l.status, l.uses])).toEqual([
      ['Laptop_Only', 'missing', 1],
      ['MyParts', 'project', 1],
      ['Device', 'standard', 2],
    ]);
    expect(r.footprints.map((l) => [l.nickname, l.status])).toEqual([
      ['Desk', 'missing'],
      ['MyFootprints', 'project'],
      ['Resistor_SMD', 'standard'],
    ]);
    expect(r.missingSheets).toEqual(['hw/usb.kicad_sch']);
    expect(r.problems).toBe(3);
    expect(librarySummary(r)).toBe('Not in the repository: 1 symbol library, 1 footprint library, 1 sheet file, 1 3D model');
  });

  it('reports libraries listed in the table whose files were not committed', () => {
    const sch = `(kicad_sch (symbol (lib_id "Gone:X")))`;
    const r = libraryReport({ projectDir: '', schematics: [{ path: 'a.kicad_sch', text: sch }], board: null, symLibTable: SYM_TABLE, fpLibTable: null, repoFiles: new Set(['a.kicad_sch']), standardSymbols: new Set(), standardFootprints: new Set() });
    expect(r.symbols).toEqual([{ nickname: 'Gone', status: 'file-missing', uses: 1, examples: ['Gone:X'], uri: '${KIPRJMOD}/libs/Gone.kicad_sym' }]);
  });

  it('says unknown rather than missing when the standard libraries are not available', () => {
    const r = libraryReport({ projectDir: '', schematics: [{ path: 'a.kicad_sch', text: SCH }], board: null, symLibTable: null, fpLibTable: null, repoFiles: new Set(), standardSymbols: null, standardFootprints: null });
    expect(r.symbols.every((l) => l.status === 'unknown')).toBe(true);
    expect(r.problems).toBe(2); // the two missing sheets only
    expect(librarySummary({ ...r, missingSheets: [], problems: 0 })).toBeNull();
  });
});
