// Static timing estimate for the ASIC flow (#51): Liberty-style delays (intrinsic + slope x load), loads from pin
// capacitance and routed wire length, ideal clock. Educational: no slews, no setup tables, no clock skew.
import type { Netlist } from './netlist';
import type { Routing } from './route';

export const PIN_FF = 2;          // input pin capacitance, fF
export const WIRE_FF = 0.03;      // fF per track of routed wire
export const OUT_FF = 10;         // load on an output port, fF
export const SETUP = 0.05;        // flip-flop setup time, ns

export interface TimingPath { delay: number; points: { at: string; time: number }[] }
export interface Timing {
  /** Worst register-to-register (or input-to-register) path including setup, ns. */
  critical: TimingPath | null;
  /** Worst path to an output port, ns. */
  output: TimingPath | null;
  fmax: number | null;
  loops: number;
}

export function analyze(nl: Netlist, r?: Routing): Timing {
  const len = new Map(r?.nets.map(n => [n.id, n.length]) ?? []);
  const netById = new Map(nl.nets.map(n => [n.id, n]));
  const load = (id: number) => {
    const n = netById.get(id)!;
    return n.pins.filter(t => nl.cells[t.cell].def.output !== t.pin).length * PIN_FF + n.ports.filter(q => nl.ports[q].dir === 'output').length * OUT_FF + (len.get(id) ?? 0) * WIRE_FF;
  };
  const delayOf = (c: number) => { const cell = nl.cells[c]; const out = cell.pins[cell.def.output!]; return cell.def.delay + cell.def.slope * (out === undefined ? 0 : load(out)); };
  // arrival time per net and the path that set it
  const arr = new Map<number, number>(), prev = new Map<number, { net: number | null; cell: number }>();
  const done = new Set<number>(), busy = new Set<number>();
  let loops = 0;
  for (const q of nl.ports) if (q.dir === 'input') { arr.set(q.net, 0); done.add(q.net); }
  const visit = (id: number): number => {
    if (done.has(id)) return arr.get(id)!;
    if (busy.has(id)) { loops++; return 0; }
    busy.add(id);
    const net = netById.get(id)!;
    let t = arr.get(id) ?? 0;
    for (const term of net.pins) {
      const cell = nl.cells[term.cell];
      if (cell.def.output !== term.pin) continue;
      if (cell.def.ff || cell.def.kind === 'tie') {
        const d = cell.def.ff ? delayOf(term.cell) : 0;
        if (d >= t) { t = d; prev.set(id, { net: null, cell: term.cell }); }
        continue;
      }
      for (const inp of cell.def.inputs) {
        const src = cell.pins[inp];
        if (src === undefined) continue;
        const v = visit(src) + delayOf(term.cell);
        if (v >= t) { t = v; prev.set(id, { net: src, cell: term.cell }); }
      }
    }
    busy.delete(id);
    done.add(id);
    arr.set(id, t);
    return t;
  };
  const trace = (id: number, end: string, extra: number): TimingPath => {
    const pts: TimingPath['points'] = [];
    let cur: number | null = id;
    while (cur !== null) {
      const pv = prev.get(cur);
      pts.unshift({ at: pv ? `${nl.cells[pv.cell].name}/${nl.cells[pv.cell].def.output} (${nl.cells[pv.cell].type})` : netById.get(cur)!.name, time: arr.get(cur)! });
      cur = pv ? pv.net : null;
      if (pv && pv.net === null) break;
    }
    const delay = arr.get(id)! + extra;
    pts.push({ at: end, time: delay });
    return { delay, points: pts };
  };
  let critical: TimingPath | null = null, output: TimingPath | null = null;
  nl.cells.forEach(c => {
    if (!c.def.ff) return;
    const d = c.pins[c.def.ff.d];
    if (d === undefined) return;
    const t = visit(d) + SETUP;
    if (!critical || t > critical.delay) critical = trace(d, `${c.name}/${c.def.ff.d} (setup)`, SETUP);
  });
  for (const q of nl.ports) {
    if (q.dir !== 'output') continue;
    const t = visit(q.net);
    if (!output || t > output.delay) output = trace(q.net, `${q.name} (output)`, 0);
  }
  const crit = critical as TimingPath | null;
  return { critical: crit, output, fmax: crit ? 1000 / crit.delay : null, loops };
}
