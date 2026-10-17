// Dataflow window: the drivers and readers of one signal, one level each way, with values at the wave cursor.
import { h, icon } from './dom';
import { t } from './i18n';
import { fmtSig, type RemoteSession as Session, type MSignal, type MDFNode } from './remote';

const SVG = 'http://www.w3.org/2000/svg';
const COL_W = 180, GAP = 50, ROW = 38, SIG_H = 26, PROC_H = 30, PAD = 16;
const MAX_ROWS = 40;

function svg(tag: string, attrs: Record<string, string | number>, ...kids: (Node | string)[]) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const c of kids) e.append(c);
  return e;
}

function short(path: string) { const p = path.split('/').filter(Boolean); return p.length > 2 ? '…/' + p.slice(-2).join('/') : path; }
function clip(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

export class DataflowView {
  el: HTMLElement;
  private canvas: HTMLElement;
  private title: HTMLElement;
  private focus: MSignal | null = null;
  private back: MSignal[] = [];
  private fwd: MSignal[] = [];
  private stale = false;
  /** Time at which values are shown (the wave cursor, or the current time). */
  getTime: () => number = () => this.session.now;
  onOpenSource?: (file: string, line: number) => void;
  onAddWave?: (paths: string[]) => void;

  constructor(private session: Session) {
    const btn = (ic: string, title: string, f: () => void) => h('button', { class: 'tb-btn', title, 'aria-label': title, onclick: f }, icon(ic));
    this.title = h('span', { class: 'df-title mono' });
    this.canvas = h('div', { class: 'df-canvas scroll' });
    this.el = h('div', { class: 'dataflow' },
      h('div', { class: 'subbar' },
        btn('prevedge', t('Back'), () => this.go(-1)),
        btn('nextedge', t('Forward'), () => this.go(1)),
        btn('addwave', t('Add the signals shown to the wave'), () => this.addShown()),
        h('span', { class: 'tb-sep' }),
        this.title),
      this.canvas);
    session.on('sim', () => { this.focus = null; this.back = []; this.fwd = []; this.render(); });
    session.on('time', () => this.refresh());
    new IntersectionObserver(es => { if (es.some(e => e.isIntersecting) && this.stale) this.render(); }).observe(this.el);
    this.render();
  }

  /** Focus a signal by path (from the wave, objects or a click in the graph). */
  show(path: string, remember = true) {
    const sig = this.session.design?.kernel.signals.find(s => s.path === path);
    if (!sig || sig === this.focus) return;
    if (remember && this.focus) { this.back.push(this.focus); this.fwd = []; }
    this.focus = sig;
    this.refresh();
  }

  private go(dir: 1 | -1) {
    const from = dir < 0 ? this.back : this.fwd, to = dir < 0 ? this.fwd : this.back;
    const s = from.pop();
    if (!s) return;
    if (this.focus) to.push(this.focus);
    this.focus = s;
    this.render();
  }

  refresh() { if (this.el.offsetParent !== null) this.render(); else this.stale = true; }

  private shown: MSignal[] = [];
  private addShown() { if (this.shown.length) this.onAddWave?.(this.shown.map(s => s.path)); }

  render() {
    this.stale = false;
    const d = this.session.design;
    const S = this.focus;
    if (!d || !S) {
      this.title.textContent = '';
      this.shown = [];
      this.canvas.replaceChildren(h('div', { class: 'empty' }, d ? t('Select a signal in the Objects or Wave window (or right-click ▸ Show in Dataflow).') : t('No design loaded.')));
      return;
    }
    this.title.textContent = S.path;
    const df = d.df;
    const drivers = df.filter(n => n.writes.includes(S));
    const readers = df.filter(n => n.reads.includes(S) && !drivers.includes(n));
    const uniq = (xs: MSignal[]) => [...new Set(xs)].filter(x => x !== S);
    const inputs = uniq(drivers.flatMap(n => n.reads));
    const outputs = uniq(readers.flatMap(n => n.writes));
    this.shown = [S, ...inputs, ...outputs];
    const cols: (MSignal | MDFNode)[][] = [inputs, drivers, [S], readers, outputs].map(c => c.slice(0, MAX_ROWS));
    const hidden = [inputs, drivers, [S], readers, outputs].map((c, i) => c.length - cols[i].length);
    const rows = Math.max(1, ...cols.map(c => c.length));
    const H = PAD * 2 + rows * ROW + 20;
    const W = PAD * 2 + 5 * COL_W + 4 * GAP;
    // scales down to the pane width (never below a readable minimum; the pane scrolls then)
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', preserveAspectRatio: 'xMinYMin meet', class: 'df-svg', role: 'img', 'aria-label': t('Dataflow of {0}', S.path) });
    (root as SVGElement).style.minWidth = `${Math.round(W * 0.7)}px`;
    (root as SVGElement).style.maxWidth = `${W}px`;
    const edges = svg('g', { class: 'df-edges' });
    const nodes = svg('g', {});
    root.append(edges, nodes);
    const time = this.getTime();
    const pos = new Map<unknown, { x: number; y: number }>();
    cols.forEach((col, ci) => {
      const x = PAD + ci * (COL_W + GAP);
      const top = PAD + ((rows - col.length) * ROW) / 2;
      col.forEach((item, ri) => {
        const y = top + ri * ROW + ROW / 2;
        pos.set(item, { x, y });
        nodes.append('reads' in item ? this.procNode(item, x, y) : this.sigNode(item, x, y, time, item === S));
      });
      if (hidden[ci] > 0) nodes.append(svg('text', { x: x + 6, y: PAD + rows * ROW + 12, class: 'df-more' }, t('+{0} more', hidden[ci])));
    });
    const link = (a: unknown, b: unknown) => {
      const p = pos.get(a), q = pos.get(b);
      if (!p || !q) return;
      const x1 = p.x + COL_W, x2 = q.x, mx = (x1 + x2) / 2;
      edges.append(svg('path', { d: `M${x1},${p.y} C${mx},${p.y} ${mx},${q.y} ${x2},${q.y}`, class: 'df-edge' }));
    };
    for (const n of cols[1] as MDFNode[]) { for (const r of n.reads) if (r !== S) link(r, n); link(n, S); if (n.reads.includes(S)) edges.append(this.loopMark(pos.get(n)!)); }
    for (const n of cols[3] as MDFNode[]) { link(S, n); for (const w of n.writes) if (w !== S) link(n, w); }
    if (!drivers.length) nodes.append(svg('text', { x: PAD + COL_W + GAP + 6, y: PAD + (rows * ROW) / 2 + 4, class: 'df-more' }, t('no driver')));
    if (!readers.length) nodes.append(svg('text', { x: PAD + 3 * (COL_W + GAP) + 6, y: PAD + (rows * ROW) / 2 + 4, class: 'df-more' }, t('no readers')));
    this.canvas.replaceChildren(root);
  }

  private sigNode(s: MSignal, x: number, y: number, time: number, focus: boolean) {
    const v = s.valueAt(time);
    const val = fmtSig(s, v, s.w > 1 ? 'hex' : 'binary', s.enumNames);
    const g = svg('g', { class: 'df-sig' + (focus ? ' focus' : '') + (v.known ? '' : ' unknown'), transform: `translate(${x},${y - SIG_H / 2})`, tabindex: 0 },
      svg('title', {}, `${s.path} = ${val}\n${t('Click: follow · Double-click: add to wave')}`),
      svg('rect', { width: COL_W, height: SIG_H, rx: SIG_H / 2 }),
      svg('text', { x: 10, y: SIG_H / 2 + 4, class: 'df-name' }, clip(short(s.path), 18)),
      svg('text', { x: COL_W - 10, y: SIG_H / 2 + 4, class: 'df-val', 'text-anchor': 'end' }, clip(val, 10)));
    g.addEventListener('click', () => this.show(s.path));
    g.addEventListener('dblclick', () => this.onAddWave?.([s.path]));
    g.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') this.show(s.path); });
    return g;
  }

  private procNode(n: MDFNode, x: number, y: number) {
    const tag = n.kind === 'process' ? 'P' : n.kind === 'assign' ? '=' : n.kind === 'port' ? '⇄' : 'U';
    const g = svg('g', { class: `df-proc df-${n.kind}`, transform: `translate(${x},${y - PROC_H / 2})`, tabindex: 0 },
      svg('title', {}, `${n.scope}/${n.name}${n.file ? `\n${n.file}:${n.line}` : ''}\n${t('Click: open source')}`),
      svg('rect', { width: COL_W, height: PROC_H, rx: 3 }),
      svg('text', { x: 8, y: 13, class: 'df-tag' }, tag),
      svg('text', { x: 22, y: 13, class: 'df-name' }, clip(n.name, 20)),
      svg('text', { x: 22, y: 25, class: 'df-scope' }, clip(n.scope, 24)));
    const open = () => { if (n.file && n.line) this.onOpenSource?.(n.file, n.line); };
    g.addEventListener('click', open);
    g.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') open(); });
    return g;
  }

  /** Small arrow on a driver that also reads the signal it drives (feedback, e.g. a counter). */
  private loopMark(p: { x: number; y: number }) {
    const x = p.x + COL_W - 14, y = p.y - PROC_H / 2 - 2;
    return svg('path', { d: `M${x},${y} a6,6 0 1,1 8,0`, class: 'df-loop' }, svg('title', {}, t('Feedback: this process also reads the signal')));
  }
}
