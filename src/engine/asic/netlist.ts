// Gate-level netlist of the ASIC flow (#51), read from the Yosys JSON written by synth -target asic.
import { CELL, type CellDef } from './cells';

export interface NCell { name: string; type: string; def: CellDef; pins: Record<string, number> }
export interface NPort { name: string; dir: 'input' | 'output'; net: number }
export interface NNet { id: number; name: string; pins: { cell: number; pin: string }[]; ports: number[] }
export interface Netlist { top: string; cells: NCell[]; nets: NNet[]; ports: NPort[] }

interface YJson {
  modules: Record<string, {
    ports: Record<string, { direction: string; bits: (number | string)[] }>;
    cells: Record<string, { type: string; connections: Record<string, (number | string)[]> }>;
    netnames: Record<string, { hide_name: number; bits: (number | string)[] }>;
  }>;
}

/** Cells, nets (by Yosys bit id) and port bits of `top`. */
export function readNetlist(json: string, top: string): Netlist {
  const mod = (JSON.parse(json) as YJson).modules[top];
  if (!mod) throw new Error(`no module "${top}" in the netlist`);
  const nets = new Map<number, NNet>();
  const net = (b: number | string, where: string): NNet => {
    if (typeof b !== 'number') throw new Error(`${where} is tied to constant '${b}' (expected TIEHI/TIELO cells)`);
    let n = nets.get(b);
    if (!n) { n = { id: b, name: `n${b}`, pins: [], ports: [] }; nets.set(b, n); }
    return n;
  };
  // readable net names: public names first, the shortest one wins
  const names = Object.entries(mod.netnames).sort(([a, x], [b, y]) => x.hide_name - y.hide_name || a.length - b.length);
  for (const [name, nn] of names.reverse()) {
    nn.bits.forEach((b, i) => { if (typeof b === 'number') net(b, name).name = nn.bits.length > 1 ? `${name}[${i}]` : name; });
  }
  const ports: NPort[] = [];
  for (const [name, p] of Object.entries(mod.ports)) {
    if (p.direction !== 'input' && p.direction !== 'output') throw new Error(`port ${name}: ${p.direction} ports are not supported`);
    p.bits.forEach((b, i) => {
      const n = net(b, `port ${name}`);
      n.ports.push(ports.length);
      ports.push({ name: p.bits.length > 1 ? `${name}[${i}]` : name, dir: p.direction as NPort['dir'], net: n.id });
    });
  }
  const cells: NCell[] = [];
  for (const [name, c] of Object.entries(mod.cells)) {
    const def = CELL.get(c.type);
    if (!def) throw new Error(`cell ${name}: "${c.type}" is not in the standard-cell library (synthesize with -target asic)`);
    const pins: Record<string, number> = {};
    for (const [pin, bits] of Object.entries(c.connections)) {
      if (!(pin in def.pins)) throw new Error(`cell ${name} (${c.type}) has no pin ${pin}`);
      const n = net(bits[0], `${name}.${pin}`);
      pins[pin] = n.id;
      n.pins.push({ cell: cells.length, pin });
    }
    cells.push({ name, type: c.type, def, pins });
  }
  return { top, cells, nets: [...nets.values()].filter(n => n.pins.length + n.ports.length > 0), ports };
}
