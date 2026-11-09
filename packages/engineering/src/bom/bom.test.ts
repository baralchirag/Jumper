import { describe, expect, it } from 'vitest';
import { checkPolicy, globToRegExp, parseTiers, summarizeTier } from '../index';

describe('cost tiers', () => {
  it('computes per-board prices from totals', () => {
    const t = summarizeTier({
      boards: 10,
      bestMix: { total: 25, covered: 8 },
      sourceable: 9,
      suppliers: [{ supplier: 'LCSC', total: 30, covered: 7, enabled: true, error: null }],
    });
    expect(t.bestMix).toEqual({ total: 25, perBoard: 2.5, covered: 8 });
    expect(t.suppliers[0]).toMatchObject({ supplier: 'LCSC', perBoard: 3 });
  });
  it('guards against zero boards', () => {
    expect(summarizeTier({ boards: 0, bestMix: { total: 5, covered: 1 }, sourceable: 1, suppliers: [] }).bestMix.perBoard).toBe(5);
  });
  it('parses volume lists defensively', () => {
    expect(parseTiers(undefined)).toEqual([1, 10, 100, 1000]);
    expect(parseTiers('100, 1,1,abc,-5,0,1.5,999999')).toEqual([1, 100]);
    expect(parseTiers('1,2,3,4,5,6,7,8', 4)).toEqual([1, 2, 3, 4]);
  });
});

describe('part policy', () => {
  const policy = { approvedManufacturers: ['TI', 'Murata'], preferredParts: ['GRM*'], bannedParts: [{ pattern: 'NE555*', reason: 'obsolete' }], bannedFootprints: [{ pattern: '*0201*', reason: 'cannot be hand assembled' }] };
  it('flags banned parts, footprints and unapproved vendors', () => {
    const r = checkPolicy(
      [
        { references: ['U1'], value: 'NE555', footprint: 'SOIC-8', mpn: 'NE555DR', manufacturer: 'TI' },
        { references: ['C1'], value: '100n', footprint: 'C_0201_0603Metric', mpn: 'GRM033', manufacturer: 'Murata' },
        { references: ['R1'], value: '1k', footprint: 'R_0603', mpn: 'RC0603', manufacturer: 'Yageo' },
      ],
      policy,
    );
    expect(r.violations.map((v) => v.rule).sort()).toEqual(['banned-footprint', 'banned-part', 'unapproved-manufacturer']);
    expect(r.preferred).toBe(1);
  });
  it('treats glob metacharacters literally except * and ?', () => {
    expect(globToRegExp('A.B*').test('A.Bxyz')).toBe(true);
    expect(globToRegExp('A.B*').test('AxBxyz')).toBe(false);
    expect(globToRegExp('(x)').test('(x)')).toBe(true);
  });
});
