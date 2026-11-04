// Static timing analysis for the ASIC flow (#51, #57). Delays and output transitions come from the library's NLDM
// tables (input transition x output load); loads are pin capacitance, routed wire and output-port loads. Constraints
// come from SDC: clocks (ideal: no clock-tree delay), input/output delays, loads, input transitions, uncertainty and
// false-path / max / min-delay exceptions. Setup uses the largest delays and transitions, hold the smallest.
import { PIN_CAP, lookup, nldm, type CellDef } from './cells';
import type { NCell, Netlist } from './netlist';
import type { Routing } from './route';
import { emptySdc, type Clock, type Exception, type Sdc } from './sdc';

export const PIN_FF = PIN_CAP * 1000;   // input pin capacitance, fF
export const WIRE_FF = 0.03;            // fF per track of routed wire
export const OUT_FF = 10;               // default load on an output port, fF
export const SETUP = 0.05;              // default flip-flop setup time, ns

export interface PathPoint { at: string; incr: number; time: number; cell?: string; slew?: number; load?: number }
export interface PathCheck {
  check: 'setup' | 'hold';
  startpoint: string; endpoint: string; startKind: string; endKind: string;
  launch?: string; capture?: string;
  arrival: number; required: number; slack: number;
  /** Data path from the launch clock edge to the endpoint. */
  points: PathPoint[];
  /** Required-time side: capture edge, uncertainty, library or external constraint. */
  req: PathPoint[];
  exception?: string;
}
export interface StaResult {
  setup: PathCheck[]; hold: PathCheck[];
  wns: number; tns: number; whs: number; ths: number;
  /** Achieved frequency per clock from its worst same-clock setup path, MHz. */
  fmax: { clock: string; period: number; mhz: number | null }[];
  unclocked: string[]; unconstrained: string[];
  loops: number;
  warnings: string[];
}

/** Old summary shape for the flow report and the Layout window. */
export interface TimingPath { delay: number; points: { at: string; time: number; cell?: string }[] }
export interface Timing { critical: TimingPath | null; output: TimingPath | null; fmax: number | null; loops: number; sta: StaResult }

interface Arc { max: number; min: number }
type Prev = { cell: number; pin: string; net: number } | { start: number };
interface Start { kind: 'ff' | 'port'; index: number; name: string; clock: Clock; net: number; max: number; min: number; ext: number[] }

/** Timing graph: loads, slews and arc delays (independent of the clocks). */
export class Graph {
  readonly netIdx = new Map<number, number>();
  readonly load: Float64Array;
  readonly slewMax: Float64Array;
  readonly slewMin: Float64Array;
  /** Arc delays per cell: input pin (or clock / reset pin of a flip-flop) -> delay. */
  readonly arcs: Map<string, Arc>[] = [];
  /** Combinational cells in topological order. */
  readonly order: number[] = [];
  loops = 0;
  constructor(readonly nl: Netlist, r: Routing | undefined, readonly sdc: Sdc) {
    const len = new Map(r?.nets.map(n => [n.id, n.length]) ?? []);
    nl.nets.forEach((n, i) => this.netIdx.set(n.id, i));
    const N = nl.nets.length;
    this.load = new Float64Array(N); this.slewMax = new Float64Array(N); this.slewMin = new Float64Array(N);
    nl.nets.forEach((n, i) => {
      const pins = n.pins.filter(t => nl.cells[t.cell].def.output !== t.pin).length;
      const outs = n.ports.filter(q => nl.ports[q].dir === 'output').reduce((s, q) => s + (sdc.load.get(nl.ports[q].name) ?? OUT_FF / 1000), 0);
      this.load[i] = pins * PIN_CAP + outs + (len.get(n.id) ?? 0) * WIRE_FF / 1000;
    });
    for (const q of nl.ports) if (q.dir === 'input') { const i = this.netIdx.get(q.net)!; this.slewMax[i] = this.slewMin[i] = sdc.transition.get(q.name) ?? 0; }
    // topological order of the combinational cells (DFS from each cell's inputs); flip-flops and ties start paths
    const driver = new Map<number, number>();
    nl.cells.forEach((c, i) => { const o = c.def.output && c.pins[c.def.output]; if (o !== undefined && o !== '') driver.set(o as number, i); });
    const state = new Uint8Array(nl.cells.length);
    const visit = (ci: number) => {
      if (state[ci] === 2) return;
      if (state[ci] === 1) { this.loops++; return; }
      state[ci] = 1;
      const c = nl.cells[ci];
      if (c.def.kind === 'comb') for (const p of c.def.inputs) { const d = c.pins[p] !== undefined ? driver.get(c.pins[p]) : undefined; if (d !== undefined) visit(d); }
      state[ci] = 2;
      if (c.def.kind === 'comb') this.order.push(ci);
    };
    // flip-flops first: their outputs are path starts whose transition depends only on the clock
    nl.cells.forEach((c, i) => {
      this.arcs[i] = new Map();
      if (!c.def.ff) return;
      const o = this.idx(c.pins[c.def.output!]);
      const t = nldm(c.def), l = o < 0 ? 0 : this.load[o];
      const cs = this.slewOf(c.pins[c.def.ff.clk]);
      this.arcs[i].set(c.def.ff.clk, { max: lookup(t.rise, cs[0], l), min: lookup(t.fall, cs[1], l) });
      if (o >= 0) { this.slewMax[o] = lookup(t.riseTr, cs[0], l); this.slewMin[o] = lookup(t.fallTr, cs[1], l); }
    });
    nl.cells.forEach((_, i) => visit(i));
    for (const ci of this.order) {
      const c = nl.cells[ci];
      const o = this.idx(c.pins[c.def.output!]);
      if (o < 0) continue;
      const t = nldm(c.def), l = this.load[o];
      let smax = 0, smin = Infinity;
      for (const p of c.def.inputs) {
        if (c.pins[p] === undefined) continue;
        const [imax, imin] = this.slewOf(c.pins[p]);
        this.arcs[ci].set(p, { max: lookup(t.rise, imax, l), min: lookup(t.fall, imin, l) });
        smax = Math.max(smax, lookup(t.riseTr, imax, l)); smin = Math.min(smin, lookup(t.fallTr, imin, l));
      }
      this.slewMax[o] = smax; this.slewMin[o] = smin === Infinity ? 0 : smin;
    }
  }
  idx(net: number | undefined) { return net === undefined ? -1 : this.netIdx.get(net) ?? -1; }
  slewOf(net: number | undefined): [number, number] { const i = this.idx(net); return i < 0 ? [0, 0] : [this.slewMax[i], this.slewMin[i]]; }
  /** Largest arc delay of a cell (for its SDF IOPATH and the old summary). */
  cellDelay(ci: number, pin?: string): number {
    const a = this.arcs[ci];
    if (pin) return a.get(pin)?.max ?? 0;
    let m = 0;
    for (const v of a.values()) m = Math.max(m, v.max);
    return m;
  }
}

const label = (c: NCell, pin: string) => `${c.name}/${pin} (${c.type})`;

/** Setup and hold separation between a launch and a capture clock (worst over the common period). */
export function separation(l: Clock, c: Clock): { setup: number; hold: number; edge: number } {
  if (l === c) return { setup: c.period, hold: 0, edge: l.waveform[0] };
  let setup = Infinity, hold = -Infinity, edge = l.waveform[0];
  for (let k = 0; k < 1000; k++) {
    const el = l.waveform[0] + k * l.period;
    const m = Math.floor((el - c.waveform[0]) / c.period + 1e-9) + 1;
    let ec = c.waveform[0] + m * c.period;
    if (ec <= el + 1e-9) ec += c.period;
    if (ec - el < setup) { setup = ec - el; edge = el; }
    hold = Math.max(hold, ec - c.period - el);
  }
  return { setup, hold, edge };
}

export function sta(nl: Netlist, r: Routing | undefined, sdc: Sdc, opts: { idealAll?: boolean } = {}): { g: Graph; res: StaResult } {
  const g = new Graph(nl, r, sdc);
  const warnings = [...sdc.warnings];
  const N = nl.nets.length;
  const portByName = new Map(nl.ports.map(p => [p.name, p]));
  // the clock of each flip-flop: its clock pin, back through buffers and inverters, to a clock port
  const clockOfPort = new Map(sdc.clocks.filter(c => c.port).map(c => [c.port!, c]));
  const portOfNet = new Map(nl.ports.filter(p => p.dir === 'input').map(p => [p.net, p.name]));
  const driver = new Map<number, number>();
  nl.cells.forEach((c, i) => { const o = c.def.output && c.pins[c.def.output]; if (typeof o === 'number') driver.set(o, i); });
  const clockOfNet = (net: number | undefined): Clock | undefined => {
    for (let hop = 0; net !== undefined && hop < 64; hop++) {
      const p = portOfNet.get(net);
      if (p !== undefined) return clockOfPort.get(p);
      const d = driver.get(net);
      if (d === undefined || !['BUF', 'INV'].includes(nl.cells[d].type)) return;
      net = nl.cells[d].pins.A;
    }
  };
  const ffClock = nl.cells.map(c => !c.def.ff ? undefined : opts.idealAll ? sdc.clocks[0] : clockOfNet(c.pins[c.def.ff.clk]));
  const unclocked = nl.cells.filter((c, i) => c.def.ff && !ffClock[i]).map(c => c.name);
  const unconstrained: string[] = [];
  // startpoints
  const starts: Start[] = [];
  nl.cells.forEach((c, i) => {
    const clk = ffClock[i];
    if (!clk || !c.def.ff) return;
    const o = c.pins[c.def.output!];
    if (o === undefined) return;
    const a = g.arcs[i].get(c.def.ff.clk)!;
    starts.push({ kind: 'ff', index: i, name: c.name, clock: clk, net: o, max: a.max, min: a.min, ext: [] });
  });
  for (const q of nl.ports) {
    if (q.dir !== 'input' || clockOfPort.has(q.name)) continue;
    const d = sdc.inputDelay.get(q.name);
    const clk = d ? sdc.clocks.find(c => c.name === d.clock) ?? (d.clock === undefined ? sdc.clocks[0] : undefined) : undefined;
    if (!d || !clk) { unconstrained.push(q.name); continue; }
    starts.push({ kind: 'port', index: nl.ports.indexOf(q), name: q.name, clock: clk, net: q.net, max: d.max, min: d.min, ext: [d.max, d.min] });
  }
  // exceptions with -from points (ports, cells, pins) get their own propagation group
  const fromPoints = (x: Exception) => x.from.filter(o => o.kind !== 'clock').map(o => o.kind === 'pin' ? o.name.replace(/\/[^/]*$/, '') : o.name);
  for (const x of sdc.exceptions) if (x.through.length) warnings.push(`-through is not supported; ignoring "${x.text}"`);
  const groups: { starts: Start[]; only?: Exception }[] = [];
  const special = new Set(sdc.exceptions.flatMap(fromPoints));
  groups.push({ starts: starts.filter(s => !special.has(s.name)) });
  for (const x of sdc.exceptions) { const f = new Set(fromPoints(x)); if (f.size) groups.push({ starts: starts.filter(s => f.has(s.name)), only: x }); }
  const matches = (objs: Exception['from'], name: string, clock: string | undefined, pin?: string) =>
    !objs.length || objs.some(o => (o.kind === 'clock' ? o.name === clock : o.kind === 'pin' ? o.name === `${name}/${pin}` : o.name === name));
  const exceptionFor = (grp: { only?: Exception }, s: Start, endName: string, endPin: string | undefined, capture: string | undefined, check: 'setup' | 'hold') => {
    const cands = grp.only ? [grp.only, ...sdc.exceptions.filter(x => !fromPoints(x).length)] : sdc.exceptions.filter(x => !fromPoints(x).length);
    // membership in an exception's group already satisfies its -from points
    const hit = cands.filter(x => (check === 'setup' ? x.setup : x.hold) && (x === grp.only || matches(x.from, s.name, s.clock.name, s.kind === 'ff' ? 'CLK' : undefined)) && matches(x.to, endName, capture, endPin));
    return hit.find(x => x.kind === 'false') ?? hit[0];
  };

  const setup = new Map<string, PathCheck>(), hold = new Map<string, PathCheck>();
  const keep = (m: Map<string, PathCheck>, p: PathCheck) => { const cur = m.get(p.endpoint); if (!cur || p.slack < cur.slack) m.set(p.endpoint, p); };
  const arrMax = new Float64Array(N), arrMin = new Float64Array(N);
  const has = new Uint8Array(N);
  const prevMax: (Prev | undefined)[] = new Array(N), prevMin: (Prev | undefined)[] = new Array(N);

  for (const grp of groups) {
    const clocks = [...new Set(grp.starts.map(s => s.clock))];
    for (const launch of clocks) {
      has.fill(0);
      const ss = grp.starts.filter(s => s.clock === launch);
      for (let si = 0; si < ss.length; si++) {
        const s = ss[si], i = g.idx(s.net);
        if (i < 0) continue;
        if (!has[i] || s.max > arrMax[i]) { arrMax[i] = s.max; prevMax[i] = { start: si }; }
        if (!has[i] || s.min < arrMin[i]) { arrMin[i] = s.min; prevMin[i] = { start: si }; }
        has[i] = 1;
      }
      for (const ci of g.order) {
        const c = nl.cells[ci];
        const o = g.idx(c.pins[c.def.output!]);
        if (o < 0) continue;
        for (const p of c.def.inputs) {
          const n = g.idx(c.pins[p]);
          if (n < 0 || !has[n]) continue;
          const a = g.arcs[ci].get(p)!;
          const vmax = arrMax[n] + a.max, vmin = arrMin[n] + a.min;
          if (!has[o] || vmax > arrMax[o]) { arrMax[o] = vmax; prevMax[o] = { cell: ci, pin: p, net: n }; }
          if (!has[o] || vmin < arrMin[o]) { arrMin[o] = vmin; prevMin[o] = { cell: ci, pin: p, net: n }; }
          has[o] = 1;
        }
      }
      const trace = (end: number, max: boolean, endLabel: string, edge: number): { s: Start; points: PathPoint[] } => {
        const arr = max ? arrMax : arrMin, prev = max ? prevMax : prevMin;
        const pts: PathPoint[] = [{ at: endLabel, incr: 0, time: edge + arr[end] }];
        let cur = end, s: Start | undefined;
        for (;;) {
          const p = prev[cur]!;
          if ('start' in p) { s = ss[p.start]; break; }
          const c = nl.cells[p.cell];
          pts.unshift({ at: label(c, c.def.output!), incr: arr[cur] - arr[p.net], time: edge + arr[cur], cell: c.name, slew: max ? g.slewMax[cur] : g.slewMin[cur], load: g.load[cur] });
          pts.unshift({ at: label(c, p.pin), incr: 0, time: edge + arr[p.net], cell: c.name });
          cur = p.net;
        }
        const head: PathPoint[] = [{ at: `clock ${launch.name} (rise edge)`, incr: edge, time: edge }];
        if (s.kind === 'ff') {
          const c = nl.cells[s.index];
          head.push({ at: 'clock network delay (ideal)', incr: 0, time: edge }, { at: label(c, c.def.ff!.clk), incr: 0, time: edge, cell: c.name });
          head.push({ at: label(c, c.def.output!), incr: max ? s.max : s.min, time: edge + (max ? s.max : s.min), cell: c.name, slew: max ? g.slewMax[cur] : g.slewMin[cur], load: g.load[cur] });
        } else head.push({ at: 'input external delay', incr: max ? s.max : s.min, time: edge + (max ? s.max : s.min) }, { at: `${s.name} (in)`, incr: 0, time: edge + (max ? s.max : s.min) });
        return { s, points: [...head, ...pts] };
      };
      // endpoints: flip-flop data (setup / hold) and reset (recovery / removal) pins, constrained outputs
      const evaluate = (net: number | undefined, endName: string, endPin: string | undefined, endLabel: string, capture: Clock, lim: { setup: number; hold: number; what: [string, string] }, endKind: string) => {
        const i = g.idx(net);
        if (i < 0 || !has[i]) return;
        const sep = separation(launch, capture);
        for (const check of ['setup', 'hold'] as const) {
          const { s, points } = trace(i, check === 'setup', endLabel, sep.edge);
          const x = exceptionFor(grp, s, endName, endPin, capture.name, check);
          if (x?.kind === 'false') continue;
          const arrival = sep.edge + (check === 'setup' ? arrMax[i] : arrMin[i]);
          const capEdge = sep.edge + (check === 'setup' ? sep.setup : sep.hold);
          let req: PathPoint[], required: number;
          if (x) {
            required = sep.edge + x.value;
            req = [{ at: `${x.kind === 'max' ? 'max' : 'min'} delay (${x.text})`, incr: x.value, time: required }];
          } else if (check === 'setup') {
            const u = sdc.uncertainty.setup;
            required = capEdge - u - lim.setup;
            req = [{ at: `clock ${capture.name} (rise edge)`, incr: capEdge, time: capEdge }, { at: 'clock network delay (ideal)', incr: 0, time: capEdge }];
            if (u) req.push({ at: 'clock uncertainty', incr: -u, time: capEdge - u });
            req.push({ at: lim.what[0], incr: -lim.setup, time: required });
          } else {
            const u = sdc.uncertainty.hold;
            required = capEdge + u + lim.hold;
            req = [{ at: `clock ${capture.name} (rise edge)`, incr: capEdge, time: capEdge }, { at: 'clock network delay (ideal)', incr: 0, time: capEdge }];
            if (u) req.push({ at: 'clock uncertainty', incr: u, time: capEdge + u });
            req.push({ at: lim.what[1], incr: lim.hold, time: required });
          }
          const slack = check === 'setup' ? required - arrival : arrival - required;
          const pc: PathCheck = { check, startpoint: s.name, endpoint: endName + (endPin ? `/${endPin}` : ''), startKind: s.kind === 'ff' ? `rising edge-triggered flip-flop clocked by ${launch.name}` : `input port clocked by ${launch.name}`, endKind, launch: launch.name, capture: capture.name, arrival, required, slack, points, req, exception: x?.text };
          keep(check === 'setup' ? setup : hold, pc);
        }
      };
      nl.cells.forEach((c, ci) => {
        const f = c.def.ff, k = c.def.checks, cap = ffClock[ci];
        if (!f || !cap) return;
        const kind = `rising edge-triggered flip-flop clocked by ${cap.name}`;
        evaluate(c.pins[f.d], c.name, f.d, label(c, f.d), cap, { setup: k?.setup ?? SETUP, hold: k?.hold ?? 0, what: ['library setup time', 'library hold time'] }, kind);
        if (f.reset && k?.recovery !== undefined) evaluate(c.pins[f.reset], c.name, f.reset, label(c, f.reset), cap, { setup: k.recovery, hold: k.removal ?? 0, what: ['library recovery time', 'library removal time'] }, kind);
      });
      for (const q of nl.ports) {
        if (q.dir !== 'output') continue;
        const d = sdc.outputDelay.get(q.name);
        const cap = d ? sdc.clocks.find(c => c.name === d.clock) ?? (d.clock === undefined ? sdc.clocks[0] : undefined) : undefined;
        if (!d || !cap) continue;
        evaluate(q.net, q.name, undefined, `${q.name} (out)`, cap, { setup: d.max, hold: -d.min, what: ['output external delay', 'output external delay'] }, `output port clocked by ${cap.name}`);
      }
    }
  }
  for (const q of nl.ports) if (q.dir === 'output' && !sdc.outputDelay.has(q.name)) unconstrained.push(q.name);
  const bySlack = (m: Map<string, PathCheck>) => [...m.values()].sort((a, b) => a.slack - b.slack);
  const S = bySlack(setup), H = bySlack(hold);
  const sum = (l: PathCheck[]) => l.reduce((t, p) => t + Math.min(0, p.slack), 0);
  const fmax = sdc.clocks.map(c => {
    const worst = S.find(p => p.launch === c.name && p.capture === c.name && !p.exception);
    return { clock: c.name, period: c.period, mhz: worst ? 1000 / (c.period - worst.slack) : null };
  });
  return {
    g,
    res: { setup: S, hold: H, wns: Math.min(0, S[0]?.slack ?? 0), tns: sum(S), whs: Math.min(0, H[0]?.slack ?? 0), ths: sum(H), fmax, unclocked, unconstrained, loops: g.loops, warnings },
  };
}

/** Timing estimate without constraints (the flow summary): one ideal clock on every flip-flop, inputs at time 0. */
export function analyze(nl: Netlist, r?: Routing, sdc?: Sdc): Timing {
  const ideal = !sdc || !sdc.clocks.length;
  const c = sdc && !ideal ? sdc : emptySdc();
  const P = 1000;
  if (ideal) {
    c.clocks = [{ name: 'ideal', period: P, waveform: [0, P / 2] }];
    for (const q of nl.ports) { if (q.dir === 'input') c.inputDelay.set(q.name, { max: 0, min: 0 }); else c.outputDelay.set(q.name, { max: 0, min: 0 }); }
  }
  const { res } = sta(nl, r, c, { idealAll: ideal });
  const old = (p: PathCheck | undefined, extra: number): TimingPath | null => p ? {
    delay: p.arrival + extra,
    points: p.points.filter(x => !x.at.startsWith('clock') && x.at !== 'input external delay' && !(x.cell && x.incr === 0 && !/\/(D|RN) \(/.test(x.at))).map(x => ({ at: x.at, time: x.time, cell: x.cell })),
  } : null;
  if (ideal) {
    const ff = res.setup.find(p => !nl.ports.some(q => q.name === p.endpoint));
    const out = res.setup.find(p => nl.ports.some(q => q.name === p.endpoint));
    const critical = ff ? old(ff, P - ff.required) : null;
    if (critical) { const last = critical.points[critical.points.length - 1]; last.at = `${ff!.endpoint} (setup)`; last.time = critical.delay; }
    return { critical, output: out ? old(out, 0) : null, fmax: critical ? 1000 / critical.delay : null, loops: res.loops, sta: res };
  }
  const w = res.setup[0];
  return { critical: w ? old(w, 0) : null, output: null, fmax: res.fmax[0]?.mhz ?? null, loops: res.loops, sta: res };
}

const f3 = (v: number) => v.toFixed(3).padStart(8);

/** A path report: startpoint, endpoint, the data arrival and required times, slack. */
export function reportPath(p: PathCheck): string {
  const o = [
    `Startpoint: ${p.startpoint} (${p.startKind})`,
    `Endpoint: ${p.endpoint} (${p.endKind})`,
    `Path type: ${p.check === 'setup' ? 'max' : 'min'} (${p.check})`,
    ...(p.exception ? [`Exception: ${p.exception}`] : []),
    '',
    '   Delay     Time    Slew    Load  Description',
    '-'.repeat(64),
    ...p.points.map(x => `${f3(x.incr)} ${f3(x.time)} ${x.slew === undefined ? '        ' : f3(x.slew)} ${x.load === undefined ? '       ' : (x.load * 1000).toFixed(1).padStart(7)}  ${x.at}`),
    `         ${f3(p.arrival)}                   data arrival time`,
    '',
    ...p.req.map(x => `${f3(x.incr)} ${f3(x.time)}                   ${x.at}`),
    `         ${f3(p.required)}                   data required time`,
    '-'.repeat(64),
    `         ${f3(p.required)}                   data required time`,
    `         ${f3(-p.arrival)}                   data arrival time`,
    '-'.repeat(64),
    `         ${f3(p.slack)}                   slack (${p.slack < -1e-9 ? 'VIOLATED' : 'MET'})`,
  ];
  return o.join('\n');
}

/** Summary lines of an STA run (also used by the sta command). */
export function staSummary(r: StaResult): string[] {
  const viol = (l: PathCheck[]) => l.filter(p => p.slack < -1e-9).length;
  const lines = [
    `Setup: WNS ${r.wns.toFixed(3)} ns, TNS ${r.tns.toFixed(3)} ns, ${viol(r.setup)} of ${r.setup.length} endpoints violated`,
    `Hold:  WHS ${r.whs.toFixed(3)} ns, THS ${r.ths.toFixed(3)} ns, ${viol(r.hold)} of ${r.hold.length} endpoints violated`,
    ...r.fmax.map(f => `Clock ${f.clock}: period ${f.period.toFixed(3)} ns${f.mhz !== null ? `, achievable ${f.mhz.toFixed(1)} MHz` : ''}`),
  ];
  if (r.unclocked.length) lines.push(`Unclocked flip-flops: ${r.unclocked.length} (${r.unclocked.slice(0, 5).join(' ')}${r.unclocked.length > 5 ? ' ...' : ''})`);
  if (r.unconstrained.length) lines.push(`Unconstrained ports: ${r.unconstrained.join(' ')}`);
  if (r.loops) lines.push(`Combinational loops broken for timing: ${r.loops}`);
  return lines;
}

export type { CellDef };
