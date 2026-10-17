import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';
import { readVcd } from '../src/engine/vcd';

const files: Record<string, string> = {
  't.v': `\`timescale 1ns/1ps
module c(input clk, output reg [3:0] q); initial q = 0; always @(posedge clk) q <= q + 1; endmodule
module t; reg clk = 0; wire [3:0] q; c u(clk, q);
  always #5 clk = ~clk;
  initial begin $dumpfile("out.vcd"); $dumpvars(0, t); #42 $finish; end
endmodule`,
};

function mk() {
  const fs = { ...files };
  const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, () => {});
  return { s, fs };
}

describe('VCD export (#4)', () => {
  it('round-trips wave signals through the writer and reader', async () => {
    const { s, fs } = mk();
    await s.exec('vlog t.v; vsim t; add wave /t/clk /t/q; run -all; vcd export w.vcd');
    const v = readVcd(fs['w.vcd']);
    expect([...v.keys()].sort()).toEqual(['t.clk', 't.q']);
    const q = v.get('t.q')!;
    expect(q[0]).toEqual([0, '0']);
    expect(q.at(-1)).toEqual([35, '100']);
    expect(v.get('t.clk')!.filter(([, b]) => b === '1').length).toBe(4);
    expect(fs['w.vcd']).toContain('$timescale 1ns $end');
  });

  it('$dumpfile/$dumpvars write the file after the run', async () => {
    const { s, fs } = mk();
    await s.exec('vlog t.v; vsim t; run -all');
    expect(fs['out.vcd']).toBeDefined();
    const v = readVcd(fs['out.vcd']);
    expect(v.has('t.u.q')).toBe(true);
    expect(v.has('t.clk')).toBe(true);
  });
});
