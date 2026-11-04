// Layout window of the educational ASIC flow (#51): runs "asic", draws the placed and routed design on a canvas
// (layers, cells, nets), highlights nets and the critical path, and downloads the GDSII stream.
import { h, icon, download } from './dom';
import { t } from './i18n';
import type { RemoteSession as Session } from './remote';
import { LAYERS, LAYER, type LayoutData, type Rect } from '../engine/asic/layout';
import { ROW_H } from '../engine/asic/cells';
import { crossSection, schematicX, schematicZ, BANDS, SCHEMATIC_TOP, STACK, STACK_BOTTOM, STACK_TOP, type XSection, type XSeg } from '../engine/asic/xsect';

const MIN_DETAIL = 0.035;   // px per nm from which cell internals are drawn

export class LayoutView {
  el: HTMLElement;
  onOpenFile?: (name: string) => void;
  private canvas: HTMLCanvasElement;
  private status: HTMLElement;
  private info: HTMLElement;
  private layerBox: HTMLElement;
  private util: HTMLInputElement;
  private sdc: HTMLInputElement;
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
  // cross-section (#75): the cut being drawn, the section shown and its panel
  private cutMode = false;
  private cut: { a: [number, number]; b: [number, number] } | null = null;
  private cutting = false;
  private xs: XSection | null = null;
  private xsScale: 'real' | 'schematic' = 'schematic';
  private xsZoom = 1; private xsPan = 0;
  private xsDrag: { x: number; pan: number } | null = null;
  private cutBtn!: HTMLButtonElement;
  private xsPanel!: HTMLElement;
  private xsCanvas!: HTMLCanvasElement;
  private xsTitle!: HTMLElement;

  constructor(private session: Session) {
    this.util = h('input', { class: 'tb-field', type: 'number', min: '0.1', max: '0.95', step: '0.05', value: '0.6', title: t('Target core utilization'), style: { width: '60px' } });
    this.layers = h('select', { class: 'tb-field', 'aria-label': t('Routing layers'), title: t('Routing layers') }, [2, 3, 4].map(n => h('option', { value: String(n), selected: n === 3 }, `M2–M${n + 1}`)));
    this.sdc = h('input', { class: 'tb-field', placeholder: t('SDC file'), 'aria-label': t('SDC file'), title: t('Timing constraints (SDC file in the project, optional)'), style: { width: '110px' } });
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
        this.sdc,
        h('button', { class: 'tb-btn', title: t('Synthesize, place and route (ASIC)'), 'aria-label': t('Synthesize, place and route (ASIC)'), onclick: () => void this.run() }, icon('compileall')),
        h('span', { class: 'grow' }),
        this.search,
        btn(t('Critical path'), t('Highlight the cells of the critical timing path'), () => { this.showCritical = !this.showCritical; this.draw(); }),
        this.cutBtn = btn(t('Cross-section'), t('Draw a line on the layout to see the cross-section along it (Shift: horizontal / vertical)'), () => this.setCutMode(!this.cutMode)) as HTMLButtonElement,
        btn(t('GDSII'), t('Download the layout as a GDSII stream'), () => void this.downloadGds()),
        btn('DEF', t('Open the DEF file'), () => this.open('.def')),
        btn(t('Report'), t('Open the report'), () => this.open('.rpt')),
        h('button', { class: 'tb-btn', title: t('Zoom to fit'), onclick: () => this.fit() }, icon('zoomfull')),
        h('button', { class: 'tb-btn', title: t('Zoom in'), onclick: () => this.zoomAt(1.5) }, icon('zoomin')),
        h('button', { class: 'tb-btn', title: t('Zoom out'), onclick: () => this.zoomAt(1 / 1.5) }, icon('zoomout'))),
      this.status,
      h('div', { class: 'synth-body' }, h('div', { class: 'chip-side scroll' }, this.layerBox, this.info), h('div', { class: 'chip-view' }, this.canvas, this.xsBuild())));
    this.canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.offsetX, e.offsetY); }, { passive: false });
    this.canvas.addEventListener('mousedown', e => {
      if (this.cutMode) { const p = this.toNm(e.offsetX, e.offsetY); this.cut = { a: p, b: p }; this.cutting = true; return; }
      this.drag = { x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy, moved: false };
    });
    window.addEventListener('mousemove', e => {
      if (this.cutting && this.cut) {
        const r = this.canvas.getBoundingClientRect();
        let b = this.toNm(e.clientX - r.left, e.clientY - r.top);
        // Shift: a horizontal or vertical cut
        if (e.shiftKey) b = Math.abs(b[0] - this.cut.a[0]) >= Math.abs(b[1] - this.cut.a[1]) ? [b[0], this.cut.a[1]] : [this.cut.a[0], b[1]];
        this.cut.b = b;
        this.draw();
      } else if (this.xsDrag) {
        this.xsPan = this.xsDrag.pan + (e.clientX - this.xsDrag.x);
        this.xsDraw();
      } else if (this.drag) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
        this.ox = this.drag.ox + dx; this.oy = this.drag.oy + dy;
        this.draw();
      } else if (e.target === this.canvas) this.hover(e.offsetX, e.offsetY);
    });
    window.addEventListener('mouseup', e => {
      if (this.cutting) { this.cutting = false; this.finishCut(); return; }
      this.xsDrag = null;
      if (this.drag && !this.drag.moved && e.target === this.canvas) this.pick(e.offsetX, e.offsetY);
      this.drag = null;
    });
    new ResizeObserver(() => { this.draw(); this.xsDraw(); }).observe(this.canvas);
    session.on('synth', () => void this.load());
    this.renderLayers();
    void this.load();
  }

  private async run() {
    this.status.textContent = t('Running synthesis, placement and routing…');
    const sdc = this.sdc.value.trim();
    await this.session.exec(`asic -util ${Number(this.util.value) || 0.6} -layers ${this.layers.value}${sdc ? ` -sdc ${sdc}` : ''}`);
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

  // ------------------------------------------------------------ cross-section (#75)

  private xsBuild(): HTMLElement {
    this.xsCanvas = h('canvas', { class: 'xs-canvas', 'aria-label': t('Cross-section') });
    this.xsTitle = h('span', { class: 'xs-title' });
    const scale = h('select', { class: 'tb-field', style: { width: 'auto' }, 'aria-label': t('Cross-section scale'), onchange: (e: Event) => { this.xsScale = (e.target as HTMLSelectElement).value as 'real' | 'schematic'; this.xsZoom = 1; this.xsPan = 0; this.xsDraw(); } },
      h('option', { value: 'schematic', selected: true }, t('Schematic (educational)')),
      h('option', { value: 'real' }, t('Real scale (1:1)')));
    this.xsPanel = h('div', { class: 'xs-panel', style: { display: 'none' } },
      h('div', { class: 'xs-bar' }, this.xsTitle, h('span', { class: 'grow' }), scale,
        h('button', { class: 'btn', onclick: () => { this.xs = null; this.cut = null; this.xsPanel.style.display = 'none'; this.draw(); } }, t('Close'))),
      h('div', { class: 'xs-view' }, this.xsCanvas));
    this.xsCanvas.addEventListener('wheel', e => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.25 : 0.8;
      this.xsPan = e.offsetX - (e.offsetX - this.xsPan) * f;
      this.xsZoom *= f;
      this.xsDraw();
    }, { passive: false });
    this.xsCanvas.addEventListener('mousedown', e => { this.xsDrag = { x: e.clientX, pan: this.xsPan }; });
    this.xsCanvas.addEventListener('mousemove', e => { if (!this.xsDrag) this.xsHover(e.offsetX, e.offsetY); });
    this.xsCanvas.addEventListener('click', e => { const g = this.xsSegAt(e.offsetX, e.offsetY); if (g?.net) { this.net = g.net; this.search.value = g.net; this.describe(); this.draw(); this.xsDraw(); } });
    return this.xsPanel;
  }

  private setCutMode(on: boolean) {
    this.cutMode = on;
    this.cutBtn.classList.toggle('on', on);
    this.canvas.style.cursor = on ? 'cell' : '';
    if (on) this.info.textContent = t('Draw the cut line on the layout: press, drag and release (Shift: horizontal / vertical).');
  }

  private finishCut() {
    const d = this.data, c = this.cut;
    if (!d || !c || Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]) * this.scale < 4) { this.cut = null; this.draw(); return; }
    this.xs = crossSection(d.layout, d.cells, c.a, c.b);
    this.xsZoom = 1; this.xsPan = 0;
    this.xsTitle.textContent = t('Cross-section A–B: {0} µm, {1} shapes', (this.xs.length / 1000).toFixed(2), this.xs.segs.length);
    this.xsPanel.style.display = '';
    this.draw();
    this.xsDraw();
  }

  /** Section coordinates -> panel pixels for the current scale: x(s) and z(layer edge) functions plus the drawing area. */
  private xsGeom() {
    const xs = this.xs!, r = this.xsCanvas.getBoundingClientRect();
    const ml = this.xsScale === 'schematic' ? 64 : 52, mr = 12, mt = 10, mb = 22;
    const w = Math.max(10, r.width - ml - mr), hgt = Math.max(10, r.height - mt - mb);
    if (this.xsScale === 'schematic') {
      const sx = schematicX(xs), total = sx(xs.length) || 1;
      const kx = (w / total) * this.xsZoom;
      return { r, ml, mt, hgt, X: (s: number) => ml + this.xsPan + sx(s) * kx, Z: (z: number) => mt + hgt - (z / SCHEMATIC_TOP) * hgt, zOf: (l: string) => schematicZ(l) };
    }
    // true scale: one factor for both axes, the whole cut fitted in the width (zoom with the wheel)
    const k0 = Math.min(w / Math.max(1, xs.length), hgt / (STACK_TOP - STACK_BOTTOM)), k = k0 * this.xsZoom;
    const centre = Math.max(0, (w - xs.length * k0) / 2);
    return { r, ml, mt, hgt, X: (s: number) => ml + centre + this.xsPan + s * k, Z: (z: number) => mt + hgt - (z - STACK_BOTTOM) * k, zOf: (l: string) => [STACK[l].z0, STACK[l].z1] as [number, number] };
  }

  private xsDraw() {
    const xs = this.xs, c = this.xsCanvas;
    if (!xs || this.xsPanel.style.display === 'none') return;
    const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width || !r.height) return;
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#10151c';
    g.fillRect(0, 0, r.width, r.height);
    const G = this.xsGeom(), x0 = G.X(0), x1 = G.X(xs.length);
    const real = this.xsScale === 'real';
    // dielectric above the silicon surface, silicon below
    const [sb, st] = real ? [STACK_BOTTOM, 0] : [0, 2];
    const top = real ? STACK_TOP : SCHEMATIC_TOP;
    g.fillStyle = '#1d2a38'; g.fillRect(x0, G.Z(top), x1 - x0, G.Z(st) - G.Z(top));
    g.fillStyle = '#3a3226'; g.fillRect(x0, G.Z(st), x1 - x0, G.Z(sb) - G.Z(st));
    for (const seg of xs.segs) {
      const [z0, z1] = G.zOf(seg.layer), ld = LAYER.get(seg.layer)!;
      const on = !!this.net && seg.net === this.net;
      g.globalAlpha = seg.layer === 'NWELL' ? 0.45 : 0.92;
      g.fillStyle = on ? '#ffffff' : ld.color;
      const px0 = G.X(seg.s0), px1 = G.X(seg.s1);
      g.fillRect(px0, G.Z(z1), Math.max(1, px1 - px0), Math.max(1, G.Z(z0) - G.Z(z1)));
    }
    g.globalAlpha = 1;
    g.fillStyle = '#c8d3e2';
    g.font = '10px ui-monospace, monospace';
    if (real) {
      // axes in µm: height on the left, distance along the cut at the bottom
      for (let z = -1000; z <= STACK_TOP; z += 1000) { g.fillText(`${z / 1000}`, 4, G.Z(z) + 3); g.fillRect(G.ml - 6, G.Z(z), 4, 1); }
      // ticks at least 48 px apart
      const span = xs.length / 1000, pxPerUm = G.X(1000) - G.X(0);
      const step = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].find(v => v * pxPerUm >= 48) ?? 200;
      for (let s = 0; s <= span + 1e-9; s += step) { const x = G.X(s * 1000); if (x > G.ml - 1 && x < G.r.width) g.fillText(`${+s.toFixed(2)}`, x - 6, G.r.height - 6); }
      g.fillText('µm', 4, G.r.height - 6);
    } else {
      // band names on the left
      for (const b of BANDS) { const [z0, z1] = schematicZ(b === 'SUB' ? 'NWELL' : b); g.fillText(b === 'SUB' ? 'Si' : b, 4, (G.Z(z0) + G.Z(z1)) / 2 + 3); }
    }
    g.fillText('A', x0 - 10, G.mt + 10);
    g.fillText('B', x1 + 3, G.mt + 10);
  }

  private xsSegAt(px: number, py: number): XSeg | null {
    if (!this.xs) return null;
    const G = this.xsGeom();
    let best: XSeg | null = null;
    for (const seg of this.xs.segs) {
      const [z0, z1] = G.zOf(seg.layer);
      if (px >= G.X(seg.s0) - 1 && px <= G.X(seg.s1) + 1 && py >= G.Z(z1) && py <= G.Z(z0)) best = seg;
    }
    return best;
  }

  private xsHover(px: number, py: number) {
    const g = this.xsSegAt(px, py);
    this.xsCanvas.title = g ? [
      `${g.layer}: ${STACK[g.layer].material}`,
      g.net ? `${t('Net')}: ${g.net}` : g.inst ? `${t('Cell')}: ${g.inst} (${g.type})` : '',
      `${t('Width along the cut')}: ${((g.s1 - g.s0) / 1000).toFixed(3)} µm`,
      `${t('Height')}: ${STACK[g.layer].z0} … ${STACK[g.layer].z1} nm`,
    ].filter(Boolean).join('\n') : '';
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
    if (this.cut) {
      const { a, b } = this.cut;
      g.strokeStyle = '#ffd34d';
      g.lineWidth = 2;
      g.setLineDash([6, 4]);
      g.beginPath(); g.moveTo(X(a[0]), Y(a[1])); g.lineTo(X(b[0]), Y(b[1])); g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#ffd34d';
      g.font = 'bold 12px ui-monospace, monospace';
      g.fillText('A', X(a[0]) - 12, Y(a[1]) - 6);
      g.fillText('B', X(b[0]) + 6, Y(b[1]) - 6);
    }
  }
}
