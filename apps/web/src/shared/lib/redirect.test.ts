import { describe, expect, it } from 'vitest';
import { safeRedirect } from './redirect';

const O = 'https://jumper.test';

describe('safeRedirect', () => {
  it('keeps same-site paths with their query', () => {
    expect(safeRedirect('/checkout?plan=pro&cycle=annual', O)).toBe('/checkout?plan=pro&cycle=annual');
    expect(safeRedirect('/acme/board#x', O)).toBe('/acme/board#x');
  });
  it.each([
    ['protocol-relative', '//evil.example/x'],
    ['backslash', '/\\evil.example'],
    ['tab inside', '/\t/evil.example'],
    ['newline inside', '/\n/evil.example'],
    ['absolute URL', 'https://evil.example'],
    ['javascript URL', 'javascript:alert(1)'],
    ['empty', ''],
    ['missing', undefined],
  ])('refuses %s', (_name, r) => {
    expect(safeRedirect(r as string | undefined, O)).toBe('/');
  });
});
