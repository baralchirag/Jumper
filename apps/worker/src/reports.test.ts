import { describe, expect, it } from 'vitest';
import { parsePcbhubConfig } from '@pcbhub/shared';
import { evaluateDrc, evaluateErc } from './reports';

const cfg = (yaml = '') => parsePcbhubConfig(yaml).config;

describe('evaluateDrc', () => {
  const report = {
    violations: [
      { type: 'clearance', description: 'Clearance violation', severity: 'error', items: [{ description: 'Track', pos: { x: 10, y: 20 } }] },
      { type: 'silk_overlap', description: 'Silk overlap', severity: 'warning', items: [] },
    ],
    unconnected_items: [{ description: 'Missing connection', severity: 'warning', items: [] }],
  };

  it('fails on errors and counts unconnected items as errors', () => {
    const e = evaluateDrc(report, cfg());
    expect(e.conclusion).toBe('failure');
    expect(e.counts).toEqual({ error: 2, warning: 1, ignored: 0 });
    expect(e.annotations[0]).toMatchObject({ type: 'clearance', x: 10, y: 20 });
  });

  it('applies severity overrides', () => {
    const e = evaluateDrc(report, cfg('severity_overrides:\n  drc:\n    clearance: ignore\n    unconnected_items: ignore\n'));
    expect(e.counts).toEqual({ error: 0, warning: 1, ignored: 2 });
    expect(e.conclusion).toBe('neutral');
  });
});

describe('evaluateErc', () => {
  it('passes a clean report', () => {
    const e = evaluateErc({ sheets: [{ path: '/', violations: [] }] }, cfg());
    expect(e.conclusion).toBe('success');
    expect(e.summary).toBe('No ERC violations');
  });

  it('respects fail_on: warning', () => {
    const rep = { sheets: [{ path: '/', violations: [{ type: 'pin_not_driven', severity: 'warning' }] }] };
    expect(evaluateErc(rep, cfg()).conclusion).toBe('neutral');
    expect(evaluateErc(rep, cfg('checks:\n  erc:\n    fail_on: warning\n')).conclusion).toBe('failure');
  });
});
