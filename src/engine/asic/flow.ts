// The physical part of the in-browser ASIC flow (#51): placement, routing, checks, timing estimate, DEF / LEF / GDSII
// and a text report, from the Yosys JSON netlist of synth -target asic.
import { LIB_NAME, ROW_TRACKS, TRACK } from './cells';
import { writeDef, writeLef } from './def';
import { writeGds } from './gds';
import { buildLayout, type Layout } from './layout';
import { readNetlist, type Netlist } from './netlist';
import { place, type Placement } from './place';
import { route, verifyRouting, type Routing } from './route';
import { analyze, type Timing } from './sta';

export interface AsicOptions { util?: number; layers?: number }
export interface AsicResult {
  nl: Netlist; p: Placement; r: Routing; layout: Layout; timing: Timing;
  shorts: number; opens: string[];
  def: string; lef: string; gds: Uint8Array; report: string;
  /** Clean: everything routed, no overflow, shorts or opens. */
  ok: boolean;
  ms: { place: number; route: number };
}

const um = (tracks: number) => (tracks * TRACK) / 1000;

export function runAsic(json: string, top: string, o: AsicOptions = {}): AsicResult {
  const nl = readNetlist(json, top);
  let t = Date.now();
  const p = place(nl, { util: o.util });
  const tPlace = Date.now() - t;
  t = Date.now();
  const r = route(nl, p, { layers: o.layers });
  const tRoute = Date.now() - t;
  const v = verifyRouting(nl, p, r);
  const layout = buildLayout(nl, p, r);
  const timing = analyze(nl, r);
  const ok = r.overflow === 0 && !r.unrouted.length && !v.shorts.length && !v.opens.length;
  const res: AsicResult = {
    nl, p, r, layout, timing, shorts: v.shorts.length, opens: v.opens, ok, ms: { place: tPlace, route: tRoute },
    def: writeDef(nl, p, r, layout), lef: writeLef(r.layers + 1), gds: writeGds(layout), report: '',
  };
  res.report = report(res);
  return res;
}

/** Summary lines for the transcript and the full report file. */
export function summary(a: AsicResult): string[] {
  const { p, r, timing } = a;
  const lines = [
    `Die ${um(p.dieW).toFixed(1)} x ${um(p.dieH).toFixed(1)} um, core ${um(p.cols).toFixed(1)} x ${um(p.rows * ROW_TRACKS).toFixed(1)} um, ${p.rows} rows, utilization ${(100 * p.util).toFixed(1)}%`,
    `Placement: ${a.nl.cells.length} cells + ${p.fillers.length} fillers, HPWL ${um(p.hpwl).toFixed(1)} um (${a.ms.place} ms)`,
    `Routing: ${r.layers} layers (M2-M${r.layers + 1}), ${r.iterations} iterations, wirelength ${um(r.wirelength).toFixed(1)} um, ${r.viaCount} vias, overflow ${r.overflow} (${a.ms.route} ms)`,
    `Checks: ${a.shorts} shorts, ${a.opens.length} opens, ${r.unrouted.length} unrouted nets`,
  ];
  if (timing.critical) lines.push(`Timing (estimate): critical path ${timing.critical.delay.toFixed(3)} ns, max frequency ${timing.fmax!.toFixed(0)} MHz`);
  else if (timing.output) lines.push(`Timing (estimate): combinational, worst input-to-output ${timing.output.delay.toFixed(3)} ns`);
  return lines;
}

function report(a: AsicResult): string {
  const counts = new Map<string, number>();
  for (const c of a.nl.cells) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  const perLayer = new Map<number, number>();
  for (const n of a.r.nets) for (const w of n.wires) perLayer.set(w.layer, (perLayer.get(w.layer) ?? 0) + (w.x2 - w.x1) + (w.y2 - w.y1));
  const o = [
    `ASIC flow report: ${a.nl.top}`,
    `Library: ${LIB_NAME} (WebSim educational cells, invented process; for learning, not fabrication)`,
    '',
    ...summary(a),
    '',
    'Cells:',
    ...[...counts].sort((x, y) => y[1] - x[1]).map(([t, n]) => `  ${t.padEnd(8)} ${String(n).padStart(6)}`),
    '',
    'Wirelength per layer:',
    ...[...perLayer].sort((x, y) => x[0] - y[0]).map(([l, n]) => `  M${l}  ${um(n).toFixed(1)} um`),
    '',
    `IO pins: ${a.nl.ports.length}`,
    ...a.nl.ports.map((q, i) => `  ${q.name.padEnd(16)} ${q.dir.padEnd(6)} ${a.p.ports[i].side} M${a.p.ports[i].layer} (${um(a.p.ports[i].x).toFixed(1)}, ${um(a.p.ports[i].y).toFixed(1)})`),
  ];
  const path = (title: string, t: Timing['critical']) => {
    if (!t) return;
    o.push('', `${title}: ${t.delay.toFixed(3)} ns`, ...t.points.map(pt => `  ${pt.time.toFixed(3).padStart(8)}  ${pt.at}`));
  };
  path('Critical path (register / input to register)', a.timing.critical);
  path('Worst path to an output', a.timing.output);
  if (a.timing.loops) o.push('', `Combinational loops broken for timing: ${a.timing.loops}`);
  if (a.opens.length) o.push('', 'Open nets:', ...a.opens.map(n => `  ${n}`));
  return o.join('\n') + '\n';
}
