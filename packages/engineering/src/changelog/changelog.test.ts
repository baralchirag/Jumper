import { describe, expect, it } from 'vitest';
import type { Change, DiffResult } from '@jumper/kicad-core/types';
import { changelogMarkdown, summarizeDiff } from '../index';

const ch = (op: Change['op'], object: string, label: string, fields: Change['fields'] = []): Change => ({ op, object, id: label, label, layer: null, bbox: null, fields });
const diff: DiffResult = {
  kind: 'pcb',
  summary: { added: 2, removed: 1, modified: 1, byObject: {} },
  changes: [ch('added', 'footprint', 'C4'), ch('added', 'footprint', 'C5'), ch('removed', 'track', 't1'), ch('modified', 'footprint', 'R1', [{ field: 'value', before: '10k', after: '4k7' }])],
  nets: [{ name: 'VBUS', op: 'modified', tracksBefore: 3, tracksAfter: 5, viasBefore: 1, viasAfter: 2, lengthBefore: 10, lengthAfter: 25.5, padsBefore: ['U1-1'], padsAfter: ['U1-1'] }, { name: 'NEW', op: 'added', tracksBefore: 0, tracksAfter: 1, viasBefore: 0, viasAfter: 0, lengthBefore: 0, lengthAfter: 1, padsBefore: [], padsAfter: [] }],
};

describe('changelog', () => {
  it('summarizes parts, values and nets', () => {
    const s = summarizeDiff(diff);
    expect(s).toContain('Added 2 footprints (C4, C5)');
    expect(s).toContain('Removed 1 track segment');
    expect(s).toContain('R1: value `10k` → `4k7`');
    expect(s).toContain('Net VBUS: vias 1 → 2, length 10.0 → 25.5 mm');
    expect(s).toContain('New net NEW');
  });
  it('truncates long reference lists', () => {
    const many: DiffResult = { ...diff, changes: Array.from({ length: 10 }, (_, i) => ch('added', 'footprint', `C${i}`)), nets: [] };
    expect(summarizeDiff(many, { maxRefs: 3 })[0]).toBe('Added 10 footprints (C0, C1, C2 and 7 more)');
  });
  it('says so when nothing changed', () => {
    expect(changelogMarkdown('v1.1', [{ file: 'a.kicad_pcb', diff: { ...diff, changes: [], nets: [] } }])).toContain('No design changes.');
  });
});
