// Floorplan and placement for the in-browser ASIC flow (#51).
// Quadratic global placement (conjugate gradient) with SimPL-style spreading anchors, Abacus row legalization,
// HPWL-driven detailed placement, IO pins assigned around the die by angle, and filler cells.
// Coordinates are in routing tracks; rows alternate N / FS (flipped) orientation so power rails are shared.
import { ROW_TRACKS } from './cells';
import type { Netlist } from './netlist';

export interface PlacedCell { x: number; row: number }
export type Side = 'L' | 'R' | 'B' | 'T';
export interface PortPin { side: Side; x: number; y: number; layer: number }
export interface Placement {
  /** Tracks between the die edge and the core (room for IO routing). */
  margin: number;
  /** Core size in sites (= tracks) and rows; die size in tracks. */
  cols: number; rows: number; dieW: number; dieH: number;
  cells: PlacedCell[];
  ports: PortPin[];
  fillers: { type: string; x: number; row: number }[];
  hpwl: number;
  util: number;
}
export interface PlaceOptions { util?: number; iterations?: number }

export const rowY = (p: Pick<Placement, 'margin'>, row: number) => p.margin + row * ROW_TRACKS;
export const flipped = (row: number) => row % 2 === 1;

/** Track coordinates of a cell pin's access point. */
export function pinXY(p: Placement, nl: Netlist, cell: number, pin: string): [number, number] {
  const c = nl.cells[cell], pc = p.cells[cell], pp = c.def.pins[pin];
  return [pc.x + pp.x, rowY(p, pc.row) + (flipped(pc.row) ? ROW_TRACKS - 1 - pp.y : pp.y)];
}

/** Half-perimeter wire length of all nets (tracks). */
export function hpwl(p: Placement, nl: Netlist): number {
  let s = 0;
  for (const n of nl.nets) s += bboxLen(netTerms(p, nl, n));
  return s;
}

function netTerms(p: Placement, nl: Netlist, net: Netlist['nets'][number]): [number, number][] {
  return [...net.pins.map(t => pinXY(p, nl, t.cell, t.pin)), ...net.ports.map(i => [p.ports[i].x, p.ports[i].y] as [number, number])];
}

function bboxLen(pts: [number, number][]): number {
  if (pts.length < 2) return 0;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 - x0 + y1 - y0;
}

/** Solve the quadratic placement A x = b along one axis with Jacobi-preconditioned conjugate gradients. */
function solveAxis(n: number, diag: Float64Array, off: Map<number, number>[], b: Float64Array, x0: Float64Array): Float64Array {
  const x = Float64Array.from(x0);
  const mul = (v: Float64Array, out: Float64Array) => {
    for (let i = 0; i < n; i++) { let s = diag[i] * v[i]; for (const [j, w] of off[i]) s += w * v[j]; out[i] = s; }
  };
  const r = new Float64Array(n), z = new Float64Array(n), q = new Float64Array(n), ap = new Float64Array(n);
  mul(x, ap);
  for (let i = 0; i < n; i++) r[i] = b[i] - ap[i];
  for (let i = 0; i < n; i++) z[i] = r[i] / diag[i];
  q.set(z);
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  const tol = 1e-8 * Math.max(1, rz);
  for (let it = 0; it < 4 * n + 50 && rz > tol; it++) {
    mul(q, ap);
    let qap = 0;
    for (let i = 0; i < n; i++) qap += q[i] * ap[i];
    const a = rz / qap;
    for (let i = 0; i < n; i++) { x[i] += a * q[i]; r[i] -= a * ap[i]; }
    let rz2 = 0;
    for (let i = 0; i < n; i++) { z[i] = r[i] / diag[i]; rz2 += r[i] * z[i]; }
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n; i++) q[i] = z[i] + beta * q[i];
  }
  return x;
}

/** Abacus: legal left edges in [lo, hi] for cells of one row, as close as possible to their targets (squared displacement). */
export function abacus(targets: number[], widths: number[], lo: number, hi: number): number[] {
  const order = targets.map((_, i) => i).sort((a, b) => targets[a] - targets[b] || a - b);
  type Cl = { e: number; q: number; w: number; x: number; cells: number[] };
  const cls: Cl[] = [];
  const place = (c: Cl) => { c.x = Math.min(Math.max(c.q / c.e, lo), hi - c.w); };
  for (const i of order) {
    const c: Cl = { e: 1, q: targets[i], w: widths[i], x: 0, cells: [i] };
    place(c);
    cls.push(c);
    while (cls.length > 1) {
      const last = cls[cls.length - 1], prev = cls[cls.length - 2];
      if (prev.x + prev.w <= last.x) break;
      prev.q += last.q - last.e * prev.w;
      prev.e += last.e;
      prev.w += last.w;
      prev.cells.push(...last.cells);
      cls.pop();
      place(prev);
    }
  }
  // integer sites, left to right without overlap, then pushed back inside on the right
  const xs = new Array<number>(targets.length);
  let end = lo;
  const flat: number[] = [];
  for (const c of cls) {
    let x = Math.max(Math.round(c.x), end);
    for (const i of c.cells) { xs[i] = x; x += widths[i]; flat.push(i); }
    end = x;
  }
  let limit = hi;
  for (let k = flat.length - 1; k >= 0; k--) {
    const i = flat[k];
    if (xs[i] + widths[i] > limit) xs[i] = limit - widths[i];
    limit = xs[i];
  }
  if (flat.length && xs[flat[0]] < lo) throw new Error('row overflow during legalization');
  return xs;
}

export function place(nl: Netlist, o: PlaceOptions = {}): Placement {
  const util = Math.min(0.95, Math.max(0.1, o.util ?? 0.6));
  const n = nl.cells.length;
  if (!n) throw new Error('the netlist has no cells');
  const widths = nl.cells.map(c => c.def.width);
  const total = widths.reduce((a, b) => a + b, 0);
  const maxW = Math.max(...widths);
  // square-ish core: rows of ROW_TRACKS tracks, cols sites
  let rows = Math.max(1, Math.round(Math.sqrt(total / util / ROW_TRACKS)));
  let cols = Math.max(maxW + 2, Math.ceil(total / util / rows));
  const margin = 4;
  // enough boundary slots (every 2 tracks) for the IO pins
  while (cols + rows * ROW_TRACKS < nl.ports.length + 4) { cols += 2; if (cols > rows * ROW_TRACKS) rows++; }
  const p: Placement = {
    margin, cols, rows, dieW: cols + 2 * margin, dieH: rows * ROW_TRACKS + 2 * margin,
    cells: nl.cells.map(() => ({ x: margin, row: 0 })), ports: [], fillers: [], hpwl: 0, util: total / (cols * rows),
  };
  const slots = boundarySlots(p);
  if (slots.length < nl.ports.length) throw new Error(`not enough room for ${nl.ports.length} IO pins`);
  // first pass: inputs on the left, outputs on the right (in name order); then pins follow the cells by angle
  p.ports = initialPorts(nl, p, slots);
  let pos = globalPlace(nl, p, widths, o.iterations ?? 12);
  p.ports = portsByAngle(nl, p, slots, pos);
  pos = globalPlace(nl, p, widths, o.iterations ?? 12);
  legalize(p, pos, widths);
  detailed(nl, p, widths);
  p.fillers = fillers(p, widths);
  p.hpwl = hpwl(p, nl);
  return p;
}

/** Candidate IO positions on the die boundary every 2 tracks, counter-clockwise from the bottom-left corner. */
function boundarySlots(p: Placement): PortPin[] {
  const s: PortPin[] = [];
  const { dieW: W, dieH: H, margin: m } = p;
  for (let x = m; x < W - m; x += 2) s.push({ side: 'B', x, y: 0, layer: 3 });
  // left / right pins on odd tracks: the power straps' rail vias sit on even tracks (see powerVias)
  for (let y = m + 1; y <= H - m - 2; y += 2) s.push({ side: 'R', x: W - 1, y, layer: 2 });
  for (let x = W - m - 1; x >= m; x -= 2) s.push({ side: 'T', x, y: H - 1, layer: 3 });
  for (let y = m + 1 + 2 * Math.floor((H - 2 * m - 3) / 2); y >= m + 1; y -= 2) s.push({ side: 'L', x: 0, y, layer: 2 });
  return s;
}

function spreadOver<T>(items: T[], slots: PortPin[]): PortPin[] {
  return items.map((_, i) => slots[Math.floor(((i + 0.5) * slots.length) / items.length)]);
}

function initialPorts(nl: Netlist, p: Placement, slots: PortPin[]): PortPin[] {
  const left = slots.filter(s => s.side === 'L').reverse(), right = slots.filter(s => s.side === 'R');
  const ins = nl.ports.map((q, i) => i).filter(i => nl.ports[i].dir === 'input');
  const outs = nl.ports.map((q, i) => i).filter(i => nl.ports[i].dir === 'output');
  const res: PortPin[] = new Array(nl.ports.length);
  const put = (idx: number[], side: PortPin[]) => {
    const pool = side.length >= idx.length ? side : slots;
    spreadOver(idx, pool).forEach((s, k) => { res[idx[k]] = s; });
  };
  put(ins, left);
  put(outs, right);
  // resolve collisions when a side overflowed into the whole boundary
  const used = new Set<PortPin>();
  for (let i = 0; i < res.length; i++) {
    if (!used.has(res[i])) { used.add(res[i]); continue; }
    res[i] = slots.find(s => !used.has(s))!;
    used.add(res[i]);
  }
  return res;
}

/** Ports sorted by the angle of their cells' centroid around the core centre, spread evenly over the boundary in the same order. */
function portsByAngle(nl: Netlist, p: Placement, slots: PortPin[], pos: { x: Float64Array; y: Float64Array }): PortPin[] {
  const cx = p.dieW / 2, cy = p.dieH / 2;
  const ang = (x: number, y: number) => Math.atan2(y - cy, x - cx);
  const netById = new Map(nl.nets.map(nn => [nn.id, nn]));
  const want = nl.ports.map((q, i) => {
    const net = netById.get(q.net)!;
    if (!net.pins.length) return ang(p.ports[i].x, p.ports[i].y);
    let sx = 0, sy = 0;
    for (const t of net.pins) { sx += pos.x[t.cell]; sy += pos.y[t.cell]; }
    return ang(sx / net.pins.length, sy / net.pins.length);
  });
  const order = nl.ports.map((_, i) => i).sort((a, b) => want[a] - want[b]);
  const sorted = slots.map(s => ({ s, a: ang(s.x, s.y) })).sort((a, b) => a.a - b.a).map(v => v.s);
  // rotate the slot ring so the first port lands near its angle
  const start = sorted.findIndex(s => ang(s.x, s.y) >= want[order[0]] - Math.PI / sorted.length);
  const ring = [...sorted.slice(Math.max(0, start)), ...sorted.slice(0, Math.max(0, start))];
  const res: PortPin[] = new Array(nl.ports.length);
  spreadOver(order, ring).forEach((s, k) => { res[order[k]] = s; });
  return res;
}

/** Cell centres in tracks after quadratic placement with spreading anchors. */
function globalPlace(nl: Netlist, p: Placement, widths: number[], iterations: number) {
  const n = nl.cells.length;
  const cx = p.margin + p.cols / 2, cy = p.margin + (p.rows * ROW_TRACKS) / 2;
  let x: Float64Array = new Float64Array(n).fill(cx), y: Float64Array = new Float64Array(n).fill(cy);
  // small deterministic jitter breaks the symmetry of unconnected cells
  for (let i = 0; i < n; i++) { x[i] += ((i * 7919) % 97) / 97 - 0.5; y[i] += ((i * 104729) % 89) / 89 - 0.5; }
  let anchors: { x: Float64Array; y: Float64Array } | null = null;
  for (let it = 0; it <= iterations; it++) {
    const alpha = it === 0 ? 0 : 0.01 * Math.pow(1.8, it);
    for (const axis of ['x', 'y'] as const) {
      const cur = axis === 'x' ? x : y;
      const diag = new Float64Array(n).fill(1e-6), b = new Float64Array(n);
      const center = axis === 'x' ? cx : cy;
      for (let i = 0; i < n; i++) b[i] = 1e-6 * center;
      const off = Array.from({ length: n }, () => new Map<number, number>());
      for (const net of nl.nets) {
        const k = net.pins.length + net.ports.length;
        if (k < 2) continue;
        const fixed = net.ports.map(i => (axis === 'x' ? p.ports[i].x : p.ports[i].y));
        const mov = net.pins.map(t => t.cell);
        if (k <= 12) {
          const w = 1 / (k - 1);
          for (let a = 0; a < mov.length; a++) {
            const i = mov[a];
            for (let c = a + 1; c < mov.length; c++) {
              const j = mov[c];
              if (i === j) continue;
              diag[i] += w; diag[j] += w;
              off[i].set(j, (off[i].get(j) ?? 0) - w);
              off[j].set(i, (off[j].get(i) ?? 0) - w);
            }
            for (const f of fixed) { diag[i] += w; b[i] += w * f; }
          }
        } else {
          // large nets: a star to the current centroid
          let s = fixed.reduce((u, v) => u + v, 0);
          for (const i of mov) s += cur[i];
          const c = s / k, w = 2 / k;
          for (const i of mov) { diag[i] += w; b[i] += w * c; }
        }
      }
      if (anchors) {
        const an = axis === 'x' ? anchors.x : anchors.y;
        for (let i = 0; i < n; i++) { diag[i] += alpha; b[i] += alpha * an[i]; }
      }
      const sol = solveAxis(n, diag, off, b, cur);
      if (axis === 'x') x = sol; else y = sol;
    }
    if (it < iterations) {
      const tmp: Placement = { ...p, cells: p.cells.map(c => ({ ...c })) };
      legalize(tmp, { x, y }, widths);
      anchors = {
        x: Float64Array.from(tmp.cells, (c, i) => c.x + widths[i] / 2),
        y: Float64Array.from(tmp.cells, c => rowY(p, c.row) + ROW_TRACKS / 2),
      };
    }
  }
  return { x, y };
}

/** Rows by y order with balanced fill, then Abacus within each row. */
function legalize(p: Placement, pos: { x: Float64Array; y: Float64Array }, widths: number[]) {
  const n = widths.length;
  const total = widths.reduce((a, b) => a + b, 0);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => pos.y[a] - pos.y[b] || pos.x[a] - pos.x[b]);
  const rowsOf: number[][] = Array.from({ length: p.rows }, () => []);
  let r = 0, acc = 0, inRow = 0;
  for (const i of order) {
    while (r < p.rows - 1 && (acc + widths[i] / 2 > (total * (r + 1)) / p.rows || inRow + widths[i] > p.cols)) { r++; inRow = 0; }
    if (inRow + widths[i] > p.cols) throw new Error('the core is too small for the cells');
    rowsOf[r].push(i);
    acc += widths[i];
    inRow += widths[i];
  }
  rowsOf.forEach((cells, row) => {
    const xs = abacus(cells.map(i => pos.x[i] - widths[i] / 2), cells.map(i => widths[i]), p.margin, p.margin + p.cols);
    cells.forEach((i, k) => { p.cells[i] = { x: xs[k], row }; });
  });
}

/** Detailed placement: adjacent swaps and moves into free space toward each cell's optimal x, while HPWL improves. */
function detailed(nl: Netlist, p: Placement, widths: number[]) {
  const netsOf: number[][] = nl.cells.map(() => []);
  const netById = new Map(nl.nets.map(nn => [nn.id, nn]));
  nl.nets.forEach(nn => { for (const t of nn.pins) if (!netsOf[t.cell].includes(nn.id)) netsOf[t.cell].push(nn.id); });
  const cost = (cells: number[]) => {
    const ids = new Set<number>();
    for (const c of cells) for (const id of netsOf[c]) ids.add(id);
    let s = 0;
    for (const id of ids) s += bboxLen(netTerms(p, nl, netById.get(id)!));
    return s;
  };
  for (let pass = 0; pass < 6; pass++) {
    let improved = false;
    for (let row = 0; row < p.rows; row++) {
      const cells = p.cells.map((c, i) => i).filter(i => p.cells[i].row === row).sort((a, b) => p.cells[a].x - p.cells[b].x);
      // moves into the gap toward the median x of the other pins of the cell's nets
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k];
        const xsOther: number[] = [];
        for (const id of netsOf[i]) {
          const net = netById.get(id)!;
          for (const t of net.pins) if (t.cell !== i) xsOther.push(pinXY(p, nl, t.cell, t.pin)[0]);
          for (const q of net.ports) xsOther.push(p.ports[q].x);
        }
        if (!xsOther.length) continue;
        xsOther.sort((a, b) => a - b);
        const want = Math.round(xsOther[xsOther.length >> 1] - widths[i] / 2);
        const lo = k > 0 ? p.cells[cells[k - 1]].x + widths[cells[k - 1]] : p.margin;
        const hi = (k < cells.length - 1 ? p.cells[cells[k + 1]].x : p.margin + p.cols) - widths[i];
        const nx = Math.min(Math.max(want, lo), hi);
        if (nx === p.cells[i].x) continue;
        const before = cost([i]), ox = p.cells[i].x;
        p.cells[i].x = nx;
        if (cost([i]) < before) improved = true; else p.cells[i].x = ox;
      }
      // adjacent swaps (keeping the outer edges of the pair)
      for (let k = 0; k + 1 < cells.length; k++) {
        const a = cells[k], b = cells[k + 1];
        const ax = p.cells[a].x, bx = p.cells[b].x;
        const before = cost([a, b]);
        p.cells[b].x = ax;
        p.cells[a].x = bx + widths[b] - widths[a];
        if (cost([a, b]) < before) { cells[k] = b; cells[k + 1] = a; improved = true; } else { p.cells[a].x = ax; p.cells[b].x = bx; }
      }
    }
    if (!improved) break;
  }
}

/** Fill the gaps of every row with FILL4 / FILL2 / FILL1 cells. */
function fillers(p: Placement, widths: number[]): Placement['fillers'] {
  const out: Placement['fillers'] = [];
  for (let row = 0; row < p.rows; row++) {
    const used = p.cells.map((c, i) => ({ c, w: widths[i] })).filter(v => v.c.row === row).sort((a, b) => a.c.x - b.c.x);
    let x = p.margin;
    const gap = (to: number) => {
      while (x < to) {
        const w = to - x >= 4 ? 4 : to - x >= 2 ? 2 : 1;
        out.push({ type: `FILL${w}`, x, row });
        x += w;
      }
    };
    for (const v of used) { gap(v.c.x); x = v.c.x + v.w; }
    gap(p.margin + p.cols);
  }
  return out;
}
