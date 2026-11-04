// Simulation throughput benchmark: npm run bench [-- [cycles] [--check bench/baseline.json] [--write bench/baseline.json]]
// The throughput is also normalized by a fixed pure-JavaScript workload timed on the same machine, so CI runners of
// different speeds can be compared with the stored baseline (#64): --check fails when a score drops below half of it (only large regressions: shared runners are noisy).
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
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

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const cycles = Number(argv.find(a => /^\d+$/.test(a)) ?? 200000);

/** Machine speed: ms for a fixed mix of BigInt, Map and array work (what the kernel spends its time on). */
function calibrate(): number {
  const run = () => {
    const t0 = performance.now();
    let a = 0x1234n, acc = 0;
    const m = new Map<number, number>(), arr: number[] = [];
    for (let i = 0; i < 300_000; i++) {
      a = ((a << 1n) ^ (a >> 3n) ^ BigInt(i & 0xff)) & 0xffffffffn;
      m.set(i & 1023, (m.get(i & 1023) ?? 0) + 1);
      arr.push(i); if (arr.length > 64) arr.length = 0;
      acc += Number(a & 0xffn);
    }
    if (acc < 0) console.log(acc);
    return performance.now() - t0;
  };
  return Math.min(run(), run(), run(), run(), run());
}
function once(debug: boolean): number {
  const lm = new LibraryManager();
  lm.compile('verilog', src, 'b.v');
  const d = new Elaborator(lm, { print: () => {} }, { debug }).elaborate('t');
  if (process.env.NOLOG) for (const s of d.kernel.signals) s.logged = false;
  const t0 = performance.now();
  let r; do r = d.kernel.run(cycles * 10e6, 1e9); while (r === 'budget');
  return performance.now() - t0;
}
const calib = calibrate();
const scores: Record<string, number> = {};
const lines: string[] = [`calibration: ${calib.toFixed(1)} ms`];
for (const debug of [false, true]) {
  const ms = Math.min(once(debug), once(debug), once(debug));
  const perS = cycles / ms * 1000;
  // cycles/s x calibration ms: about the same on fast and slow machines
  scores[`debug=${debug}`] = Math.round(perS * calib / 1000);
  lines.push(`debug=${debug}: ${cycles} cycles in ${ms.toFixed(0)} ms -> ${Math.round(perS)} cycles/s (best of 3), score ${scores[`debug=${debug}`]}`);
}
for (const l of lines) console.log(l);
const write = opt('--write');
if (write) { writeFileSync(write, JSON.stringify({ cycles, scores }, null, 2) + '\n'); console.log(`Wrote ${write}`); }
const check = opt('--check');
if (check) {
  const base = JSON.parse(readFileSync(check, 'utf8')) as { scores: Record<string, number> };
  const rows = Object.entries(scores).map(([k, v]) => ({ k, v, b: base.scores[k], r: base.scores[k] ? v / base.scores[k] : 1 }));
  const table = ['| run | score | baseline | ratio |', '|---|---|---|---|', ...rows.map(x => `| ${x.k} | ${x.v} | ${x.b ?? '-'} | ${(x.r * 100).toFixed(0)}% |`)];
  console.log(table.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['### Simulation benchmark', '', ...lines.map(l => `- ${l}`), '', ...table, ''].join('\n'));
  const slow = rows.filter(x => x.r < 0.5);
  if (slow.length) { console.error(`Performance regression: ${slow.map(x => `${x.k} at ${(x.r * 100).toFixed(0)}% of the baseline`).join(', ')}`); process.exit(1); }
}
