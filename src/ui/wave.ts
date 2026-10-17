// Waveform viewer: signal names, values at cursor, and a canvas-rendered timeline.
import { h, icon, contextMenu, clear, promptText, type CtxItem } from './dom';
import { fmtSig, type RemoteSession as Session, type MWave as WaveEntry } from './remote';
import { vecToReal } from '../engine/elab';
import type { Vec } from '../engine/logic';
import * as L from '../engine/logic';
import type { Radix } from '../engine/logic';
import { fmtTime } from '../engine/format';
import { parseValue } from '../engine/commands';
import { t } from './i18n';

const ROW_H = 22;
const HEAD_H = 26;
const ANALOG_H = 64;
/** Signal colours offered in the context menu (ModelSim-like names). */
const PALETTE: [string, string][] = [['Default', ''], ['Green', '#3fe06a'], ['Yellow', '#ffd23f'], ['Orange', '#ff9f43'], ['Red', '#ff5c5c'], ['Magenta', '#ff6bd6'], ['Cyan', '#3fd8ff'], ['Blue', '#6b8cff'], ['White', '#f0f0f0']];
const COLOR_NAMES: Record<string, string> = Object.fromEntries(PALETTE.filter(p => p[1]).map(([n, c]) => [n.toLowerCase(), c]));
/** CSS colour for a wave entry's -color value (a palette name, or any CSS colour). */
function waveColor(c?: string) { return c ? COLOR_NAMES[c.toLowerCase()] ?? c : undefined; }
const isAnalog = (w: WaveEntry) => w.format === 'analog-step' || w.format === 'analog-interp';
const isMarkerRow = (w: WaveEntry) => w.dividerLabel !== undefined || w.groupLabel !== undefined;
export const DND_TYPE = 'application/x-websim-paths';

function cssVar(el: HTMLElement, name: string) { return getComputedStyle(el).getPropertyValue(name).trim(); }

export class WaveView {
  el: HTMLElement;
  private body: HTMLElement;
  private names: HTMLElement;
  private values: HTMLElement;
  private canvasCol: HTMLElement;
  private track: HTMLElement;
  private ruler: HTMLCanvasElement;
  private canvas: HTMLCanvasElement;
  private foot: HTMLElement;
  private footText: HTMLElement;
  private scrollbar: HTMLInputElement;
  private findInput: HTMLInputElement;
  private emptyMsg: HTMLElement;
  t0 = 0;
  scale = 100; // ps per pixel
  autoFull = true;
  cursor: number | null = null;
  cursor2: number | null = null;
  selected = new Set<number>();
  private lastSel: number | null = null;
  private raf = 0;
  private drag: { x0: number; x1: number; active: boolean } | null = null;
  private colors: Record<string, string> = {};
  private dragRow: number | null = null;
  /** Display rows: a wave entry, or one bit of an expanded bus; y/h in pixels. */
  private rows: { w: WaveEntry; bit?: number; y: number; h: number; depth: number }[] = [];
  private totalH = 0;
  private ranges = new Map<number, { n: number; min: number; max: number }>();
  private expanded = new Set<number>();

  constructor(private session: Session) {
    this.names = h('div', { class: 'wave-col wave-names' });
    this.values = h('div', { class: 'wave-col wave-values' });
    this.ruler = h('canvas', { class: 'wave-ruler' });
    this.canvas = h('canvas', {});
    this.canvas.style.position = 'absolute';
    this.canvas.style.left = '0';
    this.track = h('div', { style: { position: 'relative' } }, this.canvas);
    this.canvasCol = h('div', { class: 'wave-col wave-canvas-col' }, this.ruler, this.track);
    this.emptyMsg = h('div', { class: 'wave-empty' });
    const split1 = h('div', { class: 'wave-split', title: t('Drag to resize') });
    const split2 = h('div', { class: 'wave-split', title: t('Drag to resize') });
    this.body = h('div', { class: 'wave-body' }, this.names, split1, this.values, split2, this.canvasCol, this.emptyMsg);
    this.footText = h('span', {});
    this.scrollbar = h('input', { type: 'range', min: '0', max: '1000', value: '0', step: '1', 'aria-label': t('Scroll time') });
    this.foot = h('div', { class: 'wave-foot' }, this.footText, this.scrollbar);

    this.findInput = h('input', {
      type: 'search', class: 'tb-field wave-find', placeholder: t('Find value'), title: t('Value of the selected signal to search for (in its radix, or decimal / 16#hex / 4\'b1010). Enter = next, Shift+Enter = previous'),
      'aria-label': t('Find value in selected signal'),
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); this.findValue(e.shiftKey ? -1 : 1); } },
    });
    const bar = h('div', { class: 'subbar' },
      this.tb('zoomin', t('Zoom in (I)'), () => this.zoom(0.5)),
      this.tb('zoomout', t('Zoom out (O)'), () => this.zoom(2)),
      this.tb('zoomfull', t('Zoom full (F)'), () => this.zoomFull()),
      this.tb('zoomcursor', t('Center on cursor (C)'), () => this.centerCursor()),
      h('span', { class: 'tb-sep' }),
      this.tb('prevedge', t('Previous transition of selected signal (Shift+Tab)'), () => this.jumpEdge(-1)),
      this.tb('nextedge', t('Next transition of selected signal (Tab)'), () => this.jumpEdge(1)),
      h('span', { class: 'tb-sep' }),
      this.tb('trash', t('Delete selected signals (Del)'), () => this.deleteSelected()),
      h('span', { class: 'tb-sep' }),
      this.findInput,
      this.tb('prevedge', t('Find previous'), () => this.findValue(-1)),
      this.tb('nextedge', t('Find next'), () => this.findValue(1)),
      h('span', { class: 'grow' }),
      h('span', { class: 'hint' }, t('Click: cursor · Ctrl+click: 2nd cursor · Drag: zoom area · Ctrl+wheel: zoom · Right-click names: radix · format · colour · group')),
    );
    this.el = h('div', { class: 'wave', tabindex: '0' }, bar, this.body, this.foot);

    this.colsResizer(split1, '--wn-w', 80, 600);
    this.colsResizer(split2, '--wv-w', 40, 400);
    this.bindCanvas();
    this.bindNames();
    this.bindKeys();
    this.bindDrop();
    this.body.addEventListener('scroll', () => { this.paintRows(); this.render(); });
    this.scrollbar.addEventListener('input', () => { this.autoFull = false; this.t0 = Number(this.scrollbar.value); this.render(); });
    new ResizeObserver(() => { if (this.autoFull) this.zoomFull(false); this.render(); }).observe(this.body);
    session.on('wave', () => { this.selected = new Set([...this.selected].filter(id => session.waves.some(w => w.id === id))); this.rebuildRows(); });
    session.on('time', () => { if (this.autoFull) this.zoomFull(false); this.render(); });
    session.on('zoomfull', () => this.zoomFull());
    session.on('sim', () => { if (!session.design) { this.cursor = null; this.cursor2 = null; } this.autoFull = true; this.rebuildRows(); });
    this.rebuildRows();
  }

  private tb(ic: string, title: string, f: () => void) {
    return h('button', { class: 'tb-btn', title, 'aria-label': title, onclick: f }, icon(ic));
  }

  private colsResizer(el: HTMLElement, v: string, min: number, max: number) {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const prev = el.previousElementSibling as HTMLElement;
      const start = e.clientX, w0 = prev.getBoundingClientRect().width;
      const mv = (ev: MouseEvent) => { this.body.style.setProperty(v, Math.max(min, Math.min(max, w0 + ev.clientX - start)) + 'px'); this.render(); };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }

  get endTime() { return this.session.design ? Math.max(this.session.now, 1) : 1e9; }
  get width() { return Math.max(10, this.canvasCol.clientWidth); }
  private x(t: number) { return (t - this.t0) / this.scale; }
  private t(x: number) { return this.t0 + x * this.scale; }

  zoomFull(user = true) {
    if (user) this.autoFull = true;
    this.t0 = 0;
    this.scale = Math.max(1e-3, this.endTime / Math.max(10, this.width - 8));
    this.render();
  }

  zoom(f: number, aroundX?: number) {
    this.autoFull = false;
    const ax = aroundX ?? (this.cursor !== null && this.x(this.cursor) >= 0 && this.x(this.cursor) <= this.width ? this.x(this.cursor) : this.width / 2);
    const tc = this.t(ax);
    this.scale = Math.min(Math.max(this.scale * f, 1e-3), 1e12);
    this.t0 = Math.max(0, tc - ax * this.scale);
    this.render();
  }

  zoomRange(ta: number, tb: number) {
    if (tb - ta <= 0) return;
    this.autoFull = false;
    this.t0 = Math.max(0, ta);
    this.scale = Math.max(1e-3, (tb - ta) / this.width);
    this.render();
  }

  centerCursor() {
    if (this.cursor === null) return;
    this.autoFull = false;
    this.t0 = Math.max(0, this.cursor - (this.width / 2) * this.scale);
    this.render();
  }

  private selectedEntry(): WaveEntry | undefined {
    const id = this.lastSel ?? [...this.selected][0];
    return this.session.waves.find(w => w.id === id && !isMarkerRow(w));
  }

  jumpEdge(dir: 1 | -1) {
    const e = this.selectedEntry() ?? this.session.waves.find(w => !w.dividerLabel);
    if (!e) return;
    const ts = e.sig.times;
    const c = this.cursor ?? (dir > 0 ? -1 : this.endTime + 1);
    let target: number | undefined;
    if (dir > 0) target = ts.find(t => t > c);
    else for (let i = ts.length - 1; i >= 0; i--) if (ts[i] < c) { target = ts[i]; break; }
    if (target === undefined) return;
    this.cursor = target;
    const x = this.x(target);
    if (x < 0 || x > this.width) this.centerCursor();
    this.render();
  }

  /** Move the cursor to the next/previous time the selected signal takes the searched value. */
  findValue(dir: 1 | -1) {
    const q = this.findInput.value.trim();
    const e = this.selectedEntry();
    if (!q || !e) { this.flashFind(!e ? t('Select a signal first') : t('Type a value')); return; }
    const sig = e.sig;
    let target: L.Vec | null = null;
    try { target = parseValue(q, sig.w); } catch { /* compare text only */ }
    const names = sig.enumNames;
    const ql = q.toLowerCase();
    const strip = (s: string) => s.replace(/^0+(?=.)/, '');
    const match = (v: L.Vec) => {
      if (names && v.known && names[Number(v.a)]?.toLowerCase() === ql) return true;
      const txt = L.format(v, e.radix === 'symbolic' && !names ? 'hex' : e.radix).toLowerCase();
      if (txt === ql || strip(txt) === strip(ql)) return true;
      return !!target && v.a === target.a && v.b === target.b;
    };
    const ts = sig.times, vs = sig.vals;
    const c = this.cursor ?? (dir > 0 ? -1 : Infinity);
    let hit: number | undefined;
    if (dir > 0) { for (let i = 0; i < ts.length; i++) if (ts[i] > c && match(vs[i])) { hit = ts[i]; break; } }
    else for (let i = ts.length - 1; i >= 0; i--) if (ts[i] < c && match(vs[i])) { hit = ts[i]; break; }
    if (hit === undefined) { this.flashFind(t('Not found')); return; }
    this.cursor = hit;
    const x = this.x(hit);
    if (x < 0 || x > this.width) this.centerCursor();
    this.render();
  }

  private flashFind(msg: string) {
    const el = this.findInput;
    el.classList.add('notfound'); el.title = msg;
    setTimeout(() => el.classList.remove('notfound'), 900);
  }

  deleteSelected() {
    if (!this.selected.size) return;
    // deleting a group header deletes its members
    this.session.waves = this.session.waves.filter(w => !this.selected.has(w.id) && !(w.parent !== undefined && this.selected.has(w.parent)));
    this.selected.clear();
    this.session.emit('wave');
  }

  setRadix(r: Radix) {
    for (const w of this.session.waves) if (this.selected.has(w.id)) w.radix = r;
    this.session.emit('wave');
  }

  // -------------------------------------------------------------- DOM rows
  isExpanded(id: number) { return this.expanded.has(id); }
  toggleExpand(id: number, on?: boolean) {
    if (on ?? !this.expanded.has(id)) this.expanded.add(id); else this.expanded.delete(id);
    this.rebuildRows();
  }

  rebuildRows() {
    const waves = this.session.waves;
    this.rows = [];
    let y = 0;
    const collapsed = new Set(waves.filter(w => w.groupLabel !== undefined && w.collapsed).map(w => w.id));
    const add = (w: WaveEntry, hh: number, depth: number, bit?: number) => { this.rows.push({ w, bit, y, h: hh, depth }); y += hh; };
    for (const w of waves) {
      if (w.parent !== undefined && collapsed.has(w.parent)) continue;
      const depth = w.parent !== undefined && waves.some(g => g.id === w.parent) ? 1 : 0;
      add(w, isMarkerRow(w) ? ROW_H : w.height ?? (isAnalog(w) ? ANALOG_H : ROW_H), depth);
      if (!isMarkerRow(w) && !isAnalog(w) && w.sig.w > 1 && this.expanded.has(w.id)) {
        const step = w.sig.msb >= w.sig.lsb ? -1 : 1;
        for (let i = w.sig.msb, n = 0; n < w.sig.w; i += step, n++) add(w, ROW_H, depth + 1, i);
      }
    }
    this.totalH = y;
    if (!this.session.design) this.emptyMsg.textContent = t('No simulation loaded. Compile your sources, then Simulate ▸ Start Simulation (or type "vsim <top>").');
    else if (!waves.length) this.emptyMsg.textContent = t('Wave window is empty. Drag signals here from Objects, double-click them, or type "add wave -r /*".');
    else this.emptyMsg.textContent = '';
    this.paintFirst = -1;
    this.paintRows();
    this.render();
  }

  private paintFirst = -1;
  private paintLast = -1;
  private valueEls: HTMLElement[] = [];

  /** Index of the row containing pixel offset y (0 = top of the first row). */
  private rowIndexAt(y: number): number {
    const rs = this.rows;
    let lo = 0, hi = rs.length - 1;
    if (hi < 0) return -1;
    if (y >= this.totalH) return rs.length;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (rs[m].y <= y) lo = m; else hi = m - 1; }
    return lo;
  }

  /** Build DOM only for the name/value rows in view (plus a margin); spacers keep the scroll height. */
  private paintRows() {
    const total = this.rows.length;
    const top = Math.max(0, this.body.scrollTop - HEAD_H);
    const first = Math.max(0, this.rowIndexAt(top) - 10);
    const last = Math.min(total, Math.max(0, this.rowIndexAt(top + Math.max(this.body.clientHeight, 200))) + 10);
    if (first === this.paintFirst && last === this.paintLast) return;
    this.paintFirst = first; this.paintLast = last;
    const nameRows: HTMLElement[] = [h('div', { class: 'wave-head' }, t('Name'))];
    const valueRows: HTMLElement[] = [h('div', { class: 'wave-head' }, t('Value'))];
    const pad = (px: number) => h('div', { style: { height: px + 'px' } });
    if (first > 0) { const px = this.rows[first].y; nameRows.push(pad(px)); valueRows.push(pad(px)); }
    this.valueEls = [];
    for (let i = first; i < last; i++) {
      const { w, bit, h: rh, depth } = this.rows[i];
      const sel = this.selected.has(w.id) ? ' sel' : '';
      const sz = { height: rh + 'px', lineHeight: rh + 'px' };
      const col = waveColor(w.color);
      const v = h('div', { class: 'wave-row' + sel, 'data-id': w.id, style: { ...sz, ...(col ? { color: col } : {}) } });
      this.valueEls.push(v);
      valueRows.push(v);
      if (w.dividerLabel !== undefined) { nameRows.push(h('div', { class: 'wave-row divider' + sel, 'data-id': w.id, draggable: 'true' }, w.dividerLabel)); continue; }
      if (w.groupLabel !== undefined) {
        const n = this.session.waves.filter(x => x.parent === w.id).length;
        const tog = h('span', { class: 'wave-exp', title: w.collapsed ? t('Expand group') : t('Collapse group'), onclick: (e: MouseEvent) => { e.stopPropagation(); this.toggleGroup(w); } }, w.collapsed ? '▸' : '▾');
        nameRows.push(h('div', { class: 'wave-row group' + sel, 'data-id': w.id, draggable: 'true', ondblclick: () => this.toggleGroup(w) }, tog, `${w.groupLabel} (${n})`));
        continue;
      }
      const short = w.path.split('/').filter(Boolean);
      const label = short.length > 2 ? '/' + short.slice(-2).join('/') : w.path;
      const indent = { paddingLeft: 4 + depth * 14 + 'px' };
      if (bit !== undefined) { nameRows.push(h('div', { class: 'wave-row bitrow' + sel, 'data-id': w.id, style: indent }, `${label}[${bit}]`)); continue; }
      const isBus = w.sig.w > 1 && !isAnalog(w);
      const open = isBus && this.expanded.has(w.id);
      const tog = isBus ? h('span', { class: 'wave-exp', title: open ? t('Collapse') : t('Expand bits'), onclick: (e: MouseEvent) => { e.stopPropagation(); this.toggleExpand(w.id); } }, open ? '▾' : '▸') : h('span', { class: 'wave-exp' });
      const fmt = isAnalog(w) ? `, ${w.format}` : '';
      nameRows.push(h('div', { class: 'wave-row' + sel, 'data-id': w.id, title: `${w.path}  [${w.sig.w > 1 || w.sig.msb !== 0 ? `${w.sig.msb}:${w.sig.lsb}` : '1 bit'}, ${w.radix}${fmt}]`, draggable: 'true', style: { ...sz, ...indent, ...(col ? { color: col } : {}) } }, tog, label));
    }
    if (last < total) { const px = this.totalH - this.rows[last].y; nameRows.push(pad(px)); valueRows.push(pad(px)); }
    this.names.replaceChildren(...nameRows);
    this.values.replaceChildren(...valueRows);
  }

  toggleGroup(w: WaveEntry) {
    w.collapsed = !w.collapsed;
    this.session.emit('wave');
  }

  // -------------------------------------------------------------- canvas
  render() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  private readColors() {
    const e = this.el;
    for (const k of ['--w-bg', '--w-grid', '--w-sig', '--w-bus', '--w-x', '--w-z', '--w-text', '--w-cursor', '--w-cursor2', '--w-sel', '--w-ruler', '--w-ruler-text']) this.colors[k] = cssVar(e, k);
  }

  private draw() {
    this.readColors();
    const C = this.colors;
    const dpr = window.devicePixelRatio || 1;
    const W = this.width;
    const rows = this.rows;
    const totalH = this.totalH;
    const viewH = Math.max(0, this.body.clientHeight - HEAD_H);
    const scrollTop = this.body.scrollTop;
    this.track.style.height = totalH + 'px';
    const H = Math.max(1, Math.min(viewH, totalH));
    this.canvas.style.top = Math.min(scrollTop, Math.max(0, totalH - H)) + 'px';
    const offY = Math.min(scrollTop, Math.max(0, totalH - H));
    for (const [cv, w, hh] of [[this.canvas, W, H], [this.ruler, W, HEAD_H]] as const) {
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
      cv.style.width = w + 'px'; cv.style.height = hh + 'px';
    }
    this.drawRuler(dpr, W);
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C['--w-bg'];
    ctx.fillRect(0, 0, W, H);
    // grid lines at ruler ticks
    const step = this.tickStep();
    ctx.strokeStyle = C['--w-grid'];
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = Math.ceil(this.t0 / step) * step; this.x(t) < W; t += step) { const x = Math.round(this.x(t)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    ctx.stroke();
    // end-of-simulation shading
    const xe = this.x(this.session.now);
    if (xe < W) { ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(Math.max(0, xe), 0, W, H); }
    ctx.font = '11px ' + cssVar(this.el, '--mono');
    ctx.textBaseline = 'middle';
    const first = Math.max(0, this.rowIndexAt(offY)), last = Math.min(rows.length - 1, this.rowIndexAt(offY + H));
    for (let i = first; i <= last; i++) {
      const { w, bit, h: rh } = rows[i];
      const y = rows[i].y - offY;
      if (this.selected.has(w.id)) { ctx.fillStyle = C['--w-sel']; ctx.fillRect(0, y, W, rh); }
      if (w.dividerLabel !== undefined) { ctx.fillStyle = '#2a3a52'; ctx.fillRect(0, y + ROW_H / 2, W, 1); continue; }
      if (w.groupLabel !== undefined) { ctx.fillStyle = 'rgba(90,140,220,0.10)'; ctx.fillRect(0, y, W, rh); continue; }
      if (isAnalog(w) && bit === undefined) this.drawAnalog(ctx, w, y, rh, W);
      else this.drawSignal(ctx, w, y, W, bit, rh);
    }
    // zoom drag rectangle
    if (this.drag?.active) {
      const a = Math.min(this.drag.x0, this.drag.x1), b = Math.max(this.drag.x0, this.drag.x1);
      ctx.fillStyle = 'rgba(80,150,255,0.18)'; ctx.fillRect(a, 0, b - a, H);
      ctx.strokeStyle = '#5a9cff'; ctx.strokeRect(a + 0.5, 0.5, b - a, H - 1);
    }
    // cursors
    for (const [c, col] of [[this.cursor, C['--w-cursor']], [this.cursor2, C['--w-cursor2']]] as const) {
      if (c === null) continue;
      const x = Math.round(this.x(c)) + 0.5;
      if (x < 0 || x > W) continue;
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    this.updateValues();
    this.updateFoot();
  }

  private tickStep(): number {
    const raw = 110 * this.scale;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
    for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
    return 10 * mag;
  }

  private fmtTick(t: number, step: number): string {
    const units: [number, string][] = [[1e15, 's'], [1e12, 'ms'], [1e9, 'us'], [1e6, 'ns'], [1e3, 'ps'], [1, 'fs']];
    let u = units[units.length - 1];
    for (const x of units) if (step >= x[0] || x[0] === 1) { u = x; break; }
    const v = t / u[0];
    return `${Math.round(v * 1000) / 1000} ${u[1]}`;
  }

  private drawRuler(dpr: number, W: number) {
    const C = this.colors;
    const ctx = this.ruler.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C['--w-ruler'];
    ctx.fillRect(0, 0, W, HEAD_H);
    ctx.strokeStyle = '#2a3340';
    ctx.beginPath(); ctx.moveTo(0, HEAD_H - 0.5); ctx.lineTo(W, HEAD_H - 0.5); ctx.stroke();
    const step = this.tickStep();
    ctx.fillStyle = C['--w-ruler-text'];
    ctx.strokeStyle = C['--w-ruler-text'];
    ctx.font = '10px ' + cssVar(this.el, '--ui');
    ctx.textBaseline = 'top';
    ctx.beginPath();
    const minor = step / 5;
    for (let t = Math.ceil(this.t0 / minor) * minor; this.x(t) < W; t += minor) {
      const x = Math.round(this.x(t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.moveTo(x, HEAD_H - (major ? 9 : 4)); ctx.lineTo(x, HEAD_H);
      if (major) ctx.fillText(this.fmtTick(t, step), x + 3, 3);
    }
    ctx.stroke();
    for (const [c, col] of [[this.cursor, C['--w-cursor']], [this.cursor2, C['--w-cursor2']]] as const) {
      if (c === null) continue;
      const x = this.x(c);
      if (x < -60 || x > W + 60) continue;
      const label = fmtTime(c, this.session.resolution);
      const tw = ctx.measureText(label).width + 8;
      const bx = Math.min(Math.max(0, x - tw / 2), W - tw);
      ctx.fillStyle = col; ctx.fillRect(bx, 13, tw, 12);
      ctx.fillStyle = '#000'; ctx.fillText(label, bx + 4, 14);
    }
  }

  private bitOffset(w: WaveEntry, bit: number) {
    const s = w.sig;
    return s.msb >= s.lsb ? bit - s.lsb : s.lsb - bit;
  }

  /** Numeric value of a sample for analog display (NaN when unknown). */
  private numeric(w: WaveEntry, v: Vec): number {
    if (w.sig.isReal) return vecToReal(v);
    if (!v.known) return NaN;
    return Number(w.radix === 'decimal' || w.sig.signed ? v.withSign(true).toBigInt() : v.a);
  }

  /** Value range of the analog plot: -min/-max, else the extremes of the recorded history. */
  private analogRange(w: WaveEntry): [number, number] {
    let r = this.ranges.get(w.id);
    const vals = w.sig.vals;
    if (!r || r.n !== vals.length) {
      let min = Infinity, max = -Infinity;
      for (const v of vals) { const x = this.numeric(w, v); if (Number.isFinite(x)) { if (x < min) min = x; if (x > max) max = x; } }
      if (min === Infinity) { min = 0; max = 1; }
      r = { n: vals.length, min, max };
      this.ranges.set(w.id, r);
    }
    let lo = w.min ?? r.min, hi = w.max ?? r.max;
    if (hi <= lo) hi = lo + 1;
    return [lo, hi];
  }

  private drawAnalog(ctx: CanvasRenderingContext2D, w: WaveEntry, y: number, rh: number, W: number) {
    const C = this.colors;
    const sig = w.sig, ts = sig.times;
    if (!ts.length) return;
    const tStart = this.t0, tEnd = Math.min(this.t(W), this.session.now);
    if (tEnd < tStart) return;
    const [lo, hi] = this.analogRange(w);
    const top = y + 4, bot = y + rh - 4;
    const Y = (x: number) => bot - ((Math.max(lo, Math.min(hi, x)) - lo) / (hi - lo)) * (bot - top);
    // scale labels
    ctx.fillStyle = C['--w-ruler-text'];
    ctx.font = '9px ' + cssVar(this.el, '--mono');
    ctx.textBaseline = 'top'; ctx.fillText(String(+hi.toPrecision(6)), 2, top - 2);
    ctx.textBaseline = 'bottom'; ctx.fillText(String(+lo.toPrecision(6)), 2, bot + 2);
    ctx.textBaseline = 'middle';
    ctx.font = '11px ' + cssVar(this.el, '--mono');
    let i = 0, j = ts.length - 1;
    while (i < j) { const m = (i + j + 1) >> 1; if (ts[m] <= tStart) i = m; else j = m - 1; }
    const interp = w.format === 'analog-interp';
    ctx.strokeStyle = waveColor(w.color) ?? C['--w-sig'];
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let pen = false;
    for (; i < ts.length; i++) {
      const ta = Math.max(ts[i], tStart);
      if (ta > tEnd) break;
      const next = i + 1 < ts.length ? ts[i + 1] : Infinity;
      const xa = this.x(ta), xb = this.x(Math.min(next, tEnd));
      const v = this.numeric(w, sig.vals[i]);
      if (!Number.isFinite(v)) {
        if (pen) ctx.stroke();
        pen = false;
        ctx.fillStyle = 'rgba(255,59,59,0.22)';
        ctx.fillRect(xa, top, Math.max(1, xb - xa), bot - top);
        ctx.beginPath();
        continue;
      }
      const ya = Y(v);
      // step: vertical edge then hold until the next change; interpolated: straight line between samples
      if (!pen) { ctx.moveTo(xa, ya); pen = true; } else ctx.lineTo(xa, ya);
      if (!interp || next > tEnd) ctx.lineTo(xb, ya);
    }
    if (pen) ctx.stroke();
  }

  private drawSignal(ctx: CanvasRenderingContext2D, w: WaveEntry, y: number, W: number, bit?: number, rh = ROW_H) {
    const C = this.colors;
    const custom = waveColor(w.color);
    const sig = w.sig;
    const ts = sig.times;
    const boff = bit === undefined ? -1 : this.bitOffset(w, bit);
    const val = boff < 0 ? (i: number) => sig.vals[i] : (i: number) => L.slice(sig.vals[i], boff, 1);
    const now = this.session.now;
    if (!ts.length) return;
    const tStart = this.t0, tEnd = Math.min(this.t(W), now);
    if (ts[0] > 0 && ts[0] > tStart) {
      // history before the first recorded sample was trimmed (or never logged)
      ctx.fillStyle = 'rgba(140,150,165,0.18)';
      ctx.fillRect(Math.max(0, this.x(tStart)), y + 4, Math.min(W, this.x(ts[0])) - Math.max(0, this.x(tStart)), ROW_H - 9);
    }
    if (tEnd < tStart) return;
    // last change <= tStart
    let lo = 0, hi = ts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ts[m] <= tStart) lo = m; else hi = m - 1; }
    const yHi = y + 4, yLo = y + rh - 5, yMid = y + rh / 2;
    const scalar = boff >= 0 || (sig.w === 1 && !sig.enumNames && w.radix !== 'ascii');
    const xEnd = this.x(tEnd);
    let dense: [number, number, boolean] | null = null;
    const flushDense = () => {
      if (!dense) return;
      ctx.fillStyle = dense[2] ? C['--w-x'] : custom ?? C['--w-sig'];
      ctx.fillRect(dense[0], yHi, Math.max(1, dense[1] - dense[0]), yLo - yHi);
      dense = null;
    };
    for (let i = lo; i < ts.length; i++) {
      const ta = Math.max(ts[i], tStart);
      if (ta > tEnd) break;
      const tb = i + 1 < ts.length ? Math.min(ts[i + 1], tEnd) : tEnd;
      const xa = this.x(ta), xb = i + 1 < ts.length && ts[i + 1] <= tEnd ? this.x(tb) : xEnd;
      const v = val(i);
      if (xb - xa < 1.5 && i + 1 < ts.length && ts[i + 1] <= tEnd) {
        if (!dense) dense = [xa, xb, !v.known]; else { dense[1] = xb; dense[2] = dense[2] || !v.known; }
        continue;
      }
      flushDense();
      if (scalar) {
        const b = v.bit(0);
        const lvl = (c: string) => (c === '1' ? yHi : c === '0' ? yLo : yMid);
        const weak = b !== 'x' && b !== 'z' && (v.k & 1n) !== 0n;
        const col = b === 'x' ? C['--w-x'] : b === 'z' ? C['--w-z'] : weak ? '#1f8f50' : custom ?? C['--w-sig'];
        ctx.lineWidth = 1;
        const xr = Math.round(xa) + 0.5;
        if (ts[i] >= tStart && i > 0) {
          const pb = val(i - 1).bit(0);
          ctx.strokeStyle = b === 'x' || pb === 'x' ? C['--w-x'] : custom ?? C['--w-sig'];
          ctx.beginPath();
          if (b === 'x' || pb === 'x') { ctx.moveTo(xr, yHi); ctx.lineTo(xr, yLo); }
          else { ctx.moveTo(xr, Math.round(lvl(pb)) + 0.5); ctx.lineTo(xr, Math.round(lvl(b)) + 0.5); }
          ctx.stroke();
        }
        ctx.strokeStyle = col;
        ctx.beginPath();
        if (b === 'x') {
          ctx.fillStyle = 'rgba(255,59,59,0.22)';
          ctx.fillRect(xa, yHi, xb - xa, yLo - yHi);
          ctx.moveTo(xa, yHi + 0.5); ctx.lineTo(xb, yHi + 0.5); ctx.moveTo(xa, yLo + 0.5); ctx.lineTo(xb, yLo + 0.5);
        } else {
          const yy = Math.round(lvl(b)) + 0.5;
          ctx.moveTo(xa, yy); ctx.lineTo(xb, yy);
        }
        ctx.stroke();
      } else {
        const allZ = v.b !== 0n && (v.a & v.b) === 0n && v.b === L.mask(v.w);
        const unknown = !v.known;
        const col = allZ ? C['--w-z'] : unknown ? C['--w-x'] : custom ?? C['--w-bus'];
        ctx.strokeStyle = col; ctx.lineWidth = 1;
        const s = Math.min(3, (xb - xa) / 2);
        ctx.beginPath();
        if (allZ) { ctx.moveTo(xa, yMid); ctx.lineTo(xb, yMid); }
        else {
          const showStart = ts[i] >= tStart;
          const showEnd = i + 1 < ts.length && ts[i + 1] <= tEnd;
          ctx.moveTo(xa, yMid);
          ctx.lineTo(xa + (showStart ? s : 0), yHi + 0.5); ctx.lineTo(xb - (showEnd ? s : 0), yHi + 0.5); ctx.lineTo(xb, yMid);
          ctx.lineTo(xb - (showEnd ? s : 0), yLo + 0.5); ctx.lineTo(xa + (showStart ? s : 0), yLo + 0.5); ctx.closePath();
          if (unknown) { ctx.fillStyle = 'rgba(255,59,59,0.15)'; ctx.fill(); }
        }
        ctx.stroke();
        const avail = xb - xa - 8;
        if (avail > 8) {
          let text = sig.isReal ? fmtSig(sig, v, w.radix) : L.format(v, w.radix === 'symbolic' && !sig.enumNames ? 'hex' : w.radix, w.radix === 'symbolic' || (sig.enumNames && w.radix !== 'binary' && w.radix !== 'hex') ? sig.enumNames : undefined);
          let tw = ctx.measureText(text).width;
          if (tw > avail) {
            const ch = Math.max(1, Math.floor(avail / (tw / text.length)) - 1);
            text = text.length > ch ? text.slice(0, ch) + '…' : text;
            tw = ctx.measureText(text).width;
          }
          if (tw <= avail + 6) {
            ctx.fillStyle = unknown && !allZ ? '#ffb3b3' : C['--w-text'];
            const visA = Math.max(xa, 0), visB = Math.min(xb, W);
            const cx = Math.min(Math.max(visA + 4, (visA + visB) / 2 - tw / 2), xb - tw - 4);
            ctx.fillText(text, Math.max(xa + 4, cx), yMid + 0.5);
          }
        }
      }
    }
    flushDense();
  }

  private updateValues() {
    const t = this.cursor ?? this.session.now;
    this.valueEls.forEach((row, k) => {
      const r = this.rows[this.paintFirst + k];
      if (!r || isMarkerRow(r.w)) return;
      const w = r.w;
      const full = this.cursor === null ? w.sig.value : w.sig.valueAt(t);
      const s = r.bit !== undefined ? full.bit(this.bitOffset(w, r.bit)).toUpperCase().replace(/^([01])$/, '$1')
        : w.sig.isReal ? fmtSig(w.sig, full, w.radix) : L.format(full, w.radix === 'symbolic' && !w.sig.enumNames ? 'hex' : w.radix, w.radix !== 'binary' && w.radix !== 'hex' ? w.sig.enumNames : undefined);
      if (row.textContent !== s) row.textContent = s;
    });
  }

  private updateFoot() {
    const res = this.session.resolution;
    const parts = [t('Now: ') + fmtTime(this.session.now, res)];
    if (this.cursor !== null) parts.push(t('Cursor: ') + fmtTime(this.cursor, res));
    if (this.cursor !== null && this.cursor2 !== null) parts.push(`Δ: ${fmtTime(Math.abs(this.cursor2 - this.cursor), res)}`);
    parts.push(t('View: ') + `${fmtTime(Math.round(this.t0), res)} – ${fmtTime(Math.round(this.t(this.width)), res)}`);
    this.footText.textContent = parts.join('   ');
    const span = this.width * this.scale;
    const max = Math.max(0, this.endTime - span);
    this.scrollbar.max = String(Math.ceil(max));
    this.scrollbar.step = String(Math.max(1, Math.round(this.scale)));
    this.scrollbar.value = String(Math.min(this.t0, max));
    this.scrollbar.disabled = max <= 0;
  }

  // -------------------------------------------------------------- interaction
  private rowAt(clientY: number): number {
    const r = this.track.getBoundingClientRect();
    const y = clientY - r.top;
    return y < 0 ? -1 : this.rowIndexAt(y);
  }

  private snap(t: number, row: number): number {
    const w = this.rows[row]?.w;
    if (!w || isMarkerRow(w)) return t;
    const ts = w.sig.times;
    const tol = 6 * this.scale;
    let best = t, bd = tol;
    let lo = 0, hi = ts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ts[m] <= t) lo = m; else hi = m - 1; }
    for (const k of [lo - 1, lo, lo + 1]) if (k >= 0 && k < ts.length && Math.abs(ts[k] - t) < bd && ts[k] > 0) { bd = Math.abs(ts[k] - t); best = ts[k]; }
    return Math.round(best);
  }

  private bindCanvas() {
    const target = this.canvasCol;
    target.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !this.session.design) return;
      this.el.focus({ preventScroll: true });
      const rect = this.canvasCol.getBoundingClientRect();
      const x0 = e.clientX - rect.left;
      this.drag = { x0, x1: x0, active: false };
      const mv = (ev: MouseEvent) => {
        if (!this.drag) return;
        this.drag.x1 = ev.clientX - rect.left;
        if (Math.abs(this.drag.x1 - this.drag.x0) > 6) this.drag.active = true;
        this.render();
      };
      const up = (ev: MouseEvent) => {
        document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
        const d = this.drag; this.drag = null;
        if (!d) return;
        if (d.active) { const a = Math.min(d.x0, d.x1), b = Math.max(d.x0, d.x1); this.zoomRange(this.t(a), this.t(b)); return; }
        const t = Math.max(0, this.snap(this.t(x0), this.rowAt(ev.clientY)));
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey) this.cursor2 = t; else this.cursor = t;
        const row = this.rowAt(ev.clientY);
        const w = this.rows[row]?.w;
        if (w && ev.clientY - rect.top > HEAD_H) { this.selected = new Set([w.id]); this.lastSel = w.id; this.rebuildRows(); }
        this.render();
      };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    target.addEventListener('wheel', (e) => {
      const rect = this.canvasCol.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.zoom(e.deltaY > 0 ? 1.25 : 0.8, e.clientX - rect.left); }
      else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        this.autoFull = false;
        const d = (e.shiftKey ? e.deltaY : e.deltaX) * this.scale;
        this.t0 = Math.max(0, Math.min(this.t0 + d, Math.max(0, this.endTime - this.width * this.scale * 0.5)));
        this.render();
      }
    }, { passive: false });
  }

  private bindNames() {
    const idOf = (e: Event) => { const r = (e.target as HTMLElement).closest('.wave-row') as HTMLElement | null; return r?.dataset.id ? Number(r.dataset.id) : null; };
    const onClick = (e: MouseEvent) => {
      const id = idOf(e);
      if (id === null) return;
      this.el.focus({ preventScroll: true });
      if (e.ctrlKey || e.metaKey) { if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id); }
      else if (e.shiftKey && this.lastSel !== null) {
        const ids = this.session.waves.map(w => w.id);
        const a = ids.indexOf(this.lastSel), b = ids.indexOf(id);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selected.add(ids[i]);
      } else this.selected = new Set([id]);
      this.lastSel = id;
      this.rebuildRows();
    };
    this.names.addEventListener('click', onClick);
    this.values.addEventListener('click', onClick);
    const onCtx = (e: MouseEvent) => {
      const id = idOf(e);
      if (id === null) return;
      e.preventDefault();
      if (!this.selected.has(id)) { this.selected = new Set([id]); this.lastSel = id; this.rebuildRows(); }
      const w = this.session.waves.find(x => x.id === id)!;
      if (w.groupLabel !== undefined) {
        contextMenu(e.clientX, e.clientY, [
          { label: w.collapsed ? t('Expand group') : t('Collapse group'), action: () => this.toggleGroup(w) },
          { label: t('Rename group…'), action: () => void this.renameGroup(w) },
          { label: t('Ungroup'), action: () => this.ungroup(w) },
          '-',
          { label: t('Delete group and its signals'), action: () => this.deleteSelected() },
        ]);
        return;
      }
      const r = (label: string, radix: Radix) => ({ label, action: () => this.setRadix(radix), checked: w.radix === radix });
      const sel = () => this.session.waves.filter(x => this.selected.has(x.id) && !isMarkerRow(x));
      const setAll = (f: (x: WaveEntry) => void) => { for (const x of sel()) f(x); this.ranges.clear(); this.rebuildRows(); this.session.emit('wave'); };
      const fmt = (label: string, f: WaveEntry['format']) => ({ label, checked: (w.format ?? 'literal') === f, action: () => setAll(x => { x.format = f === 'literal' ? undefined : f; if (f === 'literal') x.height = undefined; }) });
      const radixItems: CtxItem[] = [
        r(t('Binary'), 'binary'), r(t('Hexadecimal'), 'hex'), r(t('Unsigned'), 'unsigned'), r(t('Decimal (signed)'), 'decimal'), r(t('Octal'), 'octal'), r(t('ASCII'), 'ascii'),
        ...(w.sig.enumNames ? [r(t('Symbolic'), 'symbolic')] : []),
      ];
      contextMenu(e.clientX, e.clientY, [
        { label: t('Radix'), sub: radixItems },
        { label: t('Format'), sub: [
          fmt(t('Literal'), 'literal'), fmt(t('Analog (step)'), 'analog-step'), fmt(t('Analog (interpolated)'), 'analog-interp'),
          '-',
          { label: t('Analog height…'), disabled: !isAnalog(w), action: () => void this.askNumber(t('Analog height (pixels)'), w.height ?? ANALOG_H).then(n => { if (n !== null) setAll(x => { x.height = Math.max(16, Math.min(400, Math.round(n))); }); }) },
          { label: t('Analog range…'), disabled: !isAnalog(w), action: () => void this.askRange(w).then(rg => { if (rg) setAll(x => { x.min = rg[0]; x.max = rg[1]; }); }) },
          { label: t('Auto range'), disabled: !isAnalog(w) || (w.min === undefined && w.max === undefined), action: () => setAll(x => { x.min = undefined; x.max = undefined; }) },
        ] },
        { label: t('Color'), sub: PALETTE.map(([name, c]) => ({ label: t(name), swatch: c || undefined, checked: (waveColor(w.color) ?? '') === c, action: () => setAll(x => { x.color = c ? name.toLowerCase() : undefined; }) })) },
        { label: t('Group selected…'), action: () => void this.groupSelected() },
        ...(w.parent !== undefined ? [{ label: t('Remove from group'), action: () => setAll(x => { x.parent = undefined; }) }] : []),
        '-',
        ...(w.sig.w > 1 && !isAnalog(w) ? [{ label: this.expanded.has(w.id) ? t('Collapse bits') : t('Expand bits'), action: () => this.toggleExpand(w.id) }] : []),
        { label: t('Jump to next transition'), action: () => this.jumpEdge(1) },
        { label: t('Jump to previous transition'), action: () => this.jumpEdge(-1) },
        '-',
        { label: t('Insert divider below'), action: () => this.insertDivider(id) },
        { label: t('Delete selected'), action: () => this.deleteSelected() },
        { label: t('Delete all'), action: () => { this.session.waves = []; this.session.emit('wave'); } },
      ]);
    };
    this.names.addEventListener('contextmenu', onCtx);
    this.values.addEventListener('contextmenu', onCtx);
    // drag to reorder
    this.names.addEventListener('dragstart', (e) => {
      const id = idOf(e);
      if (id === null) return;
      this.dragRow = id;
      e.dataTransfer!.setData('text/plain', String(id));
      e.dataTransfer!.effectAllowed = 'move';
    });
    this.names.addEventListener('dragend', () => { this.dragRow = null; });
  }

  private async askNumber(title: string, cur: number): Promise<number | null> {
    const s = await promptText(title, t('Value'), String(cur));
    if (s === null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  private async askRange(w: WaveEntry): Promise<[number, number] | null> {
    const [lo, hi] = this.analogRange(w);
    const s = await promptText(t('Analog range'), t('min max'), `${lo} ${hi}`);
    const m = s && /^\s*(-?[\d.eE+-]+)[\s,]+(-?[\d.eE+-]+)\s*$/.exec(s);
    if (!m) return null;
    const a = Number(m[1]), b = Number(m[2]);
    return Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : null;
  }

  /** Put the selected signals into a new group (inserted where the first of them was). */
  async groupSelected() {
    const ws = this.session.waves;
    const members = ws.filter(w => this.selected.has(w.id) && !isMarkerRow(w));
    if (!members.length) return;
    const name = await promptText(t('New group'), t('Group name'), t('Group'));
    if (!name) return;
    const at = ws.indexOf(members[0]);
    const hdr: WaveEntry = { id: Date.now() % 1e9, path: '', name, sig: members[0].sig, radix: 'binary', groupLabel: name };
    const rest = ws.filter(w => !members.includes(w));
    const after = ws.slice(at).find(w => !members.includes(w));
    for (const m of members) m.parent = hdr.id;
    rest.splice(after ? rest.indexOf(after) : rest.length, 0, hdr, ...members);
    this.session.waves = rest;
    this.selected = new Set([hdr.id]);
    this.session.emit('wave');
  }

  private async renameGroup(w: WaveEntry) {
    const name = await promptText(t('Rename group'), t('Group name'), w.groupLabel);
    if (!name) return;
    w.groupLabel = name; w.name = name;
    this.session.emit('wave');
  }

  private ungroup(w: WaveEntry) {
    for (const x of this.session.waves) if (x.parent === w.id) x.parent = undefined;
    this.session.waves = this.session.waves.filter(x => x !== w);
    this.session.emit('wave');
  }

  private insertDivider(afterId: number) {
    const i = this.session.waves.findIndex(w => w.id === afterId);
    const name = prompt(t('Divider label'), t('Group'));
    if (name === null) return;
    const ws = this.session.waves;
    ws.splice(i + 1, 0, { id: Date.now() % 1e9, path: '', name, sig: ws[i].sig, radix: 'binary', dividerLabel: name || '-' });
    this.session.emit('wave');
  }

  private bindDrop() {
    const el = this.body;
    el.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes(DND_TYPE) || this.dragRow !== null) { e.preventDefault(); el.classList.add('drop-hi'); }
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-hi'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-hi');
      const data = e.dataTransfer?.getData(DND_TYPE);
      if (data) { e.preventDefault(); this.session.addWavePaths(JSON.parse(data)); return; }
      if (this.dragRow !== null) {
        e.preventDefault();
        const ws = this.session.waves;
        const from = ws.findIndex(w => w.id === this.dragRow);
        const target = this.rows[Math.max(0, Math.min(this.rows.length - 1, this.rowAt(e.clientY)))]?.w;
        let to = target ? ws.indexOf(target) : ws.length - 1;
        if (from >= 0 && to !== from) { const [item] = ws.splice(from, 1); if (to > from) to = Math.min(to, ws.length); ws.splice(to, 0, item); this.session.emit('wave'); }
        this.dragRow = null;
      }
    });
  }

  private bindKeys() {
    this.el.addEventListener('keydown', (e) => {
      if (e.target !== this.el) return;
      switch (e.key) {
        case 'f': case 'F': this.zoomFull(); break;
        case 'i': case 'I': case '+': case '=': this.zoom(0.5); break;
        case 'o': case 'O': case '-': this.zoom(2); break;
        case 'c': case 'C': this.centerCursor(); break;
        case 'Delete': case 'Backspace': this.deleteSelected(); break;
        case 'Tab': this.jumpEdge(e.shiftKey ? -1 : 1); break;
        case 'ArrowLeft': this.autoFull = false; this.t0 = Math.max(0, this.t0 - this.width * this.scale * 0.2); this.render(); break;
        case 'ArrowRight': this.autoFull = false; this.t0 = this.t0 + this.width * this.scale * 0.2; this.render(); break;
        case 'a': if (e.ctrlKey || e.metaKey) { this.selected = new Set(this.session.waves.map(w => w.id)); this.rebuildRows(); break; } return;
        default: return;
      }
      e.preventDefault();
    });
  }
}
