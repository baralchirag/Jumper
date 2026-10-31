// Node-only helpers (not exported from the browser-safe index).
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';

let cachedRoot: string | null = null;

/** Directory containing pnpm-workspace.yaml, or cwd when not in the monorepo. */
export function workspaceRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return (cachedRoot = dir);
    const parent = dirname(dir);
    if (parent === dir) return (cachedRoot = process.cwd());
    dir = parent;
  }
}

/** Resolve config paths relative to the workspace root so api and worker agree. */
export function resolveDataPath(p: string): string {
  return isAbsolute(p) ? p : resolve(workspaceRoot(), p);
}

// ---------- backing-service checks ----------


interface Endpoint {
  name: string;
  url: string;
  defaultPort: number;
  hint: string;
}

function probe(host: string, port: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (err: string | null) => {
      socket.destroy();
      resolve(err);
    };
    socket.setTimeout(timeoutMs, () => done('timed out'));
    socket.once('connect', () => done(null));
    socket.once('error', (e: NodeJS.ErrnoException) => done(e.code ?? e.message));
  });
}

/**
 * Fail fast with an actionable message when Postgres/Redis are unreachable,
 * instead of crashing deep inside a driver or retrying silently forever.
 */
export async function checkServices(endpoints: Endpoint[], timeoutMs = 3000): Promise<void> {
  const failures: string[] = [];
  for (const ep of endpoints) {
    let host: string;
    let port: number;
    try {
      const u = new URL(ep.url);
      host = u.hostname.replace(/^\[|\]$/g, '') || 'localhost';
      port = u.port ? Number(u.port) : ep.defaultPort;
    } catch {
      failures.push(`  • ${ep.name}: invalid URL "${ep.url}"`);
      continue;
    }
    const err = await probe(host, port, timeoutMs);
    if (err) failures.push(`  • ${ep.name} is not reachable at ${host}:${port} (${err}).\n    ${ep.hint}`);
  }
  if (failures.length) {
    process.stderr.write(
      `\nPCBHub cannot start: required services are unavailable.\n${failures.join('\n')}\n\n` +
        `Start them with Docker:  docker compose -f docker/docker-compose.dev.yml up -d\n` +
        `or install them locally and point DATABASE_URL / REDIS_URL in .env at them.\n\n`,
    );
    process.exit(1);
  }
}

export const POSTGRES_HINT = 'Check DATABASE_URL in .env and that PostgreSQL is running.';
export const REDIS_HINT = 'Check REDIS_URL in .env and that Redis is running.';

/** Log Redis connection loss once per outage (ioredis keeps retrying on its own). */
export function watchRedis(
  client: { on(event: string, fn: (...args: never[]) => void): unknown },
  name: string,
  logError: (msg: string) => void,
  logInfo: (msg: string) => void,
): void {
  let down = false;
  client.on('error', (e: NodeJS.ErrnoException) => {
    if (down) return;
    down = true;
    logError(`Redis (${name}) connection lost: ${e.code ?? e.message ?? 'unknown error'}; retrying…`);
  });
  client.on('ready', () => {
    if (!down) return;
    down = false;
    logInfo(`Redis (${name}) reconnected`);
  });
}
