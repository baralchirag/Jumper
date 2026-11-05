// Git smart-HTTP transport: proxies to `git http-backend` (CGI) so we get the
// exact protocol behaviour of upstream git, including protocol v2.
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, users, type User } from '@jumper/db';
import { ROLE_RANK, type RepoRole, type TokenScope } from '@jumper/shared';
import { burnPasswordCheck, verifyPassword } from '../auth/passwords';
import { lookupToken } from '../auth/plugin';
import { findRepo, permissionFor, repoDiskPath } from '../repos/access';
import { diffRefs, handleRefUpdates } from '../repos/push';
import { UNVERIFIED_MESSAGE, mustVerify } from '../auth/verify';
import { ensureHooks, hookRules, hooksDir, rulesFor } from '../protection/service';
import { pushRefusal } from '../usage/service';
import { GitRepo } from './repo';

const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);

interface GitAuth {
  user: User | null;
  scopes: TokenScope[] | null;
}

export async function basicAuth(app: FastifyInstance, req: FastifyRequest): Promise<GitAuth | 'invalid'> {
  const header = req.headers.authorization;
  if (!header) return { user: null, scopes: null };
  const [scheme, value] = header.split(' ', 2);
  if (!value) return 'invalid';
  if (/^basic$/i.test(scheme ?? '')) {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const login = decoded.slice(0, i);
    const secret = decoded.slice(i + 1);
    const tok = await lookupToken(app.ctx.db, secret);
    if (tok) return { user: tok.user, scopes: tok.scopes };
    const rows = await app.ctx.db.select().from(users).where(sql`lower(${users.username}) = lower(${login})`).limit(1);
    const user = rows[0];
    if (!user) {
      await burnPasswordCheck(secret);
      return 'invalid';
    }
    if (user.disabled || !(await verifyPassword(user.passwordHash, secret))) return 'invalid';
    return { user, scopes: null };
  }
  if (/^(bearer|token)$/i.test(scheme ?? '')) {
    const tok = await lookupToken(app.ctx.db, value);
    return tok ? { user: tok.user, scopes: tok.scopes } : 'invalid';
  }
  return 'invalid';
}

export function challenge(reply: FastifyReply, message: string) {
  return reply
    .code(401)
    .header('WWW-Authenticate', 'Basic realm="Jumper", charset="UTF-8"')
    .type('text/plain')
    .send(`${message}\n`);
}

export function scopeAllows(scopes: TokenScope[] | null, needed: RepoRole): boolean {
  if (!scopes) return true;
  if (scopes.includes('admin')) return true;
  return needed === 'read' ? scopes.includes('repo:read') || scopes.includes('repo:write') : scopes.includes('repo:write');
}

export async function gitHttpRoutes(app: FastifyInstance) {
  await ensureHooks(app.ctx.env.reposDir);
  // Hand the raw body stream to the CGI process untouched (may be gzip).
  app.addContentTypeParser(
    ['application/x-git-upload-pack-request', 'application/x-git-receive-pack-request'],
    (_req, payload, done) => done(null, payload),
  );

  const handler = async (req: FastifyRequest<{ Params: { owner: string; repo: string; '*'?: string } }>, reply: FastifyReply) => {
    const { owner } = req.params;
    const repoName = req.params.repo.replace(/\.git$/, '');
    const action = req.url.split('?')[0]!.split('/').slice(3).join('/');
    const query = req.query as Record<string, string>;
    const service = action === 'info/refs' ? query.service : action;
    if (!service || !SERVICES.has(service)) return reply.code(403).type('text/plain').send('Dumb HTTP protocol is not supported\n');

    const needed: RepoRole = service === 'git-receive-pack' ? 'write' : 'read';
    const auth = await basicAuth(app, req);
    if (auth === 'invalid') return challenge(reply, 'Invalid credentials');

    const found = await findRepo(app.ctx, owner, repoName);
    const permission = found ? await permissionFor(app.ctx, auth.user, found.repo, found.ns) : 'none';
    if (!found || permission === 'none') {
      // Ask anonymous clients to authenticate before revealing existence.
      return auth.user ? reply.code(404).type('text/plain').send('Repository not found\n') : challenge(reply, 'Authentication required');
    }
    if (ROLE_RANK[permission] < ROLE_RANK[needed] || !scopeAllows(auth.scopes, needed)) {
      return auth.user ? reply.code(403).type('text/plain').send('Permission denied\n') : challenge(reply, 'Authentication required');
    }

    if (needed === 'write' && mustVerify(app.ctx, auth.user)) return reply.code(403).type('text/plain').send(`${UNVERIFIED_MESSAGE}\n`);

    const { repo } = found;
    const diskPath = repoDiskPath(app.ctx, repo.id);
    const isPush = service === 'git-receive-pack' && action !== 'info/refs';
    const git = new GitRepo(diskPath);
    const before = isPush ? await git.refs() : null;

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_PROJECT_ROOT: app.ctx.env.reposDir,
      GIT_HTTP_EXPORT_ALL: '1',
      GIT_HTTP_MAX_REQUEST_BUFFER: '100M',
      GIT_CONFIG_NOSYSTEM: '1',
      PATH_INFO: `/${repo.id}.git/${action}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      REMOTE_ADDR: req.ip,
      REMOTE_USER: auth.user?.username ?? 'anonymous',
    };
    if (isPush) {
      // Branch protection is enforced by git itself via a pre-receive hook, so no client can sidestep it.
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
      env.GIT_CONFIG_VALUE_0 = hooksDir(app.ctx.env.reposDir);
      env.JUMPER_PROTECT = hookRules(await rulesFor(app.ctx, repo.id), permission === 'admin');
      const refusal = await pushRefusal(app.ctx, repo.namespaceId);
      if (refusal) env.JUMPER_REFUSE = refusal;
    }
    if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = String(req.headers['content-encoding']);
    if (req.headers['git-protocol']) env.GIT_PROTOCOL = String(req.headers['git-protocol']);
    if (req.headers['content-length']) env.CONTENT_LENGTH = String(req.headers['content-length']);

    reply.hijack();
    const res = reply.raw;
    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 8192) stderr += c.toString();
    });

    const fail = (code: number, msg: string) => {
      if (!res.headersSent) {
        res.writeHead(code, { 'Content-Type': 'text/plain' });
        res.end(`${msg}\n`);
      } else {
        res.destroy();
      }
      child.kill('SIGKILL');
    };

    // Stream request body with a hard size cap.
    const body = req.body as Readable | undefined;
    if (body && typeof body.pipe === 'function') {
      let received = 0;
      body.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > app.ctx.env.MAX_PUSH_BYTES) {
          body.destroy();
          fail(413, 'Push exceeds the maximum allowed size');
        }
      });
      body.pipe(child.stdin);
      child.stdin.on('error', () => {});
    } else {
      child.stdin.end();
    }

    // Parse CGI headers, then stream the body straight through.
    let headerBuf = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      let sep = headerBuf.indexOf('\r\n\r\n');
      let sepLen = 4;
      if (sep === -1) {
        sep = headerBuf.indexOf('\n\n');
        sepLen = 2;
      }
      if (sep === -1) {
        if (headerBuf.length > 64 * 1024) fail(502, 'Malformed git response');
        return;
      }
      const head = headerBuf.subarray(0, sep).toString('latin1');
      const rest = headerBuf.subarray(sep + sepLen);
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = parseInt(v, 10) || 200;
        else headers[k] = v;
      }
      headersDone = true;
      res.writeHead(status, headers);
      if (rest.length) res.write(rest);
    });

    child.on('close', async (code) => {
      if (!headersDone) {
        req.log.error({ code, stderr }, 'git http-backend failed');
        fail(500, 'git backend error');
        return;
      }
      res.end();
      if (isPush && code === 0 && before) {
        try {
          const after = await git.refs();
          await handleRefUpdates(app.ctx, repo, diffRefs(before, after), auth.user, req.log);
        } catch (e) {
          req.log.error(e, 'post-push processing failed');
        }
      }
    });
    child.on('error', (e) => {
      req.log.error(e, 'failed to spawn git http-backend');
      fail(500, 'git backend unavailable');
    });
  };

  // Accept both `/owner/repo.git/...` and `/owner/repo/...`.
  app.get('/:owner/:repo/info/refs', handler);
  app.post('/:owner/:repo/git-upload-pack', handler);
  app.post('/:owner/:repo/git-receive-pack', handler);
}

