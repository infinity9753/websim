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

describe('fork/join (#10)', () => {
  it('join waits for all, join_any for the first, join_none for none', () => {
    const { out } = simulate({
      't.v': `module t;
        initial begin
          fork
            #10 $display("a %0t", $time);
            #30 $display("b %0t", $time);
            begin #5; #15 $display("c %0t", $time); end
          join
          $display("join %0t", $time);
          fork
            #7 $display("d %0t", $time);
            #50 $display("e %0t", $time);
          join_any
          $display("join_any %0t", $time);
          fork
            #1 $display("f %0t", $time);
          join_none
          $display("join_none %0t", $time);
          #100 $finish;
        end
      endmodule`,
    }, 't');
    expect(out.slice(0, 9)).toEqual(['a 10', 'c 20', 'b 30', 'join 30', 'd 37', 'join_any 37', 'join_none 37', 'f 38', 'e 80']);
  });

  it('disable fork kills remaining branches', () => {
    const { out } = simulate({
      't.v': `module t;
        initial begin
          fork
            #5 $display("fast");
            #50 $display("slow");
          join_any
          disable fork;
          #100 $display("end %0t", $time);
        end
      endmodule`,
    }, 't');
    expect(out).toEqual(['fast', 'end 105']);
  });
});

describe('real numbers (#17)', () => {
  it('Verilog real arithmetic, conversions and formatting', () => {
    const { out } = simulate({
      't.v': `\`timescale 1ns/1ps
module t;
  real r = 1.5, s;
  integer i;
  parameter real K = 0.25;
  parameter HALF = 2.5;
  function real twice(input real x); twice = x * 2; endfunction
  initial begin
    r = r * 2;
    $display("%f", r);
    s = r / 4 + K;
    $display("%0.3f %e", s, s);
    i = r + 0.6;
    $display("%0d", i);
    i = $rtoi(3.99);
    $display("%0d %f", i, $itor(7));
    $display("%g", twice(1.25));
    if (r > 2.9 && r < 3.1) $display("cmp ok");
    #HALF $display("t=%0t rt=%f", $time, $realtime);
    $display("%f", $sqrt(2.0) * $sqrt(2.0));
    $display(r);
  end
endmodule`,
    }, 't');
    expect(out).toEqual(['3.000000', '1.000 1.000000e+00', '4', '3 7.000000', '2.5', 'cmp ok', 't=3000 rt=2.500000', '2.000000', '3']);
  });

  it('VHDL real signals, conversions and image', () => {
    const src = `
entity t is end;
architecture a of t is
  signal x : real := 0.5;
  constant G : real := 2.0;
begin
  process
    variable y : real;
    variable n : integer;
  begin
    y := x * G + 1.25;
    n := integer(y * 10.0);
    report real'image(y) & " " & integer'image(n) & " " & real'image(real(n) / 4.0);
    x <= 2.25;
    wait for 1 ns;
    report real'image(x);
    wait;
  end process;
end;`;
    const { out } = simulate({ 't.vhd': src }, 't');
    expect(out.filter(l => l.startsWith('**'))).toEqual(['** Note: 2.250000e+00 23 5.750000e+00', '** Note: 2.250000e+00']);
  });
});

describe('file I/O and $sformatf (#18)', () => {
  it('writes, reads and scans files; formats strings', () => {
    const files2: Record<string, string> = { 'in.txt': 'add 3 4\nmul 6 7\n' };
    const { out } = simulate({
      't.v': `module t;
        integer fo, fi, a, b, n, r;
        reg [8*8:1] op;
        reg [8*40:1] line, msg;
        initial begin
          fo = $fopen("out.txt", "w");
          $fdisplay(fo, "x=%0d", 5);
          $fwrite(fo, "y=%h", 8'hab);
          $fclose(fo);
          fi = $fopen("in.txt", "r");
          while (!$feof(fi)) begin
            n = $fscanf(fi, "%s %d %d\\n", op, a, b);
            if (n == 3) begin
              r = (op == "add") ? a + b : a * b;
              $display("%0s -> %0d", op, r);
            end
          end
          $fclose(fi);
          msg = $sformatf("v=%0d h=%h", 42, 4'hc);
          $display("%0s", msg);
          $sformat(line, "[%0d]", 7);
          $display("%0s", line);
          n = $sscanf("12 ff", "%d %h", a, b);
          $display("%0d %0d %0d", n, a, b);
          $fdisplay(1, "to stdout");
        end
      endmodule`,
    }, 't', 1e9, files2);
    expect(out).toEqual(['add -> 7', 'mul -> 42', 'v=42 h=c', '[7]', '2 12 255', 'to stdout']);
    expect(files2['out.txt']).toBe('x=5\ny=ab');
  });
});

describe('SystemVerilog extensions (#19)', () => {
  it('packages, imports, struct packed, foreach, do-while, inside', () => {
    const { out } = simulate({
      'pkg.sv': `package bus_pkg;
  localparam int WIDTH = 8;
  typedef enum logic [1:0] { IDLE, READ, WRITE } op_t;
  typedef struct packed { op_t op; logic [WIDTH-1:0] addr; logic valid; } req_t;
  function automatic int dbl(input int x); return x * 2; endfunction
endpackage`,
      't.sv': `import bus_pkg::*;
module t;
  req_t r;
  bus_pkg::op_t o;
  logic [7:0] mem [0:3];
  int sum, i;
  initial begin
    r = 0;
    r.op = WRITE; r.addr = 8'h3c; r.valid = 1;
    $display("%b %h %b w=%0d", r.op, r.addr, r.valid, $bits(r));
    foreach (mem[k]) mem[k] = k * 10;
    sum = 0;
    foreach (mem[k]) sum += mem[k];
    $display("sum=%0d", sum);
    i = 0;
    do i++; while (i < 5);
    $display("i=%0d dbl=%0d W=%0d", i, dbl(i), bus_pkg::WIDTH);
    o = READ;
    $display("%0d %0d %0d", 3 inside {1, [2:4]}, 7 inside {1, [2:4]}, o inside {READ, WRITE});
  end
endmodule`,
    }, 't');
    expect(out).toEqual(['10 3c 1 w=11', 'sum=60', 'i=5 dbl=10 W=8', '1 0 1']);
  });
});

describe('instance arrays, multi-dim arrays, defparam (#20)', () => {
  it('slices buses across instance arrays and shares scalar connections', () => {
    const { out } = simulate({
      't.v': `module inv #(parameter P = 0) (input a, input en, output y); assign y = en ? ~a : a; endmodule
      module t;
        reg [3:0] a = 4'b0011; reg en = 1; wire [3:0] y;
        inv u [3:0] (.a(a), .en(en), .y(y));
        initial #1 $display("%b", y);
      endmodule`,
    }, 't');
    expect(out).toEqual(['1100']);
  });

  it('flattens multi-dimensional unpacked arrays', () => {
    const { out } = simulate({
      't.v': `module t; reg [7:0] m [0:2][0:3]; integer i, j;
        initial begin
          for (i = 0; i < 3; i = i + 1) for (j = 0; j < 4; j = j + 1) m[i][j] = i * 10 + j;
          $display("%0d %0d %0d %b", m[0][0], m[1][2], m[2][3], m[2][3][1:0]);
          m[1][1][7] = 1'b1;
          $display("%0d", m[1][1]);
        end endmodule`,
    }, 't');
    expect(out).toEqual(['0 12 23 11', '139']);
  });

  it('applies defparam to direct and nested instances', () => {
    const { out } = simulate({
      't.v': `module leaf #(parameter W = 1) (); initial #1 $display("%m W=%0d", W); endmodule
      module mid; leaf l(); endmodule
      module t; leaf a(); mid m();
        defparam a.W = 4;
        defparam m.l.W = 9;
      endmodule`,
    }, 't');
    expect(out.sort()).toEqual(['t.a W=4', 't.m.l W=9']);
  });
});

describe('inertial continuous assignment delays (#27)', () => {
  it('assign #d and gate delays swallow pulses shorter than the delay', () => {
    const { out } = simulate({
      't.v': `\`timescale 1ns/1ns
      module t; reg a = 0; wire y, g; integer n = 0, m = 0;
        assign #5 y = a;
        buf #5 b1 (g, a);
        always @(y) n = n + 1;
        always @(g) m = m + 1;
        initial begin
          #10 a = 1; #2 a = 0;     // 2 ns pulse: swallowed
          #20 a = 1; #10 a = 0;    // 10 ns pulse: passes
          #20 $display("%0d %0d", n, m);
        end
      endmodule`,
    }, 't');
    expect(out[0]).toBe('3 3'); // X->0 at 5 ns, then only the 10 ns pulse (2 edges); the 2 ns pulse is swallowed
  });
});

describe('femtosecond precision (#29)', () => {
  it('honours fs timescales and delays exactly', () => {
    const { out, design } = simulate({
      't.v': `\`timescale 1ps/1fs
      module t; reg a = 0;
        initial begin #1.25 a = 1; #0.001 a = 0; #2 $display("%t %0t", $realtime, $time); end
      endmodule`,
    }, 't');
    const a = design.root.objects.find(o => o.name === 'a')!.sig;
    expect(a.times).toEqual([0, 1250, 1251]);
    expect(design.kernel.resolution).toBe(1);
    expect(out[0]).toBe(`${' '.repeat(16)}3251 3000`); // %t prints in the simulation precision (fs)
  });

  it('VHDL fs literals', () => {
    const src = `entity t is end; architecture a of t is begin
      process begin wait for 1500 fs; report time'image(now); wait; end process; end;`;
    expect(simulate({ 't.vhd': src }, 't').out[0]).toMatch(/1\.5 ns|1500 ps|1500 fs/);
  });
});

describe('gate-level modelling (#33)', () => {
  it('combinational and sequential UDPs', () => {
    const { out } = simulate({
      't.v': `
      primitive mux2 (y, s, a, b);
        output y; input s, a, b;
        table
        // s a b : y
           0 0 ? : 0;
           0 1 ? : 1;
           1 ? 0 : 0;
           1 ? 1 : 1;
           x 0 0 : 0;
           x 1 1 : 1;
        endtable
      endprimitive

      primitive dff_r (q, clk, d, rst_n);
        output q; reg q; input clk, d, rst_n;
        initial q = 1'b0;
        table
        // clk  d  rst_n : q : q+
           ?    ?  0     : ? : 0;
           r    0  1     : ? : 0;
           r    1  1     : ? : 1;
           (?0) ?  1     : ? : -;
           ?    *  1     : ? : -;
           ?    ?  (?1)  : ? : -;
        endtable
      endprimitive

      module t;
        reg s = 0, a = 0, b = 1, clk = 0, d = 0, rst_n = 0;
        wire y, q;
        mux2 #2 m (y, s, a, b);
        dff_r f (q, clk, d, rst_n);
        always #5 clk = ~clk;
        initial begin
          #1 $display("%0t q=%b", $time, q);
          #2 $display("%0t y=%b", $time, y);
          s = 1; #1 $display("%0t y=%b (delayed)", $time, y);
          #2 $display("%0t y=%b", $time, y);
          s = 1'bx; #3 $display("%0t y=%b", $time, y);
          rst_n = 1; d = 1;
          #10 $display("%0t q=%b", $time, q);
          d = 0; #4 $display("%0t q=%b", $time, q);
          #4 $display("%0t q=%b", $time, q);
          rst_n = 0; #1 $display("%0t q=%b", $time, q);
          $finish;
        end
      endmodule`,
    }, 't');
    expect(out.filter(l => !l.startsWith('**') && !l.startsWith('   Time'))).toEqual([
      '1 q=0', '3 y=0', '4 y=0 (delayed)', '6 y=1', '9 y=x', '19 q=1', '23 q=1', '27 q=0', '28 q=0',
    ]);
  });

  it('drive strengths, pullup, tri1 and %v', () => {
    const { out } = simulate({
      't.v': `module t;
        reg en = 0, dv = 0;
        wire bus; tri1 t1; wire od;
        pullup (bus);
        bufif1 (bus, dv, en);
        assign (strong0, highz1) od = dv;   // open drain
        pullup (od);
        initial begin
          #1 $display("%b %v %b %b %v", bus, bus, t1, od, od);
          en = 1; #1 $display("%b %v", bus, bus);
          dv = 1; #1 $display("%b %v %b %v %0d", bus, bus, od, od, bus === 1'b1);
          en = 1'bx; dv = 0; #1 $display("%b", bus);
        end
      endmodule`,
    }, 't');
    expect(out).toEqual(['1 Pu1 1 0 St0', '0 St0', '1 St1 1 Pu1 1', 'x']);
  });

  it('rise/fall delays and specify path delays', () => {
    const { out } = simulate({
      't.v': `\`timescale 1ns/1ns
      module cell (output y, input a);
        buf (y, a);
        specify
          specparam tr = 3, tf = 5;
          (a => y) = (tr, tf);
        endspecify
      endmodule
      module t;
        reg a = 0; wire y, z;
        cell u (.y(y), .a(a));
        assign #(2, 4) z = a;
        initial begin
          #10 a = 1; #10 a = 0; #10 $finish;
        end
        always @(y) $display("%0t y=%b", $time, y);
        always @(z) $display("%0t z=%b", $time, z);
      endmodule`,
    }, 't');
    expect(out.filter(l => /=/.test(l) && !l.startsWith('**'))).toEqual(['4 z=0', '5 y=0', '12 z=1', '13 y=1', '24 z=0', '25 y=0']);
  });
});
