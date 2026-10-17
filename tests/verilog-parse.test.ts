import { describe, it, expect } from 'vitest';
import { parseVerilog } from '../src/engine/verilog/parser';

describe('Verilog parser', () => {
  it('parses ANSI module with params, always, assign, instances', () => {
    const src = `
\`timescale 1ns/1ps
\`define W 4
module counter #(parameter N = \`W) (input clk, input rst, output reg [N-1:0] q);
  wire en = 1'b1;
  always @(posedge clk or posedge rst)
    if (rst) q <= 0; else if (en) q <= q + 1;
endmodule
module tb;
  reg clk = 0, rst;
  wire [3:0] q;
  reg [7:0] mem [0:15];
  counter #(.N(4)) dut(.clk(clk), .rst(rst), .q(q));
  always #5 clk = ~clk;
  initial begin
    rst = 1; #12 rst = 0;
    repeat (20) @(posedge clk);
    $display("q=%d", q);
    $finish;
  end
endmodule`;
    const units = parseVerilog(src, 't.v');
    expect(units.map(u => u.name)).toEqual(['counter', 'tb']);
    expect(units[0].ports.map(p => p.name)).toEqual(['clk', 'rst', 'q']);
    expect(units[0].timescale).toEqual({ unit: 1000, prec: 1 });
    expect(units[1].items.some(i => i.k === 'inst')).toBe(true);
  });

  it('parses non-ANSI ports, functions, case, generate', () => {
    const src = `
module m(a, b, y);
  input [3:0] a, b; output [3:0] y; reg [3:0] y;
  function [3:0] f; input [3:0] x; begin f = x ^ 4'hf; end endfunction
  always @* case (a) 4'd0, 4'd1: y = f(b); default: y = 4'bxxxx; endcase
  genvar i;
  generate for (i = 0; i < 4; i = i + 1) begin : g
    wire t = a[i] & b[i];
  end endgenerate
endmodule`;
    const [m] = parseVerilog(src, 'm.v');
    expect(m.ports.map(p => p.dir)).toEqual(['input', 'input', 'output']);
    expect(m.items.map(i => i.k)).toContain('genfor');
  });

  it('reports syntax errors with line', () => {
    expect(() => parseVerilog('module x;\n  assign = 1;\nendmodule', 'e.v')).toThrowError(/syntax error/);
  });
});
