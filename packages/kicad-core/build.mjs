#!/usr/bin/env node
// Builds the Rust core (WebAssembly for the browser and Node, plus the CLI). When the Rust toolchain is not
// installed but earlier build output is present, reuse it instead of failing, so `pnpm dev` works on machines
// that only change the TypeScript side. Install Rust + wasm-pack to rebuild after editing src/*.rs.
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const has = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
const built = ['pkg-web/kicad_core_bg.wasm', 'pkg-node/kicad_core_bg.wasm'].every((f) => existsSync(join(here, f)));

if (!has('wasm-pack') || !has('cargo')) {
  if (built) {
    console.log('[kicad-core] Rust toolchain not found; using the existing build in pkg-web/ and pkg-node/.');
    console.log('[kicad-core] Install Rust (https://rustup.rs) and wasm-pack to rebuild after changing src/*.rs.');
    process.exit(0);
  }
  console.error('[kicad-core] No build found and the Rust toolchain is missing.');
  console.error('[kicad-core] Install Rust (https://rustup.rs), then: cargo install wasm-pack');
  process.exit(1);
}

const run = (cmd) => execSync(cmd, { cwd: here, stdio: 'inherit' });
run('wasm-pack build --target web --out-dir pkg-web --out-name kicad_core --release --no-pack -- --features wasm');
run('wasm-pack build --target nodejs --out-dir pkg-node --out-name kicad_core --release --no-pack -- --features wasm');
writeFileSync(join(here, 'pkg-node/package.json'), JSON.stringify({ type: 'commonjs' }));
// wasm-pack writes a `*` .gitignore into each output folder, which would make `pnpm deploy` skip them.
for (const dir of ['pkg-web', 'pkg-node']) rmSync(join(here, dir, '.gitignore'), { force: true });
run('cargo build --release --features cli');
