// SDF of the placed and routed design (#56, #57): IOPATH delays per arc from the STA's NLDM delay calculation
// (rise = the slow corner of the table, fall = its fall table) and the flip-flop timing checks. With parasitics the
// largest Elmore wire delay of the output net is added to the driver's IOPATH (WebSim reads no INTERCONNECT).
import { LIB_NAME } from './cells';
import type { Netlist } from './netlist';
import type { Routing } from './route';
import { emptySdc, type Sdc } from './sdc';
import { Graph } from './sta';
import type { Parasitics } from './rc';

const v = (x: number) => `(${x.toFixed(4)}:${x.toFixed(4)}:${x.toFixed(4)})`;
const esc = (s: string) => s.replace(/[^A-Za-z0-9_]/g, c => '\\' + c);

export function writeSdf(nl: Netlist, r?: Routing, sdc: Sdc = emptySdc(), px?: Parasitics, date = new Date()): string {
  const g = new Graph(nl, r, sdc, px);
  const wire = (ci: number) => { const net = nl.cells[ci].pins[nl.cells[ci].def.output!]; const n = net === undefined ? undefined : px?.nets.get(net); return n ? Math.max(0, ...n.terms.map(t => t.elmore)) : 0; };
  const o = [
    '(DELAYFILE', '  (SDFVERSION "3.0")', `  (DESIGN "${nl.top}")`, `  (DATE "${date.toISOString()}")`,
    '  (VENDOR "WebSim")', '  (PROGRAM "WebSim ASIC flow")', `  (VERSION "${LIB_NAME}")`,
    '  (DIVIDER /)', '  (TIMESCALE 1ns)',
  ];
  nl.cells.forEach((c, i) => {
    const d = c.def;
    if (!d.output || !(d.inputs.length)) return;
    o.push('  (CELL', `    (CELLTYPE "${d.name}")`, `    (INSTANCE ${esc(c.name)})`, '    (DELAY (ABSOLUTE');
    const w = wire(i);
    if (d.ff) {
      const a0 = g.arcs[i].get(d.ff.clk), a = a0 && { max: a0.max + w, min: a0.min + w };
      o.push(`      (IOPATH (posedge ${d.ff.clk}) ${d.output} ${v(a?.max ?? d.delay)} ${v(a?.min ?? d.delay * 0.9)})`);
      if (d.ff.reset) o.push(`      (IOPATH (negedge ${d.ff.reset}) ${d.output} ${v((a?.max ?? d.delay) * 0.8)} ${v((a?.max ?? d.delay) * 0.8)})`);
    } else for (const p of d.inputs) {
      const a = g.arcs[i].get(p);
      if (a) o.push(`      (IOPATH ${p} ${d.output} ${v(a.max + w)} ${v(a.min + w)})`);
    }
    o.push('    ))');
    if (d.ff && d.checks) {
      const k = d.checks;
      o.push('    (TIMINGCHECK', `      (SETUPHOLD ${d.ff.d} (posedge ${d.ff.clk}) ${v(k.setup)} ${v(k.hold)})`);
      if (d.ff.reset && k.recovery !== undefined) o.push(`      (RECREM (posedge ${d.ff.reset}) (posedge ${d.ff.clk}) ${v(k.recovery)} ${v(k.removal ?? 0)})`);
      o.push('    )');
    }
    o.push('  )');
  });
  o.push(')');
  return o.join('\n') + '\n';
}
