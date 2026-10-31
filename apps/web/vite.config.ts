import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api/ws': { target: api, ws: true },
      '/api': { target: api, changeOrigin: false },
      // Git smart-HTTP so `git clone http://localhost:5173/owner/repo.git` works in dev.
      '^/[^/]+/[^/]+/(info/refs|git-upload-pack|git-receive-pack)': { target: api, changeOrigin: false },
    },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@pcbhub/kicad-core'] },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
});
