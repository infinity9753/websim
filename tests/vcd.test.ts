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

describe('VCD import (#36)', () => {
  it('re-opens an exported VCD with the same waveforms', async () => {
    const { s, fs } = mk();
    await s.exec('vlog t.v; vsim t; run -all; vcd export -all all.vcd');
    const orig = new Map(s.design!.kernel.signals.map(g => [g.path, g.times.map((t, i) => `${t}:${g.valAt(i).toString()}`).join(' ')]));
    await s.exec('vcd load all.vcd');
    const d = s.design!;
    expect(d.viewOnly).toBe(true);
    expect(d.root.name).toBe('t');
    expect(d.root.children.map(c => c.name)).toEqual(['u']);
    for (const g of d.kernel.signals) expect(g.times.map((t, i) => `${t}:${g.valAt(i).toString()}`).join(' ')).toBe(orig.get(g.path));
    expect(d.kernel.now).toBe(42e6);
    await s.exec('add wave /t/u/q');
    expect(s.waves.map(w => w.path)).toEqual(['/t/u/q']);
    expect(await s.exec('run 10')).toBe(false);
  });

  it('reads scalars, vectors with short values, reals, $dumpoff and several top scopes', async () => {
    const fs: Record<string, string> = {
      'x.vcd': `$timescale 10 ps $end
      $scope module a $end $var wire 1 ! clk $end $var reg 8 " bus [7:0] $end $upscope $end
      $scope module b $end $var real 64 # r $end $var wire 4 $ n[3:0] $end $upscope $end
      $enddefinitions $end
      #0 $dumpvars 0! b1 " r1.5 # bz $ $end
      #5 1! b10x1 "
      #7 r-2.25 # b0101 $`,
    };
    const lines: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs) }, m => lines.push(m));
    await s.exec('vsim -view x.vcd');
    const d = s.design!;
    expect(d.root.name).toBe('x');
    expect(d.root.children.map(c => c.name)).toEqual(['a', 'b']);
    const sig = (p: string) => d.kernel.signals.find(g => g.path === p)!;
    expect(sig('/x/a/bus').times).toEqual([0, 50000]); // fs
    expect(sig('/x/a/bus').valAt(0).toString()).toBe('00000001');
    expect(sig('/x/a/bus').valAt(1).toString()).toBe('000010x1');
    expect(sig('/x/b/n').valAt(0).toString()).toBe('zzzz');
    expect(sig('/x/b/n').msb).toBe(3);
    expect(sig('/x/b/r').isReal).toBe(true);
    await s.exec('examine -time 60 /x/b/r /x/b/n');
    expect(lines.at(-1)).toBe('-2.25 0101');
    expect(lines.some(l => l.includes('Opened VCD x.vcd: 4 signals in 3 scopes, end time 70 ps'))).toBe(true);
  });

  it('keeps real variables real across export and import', async () => {
    const fs: Record<string, string> = { 'r.v': '`timescale 1ns/1ns\nmodule r; real x = 0.25; initial #5 x = -1.5; endmodule' };
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, () => {});
    await s.exec('vlog r.v; vsim r; run 10; vcd export -all r.vcd; vcd load r.vcd');
    expect(fs['r.vcd']).toContain('$var real 64');
    const x = s.design!.kernel.signals[0];
    expect(x.isReal).toBe(true);
    expect(x.times).toEqual([0, 5e6]);
  });
});
