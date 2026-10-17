// Place & route window (iCE40 / nextpnr): options, utilization, timing and a floorplan of the placed design.
import { h, icon, download } from './dom';
import { t } from './i18n';
import type { RemoteSession as Session } from './remote';
import type { BrowserFS } from './vfs';
import { ICE40_DEVICES } from '../engine/synth';

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

/** Tiles used by each placed cell (from NEXTPNR_BEL "X12/Y8/lc0") and driver->sink tile links per net. */
export function floorplan(placedJson: string): Floorplan {
  const mod = Object.values((JSON.parse(placedJson) as { modules: Record<string, { cells: Record<string, PCell> }> }).modules)[0];
  const tiles: Floorplan['tiles'] = new Map();
  const at = new Map<string, [number, number]>();
  const drivers = new Map<number | string, [number, number]>();
  const sinks = new Map<number | string, [number, number][]>();
  for (const [name, c] of Object.entries(mod?.cells ?? {})) {
    const m = /^X(\d+)\/Y(\d+)\//.exec(c.attributes?.NEXTPNR_BEL ?? '');
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
    this.device = h('select', { class: 'tb-field', 'aria-label': t('Device') }, Object.keys(ICE40_DEVICES).map(d => h('option', { value: d, selected: d === 'up5k' }, `iCE40 ${d.toUpperCase()}`)));
    this.pkg = h('input', { class: 'tb-field', placeholder: t('package (default)'), 'aria-label': t('Package'), style: { width: '110px' } });
    this.pcf = h('select', { class: 'tb-field', 'aria-label': t('Pin constraints') });
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
        btn(t('New PCF'), t('Create a pin constraint file with the top-level ports'), () => this.newPcf()),
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

  private fillPcf() {
    const cur = this.pcf.value;
    const files = this.fs.list().filter(f => /\.pcf$/i.test(f));
    this.pcf.replaceChildren(h('option', { value: '' }, t('auto (<top>.pcf)')), ...files.map(f => h('option', { value: f, selected: f === cur }, f)));
  }

  async run() {
    const parts = ['pnr', '-device', this.device.value];
    if (this.pkg.value.trim()) parts.push('-package', this.pkg.value.trim());
    if (this.pcf.value) parts.push('-pcf', this.pcf.value);
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
    const lines = [`# Pin constraints for ${s.top}: set_io <port> <package pin>`];
    for (const [p, d] of Object.entries(mod?.ports ?? {})) for (let i = 0; i < d.bits.length; i++) lines.push(`# set_io ${d.bits.length > 1 ? `${p}[${i}]` : p} <pin>`);
    const name = `${s.top}.pcf`;
    if (!this.fs.has(name)) this.fs.write(name, lines.join('\n') + '\n');
    this.onOpenFile?.(name);
  }

  private async downloadBin() {
    const p = this.session.lastPnr;
    const bin = p?.ok ? await this.session.pnrBitstream() : null;
    if (!p || !bin) { this.status.textContent = t('No bitstream yet: run place & route first.'); return; }
    download(`${p.top}.bin`, bin);
  }

  private setZoom(z: number) { this.zoom = Math.max(0.3, Math.min(4, z)); this.render(); }

  render() {
    const p = this.session.lastPnr;
    if (!p) {
      this.status.textContent = t('Place and route for Lattice iCE40 with nextpnr: choose the device, optionally a .pcf with pin locations and a clock frequency, then press the button (or type "pnr").');
      this.table.replaceChildren();
      this.plan.replaceChildren();
      return;
    }
    const lc = p.util.find(u => u[0] === 'ICESTORM_LC');
    const timing = p.fmax.map(([c, mhz, want]) => `${c.replace(/\$.*$/, '')} ${mhz.toFixed(1)} MHz${want !== null ? (mhz >= want ? ' ✓' : ` ✗ < ${want}`) : ''}`).join(', ');
    this.status.textContent = p.ok
      ? t('{0} on iCE40 {1}: {2} logic cells — {3}', p.top, p.device.toUpperCase(), lc ? `${lc[1]}/${lc[2]}` : '?', timing || t('no clocks'))
      : t('{0}: place & route failed — see {1}.log', p.top, p.base);
    this.table.replaceChildren(h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, t('Resource')), h('th', { class: 'num' }, t('Used')), h('th', { class: 'num' }, '%'))),
      h('tbody', {}, ...p.util.filter(u => u[2] > 0).map(([n, used, av]) => h('tr', { class: used ? '' : 'kind' }, h('td', { class: 'mono' }, n), h('td', { class: 'num' }, `${used}/${av}`), h('td', { class: 'num' }, ((100 * used) / av).toFixed(0)))))));
    const placed = p.ok ? this.fs.read(`${p.base}.placed.json`) : undefined;
    if (!placed) { this.plan.replaceChildren(); return; }
    this.drawPlan(floorplan(placed), p.device);
  }

  private drawPlan(fp: Floorplan, device: string) {
    const dev = ICE40_DEVICES[device];
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
    for (const tl of fp.tiles.values()) {
      const lcs = tl.cells.filter(c => c.type === 'ICESTORM_LC').length;
      const kind = tl.cells.some(c => c.type === 'SB_IO') ? 'io' : tl.cells.some(c => /RAM/.test(c.type)) ? 'ram' : tl.cells.some(c => /GB|PLL|SPRAM|MAC|HFOSC|LFOSC/.test(c.type)) ? 'special' : 'lc';
      used.append(svg('rect', { x: px(tl.x) + 1, y: py(tl.y) + 1, width: S - 2, height: S - 2, class: `pnr-used pnr-${kind}`, 'fill-opacity': kind === 'lc' ? 0.35 + 0.65 * Math.min(1, lcs / 8) : 1 },
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
