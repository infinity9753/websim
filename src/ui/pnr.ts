// Place & route window (nextpnr: iCE40, ECP5, Gowin): options, utilization, timing and a floorplan of the placed design.
import { h, icon, download } from './dom';
import { t } from './i18n';
import type { RemoteSession as Session } from './remote';
import type { BrowserFS } from './vfs';
import { FPGA_DEVICES, FPGA_FAMILIES, constraintTemplate, type FpgaFamily } from '../engine/synth';

const SVG = 'http://www.w3.org/2000/svg';
const TILE = 22;

function svg(tag: string, attrs: Record<string, string | number>, ...kids: (Node | string)[]) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const c of kids) e.append(c);
  return e;
}

interface PCell { type: string; attributes?: Record<string, string>; connections?: Record<string, (number | string)[]>; port_directions?: Record<string, string> }

export interface Floorplan {
  tiles: Map<string, { x: number; y: number; cells: { name: string; type: string }[] }>;
  nets: { name: string; from: [number, number]; to: [number, number][]; global: boolean }[];
}

/** Tiles used by each placed cell (from NEXTPNR_BEL "X12/Y8/lc0", "X4Y11/LUT0") and driver->sink tile links per net. */
export function floorplan(placedJson: string): Floorplan {
  const mod = Object.values((JSON.parse(placedJson) as { modules: Record<string, { cells: Record<string, PCell> }> }).modules)[0];
  const tiles: Floorplan['tiles'] = new Map();
  const at = new Map<string, [number, number]>();
  const drivers = new Map<number | string, [number, number]>();
  const sinks = new Map<number | string, [number, number][]>();
  for (const [name, c] of Object.entries(mod?.cells ?? {})) {
    const m = /^X(\d+)\/?Y(\d+)\//.exec(c.attributes?.NEXTPNR_BEL ?? '');
    if (!m) continue;
    const x = Number(m[1]), y = Number(m[2]);
    const key = `${x},${y}`;
    (tiles.get(key) ?? tiles.set(key, { x, y, cells: [] }).get(key)!).cells.push({ name, type: c.type });
    at.set(name, [x, y]);
    for (const [pin, bits] of Object.entries(c.connections ?? {})) {
      const out = c.port_directions?.[pin] === 'output';
      for (const b of bits) {
        if (typeof b === 'string') continue;
        if (out) drivers.set(b, [x, y]);
        else (sinks.get(b) ?? sinks.set(b, []).get(b)!).push([x, y]);
      }
    }
  }
  const nets: Floorplan['nets'] = [];
  for (const [b, from] of drivers) {
    const to = (sinks.get(b) ?? []).filter(([x, y]) => x !== from[0] || y !== from[1]);
    if (to.length) nets.push({ name: String(b), from, to, global: to.length > 16 });
  }
  return { tiles, nets };
}

/** Used resources first, then the main unused ones (logic, IO, RAM, DSP, PLL); the many unused special blocks are left out. */
export function utilRows(util: [string, number, number][]): [string, number, number][] {
  const main = /LC$|COMB|_FF$|^DFF|LUT|IO$|^IOB|RAM|DP16KD|MULT|DSP|ALU54|PLL/;
  return [...util.filter(u => u[1] > 0), ...util.filter(u => u[1] === 0 && u[2] > 0 && main.test(u[0]))];
}

/** What a tile mostly holds: IO, block RAM, special blocks (clock buffers, PLLs, DSP) or logic. */
export function tileKind(types: string[]): 'io' | 'ram' | 'special' | 'lc' {
  if (types.some(t => /^(SB_IO|TRELLIS_IO|IOB|OBUF|IBUF|TBUF|IOBUF)/.test(t))) return 'io';
  if (types.some(t => /RAM|DP16KD|PDPW16KD|BSRAM|^SP$|^SDP|^DPB|^ROM/.test(t))) return 'ram';
  if (types.some(t => /GB|PLL|MAC|OSC|DCC|DCS|MULT|DSP|ALU54|CLK|ECLK|EHX/.test(t))) return 'special';
  return 'lc';
}

export class PnrView {
  el: HTMLElement;
  private device: HTMLSelectElement;
  private pkg: HTMLInputElement;
  private pcf: HTMLSelectElement;
  private freq: HTMLInputElement;
  private status: HTMLElement;
  private table: HTMLElement;
  private plan: HTMLElement;
  private zoom = 1;
  onOpenFile?: (name: string) => void;

  constructor(private session: Session, private fs: BrowserFS) {
    const fams = Object.keys(FPGA_FAMILIES) as FpgaFamily[];
    this.device = h('select', { class: 'tb-field', 'aria-label': t('Device'), style: { width: '210px' }, onchange: () => this.fillPcf() }, fams.map(f => h('optgroup', { label: FPGA_FAMILIES[f].label },
      Object.entries(FPGA_DEVICES).filter(([, d]) => d.family === f).map(([k, d]) => h('option', { value: k, selected: k === 'up5k' }, d.name)))));
    this.pkg = h('input', { class: 'tb-field', placeholder: t('package (default)'), 'aria-label': t('Package'), style: { width: '110px' } });
    this.pcf = h('select', { class: 'tb-field', 'aria-label': t('Pin constraints'), style: { width: '130px' } });
    this.freq = h('input', { class: 'tb-field', type: 'number', min: '1', placeholder: 'MHz', title: t('Target clock frequency (MHz)'), style: { width: '70px' } });
    this.status = h('div', { class: 'synth-status kind' });
    this.table = h('div', { class: 'synth-cells scroll' });
    this.plan = h('div', { class: 'synth-schematic scroll' });
    const btn = (label: string, title: string, f: () => void) => h('button', { class: 'btn', title, onclick: f }, label);
    this.el = h('div', { class: 'synthesis pnr' },
      h('div', { class: 'subbar' },
        this.device, ' ', this.pkg, ' ', h('label', { class: 'synth-opt' }, t('Pins'), ' ', this.pcf),
        h('label', { class: 'synth-opt' }, t('Clock'), ' ', this.freq),
        h('button', { class: 'tb-btn', title: t('Synthesize, place and route'), 'aria-label': t('Synthesize, place and route'), onclick: () => void this.run() }, icon('compileall')),
        h('span', { class: 'grow' }),
        btn(t('New constraints'), t('Create a pin constraint file with the top-level ports'), () => this.newPcf()),
        btn(t('Bitstream'), t('Download the bitstream (.bin) for programming the FPGA'), () => void this.downloadBin()),
        btn(t('Log'), t('Open the nextpnr log'), () => { const p = this.session.lastPnr; if (p) this.onOpenFile?.(p.base + '.log'); }),
        h('button', { class: 'tb-btn', title: t('Zoom in'), onclick: () => this.setZoom(this.zoom * 1.25) }, icon('zoomin')),
        h('button', { class: 'tb-btn', title: t('Zoom out'), onclick: () => this.setZoom(this.zoom / 1.25) }, icon('zoomout'))),
      this.status,
      h('div', { class: 'synth-body' }, this.table, this.plan));
    session.on('synth', () => this.render());
    fs.onChange(() => this.fillPcf());
    this.fillPcf();
    this.render();
  }

  private family() { return FPGA_FAMILIES[FPGA_DEVICES[this.device.value]?.family ?? 'ice40']; }

  private fillPcf() {
    const cur = this.pcf.value;
    const ext = this.family().constraints;
    const files = this.fs.list().filter(f => f.toLowerCase().endsWith('.' + ext));
    this.pcf.replaceChildren(h('option', { value: '' }, t('auto (<top>.{0})', ext)), ...files.map(f => h('option', { value: f, selected: f === cur }, f)));
  }

  async run() {
    const parts = ['pnr', '-device', this.device.value];
    if (this.pkg.value.trim()) parts.push('-package', this.pkg.value.trim());
    if (this.pcf.value) parts.push('-constraints', this.pcf.value);
    if (Number(this.freq.value) > 0) parts.push('-freq', this.freq.value);
    this.status.textContent = t('Running Yosys and nextpnr… (the first run downloads about 310 MB)');
    await this.session.exec(parts.join(' '));
    this.render();
  }

  /** A PCF template listing every top-level port bit, for the user to fill in package pins. */
  private newPcf() {
    const s = this.session.lastSynth;
    const json = s ? this.fs.read(`${s.base}.json`) : undefined;
    if (!s || !json) { this.status.textContent = t('Run place & route (or synth -target ice40) once to know the top-level ports.'); return; }
    const mod = (JSON.parse(json) as { modules: Record<string, { ports: Record<string, { bits: unknown[] }> }> }).modules[s.top];
    const bits = Object.entries(mod?.ports ?? {}).flatMap(([p, d]) => d.bits.map((_, i) => (d.bits.length > 1 ? `${p}[${i}]` : p)));
    const dev = FPGA_DEVICES[this.device.value];
    const name = `${s.top}.${FPGA_FAMILIES[dev.family].constraints}`;
    if (!this.fs.has(name)) this.fs.write(name, constraintTemplate(dev.family, s.top, bits));
    this.fillPcf();
    this.pcf.value = name;
    this.onOpenFile?.(name);
  }

  private async downloadBin() {
    const p = this.session.lastPnr;
    const bin = p?.ok ? await this.session.pnrBitstream() : null;
    if (!p || !bin) { this.status.textContent = t('No bitstream yet: run place & route first.'); return; }
    download(p.bitstream, bin);
  }

  private setZoom(z: number) { this.zoom = Math.max(0.3, Math.min(4, z)); this.render(); }

  render() {
    const p = this.session.lastPnr;
    if (!p) {
      this.status.textContent = t('Place and route for Lattice iCE40 / ECP5 and Gowin FPGAs with nextpnr: choose the device, optionally a pin constraint file (.pcf, .lpf, .cst) and a clock frequency, then press the button (or type "pnr").');
      this.table.replaceChildren();
      this.plan.replaceChildren();
      return;
    }
    const lc = p.util.find(u => /^(ICESTORM_LC|TRELLIS_COMB|LUT4)$/.test(u[0]));
    const timing = p.fmax.map(([c, mhz, want]) => `${c.replace(/\$.*$/, '')} ${mhz.toFixed(1)} MHz${want !== null ? (mhz >= want ? ' ✓' : ` ✗ < ${want}`) : ''}`).join(', ');
    this.status.textContent = p.ok
      ? t('{0} on {1}: {2} logic cells — {3}', p.top, FPGA_DEVICES[p.device]?.name ?? p.device, lc ? `${lc[1]}/${lc[2]}` : '?', timing || t('no clocks'))
      : t('{0}: place & route failed — see {1}.log', p.top, p.base);
    this.table.replaceChildren(h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, t('Resource')), h('th', { class: 'num' }, t('Used')), h('th', { class: 'num' }, '%'))),
      h('tbody', {}, ...utilRows(p.util).map(([n, used, av]) => h('tr', { class: used ? '' : 'kind' }, h('td', { class: 'mono' }, n), h('td', { class: 'num' }, `${used}/${av}`), h('td', { class: 'num' }, ((100 * used) / av).toFixed(0)))))));
    const placed = p.ok ? this.fs.read(`${p.base}.placed.json`) : undefined;
    if (!placed) { this.plan.replaceChildren(); return; }
    this.drawPlan(floorplan(placed), p.device);
  }

  private drawPlan(fp: Floorplan, device: string) {
    const dev = FPGA_DEVICES[device];
    let W = dev?.w ?? 0, H = dev?.h ?? 0;
    for (const tl of fp.tiles.values()) { W = Math.max(W, tl.x); H = Math.max(H, tl.y); }
    const S = TILE * this.zoom;
    // y grows upwards on the die: draw row H at the top
    const px = (x: number) => 10 + x * S, py = (y: number) => 10 + (H - y) * S;
    const root = svg('svg', { width: (W + 1) * S + 20, height: (H + 1) * S + 20, class: 'pnr-svg', role: 'img', 'aria-label': t('Floorplan') });
    const grid = svg('g', { class: 'pnr-grid' });
    for (let x = 0; x <= W; x++) for (let y = 0; y <= H; y++) {
      const edge = x === 0 || y === 0 || x === W || y === H;
      grid.append(svg('rect', { x: px(x) + 1, y: py(y) + 1, width: S - 2, height: S - 2, class: edge ? 'pnr-io' : 'pnr-tile' }));
    }
    root.append(grid);
    const used = svg('g', {});
    const fullTile = Math.max(1, ...[...fp.tiles.values()].map(tl => tl.cells.length));
    for (const tl of fp.tiles.values()) {
      const kind = tileKind(tl.cells.map(c => c.type));
      used.append(svg('rect', { x: px(tl.x) + 1, y: py(tl.y) + 1, width: S - 2, height: S - 2, class: `pnr-used pnr-${kind}`, 'fill-opacity': kind === 'lc' ? 0.35 + 0.65 * Math.min(1, tl.cells.length / fullTile) : 1 },
        svg('title', {}, `X${tl.x} Y${tl.y}\n${tl.cells.map(c => `${c.type} ${c.name}`).slice(0, 12).join('\n')}${tl.cells.length > 12 ? '\n…' : ''}`)));
    }
    const nets = svg('g', { class: 'pnr-nets' });
    const c = (v: number) => v + S / 2;
    for (const n of fp.nets.slice(0, 3000)) {
      for (const [x, y] of n.to) nets.append(svg('path', { d: `M${c(px(n.from[0]))},${c(py(n.from[1]))} L${c(px(x))},${c(py(n.from[1]))} L${c(px(x))},${c(py(y))}`, class: n.global ? 'pnr-net global' : 'pnr-net' }));
    }
    root.append(nets, used);
    this.plan.replaceChildren(root);
  }
}
