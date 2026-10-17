import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  // the simulation worker loads Yosys (WebAssembly) with a dynamic import, which needs ES-module workers
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@yowasp/yosys'] },
  test: { include: ['tests/**/*.test.ts'] },
} as any);
