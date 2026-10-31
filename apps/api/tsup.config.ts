import { defineConfig } from 'tsup';

export default defineConfig({
  // kicad-thread must sit next to the bundle: KicadPool resolves it relative to import.meta.url.
  entry: { index: 'src/index.ts', 'kicad-thread': 'src/services/kicad-thread.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Inline workspace TS sources; the WASM binding is required at runtime.
  noExternal: [/^@pcbhub\//],
  external: [/^@pcbhub\/kicad-core\/pkg-/],
});
