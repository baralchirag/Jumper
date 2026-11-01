import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.API_URL ?? 'http://localhost:3000';

const proxy = {
  '/api/ws': { target: api, ws: true },
  '/api': { target: api, changeOrigin: false },
  // Git smart-HTTP so `git clone http://localhost:5173/owner/repo.git` works.
  '^/[^/]+/[^/]+/(info/refs|git-upload-pack|git-receive-pack)': { target: api, changeOrigin: false },
  // Git LFS (large files): batch API and object transfers.
  '^/[^/]+/[^/]+/info/lfs/': { target: api, changeOrigin: false },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy },
  // `pnpm start`: the optimized production bundle, same proxy as dev.
  preview: { port: 5173, proxy },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@jumper/kicad-core'] },
  build: {
    target: 'es2022',
    // No public source maps: the client source stays private.
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
