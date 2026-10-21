// Logic synthesis with Yosys (YoWASP WebAssembly build, loaded on first use).
import type { Item, Unit } from './ast';
import type { LibraryManager } from './library';
import { newPyodide, assetLocation } from './pyodide';

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
  // synth_gowin always flattens and has no -flatten option
  const flat = o.flatten && o.target !== 'gowin' ? ' -flatten' : '';
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

// ---------------------------------------------------------------- FPGA place & route (nextpnr-ice40)

export type FpgaFamily = 'ice40' | 'ecp5' | 'gowin';
export interface FpgaDevice {
  family: FpgaFamily;
  /** Display name, e.g. "iCE40 UP5K" or "Gowin GW1NR-9 (Tang Nano 9K)". */
  name: string;
  /** Default package (iCE40, ECP5) or full part number (Gowin). */
  pkg: string;
  /** nextpnr device option(s). */
  args: string[];
  /** gowin_pack device family. */
  packFamily?: string;
  /** Tile grid size, if known before placement. */
  w?: number; h?: number;
}

const ice40 = (name: string, pkg: string, w: number, h: number): FpgaDevice => ({ family: 'ice40', name: `iCE40 ${name.toUpperCase()}`, pkg, args: [`--${name}`], w, h });
const ecp5 = (k: string): FpgaDevice => ({ family: 'ecp5', name: `ECP5 LFE5U-${k}F`, pkg: 'CABGA381', args: [`--${k}k`] });
const gowin = (name: string, part: string, family: string): FpgaDevice => ({ family: 'gowin', name: `Gowin ${name}`, pkg: part, args: ['--vopt', `family=${family}`], packFamily: family });

/** Devices for pnr -device. */
export const FPGA_DEVICES: Record<string, FpgaDevice> = {
  lp384: ice40('lp384', 'qn32', 7, 9),
  lp1k: ice40('lp1k', 'cm81', 13, 17),
  hx1k: ice40('hx1k', 'tq144', 13, 17),
  lp8k: ice40('lp8k', 'cm81', 33, 33),
  hx8k: ice40('hx8k', 'ct256', 33, 33),
  u4k: ice40('u4k', 'sg48', 25, 21),
  up5k: ice40('up5k', 'sg48', 25, 31),
  'lfe5u-12f': ecp5('12'),
  'lfe5u-25f': ecp5('25'),
  'lfe5u-45f': ecp5('45'),
  'lfe5u-85f': ecp5('85'),
  'gw1nz-1': gowin('GW1NZ-1 (Tang Nano 1K)', 'GW1NZ-LV1QN48C6/I5', 'GW1NZ-1'),
  'gw1ns-4': gowin('GW1NS-4 (Tang Nano 4K)', 'GW1NSR-LV4CQN48PC7/I6', 'GW1NS-4'),
  'gw1n-9c': gowin('GW1NR-9C (Tang Nano 9K)', 'GW1NR-LV9QN88PC6/I5', 'GW1N-9C'),
  'gw2a-18c': gowin('GW2AR-18C (Tang Nano 20K)', 'GW2AR-LV18QN88C8/I7', 'GW2A-18C'),
};

/** Per family: Yosys target, pin constraint file type, bitstream and text configuration file types. */
export const FPGA_FAMILIES: Record<FpgaFamily, { label: string; target: SynthTarget; constraints: string; bitstream: string; config?: string }> = {
  ice40: { label: 'Lattice iCE40', target: 'ice40', constraints: 'pcf', bitstream: 'bin', config: 'asc' },
  ecp5: { label: 'Lattice ECP5', target: 'ecp5', constraints: 'lpf', bitstream: 'bit', config: 'config' },
  gowin: { label: 'Gowin', target: 'gowin', constraints: 'cst', bitstream: 'fs' },
};

/** A pin constraint file template listing every port bit, in the family's format. */
export function constraintTemplate(family: FpgaFamily, top: string, bits: string[]): string {
  const head = {
    ice40: `# Pin constraints for ${top} (iCE40 .pcf): set_io <port> <package pin>`,
    ecp5: `# Pin constraints for ${top} (ECP5 .lpf): LOCATE COMP "<port>" SITE "<ball>"; IOBUF PORT "<port>" IO_TYPE=LVCMOS33;`,
    gowin: `// Pin constraints for ${top} (Gowin .cst): IO_LOC "<port>" <pin>; IO_PORT "<port>" IO_TYPE=LVCMOS33;\n// Gowin needs a location for every top-level port.`,
  }[family];
  const line = (b: string) => family === 'ice40' ? `# set_io ${b} <pin>` : family === 'ecp5' ? `# LOCATE COMP "${b}" SITE "<ball>";` : `// IO_LOC "${b}" <pin>;`;
  return [head, ...bits.map(line)].join('\n') + '\n';
}

export interface PnrOptions { device: string; pkg?: string; constraints?: string; freq?: number; seed?: number; json: string }
export interface PnrResult {
  ok: boolean; log: string;
  /** Text configuration (iCE40 .asc, ECP5 .config) and the packed bitstream. */
  config?: string; bin?: Uint8Array; placed?: string;
  util: [string, number, number][];          // cell type, used, available
  fmax: [string, number, number | null][];   // clock, achieved MHz, constraint MHz
}

type Tools = { pnr: Runner; pack: Runner };
const toolCache = new Map<FpgaFamily, Promise<Tools>>();

/** nextpnr and the bitstream packer of a family (about 175-235 MB with the chip databases), loaded on first use. */
function tools(f: FpgaFamily): Promise<Tools> {
  let p = toolCache.get(f);
  if (!p) {
    const r = (m: unknown, k: string) => (m as Record<string, Runner>)[k];
    p = f === 'ice40' ? import('@yowasp/nextpnr-ice40').then(m => ({ pnr: r(m, 'runNextpnrIce40'), pack: r(m, 'runIcepack') }))
      : f === 'ecp5' ? import('@yowasp/nextpnr-ecp5').then(m => ({ pnr: r(m, 'runNextpnrEcp5'), pack: r(m, 'runEcppack') }))
        : import('@yowasp/nextpnr-himbaechel-gowin').then(m => ({ pnr: r(m, 'runNextpnrHimbaechelGowin'), pack: (m as unknown as { commands: Record<string, Runner> }).commands.gowin_pack }));
    p.catch(() => toolCache.delete(f));
    toolCache.set(f, p);
  }
  return p;
}

const MSGSPEC = new URL('../../vendor/msgspec-0.22.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl', import.meta.url);

/**
 * gowin_pack (apycula, Python) runs on Pyodide. Its dependencies are installed from files shipped with the app
 * instead of micropip and the Pyodide CDN: msgspec from vendor/, apycula from the tool's own wheel.
 */
async function gowinPyodide(opts: Record<string, unknown>) {
  const py = await newPyodide(opts);
  await py.loadPackage([await assetLocation(MSGSPEC)], { messageCallback: () => {} });
  py.loadPackage = async () => {};
  py.runPython(`import sys, types, zipfile, site
_m = types.ModuleType('micropip')
async def _install(url, keep_going=False, **kw):
    zipfile.ZipFile(url.removeprefix('emfs:')).extractall(site.getsitepackages()[0])
_m.install = _install
sys.modules['micropip'] = _m`);
  return py;
}

export async function placeAndRoute(o: PnrOptions, progress?: (done: number, total: number) => void): Promise<PnrResult> {
  const dev = FPGA_DEVICES[o.device];
  if (!dev) throw new Error(`pnr: unknown device "${o.device}" (${Object.keys(FPGA_DEVICES).join(', ')})`);
  const fam = dev.family;
  const t = await tools(fam);
  const dec = new TextDecoder();
  let log = '';
  const sink = (b: Uint8Array | null) => { if (b) log += dec.decode(b, { stream: true }).replace(/\x1b\[[0-9;]*m/g, ''); };
  const args = [...dev.args, '--json', 'in.json', '--report', 'report.json', '--write', 'placed.json', '--timing-allow-fail'];
  const files: Tree = { 'in.json': o.json };
  if (fam === 'gowin') args.push('--device', o.pkg ?? dev.pkg);
  else args.push('--package', o.pkg ?? dev.pkg);
  if (fam === 'ice40') args.push('--asc', 'out.cfg');
  if (fam === 'ecp5') args.push('--textcfg', 'out.cfg');
  if (o.constraints !== undefined) {
    files['in.con'] = o.constraints;
    if (fam === 'ice40') args.push('--pcf', 'in.con', '--pcf-allow-unconstrained');
    else if (fam === 'ecp5') args.push('--lpf', 'in.con', '--lpf-allow-unconstrained');
    else args.push('--vopt', 'cst=in.con');
  }
  if (o.freq) args.push('--freq', String(o.freq));
  if (o.seed !== undefined) args.push('--seed', String(o.seed));
  const fetchProgress = progress ? (e: { totalLength: number; doneLength: number }) => progress(e.doneLength, e.totalLength) : undefined;
  let out: Record<string, unknown>;
  try {
    out = await t.pnr(args, files, { stdout: sink, stderr: sink, fetchProgress });
  } catch (e) {
    if (!(e as { files?: unknown }).files) throw e;
    return { ok: false, log, util: [], fmax: [] };
  }
  const text = (n: string) => { const v = out[n]; return v === undefined ? undefined : typeof v === 'string' ? v : dec.decode(v as Uint8Array); };
  const bytes = (v: unknown) => (typeof v === 'string' ? new TextEncoder().encode(v) : (v as Uint8Array | undefined));
  const config = text('out.cfg');
  const placed = text('placed.json');
  let bin: Uint8Array | undefined;
  try {
    if (fam === 'gowin') {
      const p = await t.pack(['-d', dev.packFamily!, '-o', 'out.fs', 'placed.json'], { 'placed.json': placed ?? '' }, { stdout: sink, stderr: sink, loadPyodide: gowinPyodide });
      bin = bytes(p['out.fs']);
    } else if (config) {
      const p = await t.pack(['out.cfg', 'out.bin'], { 'out.cfg': config }, { stdout: sink, stderr: sink });
      bin = bytes(p['out.bin']);
    }
  } catch (e) {
    if (!(e as { files?: unknown }).files) throw e;
    log += `\nERROR: the bitstream packer failed\n`;
    return { ok: false, log, util: [], fmax: [] };
  }
  const rep = JSON.parse(text('report.json') ?? '{}') as { utilization?: Record<string, { used: number; available: number }>; fmax?: Record<string, { achieved: number; constraint?: number }> };
  return {
    ok: true, log, config, bin, placed,
    util: Object.entries(rep.utilization ?? {}).map(([k, v]) => [k, v.used, v.available]),
    fmax: Object.entries(rep.fmax ?? {}).map(([k, v]) => [k, v.achieved, v.constraint ?? null]),
  };
}
