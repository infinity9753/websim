// Synthesis window: run Yosys on the design, show the cell usage and a schematic of the netlist.
import { h, icon } from './dom';
import { t } from './i18n';
import { LIB_NAME } from '../engine/asic/cells';
import type { RemoteSession as Session } from './remote';
import type { BrowserFS } from './vfs';

const SVG = 'http://www.w3.org/2000/svg';
const TARGETS = ['generic', 'asic', 'ice40', 'ecp5', 'gowin', 'xilinx'];
const MAX_CELLS = 400;

function svg(tag: string, attrs: Record<string, string | number>, ...kids: (Node | string)[]) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const c of kids) e.append(c);
  return e;
}

// ---- Yosys JSON netlist
type Bit = number | string;
interface YCell { type: string; connections: Record<string, Bit[]>; port_directions?: Record<string, string> }
interface YModule { ports: Record<string, { direction: string; bits: Bit[] }>; cells: Record<string, YCell>; netnames?: Record<string, { bits: Bit[]; hide_name?: number }> }

interface SNode { id: string; label: string; title: string; kind: 'in' | 'out' | 'cell'; ins: string[]; outs: string[]; level: number; x: number; y: number; h: number }
interface SEdge { from: SNode; fromPin: number; to: SNode; toPin: number; name: string }

/** Lay out a netlist left to right: inputs, cells by logic depth (flip-flops break loops), outputs. */
export function layoutNetlist(m: YModule): { nodes: SNode[]; edges: SEdge[]; width: number; height: number } {
  const nodes: SNode[] = [];
  const driver = new Map<Bit, { n: SNode; pin: number }>();
  const netName = new Map<Bit, string>();
  for (const [n, nn] of Object.entries(m.netnames ?? {})) if (!nn.hide_name) nn.bits.forEach((b, i) => netName.set(b, nn.bits.length > 1 ? `${n}[${i}]` : n));
  const mk = (id: string, label: string, title: string, kind: SNode['kind'], ins: string[], outs: string[]): SNode => {
    const n: SNode = { id, label, title, kind, ins, outs, level: 0, x: 0, y: 0, h: 0 };
    n.h = Math.max(24, 10 + 12 * Math.max(ins.length, outs.length));
    nodes.push(n);
    return n;
  };
  for (const [p, d] of Object.entries(m.ports)) {
    if (d.direction === 'input') { const n = mk(`in:${p}`, p, `input ${p}${d.bits.length > 1 ? ` [${d.bits.length}]` : ''}`, 'in', [], [p]); d.bits.forEach(b => driver.set(b, { n, pin: 0 })); }
  }
  const cells = Object.entries(m.cells);
  const cellNodes = cells.map(([name, c]) => {
    const dir = c.port_directions ?? {};
    const pins = Object.keys(c.connections);
    const outs = pins.filter(p => dir[p] === 'output' || (!dir[p] && /^(Y|Q|O)$/.test(p)));
    const ins = pins.filter(p => !outs.includes(p));
    const n = mk(`cell:${name}`, c.type.replace(/^\$_?|_$/g, ''), `${c.type} ${name}`, 'cell', ins, outs);
    outs.forEach((p, i) => c.connections[p].forEach(b => driver.set(b, { n, pin: i })));
    return { n, c, ins };
  });
  const edges: SEdge[] = [];
  const seen = new Set<string>();
  const link = (b: Bit, to: SNode, toPin: number) => {
    const d = driver.get(b);
    if (!d) return;
    const key = `${d.n.id}:${d.pin}>${to.id}:${toPin}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: d.n, fromPin: d.pin, to, toPin, name: netName.get(b) ?? '' });
  };
  for (const { n, c, ins } of cellNodes) ins.forEach((p, i) => c.connections[p].forEach(b => link(b, n, i)));
  const outsN: SNode[] = [];
  for (const [p, d] of Object.entries(m.ports)) {
    if (d.direction !== 'output') continue;
    const n = mk(`out:${p}`, p, `output ${p}${d.bits.length > 1 ? ` [${d.bits.length}]` : ''}`, 'out', [p], []);
    outsN.push(n);
    d.bits.forEach(b => link(b, n, 0));
  }
  // logic depth; edges into flip-flops do not count, which breaks every sequential loop
  const isFF = (n: SNode) => n.kind === 'cell' && /DFF|FDRE|FDCE|FDSE|FDPE|TRELLIS_FF|\bFF\b|LATCH|DLATCH/i.test(n.title.split(' ')[0]);
  const preds = new Map<SNode, SNode[]>();
  for (const e of edges) if (!isFF(e.to)) (preds.get(e.to) ?? preds.set(e.to, []).get(e.to)!).push(e.from);
  const state = new Map<SNode, number>();
  const depth = (n: SNode): number => {
    const s = state.get(n);
    if (s !== undefined) return s < 0 ? 0 : s;
    state.set(n, -1);
    let d = n.kind === 'in' ? 0 : 1;
    for (const p of preds.get(n) ?? []) d = Math.max(d, depth(p) + 1);
    state.set(n, d);
    return d;
  };
  for (const n of nodes) n.level = depth(n);
  const maxLevel = Math.max(1, ...nodes.filter(n => n.kind !== 'out').map(n => n.level));
  for (const n of outsN) n.level = maxLevel + 1;
  const cols = new Map<number, SNode[]>();
  for (const n of nodes) (cols.get(n.level) ?? cols.set(n.level, []).get(n.level)!).push(n);
  const COL = 150, GAP = 14, PAD = 20;
  let height = 0;
  for (const [lvl, col] of cols) {
    let y = PAD;
    for (const n of col) { n.x = PAD + lvl * COL; n.y = y; y += n.h + GAP; }
    height = Math.max(height, y);
  }
  return { nodes, edges, width: PAD * 2 + (maxLevel + 1) * COL + 100, height: height + PAD };
}

/** How a cell is drawn as a logic symbol (IEEE Std 91 distinctive shapes); null keeps the box. */
export interface GateSym { kind: 'and' | 'or' | 'xor' | 'buf' | 'mux' | 'aoi' | 'oai' | 'ff' | 'latch' | 'tie'; inv: boolean; invIn?: number[]; value?: 0 | 1 }

const SYMBOLS: Record<string, GateSym> = {
  // Yosys generic gates
  $_AND_: { kind: 'and', inv: false }, $_NAND_: { kind: 'and', inv: true }, $_OR_: { kind: 'or', inv: false }, $_NOR_: { kind: 'or', inv: true },
  $_XOR_: { kind: 'xor', inv: false }, $_XNOR_: { kind: 'xor', inv: true }, $_NOT_: { kind: 'buf', inv: true }, $_BUF_: { kind: 'buf', inv: false },
  $_ANDNOT_: { kind: 'and', inv: false, invIn: [1] }, $_ORNOT_: { kind: 'or', inv: false, invIn: [1] },
  $_MUX_: { kind: 'mux', inv: false }, $_NMUX_: { kind: 'mux', inv: true }, $_AOI3_: { kind: 'aoi', inv: true }, $_OAI3_: { kind: 'oai', inv: true },
  // WebSim educational standard cells (and the same names in other libraries)
  INV: { kind: 'buf', inv: true }, BUF: { kind: 'buf', inv: false }, AND2: { kind: 'and', inv: false }, OR2: { kind: 'or', inv: false },
  NAND2: { kind: 'and', inv: true }, NAND3: { kind: 'and', inv: true }, NOR2: { kind: 'or', inv: true }, NOR3: { kind: 'or', inv: true },
  XOR2: { kind: 'xor', inv: false }, XNOR2: { kind: 'xor', inv: true }, AOI21: { kind: 'aoi', inv: true }, OAI21: { kind: 'oai', inv: true },
  MUX2: { kind: 'mux', inv: false }, DFF: { kind: 'ff', inv: false }, DFFR: { kind: 'ff', inv: false },
  TIEHI: { kind: 'tie', inv: false, value: 1 }, TIELO: { kind: 'tie', inv: false, value: 0 },
};

export function gateSymbol(type: string): GateSym | null {
  if (SYMBOLS[type]) return SYMBOLS[type];
  if (/^\$_(S?DFFS?R?E?|DFFE|SDFFC?E|ALDFFE?|DFFSRE?)_/.test(type)) return { kind: 'ff', inv: false };
  if (/^\$_DLATCH/.test(type)) return { kind: 'latch', inv: false };
  return null;
}

/** SVG elements of a gate symbol in a node box of width w, height h, with the given pin rows (local coordinates). */
function gateShape(sym: GateSym, w: number, h: number, ins: string[], outs: string[], pinY: (i: number, n: number) => number): SVGElement[] {
  const out: SVGElement[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number) => out.push(svg('line', { x1, y1, x2, y2, class: 'syn-wire' }));
  const body = (d: string) => out.push(svg('path', { d, class: 'syn-gate' }));
  const bubble = (cx: number, cy: number) => out.push(svg('circle', { cx, cy, r: 3, class: 'syn-gate' }));
  const text = (x: number, y: number, s: string, cls = 'syn-pin', anchor = 'start') => out.push(svg('text', { x, y, class: cls, 'text-anchor': anchor }, s));
  const x0 = Math.round(w * 0.3), x1 = Math.round(w * 0.7), y0 = 3, y1 = h - 3, ym = h / 2;
  const yOut = pinY(0, outs.length);
  // output stub, with an inversion bubble when needed
  const outStub = (xEnd: number) => { if (sym.inv) { bubble(xEnd + 3, yOut); line(xEnd + 6, yOut, w, yOut); } else line(xEnd, yOut, w, yOut); };
  const inStubs = (xTo: (y: number) => number, only?: number[]) => ins.forEach((_, i) => {
    if (only && !only.includes(i)) return;
    const y = pinY(i, ins.length), xe = xTo(y);
    if (sym.invIn?.includes(i)) { line(0, y, xe - 6, y); bubble(xe - 3, y); } else line(0, y, xe, y);
  });
  // left edge of an OR body (a shallow curve) at height y
  const orLeft = (y: number, xl = x0) => xl + 7 * (1 - Math.pow((y - ym) / (ym - y0), 2));
  const andPath = (xa: number, xb: number, ya: number, yb: number) => { const r = (yb - ya) / 2; const xm = Math.max(xa, xb - r); return `M${xa},${ya} H${xm} A${r},${r} 0 0 1 ${xm},${yb} H${xa} Z`; };
  const orPath = (xa: number, xb: number, ya: number, yb: number) => { const yc = (ya + yb) / 2, wd = xb - xa; return `M${xa},${ya} Q${xa + wd * 0.6},${ya} ${xb},${yc} Q${xa + wd * 0.6},${yb} ${xa},${yb} Q${xa + 9},${yc} ${xa},${ya} Z`; };
  switch (sym.kind) {
    case 'and':
      inStubs(() => x0); body(andPath(x0, x1, y0, y1)); outStub(x1);
      break;
    case 'or': case 'xor':
      inStubs(y => orLeft(y)); body(orPath(x0, x1, y0, y1)); outStub(x1);
      if (sym.kind === 'xor') out.push(svg('path', { d: `M${x0 - 5},${y0} Q${x0 + 4},${ym} ${x0 - 5},${y1}`, class: 'syn-gate syn-open' }));
      break;
    case 'buf':
      inStubs(() => x0 + 6); body(`M${x0 + 6},${ym - 10} L${x1 - 6},${ym} L${x0 + 6},${ym + 10} Z`); outStub(x1 - 6);
      break;
    case 'mux': {
      // inputs A (0), B (1), S: the select arrives on the left edge too, labelled
      inStubs(() => x0); body(`M${x0},${y0} L${x1},${y0 + 7} L${x1},${y1 - 7} L${x0},${y1} Z`); outStub(x1);
      ins.forEach((p, i) => text(x0 + 3, pinY(i, ins.length) + 3, /^S/.test(p) ? 'S' : i === 0 ? '0' : '1'));
      break;
    }
    case 'aoi': case 'oai': {
      // first stage on the first two inputs, second stage (NOR / NAND) with the third input
      const ya = pinY(0, ins.length) - 6, yb = pinY(1, ins.length) + 6, yc = (ya + yb) / 2;
      const s1a = Math.round(w * 0.22), s1b = Math.round(w * 0.42), s2a = Math.round(w * 0.52);
      inStubs(() => s1a, [0, 1]);
      body(sym.kind === 'aoi' ? andPath(s1a, s1b, ya, yb) : orPath(s1a, s1b, ya, yb));
      const yIn2 = pinY(2, ins.length);
      line(s1b, yc, s2a + 4, yc);
      line(0, yIn2, s2a + 4, yIn2);
      body(sym.kind === 'aoi' ? orPath(s2a, x1, y0, y1) : andPath(s2a, x1, y0, y1));
      outStub(x1);
      break;
    }
    case 'ff': case 'latch': {
      out.push(svg('rect', { x: x0 - 6, y: y0, width: x1 - x0 + 12, height: y1 - y0, rx: 2, class: 'syn-gate' }));
      ins.forEach((p, i) => {
        const y = pinY(i, ins.length);
        const clk = /^(C|CLK|CK)$/.test(p), lowActive = /^(RN|R_N|SN|NRST|RESET_N)$/.test(p);
        if (lowActive) { line(0, y, x0 - 12, y); bubble(x0 - 9, y); } else line(0, y, x0 - 6, y);
        if (clk && sym.kind === 'ff') out.push(svg('path', { d: `M${x0 - 6},${y - 4} L${x0 + 1},${y} L${x0 - 6},${y + 4}`, class: 'syn-gate syn-open' }));
        text(x0 + (clk ? 3 : -2), y + 3, clk ? '' : p.replace(/^\$/, ''), 'syn-pin');
      });
      outs.forEach((p, i) => { const y = pinY(i, outs.length); line(x1 + 6, y, w, y); text(x1 + 2, y + 3, p, 'syn-pin', 'end'); });
      text((x0 + x1) / 2, y1 - 3, sym.kind === 'ff' ? 'FF' : 'L', 'syn-glabel', 'middle');
      break;
    }
    case 'tie': {
      line((x0 + x1) / 2, yOut, w, yOut);
      if (sym.value) { line((x0 + x1) / 2, yOut, (x0 + x1) / 2, y0 + 1); line(x0 + 4, y0 + 1, x1 - 4, y0 + 1); }
      else { line((x0 + x1) / 2, yOut, (x0 + x1) / 2, y1 - 5); for (let k = 0; k < 3; k++) line(x0 + 4 + k * 3, y1 - 5 + k * 2, x1 - 4 - k * 3, y1 - 5 + k * 2); }
      text(x0 - 2, yOut + 3, String(sym.value), 'syn-glabel', 'end');
      break;
    }
  }
  return out;
}

export class SynthesisView {
  el: HTMLElement;
  private top: HTMLInputElement;
  private tops: HTMLDataListElement;
  private target: HTMLSelectElement;
  private flatten: HTMLInputElement;
  private status: HTMLElement;
  private table: HTMLElement;
  private schematic: HTMLElement;
  private zoom = 1;
  private symbols: HTMLInputElement;
  onOpenFile?: (name: string) => void;

  constructor(private session: Session, private fs: BrowserFS) {
    this.top = h('input', { class: 'tb-field', list: 'synth-tops', placeholder: t('top module (auto)'), 'aria-label': t('Top module'), style: { width: '130px' } });
    this.tops = h('datalist', { id: 'synth-tops' });
    this.target = h('select', { class: 'tb-field', 'aria-label': t('Target') }, TARGETS.map(x => h('option', { value: x }, x)));
    this.flatten = h('input', { type: 'checkbox', checked: true });
    this.symbols = h('input', { type: 'checkbox', checked: true, onchange: () => this.render() });
    this.status = h('div', { class: 'synth-status kind' });
    this.table = h('div', { class: 'synth-cells scroll' });
    this.schematic = h('div', { class: 'synth-schematic scroll' });
    const btn = (label: string, title: string, f: () => void) => h('button', { class: 'btn', title, onclick: f }, label);
    this.el = h('div', { class: 'synthesis synth-view' },
      h('div', { class: 'subbar' },
        h('label', { class: 'synth-opt' }, t('Top'), ' ', this.top, this.tops),
        h('label', { class: 'synth-opt' }, t('Target'), ' ', this.target),
        h('label', { class: 'synth-opt', title: t('Flatten the hierarchy into one module') }, this.flatten, ' ', t('Flatten')),
        h('button', { class: 'tb-btn', title: t('Synthesize with Yosys'), 'aria-label': t('Synthesize with Yosys'), onclick: () => void this.run() }, icon('compileall')),
        h('span', { class: 'grow' }),
        h('label', { class: 'synth-opt', title: t('Draw logic gates with their standard symbols instead of boxes') }, this.symbols, ' ', t('Gate symbols')),
        btn(t('Netlist'), t('Open the synthesized Verilog netlist'), () => this.open('.v')),
        btn(t('Log'), t('Open the Yosys log'), () => this.open('.log')),
        btn(t('Simulate netlist'), t('Compile the netlist into work (it replaces the RTL module) for gate-level simulation'), () => void this.gateSim()),
        h('button', { class: 'tb-btn', title: t('Zoom in'), onclick: () => this.setZoom(this.zoom * 1.25) }, icon('zoomin')),
        h('button', { class: 'tb-btn', title: t('Zoom out'), onclick: () => this.setZoom(this.zoom / 1.25) }, icon('zoomout'))),
      this.status,
      h('div', { class: 'synth-body' }, this.table, this.schematic));
    session.on('library', () => this.fillTops());
    session.on('synth', () => this.render());
    fs.onChange(() => { if (this.el.offsetParent !== null) this.render(); });
    this.fillTops();
    this.render();
  }

  private fillTops() {
    const units = [...(this.session.libs.libs.get('work')?.list() ?? [])].filter(u => u.kind === 'module' && !u.iface).map(u => u.name);
    this.tops.replaceChildren(...units.map(u => h('option', { value: u })));
  }

  async run() {
    const parts = ['synth'];
    if (this.top.value.trim()) parts.push('-top', this.top.value.trim());
    parts.push('-target', this.target.value);
    if (this.flatten.checked) parts.push('-flatten');
    this.status.textContent = t('Running Yosys… (the first run downloads about 77 MB)');
    await this.session.exec(parts.join(' '));
    this.render();
  }

  private open(ext: string) { const s = this.session.lastSynth; if (s && this.fs.has(s.base + ext)) this.onOpenFile?.(s.base + ext); }

  private async gateSim() {
    const s = this.session.lastSynth;
    if (!s?.ok) return;
    // asic and FPGA netlists need the cell models (written by synth) compiled first
    const models = s.target === 'asic' ? `synth/${LIB_NAME}.v` : s.target === 'generic' ? '' : `synth/${s.target}_cells.v`;
    await this.session.exec(`vlog ${models ? models + ' ' : ''}${s.base}.v`);
  }

  private setZoom(z: number) { this.zoom = Math.max(0.25, Math.min(3, z)); const svgEl = this.schematic.querySelector('svg'); if (svgEl) this.applyZoom(svgEl as SVGSVGElement); }
  private applyZoom(s: SVGSVGElement) { const w = Number(s.dataset.w), hh = Number(s.dataset.h); s.setAttribute('width', String(w * this.zoom)); s.setAttribute('height', String(hh * this.zoom)); }

  render() {
    const s = this.session.lastSynth;
    if (!s) {
      this.status.textContent = t('Synthesize the design with Yosys: choose the top module and target, then press the button (or type "synth" in the transcript).');
      this.table.replaceChildren();
      this.schematic.replaceChildren();
      return;
    }
    const total = s.cells.reduce((a, [, n]) => a + n, 0);
    this.status.textContent = s.ok
      ? t('{0} ({1}): {2} cells, {3} warnings — files in {4}.*', s.top, s.target, total, s.warnings, s.base)
      : t('{0} ({1}): synthesis failed — see {2}.log', s.top, s.target, s.base);
    this.table.replaceChildren(h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, t('Cell')), h('th', { class: 'num' }, t('Count')))),
      h('tbody', {}, ...s.cells.map(([c, n]) => h('tr', {}, h('td', { class: 'mono' }, c), h('td', { class: 'num' }, String(n)))),
        h('tr', { class: 'total' }, h('td', {}, t('Total')), h('td', { class: 'num' }, String(total))))));
    this.drawSchematic(s.ok ? this.fs.read(s.base + '.json') : undefined, s.top);
  }

  private drawSchematic(json: string | undefined, top: string) {
    if (!json) { this.schematic.replaceChildren(); return; }
    let mod: YModule | undefined;
    try { mod = (JSON.parse(json) as { modules: Record<string, YModule> }).modules[top]; } catch { /* partial file */ }
    if (!mod) { this.schematic.replaceChildren(h('div', { class: 'empty' }, t('No netlist for {0}.', top))); return; }
    const n = Object.keys(mod.cells).length;
    if (n > MAX_CELLS) { this.schematic.replaceChildren(h('div', { class: 'empty' }, t('{0} cells: too many to draw (limit {1}). Open the netlist instead.', n, MAX_CELLS))); return; }
    const L = layoutNetlist(mod);
    const root = svg('svg', { viewBox: `0 0 ${L.width} ${L.height}`, class: 'synth-svg', role: 'img', 'aria-label': t('Schematic of {0}', top) }) as SVGSVGElement;
    root.dataset.w = String(L.width); root.dataset.h = String(L.height);
    const W = 110;
    const pinY = (nd: SNode, i: number, count: number) => nd.y + (count <= 1 ? nd.h / 2 : 10 + i * 12);
    const edges = svg('g', { class: 'syn-edges' });
    for (const e of L.edges) {
      const x1 = e.from.x + W, y1 = pinY(e.from, e.fromPin, e.from.outs.length);
      const x2 = e.to.x, y2 = pinY(e.to, e.toPin, e.to.ins.length);
      const mx = (x1 + x2) / 2;
      edges.append(svg('path', { d: x2 > x1 ? `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` : `M${x1},${y1} h12 V${Math.min(y1, y2) - 18} H${x2 - 12} V${y2} h12`, class: 'syn-edge' + (x2 > x1 ? '' : ' back') }, svg('title', {}, e.name)));
    }
    const nodes = svg('g', {});
    for (const nd of L.nodes) {
      const g = svg('g', { class: `syn-node syn-${nd.kind}`, transform: `translate(${nd.x},${nd.y})` }, svg('title', {}, nd.title));
      const sym = nd.kind === 'cell' && this.symbols.checked ? gateSymbol(nd.title.split(' ')[0]) : null;
      if (sym) {
        g.classList.add('syn-sym');
        g.append(...gateShape(sym, W, nd.h, nd.ins, nd.outs, (i, n) => pinY(nd, i, n) - nd.y));
      } else if (nd.kind === 'cell') {
        g.append(svg('rect', { width: W, height: nd.h, rx: 3 }), svg('text', { x: W / 2, y: nd.h / 2 + 4, 'text-anchor': 'middle', class: 'syn-type' }, nd.label.length > 14 ? nd.label.slice(0, 13) + '…' : nd.label));
        nd.ins.forEach((p, i) => g.append(svg('text', { x: 3, y: pinY(nd, i, nd.ins.length) - nd.y + 3, class: 'syn-pin' }, p)));
        nd.outs.forEach((p, i) => g.append(svg('text', { x: W - 3, y: pinY(nd, i, nd.outs.length) - nd.y + 3, class: 'syn-pin', 'text-anchor': 'end' }, p)));
      } else {
        g.append(svg('path', { d: nd.kind === 'in' ? `M0,0 H${W - 12} L${W},12 L${W - 12},24 H0 Z` : `M12,0 H${W} V24 H12 L0,12 Z`, class: 'syn-port' }),
          svg('text', { x: nd.kind === 'in' ? 8 : 18, y: 16, class: 'syn-type' }, nd.label.length > 13 ? nd.label.slice(0, 12) + '…' : nd.label));
      }
      nodes.append(g);
    }
    root.append(edges, nodes);
    this.applyZoom(root);
    this.schematic.replaceChildren(root);
  }
}
