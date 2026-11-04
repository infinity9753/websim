// WebSim educational standard-cell library ("edu") for the in-browser ASIC flow (#51).
// An invented, process-neutral library: geometry on a track grid, simple timing, Liberty for Yosys/ABC,
// Verilog models for gate-level simulation. It is meant for learning and visualization, not fabrication.

/** Database units are nm. */
export const TRACK = 400;          // routing pitch (and site width)
export const ROW_TRACKS = 8;       // row height in tracks
export const ROW_H = TRACK * ROW_TRACKS;
export const LIB_NAME = 'websim_edu';
const PIN_CAP_PF = 0.002;

export type CellKind = 'comb' | 'ff' | 'tie' | 'fill';

export interface CellDef {
  name: string;
  kind: CellKind;
  /** Width in sites (tracks). */
  width: number;
  inputs: string[];
  output?: string;
  /** Liberty function of the output (comb / tie). */
  fn?: string;
  /** Verilog expression of the output for the simulation model (comb / tie). */
  expr?: string;
  /** Flip-flops: clock, data, optional active-low asynchronous reset. */
  ff?: { clk: string; d: string; reset?: string };
  /** Flip-flops: setup / hold of D and recovery / removal of the reset against the clock edge, ns. */
  checks?: { setup: number; hold: number; recovery?: number; removal?: number };
  /** Pin access points: track column and track row inside the cell (row 0 = bottom rail). */
  pins: Record<string, { x: number; y: number }>;
  /** Intrinsic delay and delay per fF of load, ns. */
  delay: number;
  slope: number;
  description: string;
  /** Input pin capacitance, pF (default PIN_CAP). */
  cap?: number;
  /** Drive-strength variant: the base cell and the multiple (timing repair upsizes X1 -> X2 -> X4). */
  base?: string;
  drive?: number;
  /** Not used by synthesis (only by timing repair). */
  dontUse?: boolean;
}

/** Pins on distinct columns from 1 on: inputs on rows 3/4 alternating, the output on row 4 in the last column. */
function comb(name: string, inputs: string[], fn: string, expr: string, delay: number, description: string, extra = 0): CellDef {
  const width = inputs.length + 2 + extra;
  const pins: CellDef['pins'] = {};
  inputs.forEach((p, i) => { pins[p] = { x: 1 + i + (i >= 2 ? extra : 0), y: i % 2 ? 4 : 3 }; });
  pins.Y = { x: width - 1, y: 4 };
  return { name, kind: 'comb', width, inputs, output: 'Y', fn, expr, pins, delay, slope: 0.004, description };
}

export const CELLS: CellDef[] = [
  comb('INV', ['A'], '!A', '~A', 0.020, 'inverter'),
  comb('BUF', ['A'], 'A', 'A', 0.045, 'buffer', 1),
  comb('NAND2', ['A', 'B'], '!(A&B)', '~(A & B)', 0.028, '2-input NAND'),
  comb('NAND3', ['A', 'B', 'C'], '!(A&B&C)', '~(A & B & C)', 0.036, '3-input NAND'),
  comb('NOR2', ['A', 'B'], '!(A|B)', '~(A | B)', 0.034, '2-input NOR'),
  comb('NOR3', ['A', 'B', 'C'], '!(A|B|C)', '~(A | B | C)', 0.046, '3-input NOR'),
  comb('AND2', ['A', 'B'], '(A&B)', 'A & B', 0.050, '2-input AND', 1),
  comb('OR2', ['A', 'B'], '(A|B)', 'A | B', 0.055, '2-input OR', 1),
  comb('XOR2', ['A', 'B'], '(A^B)', 'A ^ B', 0.060, '2-input XOR', 2),
  comb('XNOR2', ['A', 'B'], '!(A^B)', '~(A ^ B)', 0.060, '2-input XNOR', 2),
  comb('AOI21', ['A1', 'A2', 'B'], '!((A1&A2)|B)', '~((A1 & A2) | B)', 0.040, 'AND-OR-invert (A1·A2 + B)\''),
  comb('OAI21', ['A1', 'A2', 'B'], '!((A1|A2)&B)', '~((A1 | A2) & B)', 0.040, 'OR-AND-invert ((A1+A2)·B)\''),
  comb('MUX2', ['A', 'B', 'S'], '((A&!S)|(B&S))', 'S ? B : A', 0.065, '2:1 multiplexer (S=1 selects B)', 2),
  {
    name: 'DFF', kind: 'ff', width: 12, inputs: ['D', 'CLK'], output: 'Q', ff: { clk: 'CLK', d: 'D' }, checks: { setup: 0.05, hold: 0.02 },
    pins: { D: { x: 2, y: 3 }, CLK: { x: 5, y: 4 }, Q: { x: 10, y: 4 } }, delay: 0.110, slope: 0.004, description: 'rising-edge D flip-flop',
  },
  {
    name: 'DFFR', kind: 'ff', width: 14, inputs: ['D', 'CLK', 'RN'], output: 'Q', ff: { clk: 'CLK', d: 'D', reset: 'RN' }, checks: { setup: 0.05, hold: 0.02, recovery: 0.06, removal: 0.03 },
    pins: { D: { x: 2, y: 3 }, CLK: { x: 5, y: 4 }, RN: { x: 8, y: 3 }, Q: { x: 12, y: 4 } }, delay: 0.120, slope: 0.004, description: 'rising-edge D flip-flop with active-low asynchronous reset',
  },
  { name: 'TIEHI', kind: 'tie', width: 2, inputs: [], output: 'Y', fn: '1', expr: "1'b1", pins: { Y: { x: 1, y: 4 } }, delay: 0, slope: 0, description: 'constant 1' },
  { name: 'TIELO', kind: 'tie', width: 2, inputs: [], output: 'Y', fn: '0', expr: "1'b0", pins: { Y: { x: 1, y: 3 } }, delay: 0, slope: 0, description: 'constant 0' },
  { name: 'FILL1', kind: 'fill', width: 1, inputs: [], pins: {}, delay: 0, slope: 0, description: 'filler (1 site)' },
  { name: 'FILL2', kind: 'fill', width: 2, inputs: [], pins: {}, delay: 0, slope: 0, description: 'filler (2 sites)' },
  { name: 'FILL4', kind: 'fill', width: 4, inputs: [], pins: {}, delay: 0, slope: 0, description: 'filler (4 sites)' },
];

// Timing repair (#68): stronger copies of the combinational cells (slope / k, larger input pins, wider) and a delay
// cell for hold fixing. Synthesis does not use them (dont_use).
for (const c of CELLS.filter(c => c.kind === 'comb')) {
  for (const k of [2, 4]) {
    const extra = c.width - c.inputs.length - 2 + k / 2;
    const v = comb(`${c.name}_X${k}`, c.inputs, c.fn!, c.expr!, c.delay, `${c.description}, ${k}x drive`, extra);
    CELLS.push({ ...v, slope: c.slope / k, cap: PIN_CAP_PF * (1 + 0.7 * (k - 1)), base: c.name, drive: k, dontUse: true });
  }
}
CELLS.push({ ...comb('DLY', ['A'], 'A', 'A', 0.150, 'delay cell (hold fixing)', 2), dontUse: true });

export const CELL = new Map(CELLS.map(c => [c.name, c]));

/** The next stronger variant of a cell, or undefined. */
export function upsize(c: CellDef): CellDef | undefined {
  const base = c.base ?? c.name, k = c.drive ?? 1;
  return k < 4 ? CELL.get(`${base}_X${k * 2}`) : undefined;
}

/** Input pin capacitance, pF. */
export const PIN_CAP = PIN_CAP_PF;
/** Input capacitance of a pin of a cell, pF. */
export const pinCap = (c: CellDef) => c.cap ?? PIN_CAP;

// NLDM tables (#57): delay and output transition by input transition (ns) and output load (pF), from an invented
// smooth model; the STA interpolates in these tables like a Liberty-based tool. Fall values are 0.9 x rise.
export const SLEW_IDX = [0.01, 0.04, 0.1, 0.25, 0.6];
export const LOAD_IDX = [0.001, 0.004, 0.01, 0.025, 0.06];
export interface Nldm { rise: number[][]; fall: number[][]; riseTr: number[][]; fallTr: number[][] }
const nldmCache = new Map<string, Nldm>();
export function nldm(c: CellDef): Nldm {
  let t = nldmCache.get(c.name);
  if (t) return t;
  const grid = (f: (slew: number, ff: number) => number) => SLEW_IDX.map(s => LOAD_IDX.map(l => Number(f(s, l * 1000).toFixed(4))));
  const rise = grid((s, ff) => c.delay + c.slope * ff * (1 + 0.5 * s) + 0.2 * s);
  const riseTr = grid((s, ff) => 0.5 * c.delay + 2 * c.slope * ff + 0.15 * s);
  const x9 = (g: number[][]) => g.map(r => r.map(v => Number((v * 0.9).toFixed(4))));
  t = { rise, fall: x9(rise), riseTr, fallTr: x9(riseTr) };
  nldmCache.set(c.name, t);
  return t;
}

/** Bilinear interpolation in a table over SLEW_IDX x LOAD_IDX, extrapolating linearly outside. */
export function lookup(t: number[][], slew: number, load: number): number {
  const seg = (idx: number[], v: number) => { let i = 0; while (i < idx.length - 2 && v > idx[i + 1]) i++; return [i, (v - idx[i]) / (idx[i + 1] - idx[i])] as const; };
  const [i, fx] = seg(SLEW_IDX, slew), [j, fy] = seg(LOAD_IDX, load);
  const a = t[i][j] + (t[i][j + 1] - t[i][j]) * fy, b = t[i + 1][j] + (t[i + 1][j + 1] - t[i + 1][j]) * fy;
  return a + (b - a) * fx;
}
const um2 = (c: CellDef) => ((c.width * TRACK) * ROW_H) / 1e6;
const num = (v: number) => v.toFixed(4);

/** Liberty description for Yosys (dfflibmap, abc) and the area report. */
export function liberty(): string {
  const o: string[] = [
    `/* ${LIB_NAME}: WebSim educational standard cells (invented, process-neutral). */`,
    `library(${LIB_NAME}) {`,
    '  delay_model : table_lookup;',
    '  time_unit : "1ns";',
    '  voltage_unit : "1V";',
    '  current_unit : "1mA";',
    '  pulling_resistance_unit : "1kohm";',
    '  leakage_power_unit : "1nW";',
    '  capacitive_load_unit (1, pf);',
    '  nom_process : 1;',
    '  nom_voltage : 1.2;',
    '  nom_temperature : 25;',
    '  default_inout_pin_cap : 0.002;',
    '  default_input_pin_cap : 0.002;',
    '  default_output_pin_cap : 0;',
    '  default_fanout_load : 1;',
    '  lu_table_template(delay_5x5) {',
    '    variable_1 : input_net_transition;',
    '    variable_2 : total_output_net_capacitance;',
    `    index_1 ("${SLEW_IDX.join(', ')}");`,
    `    index_2 ("${LOAD_IDX.join(', ')}");`,
    '  }',
  ];
  const table = (name: string, g: number[][]) => [`        ${name}(delay_5x5) {`, `          values (${g.map(r => `"${r.map(num).join(', ')}"`).join(', \\\n                  ')});`, '        }'];
  const timing = (c: CellDef, pin: string, scale: number, sense?: string, type?: string) => {
    const t = nldm(c), k = (g: number[][]) => g.map(r => r.map(v => v * scale));
    return [
      '      timing() {',
      `        related_pin : "${pin}";`,
      ...(sense ? [`        timing_sense : ${sense};`] : []),
      ...(type ? [`        timing_type : ${type};`] : []),
      ...table('cell_rise', k(t.rise)), ...table('cell_fall', k(t.fall)), ...table('rise_transition', t.riseTr), ...table('fall_transition', t.fallTr),
      '      }',
    ];
  };
  const constraint = (pin: string, type: string, v: number) => [
    '      timing() {', `        related_pin : "${pin}";`, `        timing_type : ${type};`,
    `        rise_constraint(scalar) { values("${num(v)}"); }`, `        fall_constraint(scalar) { values("${num(v)}"); }`, '      }',
  ];
  const checks = (c: CellDef, p: string) => {
    const k = c.checks, f = c.ff;
    if (!k || !f) return [];
    if (p === f.d) return [...constraint(f.clk, 'setup_rising', k.setup), ...constraint(f.clk, 'hold_rising', k.hold)];
    if (p === f.reset && k.recovery !== undefined) return [...constraint(f.clk, 'recovery_rising', k.recovery), ...constraint(f.clk, 'removal_rising', k.removal ?? 0)];
    return [];
  };
  for (const c of CELLS) {
    o.push(`  cell(${c.name}) {`, `    area : ${um2(c).toFixed(3)};`);
    if (c.kind === 'tie' || c.kind === 'fill' || c.dontUse) o.push('    dont_use : true;');
    if (c.ff) {
      o.push('    ff(IQ, IQN) {', `      next_state : "${c.ff.d}";`, `      clocked_on : "${c.ff.clk}";`);
      if (c.ff.reset) o.push(`      clear : "!${c.ff.reset}";`);
      o.push('    }');
    }
    for (const p of c.inputs) o.push(`    pin(${p}) {`, '      direction : input;', `      capacitance : ${pinCap(c)};`, ...(p === c.ff?.clk ? ['      clock : true;'] : []), ...checks(c, p), '    }');
    if (c.output) {
      o.push(`    pin(${c.output}) {`, '      direction : output;', `      function : "${c.ff ? 'IQ' : c.fn}";`);
      if (c.ff) {
        o.push(...timing(c, c.ff.clk, 1, undefined, 'rising_edge'));
        if (c.ff.reset) o.push(...timing(c, c.ff.reset, 0.8, 'positive_unate', 'clear'));
      } else for (const p of c.inputs) o.push(...timing(c, p, 1, /^!/.test(c.fn ?? '') ? 'negative_unate' : c.name.startsWith('X') || c.name === 'MUX2' ? 'non_unate' : 'positive_unate'));
      o.push('    }');
    }
    o.push('  }');
  }
  o.push('}');
  return o.join('\n') + '\n';
}

/** Verilog simulation models with specify delays (ns), so the gate-level netlist simulates in WebSim. */
export function verilogModels(): string {
  const o = [`// ${LIB_NAME} cell models for gate-level simulation (generated by WebSim)`, '`timescale 1ns/1ps', ''];
  for (const c of CELLS) {
    if (c.kind === 'fill') { o.push(`module ${c.name}(); endmodule`, ''); continue; }
    const ports = [...c.inputs.map(p => `input ${p}`), `output ${c.ff ? 'reg ' : ''}${c.output}`];
    o.push(`// ${c.description}`, `module ${c.name}(${ports.join(', ')});`);
    if (c.ff) {
      const { clk, d, reset } = c.ff, k = c.checks!;
      // a timing violation toggles the notifier, which makes Q unknown
      o.push('  reg notifier;', `  always @(notifier) ${c.output} <= 1'bx;`);
      o.push(reset
        ? `  always @(posedge ${clk} or negedge ${reset}) if (!${reset}) ${c.output} <= 1'b0; else ${c.output} <= ${d};`
        : `  always @(posedge ${clk}) ${c.output} <= ${d};`);
      o.push('  specify', `    (posedge ${clk} => (${c.output} +: ${d})) = (${num(c.delay)}, ${num(c.delay * 0.9)});`);
      if (reset) o.push(`    (negedge ${reset} => (${c.output} +: 1'b0)) = (${num(c.delay * 0.8)}, ${num(c.delay * 0.8)});`);
      o.push(`    $setuphold(posedge ${clk}${reset ? ` &&& ${reset}` : ''}, ${d}, ${num(k.setup)}, ${num(k.hold)}, notifier);`);
      if (reset) o.push(`    $recrem(posedge ${reset}, posedge ${clk}, ${num(k.recovery!)}, ${num(k.removal!)}, notifier);`);
      o.push('  endspecify');
    } else {
      o.push(`  assign ${c.output} = ${c.expr};`);
      if (c.inputs.length) o.push('  specify', ...c.inputs.map(p => `    (${p} => ${c.output}) = (${num(c.delay)}, ${num(c.delay * 0.9)});`), '  endspecify');
    }
    o.push('endmodule', '');
  }
  return o.join('\n');
}

/** Yosys script mapping a flattened design onto the library (expects edu.lib next to the sources). */
export function asicScript(top: string, read: string, out: string): string {
  return [
    read,
    // the cells as blackboxes with known port directions (for check, insbuf, opt_clean)
    'read_liberty -lib edu.lib',
    `synth -top ${top} -flatten`,
    // silicon flip-flops have no initial value; everything else becomes DFF / DFFR plus logic
    'attrmap -remove init',
    'dfflegalize -cell $_DFF_P_ x -cell $_DFF_PN0_ x',
    'dfflibmap -liberty edu.lib',
    'abc -liberty edu.lib',
    'opt_clean -purge',
    'setundef -zero',
    'hilomap -singleton -hicell TIEHI Y -locell TIELO Y',
    // continuous assignments between nets become buffers, so the netlist is cells and wires only
    'insbuf -buf BUF A Y',
    'opt_clean -purge',
    'check -assert',
    // _N_ names for the internal cells and nets, the same in the JSON, the Verilog netlist and the SDF
    'rename -enumerate',
    `tee -o ${out}.stat stat -liberty edu.lib`,
    `write_json ${out}.json`,
    `write_verilog -noattr -noexpr -nohex -nodec ${out}.v`,
  ].join('; ');
}
