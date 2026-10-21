import { defineConfig, type Plugin } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
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

// Gate-level simulation models of FPGA primitives ship with Yosys (ISC); read them from the installed @yowasp/yosys
// resource tar so they always match the synthesizer, and serve them as the virtual module "virtual:yosys-sim".
const YOSYS_SIM = ['ice40/cells_sim.v', 'ecp5/cells_sim.v', 'ecp5/common_sim.vh', 'ecp5/ccu2c_sim.vh', 'ecp5/cells_ff.vh', 'ecp5/cells_io.vh', 'ecp5/cells_bb.v', 'gowin/cells_sim.v', 'gowin/cells_xtra_gw1n.v', 'xilinx/cells_sim.v'];

/** Regular files of a ustar archive whose names are in `want`. */
function tarFiles(buf: Buffer, want: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (let o = 0; o + 512 <= buf.length;) {
    const name = buf.toString('latin1', o, o + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const prefix = buf.toString('latin1', o + 345, o + 500).replace(/\0.*$/s, '');
    const size = parseInt(buf.toString('latin1', o + 124, o + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const full = prefix ? `${prefix}/${name}` : name;
    if (want.has(full)) out[full] = buf.toString('utf8', o + 512, o + 512 + size);
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

function yosysSimModels(): Plugin {
  const id = 'virtual:yosys-sim';
  return {
    name: 'websim-yosys-sim-models',
    resolveId: (s) => (s === id ? '\0' + id : undefined),
    load(s) {
      if (s !== '\0' + id) return;
      const dir = fileURLToPath(new URL('node_modules/@yowasp/yosys/gen/', import.meta.url));
      const want = new Set(YOSYS_SIM);
      const files: Record<string, string> = {};
      for (const f of readdirSync(dir).filter(f => /resources\.\d+\.tar$/.test(f)).sort()) Object.assign(files, tarFiles(readFileSync(dir + f), want));
      const missing = YOSYS_SIM.filter(f => !(f in files));
      if (missing.length) this.warn(`Yosys simulation models not found: ${missing.join(', ')}`);
      return `export default ${JSON.stringify(files)};`;
    },
  };
}

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  // the simulation worker loads Yosys (WebAssembly) with a dynamic import, which needs ES-module workers
  worker: { format: 'es', plugins: () => [yosysSimModels()] },
  optimizeDeps: { exclude: ['@yowasp/yosys', 'pyodide'] },
  plugins: [pyodideAssets(), yosysSimModels()],
  test: { include: ['tests/**/*.test.ts'] },
} as any);
