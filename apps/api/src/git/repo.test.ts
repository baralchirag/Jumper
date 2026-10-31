import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EMPTY_TREE, GitRepo } from './repo';

const dir = await mkdtemp(join(tmpdir(), 'pcbhub-git-'));
afterAll(() => rm(dir, { recursive: true, force: true }));
const sig = { name: 'Test', email: 'test@example.com' };

async function commitFiles(git: GitRepo, files: Record<string, string>, parents: string[], msg: string) {
  const entries = await Promise.all(
    Object.entries(files).map(async ([name, content]) => ({ mode: '100644', type: 'blob' as const, oid: await git.writeBlob(content), name })),
  );
  return git.commitTree(await git.mktree(entries), parents, msg, sig);
}

describe('GitRepo', async () => {
  const git = await GitRepo.init(join(dir, 'r.git'), 'main');

  it('creates commits, branches and reads them back', async () => {
    expect(await git.isEmpty()).toBe(true);
    const c1 = await commitFiles(git, { 'a.txt': 'one\n', 'b.txt': 'b\n' }, [], 'first');
    await git.updateRef('refs/heads/main', c1, null);
    expect(await git.isEmpty()).toBe(false);
    expect(await git.resolveBranch('main')).toBe(c1);
    expect((await git.tree(c1, '')).map((e) => e.name)).toEqual(['a.txt', 'b.txt']);
    expect((await git.readFile(c1, 'a.txt'))?.toString()).toBe('one\n');
    expect(await git.readFile(c1, 'missing')).toBeNull();
    expect(await git.resolveCommit('--output=/tmp/x')).toBeNull();
  });

  it('diffs, merges cleanly and detects conflicts', async () => {
    const base = (await git.resolveBranch('main'))!;
    const ours = await commitFiles(git, { 'a.txt': 'one\n', 'b.txt': 'b changed\n' }, [base], 'ours');
    const theirs = await commitFiles(git, { 'a.txt': 'one\ntwo\n', 'b.txt': 'b\n', 'c.txt': 'new\n' }, [base], 'theirs');

    const files = await git.diff(base, theirs);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['a.txt', 'modified'],
      ['c.txt', 'added'],
    ]);
    expect(files[0]!.additions).toBe(1);
    expect(files[0]!.patch).toContain('+two');
    expect((await git.diff(EMPTY_TREE, base)).length).toBe(2);

    const clean = await git.mergeTree(ours, theirs);
    expect(clean.conflicts).toEqual([]);
    const merged = await git.commitTree(clean.tree, [ours, theirs], 'merge', sig);
    expect((await git.readFile(merged, 'b.txt'))?.toString()).toBe('b changed\n');
    expect(await git.isAncestor(base, merged)).toBe(true);

    const clash = await commitFiles(git, { 'a.txt': 'one\nTHREE\n', 'b.txt': 'b\n' }, [base], 'clash');
    expect((await git.mergeTree(theirs, clash)).conflicts).toEqual(['a.txt']);
  });

  it('refuses stale compare-and-swap ref updates', async () => {
    const head = (await git.resolveBranch('main'))!;
    const next = await commitFiles(git, { 'a.txt': 'x\n' }, [head], 'next');
    await expect(git.updateRef('refs/heads/main', next, '0'.repeat(39) + '1')).rejects.toThrow();
    await git.updateRef('refs/heads/main', next, head);
    expect(await git.resolveBranch('main')).toBe(next);
  });
});
