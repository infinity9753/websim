import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';

// Yosys (WebAssembly) runs in-process; the first run loads ~77 MB, so allow time.
describe('synthesis with Yosys (#47)', () => {
  const rtl = {
    'rtl/counter.v': `module counter(input clk, input rst, input en, output reg [3:0] q, output tc);
  always @(posedge clk) if (rst) q <= 0; else if (en) q <= q + 1;
  assign tc = &q;
endmodule`,
    'rtl/top.v': `module top(input clk, input rst, output [3:0] q, output tc);
  counter u(.clk(clk), .rst(rst), .en(1'b1), .q(q), .tc(tc));
endmodule`,
    'tb.v': `module tb; reg clk = 0, rst = 1; wire [3:0] q; wire tc;
  top dut(clk, rst, q, tc);
  always #5 clk = ~clk;
  initial begin #12 rst = 0; repeat (20) begin @(negedge clk); $display("%0t q=%0d tc=%b", $time, q, tc); end $finish; end
endmodule`,
  };

  it('synthesizes the design under the testbench and the netlist simulates like the RTL', async () => {
    const fs: Record<string, string> = { ...rtl };
    const out: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, m => out.push(m));
    await s.exec('vlog rtl/counter.v rtl/top.v tb.v; vsim tb; run -all');
    const rtlTrace = out.filter(l => / q=/.test(l));
    expect(rtlTrace.length).toBe(20);
    await s.exec('quit -sim');
    expect(await s.exec('synth -flatten')).toBe(true); // top found automatically (tb is a testbench)
    expect(out.some(l => l.startsWith('-- Synthesizing top (generic) from rtl/top.v, rtl/counter.v'))).toBe(true);
    const cells = out.find(l => l.startsWith('Cells: '))!;
    expect(cells).toMatch(/\$_SDFFE?_PP0P?_ 4|\$_SDFF/);
    for (const f of ['synth/top.v', 'synth/top.json', 'synth/top.stat', 'synth/top.log']) expect(fs[f], f).toBeTruthy();
    expect(JSON.parse(fs['synth/top.json']).modules.top).toBeTruthy();
    // gate-level simulation: the netlist replaces the RTL "top" in work
    out.length = 0;
    await s.exec('vlog synth/top.v; vsim tb; run -all');
    expect(out.filter(l => / q=/.test(l))).toEqual(rtlTrace);
  }, 60_000);

  it('maps to an FPGA target and reports errors from Yosys', async () => {
    const fs: Record<string, string> = { ...rtl, 'bad.v': 'module bad(input a, output b); assign b = ; endmodule' };
    const out: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, m => out.push(m));
    expect(await s.exec('synth -top counter -target ice40 rtl/counter.v')).toBe(true);
    expect(out.find(l => l.startsWith('Cells: '))).toMatch(/SB_LUT4|SB_CARRY|SB_DFF/);
    expect(fs['synth/counter_ice40.v']).toContain('SB_');
    out.length = 0;
    expect(await s.exec('synth -top bad bad.v')).toBe(false);
    expect(out.some(l => l.startsWith('** Error: (synth)') && /bad\.v/.test(l))).toBe(true);
    expect(await s.exec('synth -target asic')).toBe(false);
  }, 60_000);
});
