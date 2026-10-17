import { describe, it, expect } from 'vitest';
import { simulate } from './helpers';

describe('Verilog simulation', () => {
  it('runs a counter testbench', () => {
    const { out, design } = simulate({
      'counter.v': `
\`timescale 1ns/1ps
module counter #(parameter W = 4) (input clk, input rst, output reg [W-1:0] q);
  always @(posedge clk or posedge rst)
    if (rst) q <= 0;
    else q <= q + 1;
endmodule`,
      'tb.v': `
\`timescale 1ns/1ps
module tb;
  reg clk = 0, rst = 1;
  wire [3:0] q;
  counter #(4) dut(.clk(clk), .rst(rst), .q(q));
  always #5 clk = ~clk;
  initial begin
    #12 rst = 0;
    #100;
    $display("q=%0d t=%0t", q, $time);
    $finish;
  end
endmodule`,
    }, 'tb');
    expect(out[0]).toBe('q=10 t=112000');
    expect(out[1]).toMatch(/\$finish/);
    const q = design.root.children[0].objects.find(o => o.name === 'q')!;
    expect(q.sig.times.length).toBeGreaterThan(5);
  });

  it('handles blocking vs non-blocking swap', () => {
    const { out } = simulate({
      't.v': `module t; reg [7:0] a, b; reg clk = 0;
        initial begin a = 1; b = 2; #1 clk = 1; #1 $display("%0d %0d", a, b); end
        always @(posedge clk) begin a <= b; b <= a; end
      endmodule`,
    }, 't');
    expect(out[0]).toBe('2 1');
  });

  it('evaluates expressions with sizing and signedness', () => {
    const { out } = simulate({
      't.v': `module t;
        reg [3:0] a = 4'd15, b = 4'd1;
        reg [4:0] s;
        reg signed [7:0] n = -8'sd3;
        integer i;
        initial begin
          s = a + b;
          $display("%0d", s);
          $display("%0d", a + b);
          $display("%0d", n >>> 1);
          $display("%b", {a[1:0], 2'b01});
          $display("%h", {2{4'ha}});
          $display("%0d", (n < 0) ? 1 : 0);
          i = -5; $display("%0d", i / 2);
          $display("%b", 4'b10x1 & 4'b1111);
          $display("%0d", $clog2(17));
          $display("%d", 8'd7);
        end endmodule`,
    }, 't');
    expect(out).toEqual(['16', '0', '-2', '1101', 'aa', '1', '-2', '10x1', '5', '  7']);
  });

  it('supports functions, tasks, case, loops, memories', () => {
    const { out } = simulate({
      't.v': `module t;
        reg [7:0] mem [0:7];
        integer i;
        reg [7:0] r;
        function [7:0] sq(input [7:0] x); sq = x * x; endfunction
        function integer fact(input integer n); if (n <= 1) fact = 1; else fact = n * fact(n - 1); endfunction
        task show(input [7:0] v); $display("v=%0d", v); endtask
        initial begin
          for (i = 0; i < 8; i = i + 1) mem[i] = sq(i);
          show(mem[3]);
          r = 0;
          while (r < 5) r = r + 2;
          show(r);
          case (r) 8'd6: $display("six"); default: $display("other"); endcase
          casez (4'b1010) 4'b1???: $display("msb"); default: $display("none"); endcase
          repeat (3) r = r - 1;
          show(r);
          $display("%0d", fact(5));
        end endmodule`,
    }, 't');
    expect(out).toEqual(['v=9', 'v=6', 'six', 'msb', 'v=3', '120']);
  });

  it('continuous assigns, generate and hierarchical names', () => {
    const { out } = simulate({
      't.v': `
module fa(input a, b, ci, output s, co);
  assign s = a ^ b ^ ci;
  assign co = (a & b) | (ci & (a ^ b));
endmodule
module adder #(parameter N = 4)(input [N-1:0] a, b, output [N:0] y);
  wire [N:0] c;
  assign c[0] = 1'b0;
  genvar i;
  generate for (i = 0; i < N; i = i + 1) begin : bit_
    fa u(.a(a[i]), .b(b[i]), .ci(c[i]), .s(y[i]), .co(c[i+1]));
  end endgenerate
  assign y[N] = c[N];
endmodule
module t;
  reg [3:0] a, b; wire [4:0] y;
  adder #(.N(4)) dut(a, b, y);
  initial begin
    a = 9; b = 8; #1 $display("%0d", y);
    a = 15; b = 15; #1 $display("%0d %b", y, dut.c);
  end
endmodule`,
    }, 't');
    expect(out).toEqual(['17', '30 11110']);
  });

  it('$monitor and $strobe in postponed region', () => {
    const { out } = simulate({
      't.v': `module t; reg [1:0] x = 0;
        initial begin $monitor("x=%0d", x); #1 x = 1; #1 x = 2; x = 3; #1 $finish; end
        initial begin #1 x = 1; $strobe("strobe %0d", x); end
      endmodule`,
    }, 't');
    expect(out.slice(0, 4)).toEqual(['x=0', 'strobe 1', 'x=1', 'x=3']);
  });

  it('wait, named-block disable, event or', () => {
    const { out } = simulate({
      't.v': `module t; reg a = 0, b = 0; integer n = 0;
        initial begin : blk
          forever begin
            @(a or b) n = n + 1;
            if (n == 3) disable blk;
          end
        end
        initial begin #1 a = 1; #1 b = 1; #1 a = 0; #1 b = 0; #1 $display("n=%0d", n); end
        initial begin wait (b == 1) $display("b high at %0t", $time); end
      endmodule`,
    }, 't');
    expect(out).toEqual(['b high at 2', 'n=3']);
  });

  it('detects zero-delay always loops', () => {
    expect(() => simulate({ 't.v': 'module t; reg a; always a = ~a; endmodule' }, 't')).toThrow(/timing control/);
  });

  it('$readmemh with a file', () => {
    const { out } = simulate({
      't.v': `module t; reg [7:0] m [0:3]; initial begin $readmemh("d.hex", m); $display("%h %h", m[0], m[3]); end endmodule`,
    }, 't', 1e9, { 'd.hex': '// data\n0a 1b\n@3 ff\n' });
    expect(out[0]).toBe('0a ff');
  });
});

describe('port collapsing', () => {
  it('output reg collapsed onto a wire starts as X', () => {
    const { design } = simulate({
      't.v': `module c(input clk, output reg [1:0] q); always @(posedge clk) q <= 1; endmodule
              module t; reg clk = 0; wire [1:0] q; c u(clk, q); initial #1 clk = 1; endmodule`,
    }, 't', 0);
    const q = design.root.objects.find(o => o.name === 'q')!.sig;
    expect(q.vals[0].toString()).toBe('xx');
  });
});

describe('intra-assignment event control (#1)', () => {
  it('q <= @(posedge clk) d updates after the event and does not block', () => {
    const { out } = simulate({
      't.v': `module t; reg clk = 0, d = 1, q = 0;
        initial begin
          q <= @(posedge clk) d;
          d = 0;
          $display("t=%0t q=%b", $time, q);
          #5 $display("t=%0t q=%b", $time, q);
          clk = 1;
          #1 $display("t=%0t q=%b", $time, q);
        end
      endmodule`,
    }, 't');
    expect(out).toEqual(['t=0 q=0', 't=5 q=0', 't=6 q=1']);
  });
});

describe('named events (#3)', () => {
  it('-> e wakes processes waiting on @(e)', () => {
    const { out } = simulate({
      't.v': `module t; event go, done_ev; integer n = 0;
        initial begin #10 -> go; @(done_ev) $display("done at %0t n=%0d", $time, n); #10 -> go; #1 $display("n=%0d", n); end
        always @(go) begin n = n + 1; #5 -> done_ev; end
      endmodule`,
    }, 't');
    expect(out).toEqual(['done at 15 n=1', 'n=2']);
  });
});
