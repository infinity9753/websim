import { describe, it, expect } from 'vitest';
import { Session, parseValue } from '../src/engine/commands';
import { toBin } from '../src/engine/logic';

const files: Record<string, string> = {
  'counter.v': `\`timescale 1ns/1ps
module counter(input clk, input rst, output reg [3:0] q);
  always @(posedge clk) if (rst) q <= 0; else q <= q + 1;
endmodule`,
  'tb.v': `\`timescale 1ns/1ps
module tb; reg clk = 0, rst = 1; wire [3:0] q;
  counter dut(clk, rst, q);
  always #5 clk = ~clk;
  initial begin #20 rst = 0; #100 $display("done q=%0d", q); $finish; end
endmodule`,
  'bad.v': `module bad; wire x assign x = 1; endmodule`,
  'run.do': `vlib work\nvlog counter.v tb.v\nvsim work.tb\nadd wave -r /*\nrun -all\n`,
  'ff.v': `module ff(input clk, input d, output reg q); always @(posedge clk) q <= d; endmodule`,
};

function mk() {
  const lines: { m: string; k?: string }[] = [];
  const s = new Session({ read: (n) => files[n], list: () => Object.keys(files) }, (m, k) => lines.push({ m, k }));
  return { s, lines, text: () => lines.map(l => l.m).join('\n') };
}

describe('transcript commands', () => {
  it('runs a do-file flow', async () => {
    const { s, text } = mk();
    await s.exec('do run.do');
    expect(text()).toContain('-- Compiling module counter');
    expect(text()).toContain('Loading work.tb');
    expect(text()).toContain('done q=10');
    expect(s.waves.map(w => w.path)).toContain('/tb/dut/q');
    expect(s.now).toBe(120_000);
  });

  it('reports compile errors with file and line', async () => {
    const { s, lines } = mk();
    const ok = await s.exec('vlog bad.v');
    expect(ok).toBe(false);
    expect(lines.some(l => l.k === 'err' && /bad\.v\(1\)/.test(l.m))).toBe(true);
  });

  it('run with time, examine, force with repeat', async () => {
    const { s, lines } = mk();
    await s.exec('vlog ff.v');
    await s.exec('vsim ff');
    await s.exec('force clk 0 0, 1 5 -repeat 10');
    await s.exec('force d 1');
    await s.exec('run 30');
    expect(s.now).toBe(30_000);
    await s.exec('examine q');
    expect(lines[lines.length - 1].m).toBe('1');
    await s.exec('force d 0');
    await s.exec('run 10 ns');
    await s.exec('examine q d');
    expect(lines[lines.length - 1].m).toBe('0 0');
    await s.exec('restart');
    expect(s.now).toBe(0);
  });

  it('env and relative paths', async () => {
    const { s, lines } = mk();
    await s.exec('vlog counter.v tb.v; vsim tb');
    await s.exec('env dut');
    expect(lines[lines.length - 1].m).toBe('sim:/tb/dut');
    await s.exec('add wave *');
    expect(s.waves.map(w => w.path)).toEqual(['/tb/dut/clk', '/tb/dut/rst', '/tb/dut/q']);
  });

  it('parses force values', () => {
    expect(toBin(parseValue('16#A', 4))).toBe('1010');
    expect(toBin(parseValue("8'hF0", 8))).toBe('11110000');
    expect(toBin(parseValue('x', 4))).toBe('xxxx');
    expect(toBin(parseValue('5', 4))).toBe('0101');
    expect(toBin(parseValue('10', 2))).toBe('10');
  });
});

describe('wave format save/restore (#12)', () => {
  it('writes a do-file that rebuilds the wave window', async () => {
    const fs: Record<string, string> = { ...files };
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, () => {});
    await s.exec('vlog counter.v tb.v; vsim tb');
    await s.exec('add wave /tb/clk; add wave -divider Counter; add wave -radix hex /tb/q');
    await s.exec('write format wave w.do');
    expect(fs['w.do']).toContain('add wave -noupdate -divider {Counter}');
    expect(fs['w.do']).toContain('add wave -noupdate -radix hex /tb/q');
    await s.exec('delete wave *');
    expect(s.waves.length).toBe(0);
    await s.exec('do w.do');
    expect(s.waves.map(w => w.dividerLabel ?? `${w.path}:${w.radix}`)).toEqual(['/tb/clk:binary', 'Counter', '/tb/q:hex']);
  });
});
