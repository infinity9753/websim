import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';
import { CELLS, liberty, verilogModels, TRACK, ROW_TRACKS } from '../src/engine/asic/cells';
import { readNetlist } from '../src/engine/asic/netlist';
import { abacus, place, pinXY, hpwl } from '../src/engine/asic/place';

function session(files: Record<string, string>) {
  const out: string[] = [];
  const s = new Session({ read: n => files[n], list: () => Object.keys(files), write: (n, t) => { files[n] = t; } }, m => out.push(m));
  return { s, out };
}

// In-browser educational ASIC flow (#51)
describe('ASIC standard-cell library and synthesis (#51)', () => {
  it('describes every cell in Liberty, gives distinct on-grid pins and simulates the models', async () => {
    const lib = liberty();
    for (const c of CELLS) {
      expect(lib).toContain(`cell(${c.name})`);
      const cols = Object.values(c.pins).map(p => p.x);
      expect(new Set(cols).size, c.name).toBe(cols.length);
      for (const p of Object.values(c.pins)) {
        expect(p.x > 0 && p.x < c.width, `${c.name} x`).toBe(true);
        expect(p.y > 0 && p.y < ROW_TRACKS - 1, `${c.name} y`).toBe(true);
      }
      if (c.kind !== 'fill') expect(Object.keys(c.pins).sort()).toEqual([...c.inputs, c.output!].sort());
    }
    expect(lib).toMatch(/cell\(DFFR\)[\s\S]*clear : "!RN"/);
    expect(TRACK * ROW_TRACKS).toBe(3200);
    // the models: exhaustive truth tables of the combinational cells
    const tb = ['module tb;', '  reg [2:0] v; integer i;',
      ...CELLS.filter(c => c.kind === 'comb').map(c => `  wire y_${c.name}; ${c.name} u_${c.name}(${c.inputs.map((p, i) => `.${p}(v[${i}])`).join(', ')}, .Y(y_${c.name}));`),
      '  initial for (i = 0; i < 8; i = i + 1) begin v = i; #1;',
      ...CELLS.filter(c => c.kind === 'comb').map(c => `    $display("${c.name} %b %b", v, y_${c.name});`),
      '  end', 'endmodule'].join('\n');
    const { s, out } = session({ 'cells.v': verilogModels(), 'tb.v': tb });
    expect(await s.exec('vlog cells.v tb.v; vsim tb; run -all')).toBe(true);
    const ref: Record<string, (a: number, b: number, c: number) => number> = {
      INV: a => 1 - a, BUF: a => a, NAND2: (a, b) => 1 - (a & b), NAND3: (a, b, c) => 1 - (a & b & c), NOR2: (a, b) => 1 - (a | b), NOR3: (a, b, c) => 1 - (a | b | c),
      AND2: (a, b) => a & b, OR2: (a, b) => a | b, XOR2: (a, b) => a ^ b, XNOR2: (a, b) => 1 - (a ^ b),
      AOI21: (a, b, c) => 1 - ((a & b) | c), OAI21: (a, b, c) => 1 - ((a | b) & c), MUX2: (a, b, c) => (c ? b : a),
    };
    let n = 0;
    for (const l of out) {
      const m = /^(\w+) ([01]{3}) ([01x])$/.exec(l);
      if (!m) continue;
      const v = parseInt(m[2], 2);
      expect(m[3], l).toBe(String(ref[m[1]](v & 1, (v >> 1) & 1, (v >> 2) & 1)));
      n++;
    }
    expect(n).toBe(8 * Object.keys(ref).length);
  }, 60_000);

  it('maps a design onto the library and the gate-level netlist simulates like the RTL', async () => {
    const fs: Record<string, string> = {
      'rtl.v': `module dut(input clk, input rst_n, input en, input sel, input [3:0] d, output reg [3:0] q, output n, output [1:0] k, output [4:0] sum);
  reg nq;
  always @(posedge clk or negedge rst_n) if (!rst_n) q <= 0; else if (en) q <= q + 1; else q <= d;
  always @(negedge clk) nq <= sel ? q[0] : q[3];
  assign n = nq ^ &q;
  assign k = 2'b10;
  assign sum = q + d;
endmodule`,
      'tb.v': `module tb; reg clk = 0, rst_n = 0, en = 0, sel = 0; reg [3:0] d = 0; wire [3:0] q; wire n; wire [1:0] k; wire [4:0] sum;
  dut u(.clk(clk), .rst_n(rst_n), .en(en), .sel(sel), .d(d), .q(q), .n(n), .k(k), .sum(sum));
  always #5 clk = ~clk;
  integer i;
  initial begin
    #12 rst_n = 1;
    for (i = 0; i < 40; i = i + 1) begin
      @(negedge clk); #2 $display("%0d q=%h n=%b k=%b sum=%h", $time, q, n, k, sum);
      en = ($random & 3) != 0; sel = $random; d = $random;
      if (i == 25) begin rst_n = 0; #1 rst_n = 1; end
    end
    $finish;
  end
endmodule`,
    };
    const { s, out } = session(fs);
    await s.exec('vlog rtl.v tb.v; vsim tb; run -all');
    const rtlTrace = out.filter(l => / q=/.test(l));
    expect(rtlTrace.length).toBe(40);
    expect(rtlTrace.join('\n')).not.toMatch(/x/);
    await s.exec('quit -sim');
    out.length = 0;
    expect(await s.exec('synth -target asic'), out.join('\n')).toBe(true);
    const cells = out.find(l => l.startsWith('Cells: '))!;
    expect(cells).toMatch(/DFFR 4/);
    expect(cells).toMatch(/DFF 1\b/);
    expect(cells).toMatch(/TIEHI 1.*TIELO 1|TIELO 1.*TIEHI 1/);
    expect(cells).not.toMatch(/\$_/);
    expect(out.find(l => l.startsWith('Chip area: '))).toMatch(/^Chip area: [\d.]+ um\^2/);
    for (const f of ['synth/dut_asic.v', 'synth/dut_asic.json', 'synth/websim_edu.v', 'synth/websim_edu.lib']) expect(fs[f], f).toBeTruthy();
    // gate-level simulation with the cell models (and their specify delays)
    out.length = 0;
    expect(await s.exec('vlog synth/websim_edu.v synth/dut_asic.v; vsim tb; run -all')).toBe(true);
    expect(out.filter(l => / q=/.test(l))).toEqual(rtlTrace);
  }, 120_000);

  it('rejects latches the library cannot implement', async () => {
    const { s, out } = session({ 'l.v': 'module l(input g, input d, output reg q); always @* if (g) q = d; endmodule' });
    await s.exec('vlog l.v');
    expect(await s.exec('synth -target asic')).toBe(false);
    expect(out.join('\n')).toMatch(/\*\* Error: \(synth\)/);
  }, 60_000);
});

const ALU = `module alu(input clk, input rst_n, input [1:0] op, input [7:0] a, input [7:0] b, output reg [7:0] acc, output reg [7:0] lfsr, output reg [3:0] cnt, output z);
  always @(posedge clk or negedge rst_n)
    if (!rst_n) begin acc <= 0; lfsr <= 8'h1; cnt <= 0; end
    else begin
      case (op) 2'd0: acc <= acc + a; 2'd1: acc <= acc - b; 2'd2: acc <= acc & (a | b); default: acc <= acc ^ {a[3:0], b[7:4]}; endcase
      lfsr <= {lfsr[6:0], lfsr[7] ^ lfsr[5] ^ lfsr[4] ^ lfsr[3]};
      cnt <= cnt + (op == 2'd3);
    end
  assign z = acc == 0;
endmodule`;

async function synthAsic(files: Record<string, string>, top: string) {
  const { s, out } = session(files);
  await s.exec(`vlog ${Object.keys(files).filter(f => f.endsWith('.v')).join(' ')}`);
  if (!(await s.exec(`synth -top ${top} -target asic`))) throw new Error(out.join('\n'));
  return files[`synth/${top}_asic.json`];
}

describe('ASIC floorplan and placement (#51)', () => {
  it('Abacus legalizes a row with minimal displacement', () => {
    expect(abacus([0, 1, 2], [2, 2, 2], 0, 10)).toEqual([0, 2, 4]);
    expect(abacus([5, 0, 9], [2, 2, 2], 0, 10)).toEqual([5, 0, 8]);
    // overlapping targets share the displacement around their mean
    expect(abacus([4, 4], [2, 2], 0, 10)).toEqual([3, 5]);
    expect(abacus([9, 9, 9], [2, 2, 2], 0, 10)).toEqual([4, 6, 8]);
  });

  it('places a synthesized design legally, with IO on the boundary and short wires', async () => {
    const json = await synthAsic({ 'alu.v': ALU }, 'alu');
    const nl = readNetlist(json, 'alu');
    expect(nl.cells.length).toBeGreaterThan(60);
    expect(nl.ports.length).toBe(1 + 1 + 2 + 8 + 8 + 8 + 8 + 4 + 1);
    const t0 = Date.now();
    const p = place(nl, { util: 0.6 });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(p.util).toBeGreaterThan(0.45);
    expect(p.util).toBeLessThan(0.75);
    // every row is exactly covered by cells and fillers, without overlaps
    for (let row = 0; row < p.rows; row++) {
      const segs = [...nl.cells.map((c, i) => ({ x: p.cells[i].x, w: c.def.width, row: p.cells[i].row })), ...p.fillers.map(f => ({ x: f.x, w: Number(f.type.slice(4)), row: f.row }))]
        .filter(v => v.row === row).sort((a, b) => a.x - b.x);
      let x = p.margin;
      for (const v of segs) { expect(v.x, `row ${row}`).toBe(x); x += v.w; }
      expect(x).toBe(p.margin + p.cols);
    }
    // IO pins on distinct boundary slots
    const keys = p.ports.map(q => `${q.x},${q.y}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const q of p.ports) expect(q.x === 0 || q.y === 0 || q.x === p.dieW - 1 || q.y === p.dieH - 1).toBe(true);
    // pin access points are unique grid points inside the core
    const acc = new Set<string>();
    nl.cells.forEach((c, i) => { for (const pin of Object.keys(c.pins)) { const [x, y] = pinXY(p, nl, i, pin); expect(acc.has(`${x},${y}`)).toBe(false); acc.add(`${x},${y}`); } });
    // much shorter than a random legal placement of the same cells
    const rnd = { ...p, cells: p.cells.map(c => ({ ...c })) };
    let seed = 1;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const order = nl.cells.map((_, i) => i).sort(() => rand() - 0.5);
    let row = 0, x = p.margin;
    for (const i of order) { const w = nl.cells[i].def.width; if (x + w > p.margin + p.cols) { row++; x = p.margin; } rnd.cells[i] = { x, row }; x += w; }
    expect(p.hpwl).toBe(hpwl(p, nl));
    if ((globalThis as any).process?.env?.SHOW) console.log(nl.cells.length, p.rows, p.cols, p.util.toFixed(2), p.hpwl, hpwl(rnd, nl), Date.now() - t0);
    expect(p.hpwl).toBeLessThan(0.5 * hpwl(rnd, nl));
  }, 120_000);
});
