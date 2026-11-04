// Parasitic extraction for the ASIC flow (#58): an RC tree per routed net from the wire and via geometry (invented
// layer constants: sheet resistance, area and fringe capacitance to ground, via resistance; no coupling), Elmore delays
// from the driver to every sink, and SPEF (IEEE 1481) output.
import { TRACK, pinCap } from './cells';
import type { Netlist } from './netlist';
import type { Placement } from './place';
import { pinXY } from './place';
import type { Routing } from './route';

/** Per routing layer (index = metal number): sheet resistance (ohm/sq), area cap (aF/um^2), fringe cap per edge (aF/um). */
export const LAYER_RC: Record<number, { rs: number; area: number; fringe: number }> = {
  2: { rs: 0.4, area: 40, fringe: 40 },
  3: { rs: 0.4, area: 40, fringe: 40 },
  4: { rs: 0.15, area: 25, fringe: 35 },
  5: { rs: 0.15, area: 25, fringe: 35 },
};
/** Via resistance by lower layer (via1 = M1-M2), ohm. */
export const VIA_R: Record<number, number> = { 1: 6, 2: 4, 3: 4, 4: 2 };
/** Drawn wire width, nm. */
export const WIRE_W = TRACK / 2;

/** One track of wire on a layer: resistance (ohm) and capacitance (fF). */
export function trackRC(layer: number): { r: number; c: number } {
  const k = LAYER_RC[layer] ?? LAYER_RC[2];
  const len = TRACK / 1000, w = WIRE_W / 1000;
  return { r: k.rs * (len / w), c: (k.area * len * w + 2 * k.fringe * len) / 1000 };
}

export interface RcNode { name: string; c: number }
export interface RcNet {
  id: number; name: string;
  /** Node 0 is the driver (cell output pin or input port). */
  nodes: RcNode[];
  res: { a: number; b: number; r: number }[];
  /** Terminals: cell pins "cell:pin" (or ports) and their node, direction and Elmore delay from the driver (ns). */
  terms: { name: string; node: number; dir: 'I' | 'O' | 'B'; port: boolean; elmore: number }[];
  /** Wire capacitance (fF) and total capacitance including pins (fF). */
  wireC: number; totalC: number;
}
export interface Parasitics {
  nets: Map<number, RcNet>;
  /** Wire delay from the driver of a net to a sink ("cell/pin" or a port name), ns. */
  delay(net: number, sink: string): number;
}

const ln9 = Math.log(9);
/** Transition at a sink after an RC wire with Elmore delay `d` (PERI-style combination). */
export const wireSlew = (slew: number, d: number) => (d > 0 ? Math.sqrt(slew * slew + (ln9 * d) ** 2) : slew);

/**
 * Elmore delay (ns) from `root` to every node of an RC network (node capacitance in fF, resistors in ohm), over a
 * breadth-first spanning tree: delay(n) = delay(parent) + R(parent, n) x (capacitance downstream of n).
 */
export function elmore(cap: number[], res: { a: number; b: number; r: number }[], root: number): Float64Array {
  const n = cap.length, adj: { to: number; r: number }[][] = cap.map(() => []);
  for (const e of res) { adj[e.a].push({ to: e.b, r: e.r }); adj[e.b].push({ to: e.a, r: e.r }); }
  const parent = new Int32Array(n).fill(-1), pr = new Float64Array(n), order = [root], seen = new Uint8Array(n);
  seen[root] = 1;
  for (let i = 0; i < order.length; i++) for (const e of adj[order[i]]) if (!seen[e.to]) { seen[e.to] = 1; parent[e.to] = order[i]; pr[e.to] = e.r; order.push(e.to); }
  const down = Float64Array.from(cap);
  for (let i = order.length - 1; i > 0; i--) down[parent[order[i]]] += down[order[i]];
  const d = new Float64Array(n);
  for (let i = 1; i < order.length; i++) { const v = order[i]; d[v] = d[parent[v]] + pr[v] * down[v] * 1e-6; } // ohm x fF = 1e-6 ns
  return d;
}

export function extract(nl: Netlist, p: Placement, r: Routing): Parasitics {
  const nets = new Map<number, RcNet>();
  const byId = new Map(nl.nets.map(n => [n.id, n]));
  for (const rn of r.nets) {
    const net = byId.get(rn.id);
    if (!net) continue;
    const idx = new Map<string, number>(), nodes: RcNode[] = [];
    const node = (k: string) => { let i = idx.get(k); if (i === undefined) { i = nodes.length; idx.set(k, i); nodes.push({ name: '', c: 0 }); } return i; };
    const res: RcNet['res'] = [];
    const link = (a: number, b: number, rr: number) => { res.push({ a, b, r: rr }); };
    // terminals first so the driver can become node 0
    const terms: RcNet['terms'] = [];
    for (const t of net.pins) {
      const [x, y] = pinXY(p, nl, t.cell, t.pin), c = nl.cells[t.cell];
      const out = c.def.output === t.pin;
      terms.push({ name: `${c.name}:${t.pin}`, node: node(`1,${x},${y}`), dir: out ? 'O' : 'I', port: false, elmore: 0 });
      if (!out) nodes[idx.get(`1,${x},${y}`)!].c += pinCap(c.def) * 1000;
    }
    for (const q of net.ports) {
      const pp = p.ports[q], port = nl.ports[q];
      terms.push({ name: port.name, node: node(`${pp.layer},${pp.x},${pp.y}`), dir: port.dir === 'input' ? 'I' : 'O', port: true, elmore: 0 });
    }
    let wireC = 0;
    // a node on every track crossing, so vias in the middle of a straight wire connect
    for (const w of rn.wires) {
      const { r: rr, c } = trackRC(w.layer);
      const steps = (w.x2 - w.x1) + (w.y2 - w.y1), dx = Math.sign(w.x2 - w.x1), dy = Math.sign(w.y2 - w.y1);
      for (let k = 0; k < steps; k++) {
        const a = node(`${w.layer},${w.x1 + k * dx},${w.y1 + k * dy}`), b = node(`${w.layer},${w.x1 + (k + 1) * dx},${w.y1 + (k + 1) * dy}`);
        link(a, b, rr);
        nodes[a].c += c / 2; nodes[b].c += c / 2; wireC += c;
      }
    }
    for (const v of rn.vias) link(node(`${v.layer},${v.x},${v.y}`), node(`${v.layer + 1},${v.x},${v.y}`), VIA_R[v.layer] ?? 4);
    // the driver: a cell output (SPEF direction O) or an input port (an input of the design drives the net)
    const drv = terms.find(t => !t.port && t.dir === 'O') ?? terms.find(t => t.port && t.dir === 'I');
    const root = drv?.node ?? 0;
    const delay = elmore(nodes.map(n => n.c), res, root);
    for (const t of terms) t.elmore = delay[t.node];
    // renumber: driver first, terminals by name, internal nodes net:1, net:2, ...
    const totalC = nodes.reduce((s, n) => s + n.c, 0);
    let k = 0;
    for (const t of terms) nodes[t.node].name ||= t.name;
    nodes.forEach(n => { if (!n.name) n.name = `${rn.name}:${++k}`; });
    if (root !== 0) { [nodes[0], nodes[root]] = [nodes[root], nodes[0]]; const sw = (i: number) => (i === 0 ? root : i === root ? 0 : i); for (const e of res) { e.a = sw(e.a); e.b = sw(e.b); } for (const t of terms) t.node = sw(t.node); }
    nets.set(rn.id, { id: rn.id, name: rn.name, nodes, res, terms, wireC, totalC });
  }
  const sinkKey = (s: string) => s.replace('/', ':');
  return {
    nets,
    delay(net, sink) { const n = nets.get(net); if (!n) return 0; const k = sinkKey(sink); return n.terms.find(t => t.name === k)?.elmore ?? 0; },
  };
}

/** SPEF of the extracted parasitics (capacitance in fF, resistance in ohm). */
export function writeSpef(nl: Netlist, px: Parasitics, date = new Date()): string {
  const o = [
    '*SPEF "IEEE 1481-1998"', `*DESIGN "${nl.top}"`, `*DATE "${date.toISOString()}"`, '*VENDOR "WebSim"', '*PROGRAM "WebSim ASIC flow"',
    '*VERSION "1.0"', '*DESIGN_FLOW "EXTERNAL_LOADS" "PIN_CAP NONE" "NAME_SCOPE LOCAL"', '*DIVIDER /', '*DELIMITER :', '*BUS_DELIMITER [ ]',
    '*T_UNIT 1 NS', '*C_UNIT 1 FF', '*R_UNIT 1 OHM', '*L_UNIT 1 HENRY', '',
  ];
  const nets = [...px.nets.values()];
  const map = new Map(nets.map((n, i) => [n.name, `*${i + 1}`]));
  o.push('*NAME_MAP', ...nets.map(n => `${map.get(n.name)} ${n.name}`), '');
  o.push('*PORTS', ...nl.ports.map(q => `${q.name} ${q.dir === 'input' ? 'I' : 'O'}`), '');
  const ref = (n: RcNet, i: number) => {
    const nm = n.nodes[i].name;
    if (n.terms.some(t => t.name === nm)) return nm;
    return `${map.get(n.name)}:${nm.slice(nm.lastIndexOf(':') + 1)}`;
  };
  const f = (v: number) => v.toFixed(5).replace(/\.?0+$/, '') || '0';
  for (const n of nets) {
    o.push(`*D_NET ${map.get(n.name)} ${f(n.wireC)}`, '*CONN');
    for (const t of n.terms) {
      if (t.port) o.push(`*P ${t.name} ${t.dir}`);
      else { const cell = nl.cells.find(c => c.name === t.name.split(':')[0]); o.push(`*I ${t.name} ${t.dir}${t.dir === 'I' ? ` *L ${f((cell ? pinCap(cell.def) : 0) * 1000)}` : ` *D ${cell?.type ?? ''}`}`); }
    }
    o.push('*CAP');
    let k = 0;
    const pinC = (i: number) => { const t = n.terms.find(t => t.node === i && !t.port && t.dir === 'I'); const cell = t && nl.cells.find(c => c.name === t.name.split(':')[0]); return cell ? pinCap(cell.def) * 1000 : 0; };
    n.nodes.forEach((nd, i) => { const c = nd.c - pinC(i); if (c > 1e-9) o.push(`${++k} ${ref(n, i)} ${f(c)}`); });
    o.push('*RES');
    n.res.forEach((e, i) => o.push(`${i + 1} ${ref(n, e.a)} ${ref(n, e.b)} ${f(e.r)}`));
    o.push('*END', '');
  }
  return o.join('\n');
}
