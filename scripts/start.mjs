#!/usr/bin/env node
// Runs the built (optimized) stack: API, worker and the web bundle. Much lighter and snappier than `pnpm dev`
// (no file watchers, no on-the-fly TypeScript, one pre-minified bundle per page).
//
//   pnpm start         build everything, then run
//   pnpm start:fast    run what is already built
//
// PostgreSQL and Redis must be running (`pnpm services`, or docker compose).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = existsSync(join(root, '.env')) ? ['--env-file=../../.env'] : [];

const procs = [
  { name: 'api', cwd: 'apps/api', cmd: process.execPath, args: [...envFile, 'dist/index.js'], env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' } },
  { name: 'worker', cwd: 'apps/worker', cmd: process.execPath, args: [...envFile, 'dist/index.js'], env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' } },
  { name: 'web', cwd: 'apps/web', cmd: process.execPath, args: [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'preview', '--host'], env: {} },
];

for (const p of procs) {
  if (p.name !== 'web' && !existsSync(join(root, p.cwd, 'dist/index.js'))) {
    console.error(`[start] ${p.cwd}/dist is missing. Run \`pnpm start\` (builds first) or \`pnpm build\`.`);
    process.exit(1);
  }
}
if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
  console.error('[start] apps/web/dist is missing. Run `pnpm start` (builds first) or `pnpm build`.');
  process.exit(1);
}

const children = procs.map((p) => {
  const child = spawn(p.cmd, p.args, { cwd: join(root, p.cwd), env: { ...process.env, ...p.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = (stream) => (chunk) => String(chunk).split('\n').filter(Boolean).forEach((l) => stream.write(`[${p.name}] ${l}\n`));
  child.stdout.on('data', tag(process.stdout));
  child.stderr.on('data', tag(process.stderr));
  child.on('exit', (code, sig) => {
    console.error(`[start] ${p.name} exited (${sig ?? code}); stopping the rest.`);
    shutdown(code ?? 1);
  });
  return child;
});

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
console.log('[start] web http://localhost:5173 · api http://localhost:3000 (Ctrl-C to stop)');
