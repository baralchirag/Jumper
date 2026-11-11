// Built-in SSH server for git: `git clone ssh://git@host:2222/owner/repo.git`, push and pull with an SSH key added in
// account settings. Only the git services run here (no shell, no forwarding). Permissions, email verification, branch
// protection, plan limits and post-push processing are exactly those of HTTPS pushes.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import ssh2, { type Connection, type ServerChannel } from 'ssh2';
import { and, eq, sql, sshKeys, users, type User } from '@jumper/db';
import { ROLE_RANK, type RepoRole } from '@jumper/shared';
import type { Ctx } from '../../context';
import { UNVERIFIED_MESSAGE, mustVerify } from '../auth/verify';
import { GitRepo } from '../git/repo';
import { hookRules, hooksDir, rulesFor, ensureHooks } from '../protection/service';
import { findRepo, permissionFor, repoDiskPath } from '../repos/access';
import { diffRefs, handleRefUpdates } from '../repos/push';
import { pushRefusal } from '../usage/service';
import { parseGitCommand } from './keys';
import { sshLfsHeader } from '../lfs/routes';

export interface SshServer {
  port: number;
  hostKeyFingerprint: string;
  close(): Promise<void>;
}

async function loadHostKey(file: string): Promise<string> {
  if (existsSync(file)) return readFile(file, 'utf8');
  const pair = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'jumper host key' });
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, pair.private, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  return readFile(file, 'utf8');
}

async function userForKey(ctx: Ctx, keyData: Buffer): Promise<{ user: User; keyId: string } | null> {
  const blob = keyData.toString('base64');
  const rows = await ctx.db
    .select({ key: sshKeys, user: users })
    .from(sshKeys)
    .innerJoin(users, eq(users.id, sshKeys.userId))
    .where(eq(sshKeys.publicKey, blob))
    .limit(1);
  const row = rows[0];
  if (!row || row.user.disabled) return null;
  return { user: row.user, keyId: row.key.id };
}

function fail(ch: ServerChannel, message: string, code = 1) {
  ch.stderr.write(`${message}\n`);
  ch.exit(code);
  ch.end();
}

/** `git-lfs-authenticate owner/repo.git upload|download`: tell git-lfs where to send large files, with a short-lived credential. */
async function lfsAuthenticate(ctx: Ctx, user: User, command: string, ch: ServerChannel) {
  const m = /^git-lfs-authenticate '?\/?([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?'? (upload|download)$/.exec(command.trim());
  if (!m) return fail(ch, 'Usage: git-lfs-authenticate owner/repo.git upload|download');
  const [, owner, name, op] = m;
  const needed: RepoRole = op === 'upload' ? 'write' : 'read';
  const found = await findRepo(ctx, owner!, name!);
  const permission = found ? await permissionFor(ctx, user, found.repo, found.ns) : 'none';
  if (!found || permission === 'none') return fail(ch, `Repository ${owner}/${name} not found`);
  if (ROLE_RANK[permission] < ROLE_RANK[needed]) return fail(ch, `You do not have permission to push to ${owner}/${name}`);
  if (needed === 'write' && mustVerify(ctx, user)) return fail(ch, UNVERIFIED_MESSAGE);
  const href = `${ctx.env.PUBLIC_URL.replace(/\/$/, '')}/${found.ns.slug}/${found.repo.name}.git/info/lfs`;
  ch.write(`${JSON.stringify({ href, header: { Authorization: sshLfsHeader(ctx.env, user.id, found.repo.id, needed === 'write') }, expires_in: 3600 })}\n`);
  ch.exit(0);
  ch.end();
}

async function runGitService(ctx: Ctx, log: FastifyBaseLogger, user: User, command: string, gitProtocol: string | null, ch: ServerChannel) {
  if (command.trim().startsWith('git-lfs-authenticate ')) return lfsAuthenticate(ctx, user, command, ch);
  const parsed = parseGitCommand(command);
  if (!parsed) return fail(ch, `Jumper only runs git over SSH. Unknown command: ${command.slice(0, 100)}`);
  const needed: RepoRole = parsed.service === 'git-receive-pack' ? 'write' : 'read';
  const found = await findRepo(ctx, parsed.owner, parsed.repo);
  const permission = found ? await permissionFor(ctx, user, found.repo, found.ns) : 'none';
  if (!found || permission === 'none') return fail(ch, `Repository ${parsed.owner}/${parsed.repo} not found`);
  if (ROLE_RANK[permission] < ROLE_RANK[needed]) return fail(ch, `You do not have permission to push to ${parsed.owner}/${parsed.repo}`);
  if (needed === 'write' && mustVerify(ctx, user)) return fail(ch, UNVERIFIED_MESSAGE);

  const { repo } = found;
  const diskPath = repoDiskPath(ctx, repo.id);
  const isPush = parsed.service === 'git-receive-pack';
  const git = new GitRepo(diskPath);
  const before = isPush ? await git.refs() : null;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  if (gitProtocol && /^[a-z0-9=:.]+$/i.test(gitProtocol)) env.GIT_PROTOCOL = gitProtocol;
  if (isPush) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
    env.GIT_CONFIG_VALUE_0 = hooksDir(ctx.env.reposDir);
    env.JUMPER_PROTECT = hookRules(await rulesFor(ctx, repo.id), permission === 'admin');
    const refusal = await pushRefusal(ctx, repo.namespaceId);
    if (refusal) env.JUMPER_REFUSE = refusal;
  }

  const child = spawn('git', [parsed.service.slice('git-'.length), diskPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let received = 0;
  ch.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (isPush && received > ctx.env.MAX_PUSH_BYTES) {
      ch.stderr.write('Push exceeds the maximum allowed size\n');
      child.kill('SIGKILL');
      return;
    }
    if (!child.stdin.write(chunk)) ch.pause();
  });
  child.stdin.on('drain', () => ch.resume());
  child.stdin.on('error', () => {});
  ch.on('end', () => child.stdin.end());
  ch.on('close', () => child.kill('SIGKILL'));
  child.stdout.pipe(ch, { end: false });
  child.stderr.on('data', (c: Buffer) => ch.stderr.write(c));
  child.on('error', (e) => {
    log.error(e, 'failed to spawn git over SSH');
    fail(ch, 'git backend unavailable');
  });
  child.on('close', async (code) => {
    if (isPush && code === 0 && before) {
      try {
        await handleRefUpdates(ctx, repo, diffRefs(before, await git.refs()), user, log);
      } catch (e) {
        log.error(e, 'post-push processing failed');
      }
    }
    ch.exit(code ?? 1);
    ch.end();
  });
}

export async function startSshServer(ctx: Ctx, log: FastifyBaseLogger, opts: { host?: string; port?: number } = {}): Promise<SshServer> {
  await ensureHooks(ctx.env.reposDir);
  const hostKey = await loadHostKey(ctx.env.sshHostKeyFile);
  const parsedHost = ssh2.utils.parseKey(hostKey);
  if (parsedHost instanceof Error || Array.isArray(parsedHost)) throw new Error('SSH host key could not be read');
  const { fingerprintOf } = await import('./keys');
  const hostKeyFingerprint = fingerprintOf(parsedHost.getPublicSSH());

  const server = new ssh2.Server({ hostKeys: [hostKey], ident: 'Jumper' }, (client: Connection) => {
    let user: User | null = null;
    client.on('error', () => {});
    client.on('authentication', (actx) => {
      if (actx.method !== 'publickey') return actx.reject(['publickey']);
      void (async () => {
        const found = await userForKey(ctx, actx.key.data);
        if (!found) return actx.reject(['publickey']);
        if (actx.signature && actx.blob) {
          const k = ssh2.utils.parseKey(`${actx.key.algo.startsWith('rsa-sha2') ? 'ssh-rsa' : actx.key.algo} ${actx.key.data.toString('base64')}`);
          const key = k instanceof Error ? null : Array.isArray(k) ? k[0] : k;
          if (!key || key.verify(actx.blob, actx.signature, actx.hashAlgo) !== true) return actx.reject(['publickey']);
          user = found.user;
          // Touch at most once an hour: this runs on every connection.
          void ctx.db
            .update(sshKeys)
            .set({ lastUsedAt: new Date() })
            .where(and(eq(sshKeys.id, found.keyId), sql`(${sshKeys.lastUsedAt} is null or ${sshKeys.lastUsedAt} < now() - interval '1 hour')`))
            .catch(() => {});
        }
        // Without a signature the client is only asking whether the key would be accepted.
        actx.accept();
      })().catch((e) => {
        log.error(e, 'ssh authentication failed');
        actx.reject();
      });
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        let gitProtocol: string | null = null;
        session.on('env', (accept, _reject, info) => {
          if (info.key === 'GIT_PROTOCOL') gitProtocol = info.val;
          accept?.();
        });
        session.on('pty', (_accept, reject) => reject?.());
        session.on('shell', (accept) => {
          const ch = accept();
          ch.write(`Hi ${user?.username ?? 'there'}! You've successfully authenticated, but Jumper does not provide shell access.\r\n`);
          ch.exit(1);
          ch.end();
        });
        session.on('exec', (accept, _reject, info) => {
          const ch = accept();
          if (!user) return fail(ch, 'Not authenticated');
          runGitService(ctx, log, user, info.command, gitProtocol, ch).catch((e) => {
            log.error(e, 'ssh git command failed');
            fail(ch, 'Internal error');
          });
        });
      });
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? ctx.env.SSH_PORT, opts.host ?? ctx.env.SSH_HOST, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : (opts.port ?? ctx.env.SSH_PORT));
    });
  });
  log.info({ port, hostKeyFingerprint }, 'SSH server listening');
  return {
    port,
    hostKeyFingerprint,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
