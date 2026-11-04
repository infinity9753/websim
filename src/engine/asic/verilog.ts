// Gate-level Verilog of the (possibly repaired) netlist (#68): what the layout contains, for post-layout simulation
// with the flow's SDF. Ports keep their bus form; nets that are not ports become _n<id>_ wires.
import type { Netlist } from './netlist';

const ident = (s: string) => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(s) ? s : `\\${s} `);

export function writeVerilog(nl: Netlist): string {
  // ports grouped into buses: name -> direction and width
  const buses = new Map<string, { dir: string; width: number; bus: boolean }>();
  for (const p of nl.ports) {
    const m = /^(.*)\[(\d+)\]$/.exec(p.name);
    const name = m ? m[1] : p.name, bit = m ? Number(m[2]) : 0;
    const b = buses.get(name) ?? { dir: p.dir, width: 0, bus: !!m };
    b.width = Math.max(b.width, bit + 1);
    buses.set(name, b);
  }
  const ref = (pname: string) => { const m = /^(.*)\[(\d+)\]$/.exec(pname); return m ? `${ident(m[1])}[${m[2]}]` : ident(pname); };
  // the expression of each net: its first port (an input port first: it drives the net), else a wire
  const expr = new Map<number, string>(), wires: string[] = [], assigns: string[] = [];
  for (const n of nl.nets) {
    const ports = n.ports.map(q => nl.ports[q]).sort((a, b) => (a.dir === b.dir ? 0 : a.dir === 'input' ? -1 : 1));
    if (ports.length) {
      expr.set(n.id, ref(ports[0].name));
      for (const q of ports.slice(1)) assigns.push(`  assign ${ref(q.name)} = ${ref(ports[0].name)};`);
    } else { expr.set(n.id, `_n${n.id}_`); wires.push(`_n${n.id}_`); }
  }
  const o = [
    `// ${nl.top}: gate-level netlist of the WebSim ASIC flow (after timing repair, if any)`,
    `module ${ident(nl.top)}(${[...buses.keys()].map(ident).join(', ')});`,
    ...[...buses].map(([name, b]) => `  ${b.dir} ${b.bus ? `[${b.width - 1}:0] ` : ''}${ident(name)};`),
  ];
  for (let i = 0; i < wires.length; i += 12) o.push(`  wire ${wires.slice(i, i + 12).join(', ')};`);
  o.push(...assigns);
  for (const c of nl.cells) {
    const conns = Object.entries(c.pins).map(([pin, net]) => `.${pin}(${expr.get(net) ?? ''})`);
    o.push(`  ${c.type} ${ident(c.name)} (${conns.join(', ')});`);
  }
  o.push('endmodule', '');
  return o.join('\n');
}
