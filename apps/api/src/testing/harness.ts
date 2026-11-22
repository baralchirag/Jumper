// Integration test harness: boots the real app against a throwaway Postgres database.
// Set TEST_DATABASE_URL (default: a `pcbhub_test` database next to the dev one). Tests using it are skipped when
// PostgreSQL is not reachable, so `pnpm test` still works on a laptop without services.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createDb, runMigrations, sql } from '@jumper/db';
import { buildApp } from '../app';
import { createContext, type Ctx } from '../context';
import { loadEnv } from '../env';
import { GitRepo } from '../modules/git/repo';
import { resetGuardMemory } from '../modules/auth/guard';

const BASE = process.env.TEST_DATABASE_URL ?? 'postgres://pcbhub:pcbhub@localhost:5432/pcbhub_test';

async function ensureDatabase(): Promise<boolean> {
  const url = new URL(BASE);
  const name = url.pathname.slice(1);
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error('unsafe test database name');
  // Never run destructive resets against anything that is not obviously a test database.
  if (!/test/i.test(name)) throw new Error(`Refusing to use "${name}" for tests: the database name must contain "test"`);
  const admin = new URL(BASE);
  admin.pathname = '/postgres';
  const { db, close } = createDb(admin.toString(), { max: 1 });
  try {
    const rows = (await db.execute(sql`select 1 from pg_database where datname = ${name}`)) as unknown as unknown[];
    if (rows.length === 0) await db.execute(sql.raw(`create database "${name}"`));
    return true;
  } catch {
    return false;
  } finally {
    await close().catch(() => {});
  }
}

export const dbAvailable = await ensureDatabase();

export interface Reply<T = any> {
  status: number;
  json: T;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
}

export class Client {
  cookie = '';
  constructor(
    readonly app: FastifyInstance,
    readonly username: string,
  ) {}

  async req<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> {
    const res = await this.app.inject({
      method,
      url,
      payload: body === undefined ? undefined : (body as object),
      headers: { ...(this.cookie ? { cookie: this.cookie, 'x-requested-with': 'jumper' } : {}), ...headers },
    });
    let json: any = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.statusCode, json, headers: res.headers, body: res.body };
  }
  get = <T = any>(url: string, headers?: Record<string, string>) => this.req<T>('GET', url, undefined, headers);
  post = <T = any>(url: string, body?: unknown) => this.req<T>('POST', url, body ?? {});
  put = <T = any>(url: string, body?: unknown) => this.req<T>('PUT', url, body ?? {});
  patch = <T = any>(url: string, body?: unknown) => this.req<T>('PATCH', url, body ?? {});
  del = <T = any>(url: string) => this.req<T>('DELETE', url);
}

export interface Harness {
  app: FastifyInstance;
  ctx: Ctx;
  anon: Client;
  reset(): Promise<void>;
  user(username: string): Promise<Client>;
  repo(owner: Client, name: string, opts?: { visibility?: 'public' | 'private' }): Promise<{ owner: string; name: string; id: string; git: GitRepo }>;
  close(): Promise<void>;
}

export async function createHarness(opts: { env?: Record<string, string> } = {}): Promise<Harness> {
  const reposDir = await mkdtemp(join(tmpdir(), 'jumper-test-'));
  // Artifacts must never land in the developer's real data directory.
  process.env.STORAGE_FS_ROOT = join(reposDir, 'artifacts');
  const dbUrl = BASE;
  await runMigrations(dbUrl);
  const env = loadEnv({
    DATABASE_URL: dbUrl,
    // Unreachable on purpose: rate limiting skips on error, queue/pubsub are best effort.
    REDIS_URL: 'redis://127.0.0.1:1',
    LOG_LEVEL: 'fatal',
    NODE_ENV: 'test',
    KICAD_POOL: 'inline',
    REPOS_DIR: reposDir,
    SECRET_KEY: 'test-only-secret-key-not-for-production',
    SSH_HOST_KEY_FILE: join(reposDir, 'ssh_host_key'),
    ...opts.env,
  });
  const ctx = createContext(env);
  ctx.redis.on('error', () => {});
  await ctx.storage.ensureReady();
  const app = await buildApp(ctx);
  await app.ready();
  const anon = new Client(app, 'anonymous');

  const h: Harness = {
    app,
    ctx,
    anon,
    async reset() {
      await ctx.db.execute(sql`truncate table users, organizations, namespaces, blob_diffs, audit_log restart identity cascade`);
      resetGuardMemory();
    },
    async user(username) {
      const c = new Client(app, username);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username, email: `${username}@example.com`, password: 'correct-horse-battery' },
      });
      if (res.statusCode !== 200) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
      const set = res.headers['set-cookie'];
      const raw = Array.isArray(set) ? set : [String(set)];
      c.cookie = raw.map((s) => s.split(';')[0]).join('; ');
      return c;
    },
    async repo(owner, name, opts = {}) {
      const res = await owner.post('/api/repos', { name, visibility: opts.visibility ?? 'public', initReadme: false });
      if (res.status !== 200) throw new Error(`create repo failed: ${res.status} ${res.body}`);
      const row = (await ctx.db.execute(sql`select r.id from repositories r where r.name = ${name} order by r.created_at desc limit 1`)) as unknown as { id: string }[];
      const id = row[0]!.id;
      return { owner: owner.username, name, id, git: new GitRepo(join(reposDir, `${id}.git`)) };
    },
    async close() {
      await app.close();
      await ctx.close().catch(() => {});
      await rm(reposDir, { recursive: true, force: true });
    },
  };
  return h;
}

/** Commit `files` (path → content) on `branch`, returning the commit sha. */
export async function commitFiles(git: GitRepo, files: Record<string, string>, opts: { branch?: string; message?: string; parent?: string | null } = {}): Promise<string> {
  const branch = opts.branch ?? 'main';
  const current = await git.resolveBranch(branch);
  const parent = opts.parent !== undefined ? opts.parent : current;
  type Node = { blobs: Map<string, string>; dirs: Map<string, Node> };
  const root: Node = { blobs: new Map(), dirs: new Map() };
  // Keep the parent's tree contents: this helper replaces the whole tree, so callers pass the full file set.
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/');
    let n = root;
    for (const d of parts.slice(0, -1)) {
      if (!n.dirs.has(d)) n.dirs.set(d, { blobs: new Map(), dirs: new Map() });
      n = n.dirs.get(d)!;
    }
    n.blobs.set(parts.at(-1)!, await git.writeBlob(content));
  }
  const write = async (n: Node): Promise<string> => {
    const entries: { mode: string; type: 'blob' | 'tree'; oid: string; name: string }[] = [];
    for (const [name, oid] of n.blobs) entries.push({ mode: '100644', type: 'blob', oid, name });
    for (const [name, child] of n.dirs) entries.push({ mode: '040000', type: 'tree', oid: await write(child), name });
    return git.mktree(entries);
  };
  const tree = await write(root);
  const sha = await git.commitTree(tree, parent ? [parent] : [], opts.message ?? 'test commit', { name: 'Tester', email: 'tester@example.com' });
  await git.updateRef(`refs/heads/${branch}`, sha, current);
  return sha;
}
