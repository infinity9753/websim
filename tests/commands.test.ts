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
    expect(s.now).toBe(120e6); // fs
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
    expect(s.now).toBe(30e6);
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

  it('keeps analog format, colour, height, range and groups (#37)', async () => {
    const fs: Record<string, string> = { ...files };
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, () => {});
    await s.exec('vlog counter.v tb.v; vsim tb');
    await s.exec('add wave -group Ctl /tb/clk; add wave -format Analog-Step -height 80 -min 0 -max 15 -color Gold /tb/q; add wave -group Ctl -color red /tb/rst');
    // rst joins the existing group right after clk
    expect(s.waves.map(w => w.groupLabel ?? w.path)).toEqual(['Ctl', '/tb/clk', '/tb/rst', '/tb/q']);
    const hdr = s.waves[0];
    expect(s.waves.filter(w => w.parent === hdr.id).map(w => w.path)).toEqual(['/tb/clk', '/tb/rst']);
    const q = s.waves[3];
    expect([q.format, q.height, q.min, q.max, q.color]).toEqual(['analog-step', 80, 0, 15, 'Gold']);
    await s.exec('write format wave g.do');
    expect(fs['g.do']).toContain('add wave -noupdate -group {Ctl} -color red /tb/rst');
    expect(fs['g.do']).toContain('add wave -noupdate -color Gold -format Analog-Step -height 80 -min 0 -max 15 /tb/q');
    await s.exec('delete wave *; do g.do');
    expect(s.waves.map(w => w.groupLabel ?? `${w.path}:${w.format ?? 'literal'}:${w.color ?? ''}`)).toEqual(['Ctl', '/tb/clk:literal:', '/tb/rst:literal:red', '/tb/q:analog-step:Gold']);
  });
});

describe('memory commands (#14)', () => {
  it('lists, displays, saves, loads and deposits memory words', async () => {
    const fs: Record<string, string> = {
      'm.v': `module m; reg [7:0] ram [0:15]; integer i; initial for (i = 0; i < 16; i = i + 1) ram[i] = i * 3; endmodule`,
      'in.mem': '@2 aa bb\n',
    };
    const lines: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, m => lines.push(m));
    await s.exec('vlog m.v; vsim m; run 1');
    expect(s.listMemories()).toEqual([{ path: '/m/ram', lo: 0, hi: 15, w: 8 }]);
    await s.exec('mem display -startaddress 0 -endaddress 3 /m/ram');
    expect(lines.at(-1)).toBe('0000: 00 03 06 09');
    await s.exec('mem load -infile in.mem /m/ram');
    expect(s.memWords('/m/ram', 2, 2)!.words.map(v => Number(v.a))).toEqual([0xaa, 0xbb]);
    s.memDeposit('/m/ram', 15, '16#7f');
    await s.exec('mem save -outfile out.mem ram');
    expect(fs['out.mem']).toContain('@f 7f');
  });
});

describe('history limits and logging (#28)', () => {
  it('caps per-signal history, supports nolog and reports stats', async () => {
    const lines: string[] = [];
    const fs: Record<string, string> = { 'c.v': `module c; reg clk = 0; reg [7:0] n = 0; always #1 clk = ~clk; always @(posedge clk) n <= n + 1; endmodule` };
    const s = new Session({ read: x => fs[x], list: () => Object.keys(fs) }, m => lines.push(m));
    await s.exec('vlog c.v; vsim c; log -cap 100; nolog /c/n');
    await s.exec('run 1000');
    const clk = s.findSignal('/c/clk')!.obj.sig, n = s.findSignal('/c/n')!.obj.sig;
    expect(clk.times.length).toBeLessThanOrEqual(100);
    expect(clk.times[0]).toBeGreaterThan(0);              // oldest history trimmed
    expect(clk.times.at(-1)).toBe(1000e6);
    expect(n.times.length).toBe(1);                        // only the time-0 sample
    expect(n.value.toNumber()).toBe(500 % 256);            // value still tracked (500 edges, 8-bit wrap)
    await s.exec('simstats');
    expect(lines.at(-1)).toMatch(/Signals: 2 \(1 logged\)/);
  });

  it('add list / write list / delete list (#35)', async () => {
    const written: Record<string, string> = {};
    const lines: string[] = [];
    const s = new Session({ read: (n) => files[n], list: () => Object.keys(files), write: (n, t) => { written[n] = t; } }, (m) => lines.push(m));
    await s.exec('vlib work');
    await s.exec('vlog counter.v tb.v');
    await s.exec('vsim work.tb');
    await s.exec('add list -radix unsigned /tb/q /tb/rst');
    await s.exec('run 50 ns');
    await s.exec('write list out.lst');
    const t = written['out.lst'].split('\n');
    expect(t[0].trim().split(/\s+/)).toEqual(['ps', '/tb/q', '/tb/rst']); // times are in the simulator resolution (1 ps)
    // q is X until the first clock with rst, then counts once rst drops at 20 ns
    expect(t.slice(1, 6).map(l => l.trim().split(/\s+/))).toEqual([['0', 'x', '1'], ['5000', '0', '1'], ['20000', '0', '0'], ['25000', '1', '0'], ['35000', '2', '0']]);
    await s.exec('delete list /tb/rst');
    expect(s.lists.map(l => l.path)).toEqual(['/tb/q']);
    await s.exec('restart -f');
    expect(s.lists.map(l => l.path)).toEqual(['/tb/q']);
  });
});

describe('code coverage (#42)', () => {
  it('reports statements, branches and toggles; -details lists the misses', async () => {
    const fs: Record<string, string> = {
      'c.v': `module c;
  reg clk = 0; reg [1:0] s = 0; reg [3:0] q = 0; reg never = 0;
  always #5 clk = ~clk;
  always @(posedge clk) begin
    if (s != 3) q <= q + 1;
    else q <= 0;
    case (s)
      0: s <= 1;
      1: s <= 2;
      3: s <= 0;
    endcase
  end
  initial #100 $finish;
endmodule`,
    };
    const lines: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, m => lines.push(m));
    await s.exec('vlog c.v; vsim c');
    expect(await s.exec('coverage report')).toBe(false); // not enabled
    await s.exec('vsim -coverage c; run -all; coverage report -details -file cov.txt');
    const r = fs['cov.txt'];
    expect(r).toMatch(/Statements\s+8\s+6\s+2\s+75\.00%/);   // else branch and "3:" item never run
    expect(r).toMatch(/Branches\s+6\s+4\s+2\s+66\.67%/);     // if: true only; case: items 1, 2 and the implicit default (s stays 2)
    expect(r).toContain('Statements not executed: lines 6, 10');
    expect(r).toContain('Branch (if) at line 5 never took: else');
    expect(r).toContain('Branch (case) at line 7 never took: item 3 (line 10)');
    expect(r).toContain('/c/never: no toggle');
    expect(r).toMatch(/\/c\/s:\[1\] no 1->0/);
    const g = s.coverageLines()!.find(f => f.file === 'c.v')!;
    expect(g.lines.filter(([, n]) => n === 0).map(([l]) => l)).toEqual([6, 10]);
    await s.exec('coverage clear');
    expect(s.coverageLines()!.find(f => f.file === 'c.v')!.lines.every(([, n]) => n === 0)).toBe(true);
  });
});
