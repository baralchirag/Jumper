import { describe, expect, it } from 'vitest';
import { buildModelIndex, fixModelPaths } from './models3d';

const index = buildModelIndex('/usr/share/kicad/3dmodels/', [
  'LED_SMD.3dshapes/LED_0603_1608Metric.step',
  'Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step',
  'RF_Module.3dshapes/ESP32-WROVER-E.step',
]);

describe('fixModelPaths', () => {
  it('maps legacy variables and .wrl to the installed STEP file', () => {
    const board = '(model "${KICAD6_3DMODEL_DIR}/LED_SMD.3dshapes/LED_0603_1608Metric.wrl" (offset))';
    const r = fixModelPaths(board, index, new Set());
    expect(r.text).toBe('(model "/usr/share/kicad/3dmodels/LED_SMD.3dshapes/LED_0603_1608Metric.step" (offset))');
    expect(r.fixed).toBe(1);
  });

  it('understands the :ALIAS: syntax', () => {
    const r = fixModelPaths('(model ":KICAD7_3DMODEL_DIR:Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step"', index, new Set());
    expect(r.text).toContain('/usr/share/kicad/3dmodels/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step');
  });

  it('falls back to a file-name match for foreign absolute paths', () => {
    const r = fixModelPaths('(model "D:/Kicad Lib/Espressif/3d/ESP32-WROVER-E.STEP"', index, new Set());
    expect(r.text).toContain('RF_Module.3dshapes/ESP32-WROVER-E.step');
  });

  it('keeps project models and reports unresolved ones', () => {
    const r = fixModelPaths('(model "${KIPRJMOD}/shapes/x.step") (model "${FOO}/nope.step")', index, new Set(['shapes/x.step']));
    expect(r.fixed).toBe(0);
    expect(r.missing).toEqual(['${FOO}/nope.step']);
  });
});
