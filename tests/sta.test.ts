import { describe, it, expect } from 'vitest';
import { CELL, LOAD_IDX, PIN_CAP, SLEW_IDX, liberty, lookup, nldm } from '../src/engine/asic/cells';
import type { Netlist } from '../src/engine/asic/netlist';
import { readSdc } from '../src/engine/asic/sdc';
import { OUT_FF, analyze, reportPath, separation, sta } from '../src/engine/asic/sta';
import { writeSdf } from '../src/engine/asic/sdf';
import { Session } from '../src/engine/commands';

/** in a, clk; ff1(D=a) -> INV u1 -> INV u2 -> ff2(D); ff2/Q -> out q. Nets 1..n by name. */
function design(): Netlist {
  const names = ['a', 'clk', 'n1', 'n2', 'n3', 'q'];
  const nets = names.map((name, i) => ({ id: i + 1, name, pins: [] as { cell: number; pin: string }[], ports: [] as number[] }));
  const id = (n: string) => names.indexOf(n) + 1;
  const cells = [
    { name: 'ff1', type: 'DFF', pins: { D: 'a', CLK: 'clk', Q: 'n1' } },
    { name: 'u1', type: 'INV', pins: { A: 'n1', Y: 'n2' } },
    { name: 'u2', type: 'INV', pins: { A: 'n2', Y: 'n3' } },
    { name: 'ff2', type: 'DFF', pins: { D: 'n3', CLK: 'clk', Q: 'q' } },
  ].map((c, ci) => {
    const pins: Record<string, number> = {};
    for (const [p, n] of Object.entries(c.pins)) { pins[p] = id(n); nets[id(n) - 1].pins.push({ cell: ci, pin: p }); }
    return { name: c.name, type: c.type, def: CELL.get(c.type)!, pins };
  });
  const ports = [{ name: 'a', dir: 'input' as const, net: id('a') }, { name: 'clk', dir: 'input' as const, net: id('clk') }, { name: 'q', dir: 'output' as const, net: id('q') }];
  ports.forEach((p, i) => nets[p.net - 1].ports.push(i));
  return { top: 't', cells, nets, ports };
}

describe('NLDM tables (#57)', () => {
  it('lookup returns table values on the grid and interpolates between them', () => {
    const t = nldm(CELL.get('NAND2')!);
    expect(lookup(t.rise, SLEW_IDX[2], LOAD_IDX[3])).toBeCloseTo(t.rise[2][3], 9);
    const mid = lookup(t.rise, (SLEW_IDX[1] + SLEW_IDX[2]) / 2, LOAD_IDX[0]);
    expect(mid).toBeCloseTo((t.rise[1][0] + t.rise[2][0]) / 2, 9);
    expect(lookup(t.rise, 0.6, 0.06)).toBeGreaterThan(lookup(t.rise, 0.01, 0.001));
    expect(t.fall[0][0]).toBeCloseTo(t.rise[0][0] * 0.9, 3);
  });

  it('the Liberty has a table template, 5x5 delay tables and setup / hold constraints', () => {
    const lib = liberty();
    expect(lib).toMatch(/lu_table_template\(delay_5x5\) \{\s+variable_1 : input_net_transition;\s+variable_2 : total_output_net_capacitance;/);
    expect(lib).toMatch(/cell\(INV\)[\s\S]*?cell_rise\(delay_5x5\) \{\s+values \("[\d., ]+", \\\n/);
    expect(lib).toMatch(/pin\(D\)[\s\S]*?timing_type : setup_rising;[\s\S]*?timing_type : hold_rising;/);
    expect(lib).toMatch(/pin\(RN\)[\s\S]*?timing_type : recovery_rising;/);
  });
});

describe('SDC reader (#57)', () => {
  it('reads clocks, IO delays, loads and exceptions with Tcl words, lists and variables', () => {
    const nl = design();
    const sdc = readSdc(`# constraints
set period 10
create_clock -name core -period $period -waveform {0 5} [get_ports clk]
set_input_delay -clock core 2.0 [all_inputs]
set_input_delay -clock [get_clocks core] -min 0.5 [get_ports {a}]
set_output_delay -clock core 1.5 \\
  [get_ports q]
set_load 0.02 [all_outputs]; set_input_transition 0.1 [get_ports a]
set_clock_uncertainty 0.1
set_false_path -from [get_ports a] -hold
set_max_delay 3 -from [get_cells ff1] -to [get_cells ff2]
set_bogus 1
get_ports nothere`, nl);
    expect(sdc.clocks).toEqual([{ name: 'core', period: 10, waveform: [0, 5], port: 'clk' }]);
    expect(sdc.inputDelay.get('a')).toEqual({ clock: 'core', max: 2, min: 0.5 });
    expect(sdc.inputDelay.get('clk')?.max).toBe(2);
    expect(sdc.outputDelay.get('q')).toEqual({ clock: 'core', max: 1.5, min: 1.5 });
    expect(sdc.load.get('q')).toBe(0.02);
    expect(sdc.transition.get('a')).toBe(0.1);
    expect(sdc.uncertainty).toEqual({ setup: 0.1, hold: 0.1 });
    expect(sdc.exceptions.map(x => [x.kind, x.setup, x.hold, x.from.map(o => o.name), x.to.map(o => o.name)])).toEqual([['false', false, true, ['a'], []], ['max', true, false, ['ff1'], ['ff2']]]);
    expect(sdc.warnings).toEqual(['line 12: unknown SDC command set_bogus', 'line 13: no port matches "nothere"']);
  });

  it('get_ports matches bus bits by the bus name and globs', () => {
    const nl = design();
    nl.ports.push({ name: 'd[0]', dir: 'input', net: 1 }, { name: 'd[1]', dir: 'input', net: 1 });
    const sdc = readSdc('create_clock -period 5 clk\nset_input_delay 1 [get_ports d]\nset_input_delay 2 [get_ports {d[1] c*}]', nl);
    expect(sdc.inputDelay.get('d[0]')?.max).toBe(1);
    expect(sdc.inputDelay.get('d[1]')?.max).toBe(2);
    expect(sdc.inputDelay.get('clk')?.max).toBe(2);
  });
});

describe('static timing analysis (#57)', () => {
  const nl = design();
  const base = 'create_clock -name clk -period 2 [get_ports clk]\nset_input_delay -clock clk -max 0.3 [get_ports a]\nset_input_delay -clock clk -min 0.01 [get_ports a]\nset_output_delay -clock clk 0.5 [get_ports q]\n';
  // the delay calculation by hand: no wires, pin loads only, ideal input transitions
  const dff = nldm(CELL.get('DFF')!), inv = nldm(CELL.get('INV')!);
  const l1 = PIN_CAP, lq = OUT_FF / 1000;
  const q1 = lookup(dff.rise, 0, l1), s1 = lookup(dff.riseTr, 0, l1);
  const i1 = lookup(inv.rise, s1, PIN_CAP), si1 = lookup(inv.riseTr, s1, PIN_CAP);
  const i2 = lookup(inv.rise, si1, PIN_CAP);

  it('computes setup and hold slack of register, input and output paths from the tables', () => {
    const { res } = sta(nl, undefined, readSdc(base, nl));
    const ff2 = res.setup.find(p => p.endpoint === 'ff2/D')!;
    expect(ff2.startpoint).toBe('ff1');
    expect(ff2.arrival).toBeCloseTo(q1 + i1 + i2, 9);
    expect(ff2.required).toBeCloseTo(2 - 0.05, 9);
    expect(ff2.slack).toBeCloseTo(2 - 0.05 - (q1 + i1 + i2), 9);
    expect(ff2.points.map(p => p.at)).toEqual(['clock clk (rise edge)', 'clock network delay (ideal)', 'ff1/CLK (DFF)', 'ff1/Q (DFF)', 'u1/A (INV)', 'u1/Y (INV)', 'u2/A (INV)', 'u2/Y (INV)', 'ff2/D (DFF)']);
    const out = res.setup.find(p => p.endpoint === 'q')!;
    expect(out.arrival).toBeCloseTo(lookup(dff.rise, 0, lq), 9);
    expect(out.slack).toBeCloseTo(2 - 0.5 - lookup(dff.rise, 0, lq), 9);
    expect(res.setup.find(p => p.endpoint === 'ff1/D')!.slack).toBeCloseTo(2 - 0.05 - 0.3, 9);
    // hold: the input arrives 0.01 ns after the edge, the flip-flop needs 0.02 ns
    const h = res.hold.find(p => p.endpoint === 'ff1/D')!;
    expect(h.slack).toBeCloseTo(0.01 - 0.02, 9);
    expect(res.whs).toBeCloseTo(-0.01, 9);
    expect(res.hold.find(p => p.endpoint === 'ff2/D')!.arrival).toBeCloseTo(lookup(dff.fall, 0, l1) + lookup(inv.fall, lookup(dff.fallTr, 0, l1), PIN_CAP) + lookup(inv.fall, lookup(inv.fallTr, lookup(dff.fallTr, 0, l1), PIN_CAP), PIN_CAP), 9);
    expect(res.wns).toBe(0);
    expect(res.fmax[0].mhz).toBeCloseTo(1000 / (2 - res.setup[0].slack), 6);
    const rep = reportPath(h);
    expect(rep).toMatch(/^Startpoint: a \(input port clocked by clk\)\nEndpoint: ff1\/D \(rising edge-triggered flip-flop clocked by clk\)\nPath type: min \(hold\)/);
    expect(rep).toMatch(/0\.020 +0\.020 +library hold time/);
    expect(rep).toMatch(/-0\.010 +slack \(VIOLATED\)$/);
  });

  it('uncertainty, transitions, loads and a tight clock change the result', () => {
    const { res } = sta(nl, undefined, readSdc(base.replace('-period 2', '-period 0.25') + 'set_clock_uncertainty 0.05\nset_load 0.05 [get_ports q]', nl));
    const ff2 = res.setup.find(p => p.endpoint === 'ff2/D')!;
    expect(ff2.required).toBeCloseTo(0.25 - 0.05 - 0.05, 9);
    expect(ff2.slack).toBeLessThan(0);
    expect(res.setup.find(p => p.endpoint === 'q')!.arrival).toBeCloseTo(lookup(dff.rise, 0, 0.05), 9);
    expect(res.hold.find(p => p.endpoint === 'ff1/D')!.required).toBeCloseTo(0.02 + 0.05, 9);
    const slow = sta(nl, undefined, readSdc(base + 'set_input_transition 0.4 [get_ports clk]', nl)).res;
    expect(slow.setup.find(p => p.endpoint === 'ff2/D')!.arrival).toBeGreaterThan(ff2.arrival);
  });

  it('false paths and max-delay exceptions', () => {
    const { res } = sta(nl, undefined, readSdc(base + 'set_false_path -from [get_ports a]\nset_max_delay 0.4 -from [get_cells ff1] -to [get_cells ff2]', nl));
    expect(res.setup.some(p => p.endpoint === 'ff1/D')).toBe(false);
    expect(res.hold.some(p => p.endpoint === 'ff1/D')).toBe(false);
    const ff2 = res.setup.find(p => p.endpoint === 'ff2/D')!;
    expect(ff2.required).toBeCloseTo(0.4, 9);
    expect(ff2.exception).toBe('set_max_delay 0.4 -from [get_cells ff1] -to [get_cells ff2]');
    expect(reportPath(ff2)).toContain('Exception: set_max_delay 0.4');
    // -to only, and a clock-to-clock false path
    expect(sta(nl, undefined, readSdc(base + 'set_false_path -to [get_ports q]', nl)).res.setup.some(p => p.endpoint === 'q')).toBe(false);
    expect(sta(nl, undefined, readSdc(base + 'set_false_path -from [get_clocks clk] -to [get_clocks clk]', nl)).res.setup).toEqual([]);
  });

  it('unclocked flip-flops and unconstrained ports are listed', () => {
    const { res } = sta(nl, undefined, readSdc('create_clock -name v -period 5', nl));
    expect(res.unclocked).toEqual(['ff1', 'ff2']);
    expect(res.unconstrained).toEqual(['a', 'clk', 'q']);
  });

  it('separation between clocks: worst setup and hold relation', () => {
    const c = (name: string, period: number, w0 = 0) => ({ name, period, waveform: [w0, w0 + period / 2] as [number, number] });
    const a = c('a', 10), b = c('b', 4);
    expect(separation(a, a)).toEqual({ setup: 10, hold: 0, edge: 0 });
    expect(separation(a, b).setup).toBeCloseTo(2, 9);   // launch at 10, capture at 12
    expect(separation(b, a).setup).toBeCloseTo(2, 9);   // launch at 8, capture at 10
    expect(separation(a, c('s', 10, 3)).setup).toBeCloseTo(3, 9);
  });

  it('the ideal-clock estimate and the SDF use the same delays', () => {
    const t = analyze(nl);
    expect(t.critical!.delay).toBeCloseTo(q1 + i1 + i2 + 0.05, 9);
    expect(t.critical!.points.map(p => p.at)).toEqual(['ff1/Q (DFF)', 'u1/Y (INV)', 'u2/Y (INV)', 'ff2/D (setup)']);
    const sdf = writeSdf(nl);
    expect(sdf).toContain(`(INSTANCE u2)\n    (DELAY (ABSOLUTE\n      (IOPATH A Y (${i2.toFixed(4)}:${i2.toFixed(4)}:${i2.toFixed(4)})`);
  });
});

describe('sta command (#57)', () => {
  const ALU = `module alu(input clk, input rst_n, input [3:0] a, output reg [3:0] acc);
  always @(posedge clk or negedge rst_n) if (!rst_n) acc <= 0; else acc <= acc + a;
endmodule`;
  it('asic -sdc and sta report slack and paths, and fail on violations', async () => {
    const fs: Record<string, string> = { 'alu.v': ALU, 'alu.sdc': 'create_clock -name clk -period 5 [get_ports clk]\nset_input_delay -clock clk 0.2 [get_ports {a rst_n}]\nset_output_delay -clock clk 0.2 [all_outputs]\n', 'fast.sdc': 'create_clock -period 0.2 clk\nset_input_delay 0 [all_inputs]\n' };
    const out: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, m => out.push(m));
    await s.exec('vlog alu.v');
    expect(await s.exec('asic -sdc alu.sdc'), out.join('\n')).toBe(true);
    expect(out.join('\n')).toMatch(/Timing \(SDC\): Setup: WNS 0\.000 ns, TNS 0\.000 ns, 0 of \d+ endpoints violated/);
    expect(fs['asic/alu.rpt']).toMatch(/Static timing analysis \(SDC\):[\s\S]*slack \(MET\)/);
    out.length = 0;
    expect(await s.exec('sta -paths 2 -setup')).toBe(true);
    expect(out.filter(l => l.startsWith('Startpoint:')).length).toBe(2);
    expect(fs['asic/alu_sta.rpt']).toMatch(/Setup slack per endpoint:\n +[\d.]+ +\S+\/(D|RN) +<- \S+/);
    out.length = 0;
    expect(await s.exec('sta -sdc fast.sdc')).toBe(false);
    expect(out.join('\n')).toMatch(/slack \(VIOLATED\)/);
    expect(out.join('\n')).toMatch(/Unconstrained ports: acc\[0\]/);
  }, 120_000);
});
