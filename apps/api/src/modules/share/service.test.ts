import { describe, expect, it } from 'vitest';
import { cleanPath, contentTypeFor, inScope, linkState, listingAllowed } from './service';

describe('cleanPath', () => {
  it('normalises slashes and rejects traversal', () => {
    expect(cleanPath('/a//b/')).toBe('a/b');
    expect(cleanPath('a\\b')).toBe('a/b');
    expect(cleanPath('')).toBe('');
    expect(cleanPath(undefined)).toBe('');
    expect(cleanPath('../etc/passwd')).toBeNull();
    expect(cleanPath('a/../../b')).toBeNull();
    expect(cleanPath('a/./b')).toBeNull();
    expect(cleanPath('a\0b')).toBeNull();
  });
});

describe('scope', () => {
  it('limits files to the scope subtree, without prefix confusion', () => {
    expect(inScope('hw', 'hw/board.kicad_pcb')).toBe(true);
    expect(inScope('hw', 'hw')).toBe(true);
    expect(inScope('hw', 'hw-secret/board.kicad_pcb')).toBe(false);
    expect(inScope('hw', 'other/hw/board')).toBe(false);
    expect(inScope(null, 'anything')).toBe(true);
  });
  it('lets viewers list ancestors of the scope but nothing beside it', () => {
    expect(listingAllowed('a/b', '')).toBe(true);
    expect(listingAllowed('a/b', 'a')).toBe(true);
    expect(listingAllowed('a/b', 'a/b/c')).toBe(true);
    expect(listingAllowed('a/b', 'a/x')).toBe(false);
    expect(listingAllowed('a/b', 'ab')).toBe(false);
  });
});

describe('linkState', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  it('reports revoked, expired and active', () => {
    expect(linkState({ expiresAt: null, revokedAt: null }, now)).toBe('active');
    expect(linkState({ expiresAt: new Date('2026-06-01'), revokedAt: null }, now)).toBe('active');
    expect(linkState({ expiresAt: new Date('2025-12-31'), revokedAt: null }, now)).toBe('expired');
    expect(linkState({ expiresAt: new Date('2027-01-01'), revokedAt: new Date('2025-01-01') }, now)).toBe('revoked');
  });
});

describe('contentTypeFor', () => {
  it('renders only known-safe types inline', () => {
    expect(contentTypeFor('x.svg')).toEqual({ type: 'image/svg+xml', inline: true });
    expect(contentTypeFor('x.html')).toEqual({ type: 'application/octet-stream', inline: false });
    expect(contentTypeFor('x.js').inline).toBe(false);
    expect(contentTypeFor('noext').inline).toBe(false);
  });
});
