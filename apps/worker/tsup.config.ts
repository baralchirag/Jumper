import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Inline workspace TS sources; the WASM binding is required at runtime.
  noExternal: [/^@jumper\//],
  external: [/^@jumper\/kicad-core\/pkg-/],
});
