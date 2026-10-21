// WebSim educational standard-cell library ("edu") for the in-browser ASIC flow (#51).
// An invented, process-neutral library: geometry on a track grid, simple timing, Liberty for Yosys/ABC,
// Verilog models for gate-level simulation. It is meant for learning and visualization, not fabrication.

/** Database units are nm. */
export const TRACK = 400;          // routing pitch (and site width)
export const ROW_TRACKS = 8;       // row height in tracks
export const ROW_H = TRACK * ROW_TRACKS;
export const LIB_NAME = 'websim_edu';

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
  /** Pin access points: track column and track row inside the cell (row 0 = bottom rail). */
  pins: Record<string, { x: number; y: number }>;
  /** Intrinsic delay and delay per fF of load, ns. */
  delay: number;
  slope: number;
  description: string;
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
    name: 'DFF', kind: 'ff', width: 12, inputs: ['D', 'CLK'], output: 'Q', ff: { clk: 'CLK', d: 'D' },
    pins: { D: { x: 2, y: 3 }, CLK: { x: 5, y: 4 }, Q: { x: 10, y: 4 } }, delay: 0.110, slope: 0.004, description: 'rising-edge D flip-flop',
  },
  {
    name: 'DFFR', kind: 'ff', width: 14, inputs: ['D', 'CLK', 'RN'], output: 'Q', ff: { clk: 'CLK', d: 'D', reset: 'RN' },
    pins: { D: { x: 2, y: 3 }, CLK: { x: 5, y: 4 }, RN: { x: 8, y: 3 }, Q: { x: 12, y: 4 } }, delay: 0.120, slope: 0.004, description: 'rising-edge D flip-flop with active-low asynchronous reset',
  },
  { name: 'TIEHI', kind: 'tie', width: 2, inputs: [], output: 'Y', fn: '1', expr: "1'b1", pins: { Y: { x: 1, y: 4 } }, delay: 0, slope: 0, description: 'constant 1' },
  { name: 'TIELO', kind: 'tie', width: 2, inputs: [], output: 'Y', fn: '0', expr: "1'b0", pins: { Y: { x: 1, y: 3 } }, delay: 0, slope: 0, description: 'constant 0' },
  { name: 'FILL1', kind: 'fill', width: 1, inputs: [], pins: {}, delay: 0, slope: 0, description: 'filler (1 site)' },
  { name: 'FILL2', kind: 'fill', width: 2, inputs: [], pins: {}, delay: 0, slope: 0, description: 'filler (2 sites)' },
  { name: 'FILL4', kind: 'fill', width: 4, inputs: [], pins: {}, delay: 0, slope: 0, description: 'filler (4 sites)' },
];

export const CELL = new Map(CELLS.map(c => [c.name, c]));

/** Input pin capacitance, pF. */
const PIN_CAP = 0.002;
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
  ];
  const timing = (pin: string, d: number, sense?: string, type?: string) => [
    '      timing() {',
    `        related_pin : "${pin}";`,
    ...(sense ? [`        timing_sense : ${sense};`] : []),
    ...(type ? [`        timing_type : ${type};`] : []),
    `        cell_rise(scalar) { values("${num(d)}"); }`,
    `        cell_fall(scalar) { values("${num(d * 0.9)}"); }`,
    `        rise_transition(scalar) { values("${num(d * 0.5)}"); }`,
    `        fall_transition(scalar) { values("${num(d * 0.45)}"); }`,
    '      }',
  ];
  for (const c of CELLS) {
    o.push(`  cell(${c.name}) {`, `    area : ${um2(c).toFixed(3)};`);
    if (c.kind === 'tie' || c.kind === 'fill') o.push('    dont_use : true;');
    if (c.ff) {
      o.push('    ff(IQ, IQN) {', `      next_state : "${c.ff.d}";`, `      clocked_on : "${c.ff.clk}";`);
      if (c.ff.reset) o.push(`      clear : "!${c.ff.reset}";`);
      o.push('    }');
    }
    for (const p of c.inputs) o.push(`    pin(${p}) {`, '      direction : input;', `      capacitance : ${PIN_CAP};`, ...(p === c.ff?.clk ? ['      clock : true;'] : []), '    }');
    if (c.output) {
      o.push(`    pin(${c.output}) {`, '      direction : output;', `      function : "${c.ff ? 'IQ' : c.fn}";`);
      if (c.ff) {
        o.push(...timing(c.ff.clk, c.delay, undefined, 'rising_edge'));
        if (c.ff.reset) o.push(...timing(c.ff.reset, c.delay * 0.8, 'positive_unate', 'clear'));
      } else for (const p of c.inputs) o.push(...timing(p, c.delay, /^!/.test(c.fn ?? '') ? 'negative_unate' : c.name.startsWith('X') || c.name === 'MUX2' ? 'non_unate' : 'positive_unate'));
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
      const { clk, d, reset } = c.ff;
      o.push(reset
        ? `  always @(posedge ${clk} or negedge ${reset}) if (!${reset}) ${c.output} <= 1'b0; else ${c.output} <= ${d};`
        : `  always @(posedge ${clk}) ${c.output} <= ${d};`);
      o.push('  specify', `    (posedge ${clk} => (${c.output} +: ${d})) = (${num(c.delay)}, ${num(c.delay * 0.9)});`);
      if (reset) o.push(`    (negedge ${reset} => (${c.output} +: 1'b0)) = (${num(c.delay * 0.8)}, ${num(c.delay * 0.8)});`);
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
    `tee -o ${out}.stat stat -liberty edu.lib`,
    `write_json ${out}.json`,
    `write_verilog -noattr -noexpr -nohex -nodec ${out}.v`,
  ].join('; ');
}
