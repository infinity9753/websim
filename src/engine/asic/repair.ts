// Timing repair for the ASIC flow (#68), in the spirit of repair_timing in physical design tools: before placement,
// with the STA's delay calculation (no wires yet), upsize the cells on violating setup paths (X1 -> X2 -> X4; a change
// is kept only when the worst slack improves) and fix hold violations at flip-flop inputs with delay cells (as long as
// that endpoint still meets setup).
import { CELL, upsize } from './cells';
import type { Netlist } from './netlist';
import type { Sdc } from './sdc';
import { sta, type StaResult } from './sta';

export interface RepairResult {
  upsized: number; buffers: number;
  before: { wns: number; whs: number }; after: { wns: number; whs: number };
  log: string[];
}

export function repairTiming(nl: Netlist, sdc: Sdc, o: { maxPasses?: number; maxBuffers?: number; /** STA of the current netlist (default: no wires). */ run?: () => StaResult } = {}): RepairResult {
  const run = o.run ?? ((): StaResult => sta(nl, undefined, sdc).res);
  let res = run();
  const before = { wns: res.wns, whs: res.whs }, log: string[] = [];
  const byName = new Map(nl.cells.map((c, i) => [c.name, i]));
  const sized = new Set<number>();
  // setup: upsize along the worst path while it helps
  for (let pass = 0; pass < (o.maxPasses ?? 40) && res.wns < 0; pass++) {
    const path = res.setup[0];
    const cells = [...new Set(path.points.filter(p => p.out && p.cell).map(p => byName.get(p.cell!)!))].filter(i => nl.cells[i].def.kind === 'comb').reverse();
    let improved = false;
    for (const ci of cells) {
      const c = nl.cells[ci], up = upsize(c.def);
      if (!up) continue;
      const old = c.def;
      c.def = up; c.type = up.name;
      const r2 = run();
      if (r2.wns > res.wns + 1e-6 && r2.whs >= Math.min(res.whs, 0) - 1e-9) { res = r2; improved = true; sized.add(ci); log.push(`upsized ${c.name} ${old.name} -> ${up.name}: WNS ${r2.wns.toFixed(3)} ns`); }
      else { c.def = old; c.type = old.name; }
    }
    if (!improved) break;
  }
  // hold: delay cells in front of flip-flop inputs
  const dly = CELL.get('DLY')!;
  let buffers = 0, nextId = Math.max(0, ...nl.nets.map(n => n.id)) + 1;
  const insert = (ci: number, pin: string) => {
    const ff = nl.cells[ci], old = ff.pins[pin], net = nl.nets.find(n => n.id === old)!;
    const id = nextId++, k = nl.cells.length;
    let name = `hold_${k}_`;
    while (nl.cells.some(c => c.name === name)) name += 'x';
    net.pins = net.pins.filter(t => !(t.cell === ci && t.pin === pin));
    net.pins.push({ cell: k, pin: 'A' });
    nl.nets.push({ id, name: `${name}n`, pins: [{ cell: k, pin: 'Y' }, { cell: ci, pin }], ports: [] });
    nl.cells.push({ name, type: dly.name, def: dly, pins: { A: old, Y: id } });
    ff.pins[pin] = id;
    buffers++;
  };
  const remove = (ci: number, pin: string) => {
    const k = nl.cells.length - 1, d = nl.cells[k], id = d.pins.Y, old = d.pins.A;
    const net = nl.nets.find(n => n.id === old)!;
    net.pins = net.pins.filter(t => t.cell !== k);
    net.pins.push({ cell: ci, pin });
    nl.nets = nl.nets.filter(n => n.id !== id);
    nl.cells.pop();
    nl.cells[ci].pins[pin] = old;
    buffers--;
  };
  for (const v of res.hold.filter(p => p.slack < -1e-9)) {
    const [cname, pin] = v.endpoint.split('/');
    const ci = byName.get(cname);
    if (ci === undefined || !pin || !nl.cells[ci].def.ff) { log.push(`hold violation at ${v.endpoint}: not a flip-flop input, left alone`); continue; }
    const setupOf = (r: StaResult) => r.setup.find(p => p.endpoint === v.endpoint)?.slack ?? Infinity;
    let r = res, n = 0;
    while ((r.hold.find(p => p.endpoint === v.endpoint)?.slack ?? 0) < -1e-9 && n < (o.maxBuffers ?? 8)) {
      insert(ci, pin); n++;
      const r2 = run();
      if (setupOf(r2) < Math.min(0, setupOf(r)) - 1e-9) { remove(ci, pin); n--; log.push(`hold at ${v.endpoint}: another delay cell would break setup`); break; }
      r = r2;
    }
    if (n) log.push(`${n} delay cell(s) before ${v.endpoint}: hold slack ${(r.hold.find(p => p.endpoint === v.endpoint)?.slack ?? 0).toFixed(3)} ns`);
    res = r;
  }
  return { upsized: sized.size, buffers, before, after: { wns: res.wns, whs: res.whs }, log };
}
