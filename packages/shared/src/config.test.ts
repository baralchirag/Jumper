import { describe, expect, it } from 'vitest';
import { parsePcbhubConfig } from './config';

describe('parsePcbhubConfig', () => {
  it('returns defaults for empty input', () => {
    const { config, error } = parsePcbhubConfig('');
    expect(error).toBeNull();
    expect(config.checks.drc.enabled).toBe(true);
    expect(config.required_checks).toEqual(['ERC', 'DRC']);
  });

  it('merges partial config with defaults', () => {
    const { config } = parsePcbhubConfig('checks:\n  drc:\n    fail_on: warning\nseverity_overrides:\n  drc:\n    silk_overlap: ignore\n');
    expect(config.checks.drc.fail_on).toBe('warning');
    expect(config.checks.erc.fail_on).toBe('error');
    expect(config.severity_overrides.drc.silk_overlap).toBe('ignore');
  });

  it('reports schema errors', () => {
    const { error } = parsePcbhubConfig('checks:\n  drc:\n    fail_on: sometimes\n');
    expect(error).toContain('fail_on');
  });
});
