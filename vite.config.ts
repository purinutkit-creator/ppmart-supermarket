import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(__dirname, 'shared') } },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': 'http://localhost:4000',
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
