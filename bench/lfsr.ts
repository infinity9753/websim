// Simulation throughput benchmark: npx tsx bench/lfsr.ts [cycles]
import { LibraryManager } from '../src/engine/library';
import { Elaborator } from '../src/engine/elab';
import '../src/engine/vhdl';

const src = `\`timescale 1ns/1ps
module lfsr(input clk, input rst, output reg [15:0] r);
  always @(posedge clk) if (rst) r <= 16'hACE1; else r <= {r[14:0], r[15]^r[13]^r[12]^r[10]};
endmodule
module cnt(input clk, output reg [31:0] c); initial c = 0; always @(posedge clk) c <= c + 1; endmodule
module t; reg clk = 0, rst = 1; wire [15:0] r; wire [31:0] c;
  lfsr u(clk, rst, r);
  cnt k(clk, c);
  always #5 clk = ~clk;
  initial #20 rst = 0;
endmodule`;

const cycles = Number(process.argv[2] ?? 200000);
function once(debug: boolean): number {
  const lm = new LibraryManager();
  lm.compile('verilog', src, 'b.v');
  const d = new Elaborator(lm, { print: () => {} }, { debug }).elaborate('t');
  if (process.env.NOLOG) for (const s of d.kernel.signals) s.logged = false;
  const t0 = performance.now();
  let r; do r = d.kernel.run(cycles * 10e6, 1e9); while (r === 'budget');
  return performance.now() - t0;
}
for (const debug of [false, true]) {
  const ms = Math.min(once(debug), once(debug), once(debug));
  console.log(`debug=${debug}: ${cycles} cycles in ${ms.toFixed(0)} ms -> ${Math.round(cycles / ms * 1000)} cycles/s (best of 3)`);
}
