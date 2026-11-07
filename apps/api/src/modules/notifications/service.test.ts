import { describe, expect, it } from 'vitest';
import { parseMentions } from './service';

describe('parseMentions', () => {
  it('finds mentions and de-duplicates case-insensitively', () => {
    expect(parseMentions('hi @Alice and @bob-1, ping @alice again')).toEqual(['alice', 'bob-1']);
  });
  it('ignores emails, paths and code', () => {
    expect(parseMentions('mail me@example.com or see /org/@scope/pkg')).toEqual([]);
    expect(parseMentions('use `@ignored` and\n```\n@fenced\n```\nbut @real')).toEqual(['real']);
  });
  it('requires a boundary after the name', () => {
    expect(parseMentions('@name_with_underscore')).toEqual(['name']);
    expect(parseMentions('@-bad')).toEqual([]);
  });
  it('handles mention at line start and after punctuation', () => {
    expect(parseMentions('@a\n(@b) "@c"')).toEqual(['a', 'b', 'c']);
  });
});
