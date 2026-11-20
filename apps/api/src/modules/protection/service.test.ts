import { describe, expect, it } from 'vitest';
import type { BranchProtection } from '@jumper/db';
import { branchMatches, effectiveFor, hookRules, validatePattern } from './service';

const rule = (over: Partial<BranchProtection>): BranchProtection => ({
  id: 'x', repoId: 'r', pattern: 'main', blockDeletion: true, blockForcePush: true, requirePullRequest: false, enforceAdmins: false, createdAt: new Date(), ...over,
});

describe('branchMatches', () => {
  it('matches exact names and wildcards like a shell glob', () => {
    expect(branchMatches('main', 'main')).toBe(true);
    expect(branchMatches('main', 'main2')).toBe(false);
    expect(branchMatches('release/*', 'release/1.0')).toBe(true);
    expect(branchMatches('release/*', 'release/1.0/hotfix')).toBe(true);
    expect(branchMatches('release/*', 'releases/1')).toBe(false);
    expect(branchMatches('v?', 'v1')).toBe(true);
    expect(branchMatches('*', 'anything/at/all')).toBe(true);
  });
  it('is linear on hostile patterns', () => {
    const t = Date.now();
    branchMatches('*'.repeat(50) + 'x', 'a'.repeat(20_000));
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe('validatePattern', () => {
  it('accepts normal patterns and rejects anything shell-interesting', () => {
    for (const ok of ['main', 'release/*', 'feat-?', 'v1.2']) expect(validatePattern(ok)).toBeNull();
    for (const bad of ['', 'a b', '$(rm -rf /)', 'a;b', 'a`b`', '[ab]', '{a,b}', '../x', '/main', 'main/', 'a//b', 'x'.repeat(101), 'a\nb', "a'b"]) expect(validatePattern(bad), bad).not.toBeNull();
  });
});

describe('effectiveFor / hookRules', () => {
  it('combines matching rules and exempts admins unless enforced', () => {
    const rules = [rule({ pattern: 'main', requirePullRequest: true }), rule({ pattern: 'rel*', blockForcePush: false, enforceAdmins: true })];
    expect(effectiveFor(rules, 'main', false)).toEqual({ blockDeletion: true, blockForcePush: true });
    expect(effectiveFor(rules, 'main', true)).toBeNull();
    expect(effectiveFor(rules, 'release', true)).toMatchObject({ blockForcePush: false, blockDeletion: true });
    expect(effectiveFor(rules, 'feature', false)).toBeNull();
  });
  it('serialises flags for the hook', () => {
    // Old rows with require_pull_request set must not lock anyone out.
    expect(hookRules([rule({ pattern: 'main', requirePullRequest: true })], false)).toBe('main\tDF');
    expect(hookRules([rule({ pattern: 'main' })], true)).toBe('');
  });
});
