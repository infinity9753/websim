// SDF of the placed and routed design (#56): IOPATH delays from the load-dependent cell delays of the timing
// estimate (rise = the delay, fall = 0.9 x, as in the Liberty and the simulation models) and the flip-flop checks.
import { LIB_NAME } from './cells';
import type { Netlist } from './netlist';
import type { Routing } from './route';
import { cellDelays } from './sta';

const v = (x: number) => `(${x.toFixed(4)}:${x.toFixed(4)}:${x.toFixed(4)})`;
const esc = (s: string) => s.replace(/[^A-Za-z0-9_]/g, c => '\\' + c);

export function writeSdf(nl: Netlist, r?: Routing, date = new Date()): string {
  const delay = cellDelays(nl, r);
  const o = [
    '(DELAYFILE', '  (SDFVERSION "3.0")', `  (DESIGN "${nl.top}")`, `  (DATE "${date.toISOString()}")`,
    '  (VENDOR "WebSim")', '  (PROGRAM "WebSim ASIC flow")', `  (VERSION "${LIB_NAME}")`,
    '  (DIVIDER /)', '  (TIMESCALE 1ns)',
  ];
  nl.cells.forEach((c, i) => {
    const d = c.def;
    if (!d.output || !(d.inputs.length)) return;
    const t = delay(i);
    o.push('  (CELL', `    (CELLTYPE "${d.name}")`, `    (INSTANCE ${esc(c.name)})`, '    (DELAY (ABSOLUTE');
    if (d.ff) {
      o.push(`      (IOPATH (posedge ${d.ff.clk}) ${d.output} ${v(t)} ${v(t * 0.9)})`);
      if (d.ff.reset) o.push(`      (IOPATH (negedge ${d.ff.reset}) ${d.output} ${v(t * 0.8)} ${v(t * 0.8)})`);
    } else for (const p of d.inputs) o.push(`      (IOPATH ${p} ${d.output} ${v(t)} ${v(t * 0.9)})`);
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
