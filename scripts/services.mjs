#!/usr/bin/env node
// Runs PostgreSQL and Redis for local development without Docker or root.
//
//   pnpm services          start both (Ctrl-C stops them)
//
// PostgreSQL comes from the `embedded-postgres` package (prebuilt binaries).
// Redis uses, in order: REDIS_SERVER env var, data/services/redis-stable/src/redis-server
// (built from source), or `redis-server` on PATH. If Redis is already listening
// on the configured port (e.g. a system install), it is reused.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data');
const PG_PORT = Number(process.env.PG_PORT ?? 5432);
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

const log = (msg) => console.log(`[services] ${msg}`);

function listening(port) {
  return new Promise((res) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => (s.destroy(), res(true)));
    s.once('error', () => res(false));
  });
}

function findRedis() {
  const candidates = [process.env.REDIS_SERVER, join(dataDir, 'services/redis-stable/src/redis-server')].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  const which = spawnSync('sh', ['-c', 'command -v redis-server || command -v valkey-server'], { encoding: 'utf8' });
  return which.status === 0 ? which.stdout.trim() : null;
}

async function startPostgres() {
  if (await listening(PG_PORT)) {
    log(`PostgreSQL already listening on ${PG_PORT}; reusing it`);
    return null;
  }
  const dir = join(dataDir, 'postgres');
  const fresh = !existsSync(join(dir, 'PG_VERSION'));
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'pcbhub',
    password: 'pcbhub',
    port: PG_PORT,
    persistent: true,
    onLog: () => {},
    onError: (e) => console.error('[postgres]', String(e).trim()),
  });
  if (fresh) {
    log('initialising PostgreSQL data directory…');
    await pg.initialise();
  }
  await pg.start();
  if (fresh) await pg.createDatabase('pcbhub');
  log(`PostgreSQL ready on 127.0.0.1:${PG_PORT} (db pcbhub, user pcbhub)`);
  return pg;
}

async function startRedis() {
  if (await listening(REDIS_PORT)) {
    log(`Redis already listening on ${REDIS_PORT}; reusing it`);
    return null;
  }
  const bin = findRedis();
  if (!bin) {
    console.error(
      '[services] Redis not found. Either install it (sudo apt install redis-server), or build it locally:\n' +
        '  mkdir -p data/services && cd data/services && curl -fsSL https://download.redis.io/redis-stable.tar.gz | tar xz\n' +
        '  make -C redis-stable -j"$(nproc)" BUILD_TLS=no MALLOC=libc',
    );
    return 'missing';
  }
  const dir = join(dataDir, 'redis');
  mkdirSync(dir, { recursive: true });
  const child = spawn(bin, ['--port', String(REDIS_PORT), '--bind', '127.0.0.1', '--dir', dir, '--appendonly', 'yes', '--save', ''], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 50 && !(await listening(REDIS_PORT)); i++) await new Promise((r) => setTimeout(r, 100));
  log(`Redis ready on 127.0.0.1:${REDIS_PORT} (${bin})`);
  return child;
}

const pg = await startPostgres();
const redis = await startRedis();

const stop = async () => {
  log('stopping…');
  if (redis && typeof redis === 'object') redis.kill('SIGTERM');
  if (pg) await pg.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

if (redis === 'missing' && !pg) process.exit(1);
log('running — press Ctrl-C to stop');
setInterval(() => {}, 1 << 30);
