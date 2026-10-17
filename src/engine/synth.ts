// Logic synthesis with Yosys (YoWASP WebAssembly build, loaded on first use).
import type { Item, Unit } from './ast';
import type { LibraryManager } from './library';

export type SynthTarget = 'generic' | 'ice40' | 'ecp5' | 'gowin' | 'xilinx';
export const SYNTH_TARGETS: SynthTarget[] = ['generic', 'ice40', 'ecp5', 'gowin', 'xilinx'];

export interface SynthOptions { top: string; target: SynthTarget; flatten: boolean; files: Record<string, string> }
export interface SynthResult { ok: boolean; log: string; netlist?: string; json?: string; stat?: string; cells: [string, number][] }

type Tree = { [name: string]: Tree | string };
type Runner = (args: string[], files: Tree, opts: object) => Promise<Record<string, unknown>>;

/** "rtl/a.v" -> { rtl: { "a.v": ... } } for the Yosys virtual file system. */
function toTree(files: Record<string, string>): Tree {
  const root: Tree = {};
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/').filter(Boolean);
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = (dir[p] ??= {}) as Tree;
    dir[parts[parts.length - 1]] = text;
  }
  return root;
}
let runner: Promise<Runner> | null = null;

/** Load Yosys once (about 77 MB of WebAssembly, cached by the browser). */
function yosys(): Promise<Runner> {
  runner ??= import('@yowasp/yosys').then(m => m.runYosys as unknown as Runner);
  return runner;
}

/** Files of `top` and of every module it instantiates (Verilog only), in compile order of discovery. */
export function designFiles(libs: LibraryManager, top: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const found = libs.findDesign(name);
    if (!found) return;
    if (found.unit.lang !== 'verilog') throw new Error(`synth: '${name}' is VHDL; only Verilog / SystemVerilog can be synthesized.`);
    if (found.unit.udp) return;
    if (!files.includes(found.unit.file)) files.push(found.unit.file);
    const walk = (items: Item[]) => {
      for (const it of items) {
        if (it.k === 'inst') visit(it.module);
        else if (it.k === 'genfor') walk(it.items);
        else if (it.k === 'genif') { walk(it.then); if (it.else) walk(it.else); }
      }
    };
    walk((found.unit as Unit).items);
  };
  visit(top);
  return files;
}

function script(o: SynthOptions, out: string): string {
  const read = Object.keys(o.files).map(f => `read_verilog -sv -defer "${f}"`).join('; ');
  const flat = o.flatten ? ' -flatten' : '';
  const synth = o.target === 'generic' ? `synth -top ${o.top}${flat}` : `synth_${o.target} -top ${o.top}${flat}`;
  return `${read}; ${synth}; tee -o ${out}.stat stat; write_json ${out}.json; write_verilog -noattr ${out}.v`;
}

/** Cell counts from Yosys "stat" output ("   3   $_AND_" lines of the top module). */
export function parseStat(stat: string): [string, number][] {
  const out: [string, number][] = [];
  const lines = stat.split('\n');
  // the cell breakdown follows the "N cells" line of the (last printed) top module
  let i = lines.length - 1;
  while (i >= 0 && !/^\s+\d+\s+cells\s*$/.test(lines[i])) i--;
  if (i < 0) return out;
  for (i++; i < lines.length; i++) {
    const m = /^\s+(\d+)\s+(\$?[A-Za-z_][\w$]*)\s*$/.exec(lines[i]);
    if (!m) break;
    out.push([m[2], Number(m[1])]);
  }
  return out;
}

export async function synthesize(o: SynthOptions, progress?: (done: number, total: number) => void): Promise<SynthResult> {
  const run = await yosys();
  let log = '';
  const dec = new TextDecoder();
  // Yosys colours its messages; keep the log plain
  const sink = (b: Uint8Array | null) => { if (b) log += dec.decode(b, { stream: true }).replace(/\x1b\[[0-9;]*m/g, ''); };
  const out = 'out';
  let files: Record<string, unknown>;
  try {
    files = await run(['-p', script(o, out)], toTree(o.files), {
      stdout: sink, stderr: sink,
      fetchProgress: progress ? (e: { totalLength: number; doneLength: number }) => progress(e.doneLength, e.totalLength) : undefined,
    });
  } catch (e) {
    const x = e as { files?: Record<string, unknown>; message?: string };
    if (!x.files) throw e;
    return { ok: false, log: log || String(x.message ?? e), cells: [] };
  }
  const text = (n: string) => { const v = files[n]; return v === undefined ? undefined : typeof v === 'string' ? v : dec.decode(v as Uint8Array); };
  const stat = text(`${out}.stat`) ?? '';
  return { ok: true, log, netlist: text(`${out}.v`), json: text(`${out}.json`), stat, cells: parseStat(stat) };
}
