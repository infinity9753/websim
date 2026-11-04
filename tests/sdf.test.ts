import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';
import { simulate } from './helpers';

const FF = `\`timescale 1ns/1ps
module ff(input CLK, input D, input RN, input EN, output reg Q);
  reg notifier;
  always @(posedge CLK or negedge RN) if (!RN) Q <= 0; else Q <= D;
  always @(notifier) Q <= 1'bx;
  specify
    $setuphold(posedge CLK &&& EN, D, 2, 1, notifier);
    $recovery(posedge RN, posedge CLK, 3);
    $width(posedge CLK, 4);
    $period(posedge CLK, 9);
  endspecify
endmodule
`;
const TB = `\`timescale 1ns/1ps
module tb; reg clk = 0, d = 0, rn = 0, en = 1; wire q; ff u(clk, d, rn, en, q);
  initial begin
    #5 rn = 1;              // recovery: clk at 7, 2 < 3
    #2 clk = 1; #5 clk = 0;
    #4 d = 1; #1 clk = 1;   // setup: d at 16, clk at 17, 1 < 2
    #3 clk = 0;             // width: high for 3 < 4
    #3 clk = 1; #0.5 d = 0; // hold: 0.5 < 1; period: 6 < 9
    #0.1 $display("qh=%b", q);
    #4.9 en = 0; d = 1; #1 clk = 0; #0.5 clk = 1; // EN = 0: no setup check
    #2 $display("q=%b", q); $finish;
  end
endmodule
`;

const viol = (out: string[]) => out.filter(l => /^\*\* Warning: .*\$\w+\(/.test(l)).map(l => /\$(\w+)/.exec(l)![1]);

describe('timing checks (#56)', () => {
  it('reports setup, hold, recovery, width and period violations and toggles the notifier', () => {
    const { out } = simulate({ 'f.v': FF + TB }, 'tb');
    expect(viol(out)).toEqual(['recovery', 'setuphold', 'width', 'period', 'setuphold', 'period']);
    expect(out.find(l => l.includes('$setuphold'))).toContain('$setuphold( posedge CLK:17000 ps, D:16000 ps, 2000 ps );');
    expect(out).toContain('qh=x'); // the hold violation toggled the notifier, which made Q unknown
    expect(out).toContain('q=1');
  });

  it('+notimingchecks and +nospecify turn the checks off', async () => {
    for (const opt of ['+notimingchecks', '+nospecify']) {
      const fs: Record<string, string> = { 'f.v': FF + TB };
      const out: string[] = [];
      const s = new Session({ read: n => fs[n], list: () => Object.keys(fs) }, m => out.push(m));
      await s.exec(`vlog f.v; vsim ${opt} tb; run -all`);
      expect(viol(out)).toEqual([]);
      expect(out).toContain('qh=1');
      expect(out).toContain('q=1');
    }
  });
});

const GATE = `\`timescale 1ns/1ps
module inv(input A, output Y);
  assign Y = ~A;
  specify (A => Y) = (1, 1); endspecify
endmodule
module top(input a, output y); wire n; inv u1(.A(a), .Y(n)); inv u2(.A(n), .Y(y)); endmodule
module tb; reg a = 0; wire y; top dut(a, y);
  always @(y) $display("%t y=%b", $realtime, y);
  initial begin #10 a = 1; #20 $finish; end
endmodule
`;
const SDF = `(DELAYFILE (SDFVERSION "3.0") (DESIGN "top") (TIMESCALE 100ps)
  (CELL (CELLTYPE "inv") (INSTANCE u1) (DELAY (ABSOLUTE (IOPATH A Y (20:30:40) (10:15:20)))))
  (CELL (CELLTYPE "inv") (INSTANCE u2) (DELAY (ABSOLUTE (IOPATH A Y (5) (7)))))
)`;

describe('SDF back-annotation (#56)', () => {
  const run = async (cmd: string, extra: Record<string, string> = {}) => {
    const fs: Record<string, string> = { 'g.v': GATE, 'top.sdf': SDF, ...extra };
    const out: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs) }, m => out.push(m));
    await s.exec(`vlog ${Object.keys(fs).filter(f => f.endsWith('.v')).join(' ')}; ${cmd}; run -all`);
    return out;
  };
  const ys = (out: string[]) => out.filter(l => / y=/.test(l)).map(l => l.trim().replace(/\s+/g, ' '));

  it('without SDF the specify path delays apply', async () => {
    expect(ys(await run('vsim -t 1ps tb'))).toEqual(['1000 y=x', '2000 y=0', '12000 y=1']);
  });

  it('vsim -sdftyp/-sdfmax replace IOPATH delays (rise/fall picked by the new value)', async () => {
    // typ: u1 rises after 3 ns, falls after 1.5 ns; u2 rises after 0.5 ns, falls after 0.7 ns (x: the minimum)
    const typ = await run('vsim -t 1ps -sdftyp /tb/dut=top.sdf tb');
    expect(typ.some(l => l.includes('Loading SDF file top.sdf for region /tb/dut (typ): 2 path delays'))).toBe(true);
    expect(ys(typ)).toEqual(['500 y=x', '3700 y=0', '12000 y=1']);
    expect(ys(await run('vsim -t 1ps -sdfmax dut=top.sdf tb'))).toEqual(['500 y=x', '4700 y=0', '12500 y=1']);
  });

  it('$sdf_annotate annotates an instance at run time', async () => {
    const tb2 = `\`timescale 1ns/1ps
module tb2; reg a = 0; wire y; top dut(a, y);
  initial $sdf_annotate("top.sdf", dut, , , "MINIMUM");
  always @(y) $display("%t y=%b", $realtime, y);
  initial begin #10 a = 1; #20 $finish; end
endmodule
`;
    const out = await run('vsim -t 1ps tb2', { 'tb2.v': tb2 });
    expect(out.some(l => l.includes('annotated /tb2/dut: 2 path delays'))).toBe(true);
    expect(ys(out).at(-1)).toBe('11500 y=1'); // min: u1 falls after 1 ns, u2 rises after 0.5 ns
  });

  it('TIMINGCHECK values replace check limits; unknown instances warn', async () => {
    const sdf = `(DELAYFILE (TIMESCALE 1ns)
      (CELL (CELLTYPE "ff") (INSTANCE u) (TIMINGCHECK (SETUPHOLD D (posedge CLK) (0.5) (0.2)) (WIDTH (posedge CLK) (1)) (PERIOD (posedge CLK) (2))))
      (CELL (CELLTYPE "ff") (INSTANCE nope) (DELAY (ABSOLUTE (IOPATH CLK Q (1))))))`;
    const fs: Record<string, string> = { 'f.v': FF + TB, 'ff.sdf': sdf };
    const out: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs) }, m => out.push(m));
    await s.exec('vlog f.v; vsim -sdftyp ff.sdf tb; run -all');
    expect(out.some(l => l.includes('4 timing checks'))).toBe(true);
    expect(out.some(l => l.includes('no specify path to /tb/nope/Q'))).toBe(true);
    expect(viol(out)).toEqual(['recovery']);
  });
});
