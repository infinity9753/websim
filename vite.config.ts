import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Pyodide (cocotb tests) loads its runtime files from pyodide/ next to the app: serve them in dev, copy them on build
const PYODIDE = ['pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
const pyFile = (f: string) => readFileSync(fileURLToPath(new URL(`node_modules/pyodide/${f}`, import.meta.url)));
const MIME: Record<string, string> = { mjs: 'text/javascript', wasm: 'application/wasm', zip: 'application/zip', json: 'application/json' };

function pyodideAssets(): Plugin {
  return {
    name: 'websim-pyodide-assets',
    configureServer(server) {
      server.middlewares.use('/pyodide/', (req, res, next) => {
        const f = (req.url ?? '').split('?')[0].replace(/^\//, '');
        if (!PYODIDE.includes(f)) return next();
        res.setHeader('Content-Type', MIME[f.split('.').pop()!]);
        res.end(pyFile(f));
      });
    },
    generateBundle() {
      for (const f of PYODIDE) this.emitFile({ type: 'asset', fileName: `pyodide/${f}`, source: pyFile(f) });
    },
  };
}

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  // the simulation worker loads Yosys (WebAssembly) with a dynamic import, which needs ES-module workers
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@yowasp/yosys', 'pyodide'] },
  plugins: [pyodideAssets()],
  test: { include: ['tests/**/*.test.ts'] },
} as any);
