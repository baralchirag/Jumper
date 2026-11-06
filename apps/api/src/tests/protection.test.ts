import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, dbAvailable, type Client, type Harness } from '../testing/harness';

const run = promisify(execFile);

describe.skipIf(!dbAvailable)('branch protection (real git pushes over HTTP)', () => {
  let h: Harness;
  let base: string;
  let work: string;
  let alice: Client, bob: Client;
  let aliceTok: string, bobTok: string;

  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args: string[]) => run('git', args, { cwd: work, env, timeout: 30_000 });
  /** Push and report success plus git's stderr (which carries the hook's message). */
  const push = async (tok: string, user: string, ...refspec: string[]) => {
    try {
      const r = await git('push', `http://${user}:${tok}@${base}/alice/board.git`, ...refspec);
      return { ok: true, err: r.stderr };
    } catch (e) {
      return { ok: false, err: String((e as { stderr?: string }).stderr ?? e) };
    }
  };
  const commit = async (file: string, text: string) => {
    await writeFile(join(work, file), text);
    await git('add', '.');
    await git('commit', '-q', '-m', `change ${file}`);
  };

  beforeAll(async () => {
    h = await createHarness();
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    base = `127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    work = await mkdtemp(join(tmpdir(), 'jumper-work-'));
    alice = await h.user('alice');
    bob = await h.user('bob');
    await h.repo(alice, 'board');
    expect((await alice.put('/api/repos/alice/board/collaborators/bob', { role: 'write' })).status).toBe(200);
    aliceTok = (await alice.post('/api/user/tokens', { name: 't', scopes: ['repo:write'], expiresInDays: 1 })).json.token;
    bobTok = (await bob.post('/api/user/tokens', { name: 't', scopes: ['repo:write'], expiresInDays: 1 })).json.token;
    await git('init', '-q', '-b', 'main');
    await commit('a.txt', '1');
    expect((await push(aliceTok, 'alice', 'main')).ok).toBe(true);
    await rm(work, { recursive: false, force: true }).catch(() => {});
  });
  afterAll(() => rm(work, { recursive: true, force: true }).catch(() => {}));

  async function freshClone(tok: string, user: string) {
    work = await mkdtemp(join(tmpdir(), 'jumper-work-'));
    await run('git', ['clone', '-q', `http://${user}:${tok}@${base}/alice/board.git`, work], { env, timeout: 30_000 });
  }

  it('without a rule everything is allowed', async () => {
    await freshClone(bobTok, 'bob');
    await commit('b.txt', '2');
    expect((await push(bobTok, 'bob', 'main')).ok).toBe(true);
  });

  it('refuses force-pushes and deletions of a protected branch, allows normal pushes', async () => {
    expect((await alice.post('/api/repos/alice/board/branch-protection', { pattern: 'main' })).status).toBe(200);
    await freshClone(bobTok, 'bob');
    await commit('b.txt', '2');
    expect((await push(bobTok, 'bob', 'main')).ok).toBe(true);
    await git('reset', '-q', '--hard', 'HEAD~1');
    await commit('c.txt', 'rewritten');
    const forced = await push(bobTok, 'bob', '--force', 'main');
    expect(forced.ok).toBe(false);
    expect(forced.err).toContain('cannot be force-pushed');
    const del = await push(bobTok, 'bob', '--delete', 'main');
    expect(del.ok).toBe(false);
    expect(del.err).toMatch(/cannot be deleted|default branch|protected/i);
  });

  it('other branches are unaffected by a rule on main', async () => {
    await alice.post('/api/repos/alice/board/branch-protection', { pattern: 'main' });
    await freshClone(bobTok, 'bob');
    await git('checkout', '-q', '-b', 'feature');
    await commit('f.txt', 'x');
    expect((await push(bobTok, 'bob', 'feature')).ok).toBe(true);
    await git('reset', '-q', '--hard', 'HEAD~1');
    expect((await push(bobTok, 'bob', '--force', 'feature')).ok).toBe(true);
    expect((await push(bobTok, 'bob', '--delete', 'feature')).ok).toBe(true);
  });

  it('admins are exempt unless the rule enforces admins', async () => {
    const rule = await alice.post('/api/repos/alice/board/branch-protection', { pattern: 'main' });
    await freshClone(aliceTok, 'alice');
    await git('reset', '-q', '--hard', 'HEAD');
    await commit('x.txt', 'x');
    await git('commit', '-q', '--amend', '-m', 'amended');
    // alice is admin and the rule does not enforce admins: a force push over the same history is fine.
    expect((await push(aliceTok, 'alice', '--force', 'main')).ok).toBe(true);
    expect((await alice.patch(`/api/repos/alice/board/branch-protection/${rule.json.id}`, { enforceAdmins: true })).status).toBe(200);
    await git('commit', '-q', '--amend', '-m', 'amended again');
    const res = await push(aliceTok, 'alice', '--force', 'main');
    expect(res.ok).toBe(false);
    expect(res.err).toContain('cannot be force-pushed');
  });

  it('require-pull-request blocks direct pushes but not merges through a pull request', async () => {
    await alice.post('/api/repos/alice/board/branch-protection', { pattern: 'main', requirePullRequest: true });
    await freshClone(bobTok, 'bob');
    await git('checkout', '-q', '-b', 'feature');
    await commit('f.txt', 'feature work');
    // No worker runs in tests, so do not require checks that can never report.
    await commit('.jumper.yml', 'required_checks: []\n');
    expect((await push(bobTok, 'bob', 'feature')).ok).toBe(true);
    await git('checkout', '-q', 'main');
    await commit('direct.txt', 'sneaky');
    const direct = await push(bobTok, 'bob', 'main');
    expect(direct.ok).toBe(false);
    expect(direct.err).toContain('open a pull request');
    const pr = await bob.post('/api/repos/alice/board/pulls', { title: 'Feature', base: 'main', head: 'feature' });
    expect(pr.status).toBe(200);
    const merged = await alice.post(`/api/repos/alice/board/pulls/${pr.json.number}/merge`, { method: 'merge' });
    expect(merged.status, merged.body).toBe(200);
  });

  it('the API refuses to delete a protected branch and hides nothing from readers', async () => {
    await freshClone(aliceTok, 'alice');
    await git('checkout', '-q', '-b', 'release/1');
    await commit('r.txt', 'r');
    expect((await push(aliceTok, 'alice', 'release/1')).ok).toBe(true);
    await alice.post('/api/repos/alice/board/branch-protection', { pattern: 'release/*', enforceAdmins: true });
    const del = await alice.del('/api/repos/alice/board/branches/release/1');
    expect(del.status).toBe(409);
    expect((await h.anon.get('/api/repos/alice/board/branch-protection')).json[0].pattern).toBe('release/*');
  });

  it('rules are admin-only and patterns are validated', async () => {
    expect((await bob.post('/api/repos/alice/board/branch-protection', { pattern: 'main' })).status).toBe(403);
    expect((await h.anon.post('/api/repos/alice/board/branch-protection', { pattern: 'main' })).status).toBe(401);
    for (const bad of ['a b', '$(id)', 'x;y', '../m', '[a]']) {
      expect((await alice.post('/api/repos/alice/board/branch-protection', { pattern: bad })).status, bad).toBe(400);
    }
    expect((await alice.post('/api/repos/alice/board/branch-protection', { pattern: 'main' })).status).toBe(200);
    expect((await alice.post('/api/repos/alice/board/branch-protection', { pattern: 'main' })).status).toBe(409);
  });
});
