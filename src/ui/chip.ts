// Layout window of the educational ASIC flow (#51): runs "asic", draws the placed and routed design on a canvas
// (layers, cells, nets), highlights nets and the critical path, and downloads the GDSII stream.
import { h, icon, download } from './dom';
import { t } from './i18n';
import type { RemoteSession as Session } from './remote';
import { LAYERS, LAYER, type LayoutData, type Rect } from '../engine/asic/layout';
import { ROW_H } from '../engine/asic/cells';

const MIN_DETAIL = 0.035;   // px per nm from which cell internals are drawn

export class LayoutView {
  el: HTMLElement;
  onOpenFile?: (name: string) => void;
  private canvas: HTMLCanvasElement;
  private status: HTMLElement;
  private info: HTMLElement;
  private layerBox: HTMLElement;
  private util: HTMLInputElement;
  private layers: HTMLSelectElement;
  private search: HTMLInputElement;
  private data: LayoutData | null = null;
  private loadedRun = -1;
  private hidden = new Set<string>(['NWELL']);
  private scale = 0.01;      // px per nm
  private ox = 0; private oy = 0;   // screen position of the origin
  private net: string | null = null;
  private showCritical = false;
  private drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;
  private frame = 0;

  constructor(private session: Session) {
    this.util = h('input', { class: 'tb-field', type: 'number', min: '0.1', max: '0.95', step: '0.05', value: '0.6', title: t('Target core utilization'), style: { width: '60px' } });
    this.layers = h('select', { class: 'tb-field', 'aria-label': t('Routing layers'), title: t('Routing layers') }, [2, 3, 4].map(n => h('option', { value: String(n), selected: n === 3 }, `M2–M${n + 1}`)));
    this.search = h('input', { class: 'tb-field', placeholder: t('net name'), 'aria-label': t('Highlight net'), style: { width: '120px' }, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') this.findNet(this.search.value.trim()); } });
    this.canvas = h('canvas', { class: 'chip-canvas', 'aria-label': t('Layout') });
    this.status = h('div', { class: 'synth-status kind' });
    this.info = h('div', { class: 'chip-info mono' });
    this.layerBox = h('div', { class: 'chip-layers' });
    const btn = (label: string, title: string, f: () => void) => h('button', { class: 'btn', title, onclick: f }, label);
    this.el = h('div', { class: 'synthesis chip' },
      h('div', { class: 'subbar' },
        h('label', { class: 'synth-opt' }, t('Utilization'), ' ', this.util),
        h('label', { class: 'synth-opt' }, t('Layers'), ' ', this.layers),
        h('button', { class: 'tb-btn', title: t('Synthesize, place and route (ASIC)'), 'aria-label': t('Synthesize, place and route (ASIC)'), onclick: () => void this.run() }, icon('compileall')),
        h('span', { class: 'grow' }),
        this.search,
        btn(t('Critical path'), t('Highlight the cells of the critical timing path'), () => { this.showCritical = !this.showCritical; this.draw(); }),
        btn(t('GDSII'), t('Download the layout as a GDSII stream'), () => void this.downloadGds()),
        btn('DEF', t('Open the DEF file'), () => this.open('.def')),
        btn(t('Report'), t('Open the report'), () => this.open('.rpt')),
        h('button', { class: 'tb-btn', title: t('Zoom to fit'), onclick: () => this.fit() }, icon('zoomfull')),
        h('button', { class: 'tb-btn', title: t('Zoom in'), onclick: () => this.zoomAt(1.5) }, icon('zoomin')),
        h('button', { class: 'tb-btn', title: t('Zoom out'), onclick: () => this.zoomAt(1 / 1.5) }, icon('zoomout'))),
      this.status,
      h('div', { class: 'synth-body' }, h('div', { class: 'chip-side scroll' }, this.layerBox, this.info), h('div', { class: 'chip-view' }, this.canvas)));
    this.canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.offsetX, e.offsetY); }, { passive: false });
    this.canvas.addEventListener('mousedown', e => { this.drag = { x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy, moved: false }; });
    window.addEventListener('mousemove', e => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
        this.ox = this.drag.ox + dx; this.oy = this.drag.oy + dy;
        this.draw();
      } else if (e.target === this.canvas) this.hover(e.offsetX, e.offsetY);
    });
    window.addEventListener('mouseup', e => {
      if (this.drag && !this.drag.moved && e.target === this.canvas) this.pick(e.offsetX, e.offsetY);
      this.drag = null;
    });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    session.on('synth', () => void this.load());
    this.renderLayers();
    void this.load();
  }

  private async run() {
    this.status.textContent = t('Running synthesis, placement and routing…');
    await this.session.exec(`asic -util ${Number(this.util.value) || 0.6} -layers ${this.layers.value}`);
  }

  private open(ext: string) { const a = this.session.lastAsic; if (a) this.onOpenFile?.(a.base + ext); }

  private async downloadGds() {
    const a = this.session.lastAsic;
    const g = a ? await this.session.asicGds() : null;
    if (!a || !g) { this.status.textContent = t('No layout yet: run the ASIC flow first.'); return; }
    download(`${a.top}.gds`, g);
  }

  /** Fetch the layout of a new asic run. */
  async load() {
    const a = this.session.lastAsic;
    if (!a) {
      this.status.textContent = t('Educational ASIC flow: synthesis to the WebSim cell library, placement, routing and GDSII, in the browser. Choose the utilization and routing layers, then press the button (or type "asic").');
      return;
    }
    this.status.textContent = a.summary.length ? a.summary.join('  ·  ') : t('{0}: the ASIC flow failed — see the transcript.', a.top);
    if (a.run === this.loadedRun) return;
    this.loadedRun = a.run;
    this.data = await this.session.asicLayout();
    this.net = null;
    this.renderLayers();
    this.fit();
  }

  private renderLayers() {
    const used = new Set<string>(['NWELL', 'DIFF', 'POLY', 'CONT', 'M1', 'BOUNDARY']);
    for (const s of this.data?.layout.shapes ?? []) used.add(s.r[0]);
    this.layerBox.replaceChildren(h('div', { class: 'chip-title' }, t('Layers')), ...LAYERS.filter(l => used.has(l.name)).map(l =>
      h('label', { class: 'chip-layer' },
        h('input', { type: 'checkbox', checked: !this.hidden.has(l.name), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) this.hidden.delete(l.name); else this.hidden.add(l.name); this.draw(); } }),
        h('span', { class: 'chip-swatch', style: { background: l.color } }), l.name)));
  }

  private fit() {
    const d = this.data;
    const r = this.canvas.getBoundingClientRect();
    if (!d || !r.width) { this.draw(); return; }
    const [W, H] = d.layout.die;
    this.scale = Math.min(r.width / W, r.height / H) * 0.94;
    this.ox = (r.width - W * this.scale) / 2;
    this.oy = r.height - (r.height - H * this.scale) / 2;
    this.draw();
  }

  private zoomAt(f: number, sx?: number, sy?: number) {
    const r = this.canvas.getBoundingClientRect();
    const x = sx ?? r.width / 2, y = sy ?? r.height / 2;
    this.ox = x - (x - this.ox) * f;
    this.oy = y - (y - this.oy) * f;
    this.scale *= f;
    this.draw();
  }

  /** Screen <-> layout (nm; y up). */
  private toNm(sx: number, sy: number): [number, number] { return [(sx - this.ox) / this.scale, (this.oy - sy) / this.scale]; }

  private shapeAt(sx: number, sy: number) {
    const d = this.data;
    if (!d) return null;
    const [x, y] = this.toNm(sx, sy);
    const slack = 3 / this.scale;
    let best: { net: string; layer: string } | null = null, rank = -1;
    for (const s of d.layout.shapes) {
      const [l, x0, y0, x1, y1] = s.r;
      if (this.hidden.has(l) || x < x0 - slack || x > x1 + slack || y < y0 - slack || y > y1 + slack) continue;
      const k = LAYERS.findIndex(v => v.name === l);
      if (k > rank) { rank = k; best = { net: s.net, layer: l }; }
    }
    return best;
  }

  private instAt(sx: number, sy: number) {
    const [x, y] = this.toNm(sx, sy);
    return this.data?.layout.instances.find(i => x >= i.x && x <= i.x + i.w && y >= i.y && y <= i.y + ROW_H) ?? null;
  }

  private hover(sx: number, sy: number) {
    const s = this.shapeAt(sx, sy), i = this.instAt(sx, sy);
    const [x, y] = this.toNm(sx, sy);
    this.canvas.title = [s ? `${t('Net')}: ${s.net} (${s.layer})` : '', i ? `${t('Cell')}: ${i.name} (${i.type})` : '', `(${(x / 1000).toFixed(2)}, ${(y / 1000).toFixed(2)}) µm`].filter(Boolean).join('\n');
  }

  private pick(sx: number, sy: number) {
    const s = this.shapeAt(sx, sy);
    this.net = s && s.net !== this.net ? s.net : null;
    this.search.value = this.net ?? '';
    this.describe();
    this.draw();
  }

  private findNet(name: string) {
    const d = this.data;
    if (!d || !name) { this.net = null; this.describe(); this.draw(); return; }
    const sh = d.layout.shapes.filter(s => s.net === name);
    if (!sh.length) { this.info.textContent = t('No net named {0}.', name); return; }
    this.net = name;
    const x0 = Math.min(...sh.map(s => s.r[1])), y0 = Math.min(...sh.map(s => s.r[2])), x1 = Math.max(...sh.map(s => s.r[3])), y1 = Math.max(...sh.map(s => s.r[4]));
    const r = this.canvas.getBoundingClientRect();
    this.scale = Math.min(r.width / Math.max(1, x1 - x0), r.height / Math.max(1, y1 - y0)) * 0.7;
    this.ox = r.width / 2 - ((x0 + x1) / 2) * this.scale;
    this.oy = r.height / 2 + ((y0 + y1) / 2) * this.scale;
    this.describe();
    this.draw();
  }

  private describe() {
    const d = this.data;
    if (!d || !this.net) { this.info.textContent = ''; return; }
    const sh = d.layout.shapes.filter(s => s.net === this.net);
    const len: Record<string, number> = {};
    for (const s of sh) if (/^M\d$/.test(s.r[0])) len[s.r[0]] = (len[s.r[0]] ?? 0) + Math.max(s.r[3] - s.r[1], s.r[4] - s.r[2]);
    const vias = sh.filter(s => /^VIA/.test(s.r[0])).length;
    this.info.replaceChildren(h('div', { class: 'chip-title' }, `${t('Net')} ${this.net}`),
      ...Object.entries(len).sort().map(([l, n]) => h('div', {}, `${l}: ${(n / 1000).toFixed(1)} µm`)), h('div', {}, `${t('Vias')}: ${vias}`));
  }

  draw() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.paint());
  }

  private paint() {
    const c = this.canvas, r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width || !r.height) return;
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0b0f14';
    g.fillRect(0, 0, r.width, r.height);
    const d = this.data;
    if (!d) return;
    const s = this.scale, ox = this.ox, oy = this.oy;
    const X = (x: number) => ox + x * s, Y = (y: number) => oy - y * s;
    const vx0 = -ox / s, vx1 = (r.width - ox) / s, vy0 = (oy - r.height) / s, vy1 = oy / s;
    const visible = (x0: number, y0: number, x1: number, y1: number) => x1 >= vx0 && x0 <= vx1 && y1 >= vy0 && y0 <= vy1;
    const dim = this.net !== null || this.showCritical;
    const rect = (q: Rect, color: string, alpha: number) => {
      g.globalAlpha = alpha;
      g.fillStyle = color;
      g.fillRect(X(q[1]), Y(q[4]), Math.max(0.5, (q[3] - q[1]) * s), Math.max(0.5, (q[4] - q[2]) * s));
    };
    const [W, H] = d.layout.die;
    g.strokeStyle = '#3a4656';
    g.lineWidth = 1;
    g.strokeRect(X(0), Y(H), W * s, H * s);
    const crit = new Set(this.showCritical ? d.critical : []);
    // cells: internals when zoomed in, otherwise outlined boxes
    const detail = s >= MIN_DETAIL;
    for (const i of d.layout.instances) {
      if (!visible(i.x, i.y, i.x + i.w, i.y + ROW_H)) continue;
      const fill = i.type.startsWith('FILL');
      if (detail) {
        for (const q of d.cells[i.type] ?? []) {
          const l = q[0];
          if (this.hidden.has(l) || l === 'BOUNDARY') continue;
          const tq: Rect = i.flip ? [l, i.x + q[1], i.y + ROW_H - q[4], i.x + q[3], i.y + ROW_H - q[2]] : [l, i.x + q[1], i.y + q[2], i.x + q[3], i.y + q[4]];
          rect(tq, LAYER.get(l)!.color, (dim && !crit.has(i.name) ? 0.15 : 1) * (LAYER.get(l)!.kind === 'base' ? 0.45 : 0.75));
        }
      } else if (!fill) {
        rect(['BOUNDARY', i.x, i.y, i.x + i.w, i.y + ROW_H], i.type.startsWith('DFF') ? '#5a4a8a' : '#2c4766', dim && !crit.has(i.name) ? 0.25 : 0.9);
      }
      if (crit.has(i.name)) {
        g.globalAlpha = 1;
        g.strokeStyle = '#ff5f5f';
        g.lineWidth = 2;
        g.strokeRect(X(i.x), Y(i.y + ROW_H), i.w * s, ROW_H * s);
      } else if (detail && !this.hidden.has('BOUNDARY')) {
        g.globalAlpha = 0.5;
        g.strokeStyle = '#7a7a7a';
        g.lineWidth = 0.5;
        g.strokeRect(X(i.x), Y(i.y + ROW_H), i.w * s, ROW_H * s);
      }
    }
    // cell types on the cells when there is room
    if (detail) {
      g.globalAlpha = 0.8;
      g.fillStyle = '#c8d3e2';
      g.font = '10px ui-monospace, monospace';
      for (const i of d.layout.instances) {
        if (i.type.startsWith('FILL') || i.w * s < 34 || !visible(i.x, i.y, i.x + i.w, i.y + ROW_H)) continue;
        g.fillText(i.type, X(i.x) + 3, Y(i.y + ROW_H / 2) + 4);
      }
    }
    // routing and power, lower layers first
    for (const ld of LAYERS) {
      if (this.hidden.has(ld.name)) continue;
      for (const sh of d.layout.shapes) {
        if (sh.r[0] !== ld.name || !visible(sh.r[1], sh.r[2], sh.r[3], sh.r[4])) continue;
        const on = sh.net === this.net;
        rect(sh.r, on ? '#ffffff' : ld.color, dim && !on ? 0.2 : ld.kind === 'cut' ? 0.9 : 0.7);
      }
    }
    // pin labels when zoomed in
    g.globalAlpha = 1;
    if (s > 0.02) {
      g.fillStyle = '#e6edf7';
      g.font = '11px ui-monospace, monospace';
      for (const lb of d.layout.labels) if (visible(lb.x, lb.y, lb.x, lb.y)) g.fillText(lb.text, X(lb.x) + 4, Y(lb.y) - 4);
    }
    g.globalAlpha = 1;
  }
}
