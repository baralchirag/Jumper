import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@jumper/db';
import { commitFiles, createHarness, dbAvailable, type Client, type Harness } from '../testing/harness';
import { parseGitCommand, parsePublicKey } from '../modules/ssh/keys';
import { startSshServer, type SshServer } from '../modules/ssh/server';

const hasSsh = spawnSync('ssh', ['-V']).status === 0;

describe('ssh key parsing', () => {
  it('accepts modern keys and computes the OpenSSH fingerprint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jumper-key-'));
    try {
      spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'me@laptop', '-f', join(dir, 'k'), '-q']);
      const pub = await readFile(join(dir, 'k.pub'), 'utf8');
      const fp = spawnSync('ssh-keygen', ['-lf', join(dir, 'k.pub')], { encoding: 'utf8' }).stdout.split(' ')[1];
      const parsed = parsePublicKey(pub);
      expect(parsed).toMatchObject({ keyType: 'ssh-ed25519', comment: 'me@laptop', fingerprint: fp });
      spawnSync('ssh-keygen', ['-t', 'rsa', '-b', '1024', '-N', '', '-f', join(dir, 'weak'), '-q']);
      expect(() => parsePublicKey(spawnSync('cat', [join(dir, 'weak.pub')], { encoding: 'utf8' }).stdout)).toThrow(/2048/);
      expect(() => parsePublicKey(spawnSync('cat', [join(dir, 'k')], { encoding: 'utf8' }).stdout)).toThrow(/private key/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(() => parsePublicKey('ssh-dss AAAAB3NzaC1kc3M')).toThrow(/DSA/);
    expect(() => parsePublicKey('ssh-ed25519 notbase64!!')).toThrow();
  });

  it('accepts only git service commands on owner/repo paths', () => {
    expect(parseGitCommand("git-receive-pack '/alice/board.git'")).toEqual({ service: 'git-receive-pack', owner: 'alice', repo: 'board' });
    expect(parseGitCommand("git-upload-pack 'alice/board'")).toEqual({ service: 'git-upload-pack', owner: 'alice', repo: 'board' });
    expect(parseGitCommand("git-upload-pack '../../etc/passwd'")).toBeNull();
    expect(parseGitCommand('git-upload-pack alice/board; rm -rf /')).toBeNull();
    expect(parseGitCommand('bash')).toBeNull();
  });
});

describe.skipIf(!dbAvailable || !hasSsh)('git over SSH', () => {
  let h: Harness;
  let ssh: SshServer;
  let dir: string;
  let alice: Client, bob: Client;
  beforeAll(async () => {
    h = await createHarness({ env: { SSH_ENABLED: 'true', SSH_PORT: '0' } });
    ssh = await startSshServer(h.ctx, h.app.log, { host: '127.0.0.1', port: 0 });
    dir = await mkdtemp(join(tmpdir(), 'jumper-ssh-'));
    for (const who of ['alice', 'bob', 'stranger']) spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', join(dir, who), '-q']);
  });
  afterAll(async () => {
    await ssh.close();
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await h.reset();
    alice = await h.user('alice');
    bob = await h.user('bob');
  });

  // Async on purpose: the SSH server runs in this process, so a blocking spawn would deadlock.
  const git = (who: string, args: string[], cwd = dir) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn('git', args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_SSH_COMMAND: `ssh -i ${join(dir, who)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p ${ssh.port}`,
        GIT_AUTHOR_NAME: who,
        GIT_AUTHOR_EMAIL: `${who}@example.com`,
        GIT_COMMITTER_NAME: who,
        GIT_COMMITTER_EMAIL: `${who}@example.com`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  const addKey = async (c: Client, who: string) => c.post('/api/user/ssh-keys', { title: who, key: await readFile(join(dir, `${who}.pub`), 'utf8') });

  it('clones and pushes with a registered key, honouring repository permissions', async () => {
    const repo = await h.repo(alice, 'board', { visibility: 'private' });
    await commitFiles(repo.git, { 'README.md': '# board' });
    expect((await addKey(alice, 'alice')).status).toBe(200);
    expect((await addKey(bob, 'bob')).status).toBe(200);
    const info = await alice.get('/api/repos/alice/board');
    expect(info.json.sshCloneUrl).toMatch(/^ssh:\/\/git@localhost:\d+\/alice\/board\.git$/);
    const url = `ssh://git@127.0.0.1:${ssh.port}/alice/board.git`;

    const clone = await git('alice', ['clone', url, 'a']);
    expect(clone.status, clone.stderr).toBe(0);
    await writeFile(join(dir, 'a', 'notes.txt'), 'hello');
    await git('alice', ['add', '.'], join(dir, 'a'));
    await git('alice', ['commit', '-m', 'notes'], join(dir, 'a'));
    const push = await git('alice', ['push', 'origin', 'HEAD:main'], join(dir, 'a'));
    expect(push.status, push.stderr).toBe(0);
    const head = (await git('alice', ['rev-parse', 'HEAD'], join(dir, 'a'))).stdout.trim();
    expect(await repo.git.resolveBranch('main')).toBe(head);
    const used = (await alice.get('/api/user/ssh-keys')).json;
    expect(used[0].lastUsedAt).toBeTruthy();

    // Bob has no access to the private repository; a key nobody registered gets nothing.
    const denied = await git('bob', ['clone', url, 'b']);
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain('not found');
    expect((await git('stranger', ['clone', url, 'c'])).status).not.toBe(0);

    // Read access lets Bob clone but not push.
    await alice.put('/api/repos/alice/board/collaborators/bob', { role: 'read' });
    expect((await git('bob', ['clone', url, 'b'])).status).toBe(0);
    await writeFile(join(dir, 'b', 'x.txt'), 'x');
    await git('bob', ['add', '.'], join(dir, 'b'));
    await git('bob', ['commit', '-m', 'x'], join(dir, 'b'));
    const refused = await git('bob', ['push', 'origin', 'HEAD:main'], join(dir, 'b'));
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('permission');
  });

  it('enforces branch protection over SSH, like HTTPS', async () => {
    const repo = await h.repo(alice, 'board');
    await commitFiles(repo.git, { 'README.md': '# board' });
    await addKey(alice, 'alice');
    await alice.put('/api/repos/alice/board/collaborators/bob', { role: 'write' });
    await addKey(bob, 'bob');
    const rule = await alice.post('/api/repos/alice/board/branch-protection', { pattern: 'main', blockForcePush: true, blockDeletion: true });
    expect(rule.status, rule.body).toBe(200);
    const url = `ssh://git@127.0.0.1:${ssh.port}/alice/board.git`;
    await git('bob', ['clone', url, 'p']);
    await writeFile(join(dir, 'p', 'y.txt'), 'y');
    await git('bob', ['add', '.'], join(dir, 'p'));
    await git('bob', ['commit', '-m', 'y'], join(dir, 'p'));
    // Normal pushes go through; deleting or rewriting the protected branch does not.
    expect((await git('bob', ['push', 'origin', 'HEAD:main'], join(dir, 'p'))).status).toBe(0);
    expect((await git('bob', ['push', 'origin', '--delete', 'main'], join(dir, 'p'))).status).not.toBe(0);
    expect((await git('bob', ['push', '--force', 'origin', 'HEAD~1:main'], join(dir, 'p'))).status).not.toBe(0);
  });

  it('answers git-lfs-authenticate with a credential scoped to one repository and operation', async () => {
    await h.repo(alice, 'board', { visibility: 'private' });
    await h.repo(alice, 'other', { visibility: 'private' });
    await addKey(alice, 'alice');
    const run = (cmd: string) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn('ssh', ['-i', join(dir, 'alice'), '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-p', String(ssh.port), 'git@127.0.0.1', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.stderr.on('data', (c) => (stderr += c));
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });
    const res = await run("git-lfs-authenticate 'alice/board.git' download");
    expect(res.status, res.stderr).toBe(0);
    const grant = JSON.parse(res.stdout) as { href: string; header: { Authorization: string } };
    expect(grant.href).toMatch(/\/alice\/board\.git\/info\/lfs$/);
    const call = (path: string, operation: string) =>
      h.app.inject({ method: 'POST', url: `${path}/info/lfs/objects/batch`, headers: { 'content-type': 'application/vnd.git-lfs+json', authorization: grant.header.Authorization }, payload: JSON.stringify({ operation, objects: [] }) });
    expect((await call('/alice/board.git', 'download')).statusCode).toBe(200);
    // A download grant cannot upload, and it is useless for any other repository.
    expect((await call('/alice/board.git', 'upload')).statusCode).toBe(401);
    expect((await call('/alice/other.git', 'download')).statusCode).toBe(401);
    // It is not an API credential.
    expect((await h.app.inject({ method: 'GET', url: '/api/user/ssh-keys', headers: { authorization: grant.header.Authorization } })).statusCode).toBe(401);
    expect((await run("git-lfs-authenticate 'alice/nope.git' upload")).status).not.toBe(0);
  });

  it('manages keys: one account per key, owner-only deletion, audit trail', async () => {
    const added = await addKey(alice, 'alice');
    expect(added.json.fingerprint).toMatch(/^SHA256:/);
    expect((await addKey(alice, 'alice')).status).toBe(409);
    const stolen = await addKey(bob, 'alice');
    expect(stolen.status).toBe(409);
    expect(stolen.json.message).not.toContain('alice');
    expect((await bob.del(`/api/user/ssh-keys/${added.json.id}`)).status).toBe(404);
    expect((await alice.del(`/api/user/ssh-keys/${added.json.id}`)).status).toBe(200);
    const audit = (await h.ctx.db.execute(sql`select action from audit_log where action like 'ssh_key.%' order by id`)) as unknown as { action: string }[];
    expect(audit.map((a) => a.action).sort()).toEqual(['ssh_key.add', 'ssh_key.delete']);
    expect((await h.anon.get('/api/ssh')).json).toMatchObject({ enabled: true });
  });
});
