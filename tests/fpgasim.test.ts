import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';
import { fpgaSimModels } from '../src/engine/fpgasim';

function session(files: Record<string, string>) {
  const out: string[] = [];
  const s = new Session({ read: n => files[n], list: () => Object.keys(files), write: (n, t) => { files[n] = t; } }, m => out.push(m));
  return { s, out };
}

describe('Verilog features used by vendor cell models (#52)', () => {
  it('ignores attribute instances but keeps @(*)', async () => {
    const { s, out } = session({
      'a.v': `(* keep_hierarchy, src = "x.v:1 (*) *)" *)
module a((* iopad_external_pin *) input i, output reg o);
  (* keep *) wire w = ~i;
  always @(*) o = (* parallel_case *) w;
  initial begin #2; $display("o=%b", o); end
endmodule
module tb; reg i = 1; wire o; a u(.i(i), .o(o)); initial #1 i = 0; endmodule`,
    });
    expect(await s.exec('vlog a.v; vsim tb; run -all'), out.join('\n')).toBe(true);
    expect(out, out.join('\n')).toContain('o=1');
  });

  it('elaborates case-generate blocks, with several labels, default and named blocks', async () => {
    const { s, out } = session({
      'g.v': `module g #(parameter MODE = "B", parameter N = 2) (output [7:0] y);
  generate
    case (MODE)
      "A", "AA": assign y = 8'h0a;
      "B": begin : bmode
        wire [7:0] t = 8'h0b + N;
        assign y = t;
      end
      default: assign y = 8'hff;
    endcase
  endgenerate
endmodule
module tb; wire [7:0] a, b, c, d;
  g #(.MODE("A")) ua(a); g #(.MODE("AA")) uaa(b); g #(.N(3)) ub(c); g #(.MODE("Z")) uz(d);
  initial #1 $display("%h %h %h %h", a, b, c, d);
endmodule`,
    });
    expect(await s.exec('vlog g.v; vsim tb; run -all'), out.join('\n')).toBe(true);
    expect(out).toContain('0a 0a 0e ff');
    expect(s.findScope('/tb/ub/bmode')).not.toBeNull();
  });

  it('reports elaboration-time $error / $warning only in the chosen generate branch', async () => {
    const files = {
      'e.v': `module e #(parameter W = 4) (output [W-1:0] y);
  if (W > 8) $error("W=%0d is too wide", W);
  else if (W < 2) $warning("W=%0d is narrow", W);
  assign y = 0;
endmodule
module ok; wire [3:0] y; e u(y); endmodule
module narrow; wire y; e #(1) u(y); endmodule
module bad; wire [15:0] y; e #(16) u(y); endmodule`,
    };
    const { s, out } = session(files);
    await s.exec('vlog e.v');
    expect(await s.exec('vsim ok')).toBe(true);
    expect(out.join('\n'), out.join('\n')).not.toMatch(/is narrow|too wide/);
    await s.exec('vsim narrow');
    expect(out.join('\n')).toMatch(/\*\* Warning: \(vsim-8323\) Warning: \/narrow\/u: W=1 is narrow/);
    out.length = 0;
    await s.exec('vsim bad');
    expect(out.join('\n')).toMatch(/\*\* Error: e\.v\(2\): \(vsim-8323\) \/bad\/u: W=16 is too wide/);
    expect(s.design).toBeNull();
  });

  it('merges many specify paths to one output without blowing up (largest delay wins)', async () => {
    const paths = Array.from({ length: 40 }, (_, k) => `    (I[${k % 8}] => O[${k % 4}]) = ${10 + k};`).join('\n');
    const { s, out } = session({
      'p.v': `\`timescale 1ns/1ns
module p(input [7:0] I, output [3:0] O);
  assign O = I[3:0] ^ I[7:4];
  specify
${paths}
  endspecify
endmodule
module tb; reg [7:0] i = 0; wire [3:0] o; p u(i, o);
  initial begin #1 i = 8'h01; #48 $display("t49 o=%b", o); #1 $display("t50 o=%b", o); end
endmodule`,
    });
    const t0 = Date.now();
    expect(await s.exec('vlog p.v; vsim tb; run -all'), out.join('\n')).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    // the largest path delay to O is 49: the change at t=1 arrives at t=50
    expect(out.find(l => l.startsWith('t49'))).not.toBe('t49 o=0001');
    expect(out).toContain('t50 o=0001');
  });
});

const RTL = `module dut(input clk, input rst_n, input en, input sel, input [3:0] d, output reg [3:0] q, output n, output [1:0] k, output [4:0] sum, output [7:0] prod);
  reg nq;
  always @(posedge clk or negedge rst_n) if (!rst_n) q <= 0; else if (en) q <= q + 1; else q <= d;
  always @(negedge clk) nq <= sel ? q[0] : q[3];
  assign n = nq ^ &q;
  assign k = 2'b10;
  assign sum = q + d;
  assign prod = q * d;
endmodule`;
const TB = `module tb; reg clk = 0, rst_n = 0, en = 0, sel = 0; reg [3:0] d = 0; wire [3:0] q; wire n; wire [1:0] k; wire [4:0] sum; wire [7:0] prod;
  dut u(.clk(clk), .rst_n(rst_n), .en(en), .sel(sel), .d(d), .q(q), .n(n), .k(k), .sum(sum), .prod(prod));
  // a slow clock: the FPGA models carry realistic (ns) cell delays
  always #20 clk = ~clk;
  integer i;
  initial begin
    #30 rst_n = 1;
    for (i = 0; i < 40; i = i + 1) begin
      @(negedge clk); #15 $display("%0d q=%h n=%b k=%b sum=%h prod=%h", $time, q, n, k, sum, prod);
      en = ($random & 3) != 0; sel = $random; d = $random;
      if (i == 25) begin rst_n = 0; #1 rst_n = 1; end
    end
    $finish;
  end
endmodule`;

describe('gate-level simulation of FPGA netlists (#52)', () => {
  for (const [target, cells] of [['ice40', /SB_LUT4/], ['ecp5', /MULT18X18D/], ['gowin', /MULT9X9/], ['xilinx', /CARRY4/]] as const) {
    it(`${target}: the netlist with the primitive models simulates like the RTL`, async () => {
      const fs: Record<string, string> = { 'rtl.v': RTL, 'tb.v': TB };
      const { s, out } = session(fs);
      await s.exec('vlog rtl.v tb.v; vsim tb; run -all');
      const ref = out.filter(l => / q=/.test(l));
      expect(ref.length).toBe(40);
      expect(ref.join('\n')).not.toMatch(/x|z/);
      await s.exec('quit -sim');
      out.length = 0;
      expect(await s.exec(`synth -top dut -target ${target}`)).toBe(true);
      expect(out.find(l => l.startsWith('Cells: '))).toMatch(cells);
      expect(out.join('\n')).toContain(`cell models synth/${target}_cells.v`);
      expect(fs[`synth/${target}_cells.v`]).toMatch(/^\/\/ Simulation models of/);
      out.length = 0;
      expect(await s.exec(`vlog synth/${target}_cells.v synth/dut_${target}.v; vsim tb; run -all`), out.filter(l => /Error/.test(l)).join('\n')).toBe(true);
      expect(out.filter(l => / q=/.test(l))).toEqual(ref);
    }, 120_000);
  }

  it('the DSP models refuse registered modes they do not model', async () => {
    const { s, out } = session({
      'm.v': fpgaSimModels('gowin'),
      'tb.v': `module tb; wire [17:0] p; MULT9X9 #(.AREG(1'b1)) u(.A(9'd3), .B(9'd5), .ASIGN(1'b0), .BSIGN(1'b0), .ASEL(1'b0), .BSEL(1'b0), .DOUT(p)); endmodule
module tb2; wire [17:0] p; MULT9X9 u(.A(9'd3), .B(-9'sd5), .ASIGN(1'b0), .BSIGN(1'b1), .ASEL(1'b0), .BSEL(1'b0), .DOUT(p)); initial #1 $display("p=%0d", $signed(p)); endmodule`,
    });
    await s.exec('vlog m.v tb.v');
    expect(await s.exec('vsim tb')).toBe(false);
    expect(out.join('\n')).toMatch(/registered MULT9X9 modes have no simulation model/);
    expect(await s.exec('vsim tb2; run -all')).toBe(true);
    expect(out).toContain('p=-15');
  });
});
