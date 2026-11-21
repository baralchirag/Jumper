#!/usr/bin/env node
// Parse and diff the two demo boards with Jumper's own Rust core, ahead of time, so the homepage shows the live demo
// the moment its data arrives instead of downloading 7 MB of KiCad text and parsing it in the visitor's browser.
// Usage: node scripts/hero-board/pack.mjs rev-a.kicad_pcb rev-b.kicad_pcb out/demo.json.gz
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const core = require('../../packages/kicad-core/pkg-node/kicad_core.js');

const [revA, revB, out] = process.argv.slice(2);
if (!out) {
  console.error('usage: pack.mjs rev-a.kicad_pcb rev-b.kicad_pcb out.json.gz');
  process.exit(1);
}
const ta = readFileSync(revA, 'utf8');
const tb = readFileSync(revB, 'utf8');
const data = {
  a: JSON.parse(core.parse(ta, 'pcb')),
  b: JSON.parse(core.parse(tb, 'pcb')),
  diff: JSON.parse(core.diff(ta, tb, 'pcb')),
  bytes: ta.length + tb.length,
};
// A tenth of a micron is far below anything a board can show; fewer digits compress much better.
const json = JSON.stringify(data, (_, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v));
const gz = gzipSync(json, { level: 9 });
writeFileSync(out, gz);
console.log(`wrote ${out}: ${(json.length / 1e6).toFixed(1)} MB JSON, ${(gz.length / 1e3).toFixed(0)} kB gzipped`);
