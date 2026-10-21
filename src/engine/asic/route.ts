// Detailed routing for the in-browser ASIC flow (#51): a 3D track grid over the die (M2 horizontal, M3 vertical,
// M4 horizontal, M5 vertical), A* growing a tree per net, and PathFinder negotiated congestion (rip-up and reroute).
// Cell pins are reached from M2 through a via1 at their access point; M1 stays inside the cells.
import type { Netlist } from './netlist';
import { pinXY, type Placement } from './place';
import { ROW_TRACKS } from './cells';

export interface Wire { layer: number; x1: number; y1: number; x2: number; y2: number }
/** A via between `layer` and `layer + 1` (layer 1 = the M1 pin of a cell). */
export interface Via { layer: number; x: number; y: number }
export interface RoutedNet { id: number; name: string; wires: Wire[]; vias: Via[]; length: number; ok: boolean }
export interface Routing {
  layers: number;
  nets: RoutedNet[];
  /** Grid points used by more than one net after the last iteration. */
  overflow: number;
  unrouted: string[];
  iterations: number;
  wirelength: number;
  viaCount: number;
  /** Columns of the power straps (VDD, VSS) on M3, blocked for signals. */
  straps: [number, number];
}
export interface RouteOptions { layers?: number; maxIterations?: number }

/** Power straps on M3 in the margins (VDD left, VSS right) and the via stacks down to the M1 rails of each row boundary. */
export function powerGrid(p: Placement): { straps: { net: 'VDD' | 'VSS'; x: number }[]; vias: { net: 'VDD' | 'VSS'; x: number; y: number }[] } {
  const straps = [{ net: 'VDD' as const, x: 2 }, { net: 'VSS' as const, x: p.dieW - 3 }];
  const vias: { net: 'VDD' | 'VSS'; x: number; y: number }[] = [];
  // boundary b between rows b-1 and b: VSS for even b, VDD for odd b (rows alternate N / FS)
  for (let b = 0; b <= p.rows; b++) {
    const net = b % 2 ? 'VDD' : 'VSS';
    const y = p.margin + ROW_TRACKS * b - (b === p.rows ? 1 : 0);
    vias.push({ net, x: straps.find(s => s.net === net)!.x, y });
  }
  return { straps, vias };
}

/** M2 and M4 prefer horizontal wires, M3 and M5 vertical ones. */
export const horizontal = (layer: number) => layer % 2 === 0;

const WRONG_WAY = 3, VIA = 3;

class Heap {
  k: number[] = []; v: number[] = [];
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop(): number {
    const k = this.k, v = this.v, top = v[0], lk = k.pop()!, lv = v.pop()!;
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
  get size() { return this.k.length; }
}

export function route(nl: Netlist, p: Placement, o: RouteOptions = {}): Routing {
  const L = Math.min(4, Math.max(2, o.layers ?? 3));
  const W = p.dieW, H = p.dieH, plane = W * H, N = plane * L;
  // node = (layerIndex * H + y) * W + x, layerIndex 0 = M2
  const node = (li: number, x: number, y: number) => (li * H + y) * W + x;
  const owner = new Int32Array(N).fill(-1);     // reserved for one net (pins, ports); -2 = blocked
  const occ = new Int16Array(N);
  const hist = new Float32Array(N);
  const pg = powerGrid(p);
  const straps: [number, number] = [pg.straps[0].x, pg.straps[1].x];
  // power straps on M3 along the core, and their M2 landing points on the rail vias
  for (const sx of straps) for (let y = p.margin; y <= H - p.margin - 1; y++) owner[node(1, sx, y)] = -2;
  for (const v of pg.vias) owner[node(0, v.x, v.y)] = -2;
  const nets = nl.nets.map((net, ni) => {
    const terms: number[] = [];
    for (const t of net.pins) { const [x, y] = pinXY(p, nl, t.cell, t.pin); terms.push(node(0, x, y)); }
    for (const q of net.ports) { const pp = p.ports[q]; terms.push(node(pp.layer - 2, pp.x, pp.y)); }
    for (const t of terms) owner[t] = ni;
    return { net, terms: [...new Set(terms)], path: [] as number[], parent: new Map<number, number>() };
  });
  const gScore = new Float64Array(N);
  const from = new Int32Array(N);
  const stamp = new Int32Array(N);
  let epoch = 0;
  let pres = 0.6;

  const cost = (n: number, ni: number) => {
    const ow = owner[n];
    if (ow === -2 || (ow >= 0 && ow !== ni)) return Infinity;
    const over = occ[n];          // other nets already here (this net's own nodes are free)
    return (1 + hist[n]) * (1 + pres * over);
  };

  /** A* from all nodes of the current tree to `target`; returns the new path (target first) or null. */
  const search = (tree: Set<number>, target: number, ni: number, mine: Set<number>): number[] | null => {
    epoch++;
    const tx = target % W, ty = Math.floor(target / W) % H;
    const h = (n: number) => { const x = n % W, y = Math.floor(n / W) % H; return Math.abs(x - tx) + Math.abs(y - ty); };
    const heap = new Heap();
    for (const s of tree) { stamp[s] = epoch; gScore[s] = 0; from[s] = -1; heap.push(h(s), s); }
    while (heap.size) {
      const u = heap.pop();
      if (u === target) {
        const path: number[] = [];
        for (let v = u; v !== -1 && !tree.has(v); v = from[v]) path.push(v);
        const last = path.length ? from[path[path.length - 1]] : -1;
        if (last >= 0) path.push(last);
        return path;
      }
      const gu = gScore[u];
      const li = Math.floor(u / plane), x = u % W, y = Math.floor(u / W) % H;
      const hor = horizontal(li + 2);
      const step = (v: number, base: number) => {
        const c = mine.has(v) ? 0.01 : base * cost(v, ni);
        if (c === Infinity) return;
        const g = gu + c;
        if (stamp[v] === epoch && g >= gScore[v]) return;
        stamp[v] = epoch; gScore[v] = g; from[v] = u;
        heap.push(g + h(v), v);
      };
      if (x > 0) step(u - 1, hor ? 1 : WRONG_WAY);
      if (x < W - 1) step(u + 1, hor ? 1 : WRONG_WAY);
      if (y > 0) step(u - W, hor ? WRONG_WAY : 1);
      if (y < H - 1) step(u + W, hor ? WRONG_WAY : 1);
      if (li > 0) step(u - plane, VIA);
      if (li < L - 1) step(u + plane, VIA);
    }
    return null;
  };

  const rip = (r: typeof nets[number]) => { for (const n of r.path) occ[n]--; r.path = []; r.parent.clear(); };

  const routeNet = (ni: number): boolean => {
    const r = nets[ni];
    rip(r);
    if (r.terms.length < 2) return true;
    const tree = new Set<number>([r.terms[0]]);
    const left = new Set(r.terms.slice(1));
    let ok = true;
    while (left.size) {
      // the remaining terminal closest to the tree's bounding box centre of mass
      let best = -1, bd = Infinity;
      for (const t of left) {
        const tx = t % W, ty = Math.floor(t / W) % H;
        for (const s of tree) {
          const d = Math.abs(s % W - tx) + Math.abs(Math.floor(s / W) % H - ty);
          if (d < bd) { bd = d; best = t; }
        }
      }
      left.delete(best);
      if (tree.has(best)) continue;
      const path = search(tree, best, ni, tree);
      if (!path) { ok = false; continue; }
      for (let k = 0; k + 1 < path.length; k++) r.parent.set(path[k], path[k + 1]);
      for (const n of path) tree.add(n);
    }
    r.path = [...tree];
    for (const n of r.path) occ[n]++;
    return ok;
  };

  // short nets first: they have the least freedom
  const order = nets.map((_, i) => i).sort((a, b) => spanOf(a) - spanOf(b));
  function spanOf(i: number) {
    const t = nets[i].terms;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const n of t) { const x = n % W, y = Math.floor(n / W) % H; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return x1 - x0 + y1 - y0;
  }
  const failed = new Set<number>();
  for (const i of order) if (!routeNet(i)) failed.add(i);
  let iterations = 1;
  const maxIt = o.maxIterations ?? 40;
  const overused = () => { let c = 0; for (let n = 0; n < N; n++) if (occ[n] > 1) c++; return c; };
  let over = overused();
  while ((over > 0 || failed.size) && iterations < maxIt) {
    for (let n = 0; n < N; n++) if (occ[n] > 1) hist[n] += 0.4 * (occ[n] - 1);
    pres *= 1.6;
    const redo = order.filter(i => failed.has(i) || nets[i].path.some(n => occ[n] > 1));
    failed.clear();
    for (const i of redo) if (!routeNet(i)) failed.add(i);
    over = overused();
    iterations++;
  }
  // geometry: straight runs per layer and vias
  const out: RoutedNet[] = nets.map((r, ni) => {
    const wires: Wire[] = [], vias: Via[] = [];
    let length = 0;
    for (const [a, b] of r.parent) {
      const la = Math.floor(a / plane), lb = Math.floor(b / plane);
      const ax = a % W, ay = Math.floor(a / W) % H, bx = b % W, by = Math.floor(b / W) % H;
      if (la !== lb) vias.push({ layer: Math.min(la, lb) + 2, x: ax, y: ay });
      else { wires.push({ layer: la + 2, x1: Math.min(ax, bx), y1: Math.min(ay, by), x2: Math.max(ax, bx), y2: Math.max(ay, by) }); length++; }
    }
    // via1 down to every cell pin
    for (const t of r.net.pins) { const [x, y] = pinXY(p, nl, t.cell, t.pin); vias.push({ layer: 1, x, y }); }
    return { id: r.net.id, name: r.net.name, wires: mergeWires(wires), vias, length, ok: !failed.has(ni) };
  });
  const unrouted = out.filter(r => !r.ok).map(r => r.name);
  return {
    layers: L, nets: out, overflow: over, unrouted, iterations, straps,
    wirelength: out.reduce((s, r) => s + r.length, 0),
    viaCount: out.reduce((s, r) => s + r.vias.length, 0),
  };
}

/** Join unit grid segments into maximal straight wires. */
export function mergeWires(ws: Wire[]): Wire[] {
  const out: Wire[] = [];
  const key = (w: Wire, hor: boolean) => `${w.layer}:${hor ? 'h' : 'v'}:${hor ? w.y1 : w.x1}`;
  const groups = new Map<string, Wire[]>();
  for (const w of ws) {
    const hor = w.y1 === w.y2;
    const k = key(w, hor);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(w);
  }
  for (const [k, g] of groups) {
    const hor = k.includes(':h:');
    g.sort((a, b) => (hor ? a.x1 - b.x1 : a.y1 - b.y1));
    let cur = { ...g[0] };
    for (const w of g.slice(1)) {
      if (hor ? w.x1 <= cur.x2 : w.y1 <= cur.y2) { if (hor) cur.x2 = Math.max(cur.x2, w.x2); else cur.y2 = Math.max(cur.y2, w.y2); }
      else { out.push(cur); cur = { ...w }; }
    }
    out.push(cur);
  }
  return out;
}

/**
 * Independent check of a routing from its geometry: shorts (grid points of one layer used by two nets, or by a net
 * and a power strap) and opens (terminals of a net not connected by its wires and vias).
 */
export function verifyRouting(nl: Netlist, p: Placement, r: Routing): { shorts: { layer: number; x: number; y: number; nets: string[] }[]; opens: string[] } {
  const used = new Map<string, Set<string>>();
  const mark = (layer: number, x: number, y: number, net: string) => {
    const k = `${layer},${x},${y}`;
    (used.get(k) ?? used.set(k, new Set()).get(k)!).add(net);
  };
  const pg = powerGrid(p);
  for (const s of pg.straps) for (let y = p.margin; y <= p.dieH - p.margin - 1; y++) mark(3, s.x, y, s.net);
  for (const v of pg.vias) mark(2, v.x, v.y, v.net);
  const opens: string[] = [];
  const netById = new Map(nl.nets.map(n => [n.id, n]));
  for (const rn of r.nets) {
    // union-find over the grid points of this net
    const parent = new Map<string, string>();
    const find = (a: string): string => { let x = a; while (parent.get(x) !== x) x = parent.get(x)!; parent.set(a, x); return x; };
    const add = (k: string) => { if (!parent.has(k)) parent.set(k, k); };
    const join = (a: string, b: string) => { add(a); add(b); parent.set(find(a), find(b)); };
    for (const w of rn.wires) {
      let prev: string | null = null;
      for (let x = w.x1; x <= w.x2; x++) for (let y = w.y1; y <= w.y2; y++) {
        const k = `${w.layer},${x},${y}`;
        mark(w.layer, x, y, rn.name);
        add(k);
        if (prev) join(prev, k);
        prev = k;
      }
    }
    for (const v of rn.vias) {
      if (v.layer === 1) { add(`2,${v.x},${v.y}`); mark(2, v.x, v.y, rn.name); continue; }
      join(`${v.layer},${v.x},${v.y}`, `${v.layer + 1},${v.x},${v.y}`);
      mark(v.layer, v.x, v.y, rn.name); mark(v.layer + 1, v.x, v.y, rn.name);
    }
    const net = netById.get(rn.id)!;
    const terms = [
      ...net.pins.map(t => { const [x, y] = pinXY(p, nl, t.cell, t.pin); return `2,${x},${y}`; }),
      ...net.ports.map(q => `${p.ports[q].layer},${p.ports[q].x},${p.ports[q].y}`),
    ];
    for (const t of terms) { add(t); mark(Number(t.split(',')[0]), Number(t.split(',')[1]), Number(t.split(',')[2]), rn.name); }
    if (new Set(terms.map(find)).size > 1) opens.push(rn.name);
  }
  const shorts = [...used].filter(([, s]) => s.size > 1).map(([k, s]) => { const [layer, x, y] = k.split(',').map(Number); return { layer, x, y, nets: [...s] }; });
  return { shorts, opens };
}
