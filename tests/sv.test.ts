import { describe, it, expect } from 'vitest';
import { simulate } from './helpers';

describe('SystemVerilog interfaces (#32)', () => {
  it('connects modules through an interface with modports and tasks', () => {
    const { out } = simulate({
      't.sv': `
      interface bus_if(input logic clk);
        logic [7:0] data;
        logic valid;
        modport master(output data, output valid, input clk);
        modport slave(input data, input valid, input clk);
        task automatic send(input [7:0] d);
          @(posedge clk); data <= d; valid <= 1;
          @(posedge clk); valid <= 0;
        endtask
      endinterface

      module producer(bus_if.master m);
        initial begin m.valid = 0; m.send(8'h12); m.send(8'h34); end
      endmodule

      module consumer(bus_if.slave s, output logic [7:0] last);
        always @(posedge s.clk) if (s.valid) begin last <= s.data; $display("%0t got %h", $time, s.data); end
      endmodule

      module top;
        logic clk = 0; always #5 clk = ~clk;
        logic [7:0] last;
        bus_if b(clk);
        producer p(.m(b));
        consumer c(b.slave, last);
        initial #100 begin $display("last=%h", last); $finish; end
      endmodule`,
    }, 'top');
    expect(out.filter(l => /got|last/.test(l))).toEqual(['15 got 12', '35 got 34', 'last=34']);
  });

  it('rejects a port connected to the wrong interface', () => {
    expect(() => simulate({
      't.sv': `interface a_if; logic x; endinterface
      interface b_if; logic x; endinterface
      module m(a_if p); endmodule
      module top; b_if b(); m u(.p(b)); endmodule`,
    }, 'top')).toThrow(/expects interface 'a_if'/);
  });
});

describe('SystemVerilog assertions (#32)', () => {
  it('immediate assert / cover with labels and action blocks', () => {
    const { out } = simulate({
      't.sv': `module t; int x = 3;
        initial begin
          a_ok: assert (x == 3) $display("pass");
          a_bad: assert (x == 4);
          assert (x > 5) else $display("x too small: %0d", x);
          c1: cover (x == 3) $display("covered");
          assert (1'bx) else $display("x fails");
        end
      endmodule`,
    }, 't');
    expect(out).toEqual([
      'pass',
      '** Error: Assertion error.',
      '   Time: 0 ns  Scope: t.a_bad File: t.sv Line: 4',
      'x too small: 3',
      'covered',
      'x fails',
    ]);
  });

  const tb = (props: string, stim: string) => ({
    't.sv': `module t;
      logic clk = 0, rst = 1, req = 0, ack = 0, a = 0;
      always #5 clk = ~clk;
      ${props}
      initial begin ${stim} #200 $finish; end
    endmodule`,
  });
  const errs = (out: string[]) => out.filter(l => l.startsWith('   Time:') && l.includes('Scope:')).map(l => l.replace(/\s+File.*$/, '').trim());

  it('|-> and |=> with fixed delays, start times in the report', () => {
    const { out } = simulate(tb(
      `p_next: assert property (@(posedge clk) req |=> ack);
       p_same: assert property (@(posedge clk) req |-> ##2 a);`,
      // req sampled at 15; ack at 25 ok, a at 35 missing; req again at 45 with ack missing at 55
      `#12 req = 1; #10 req = 0; ack = 1; #10 ack = 0; #10 req = 1; #10 req = 0; a = 1;`), 't');
    expect(errs(out)).toEqual([
      'Time: 35 ns Started: 15 ns Scope: t.p_same',
      'Time: 55 ns Started: 45 ns Scope: t.p_next',
    ]);
  });

  it('## ranges, repetition, $rose and disable iff', () => {
    const { out } = simulate(tb(
      `sequence s_ack; ##[1:3] ack; endsequence
       property p_hand; @(posedge clk) disable iff (rst) $rose(req) |-> s_ack; endproperty
       a_hand: assert property (p_hand) $display("%0t hand ok", $time);
       a_rep: assert property (@(posedge clk) $rose(a) |-> a[*3] ##1 !a) else $display("%0t rep fail", $time);`,
      // rst blocks the first req; second req acked after 3 ticks; third never acked
      `#2 req = 1; #10 req = 0; rst = 0; #10 req = 1; #10 req = 0; #20 ack = 1; #10 ack = 0;
       a = 1; #30 a = 0; #10 req = 1; #10 req = 0; #10 a = 1; #10 a = 0;`), 't');
    expect(out.filter(l => / ok| fail/.test(l))).toEqual(['55 hand ok', '135 rep fail']);
    expect(errs(out)).toEqual(['Time: 135 ns Started: 105 ns Scope: t.a_hand']);
  });

  it('default clocking, not, and $past / $stable', () => {
    const { out } = simulate(tb(
      `default clocking cb @(posedge clk); endclocking
       a_never: assert property (not (req ##1 ack));
       a_past: assert property (ack |-> $past(req, 2));
       a_stab: assert property ($stable(a)) else $display("%0t a changed", $time);`,
      `#12 req = 1; #10 req = 0; ack = 1; #10 ack = 0; #30 a = 1;`), 't');
    expect(errs(out)).toEqual([
      'Time: 25 ns Started: 15 ns Scope: t.a_never',
      'Time: 25 ns Started: 25 ns Scope: t.a_past',
    ]);
    expect(out.filter(l => l.includes('changed'))).toEqual(['65 a changed']);
  });
});

describe('SystemVerilog classes (#32)', () => {
  it('objects, constructors, properties, methods and null handles', () => {
    const { out } = simulate({
      't.sv': `module t;
        class Counter;
          int count;
          string name;
          int step = 1;
          static int made = 0;
          function new(string n, int s = 1);
            name = n; step = s; made++;
          endfunction
          function void bump(); count += step; endfunction
          function int get(); return count; endfunction
          task automatic tick(int n); repeat (n) begin #1 bump(); end endtask
        endclass
        Counter a, b, z;
        initial begin
          a = new("a");
          b = new("b", 5);
          a.bump(); b.bump(); b.bump();
          $display("%s=%0d %s=%0d made=%0d", a.name, a.get(), b.name, b.count, Counter::made);
          b.count = 100;
          a.tick(3);
          $display("t=%0t a=%0d b=%0d null=%0d", $time, a.count, b.get(), z == null);
          z = a; z.bump();
          $display("shared %0d", a.count);
        end
      endmodule`,
    }, 't');
    expect(out).toEqual(['a=1 b=10 made=2', 't=3 a=4 b=100 null=1', 'shared 5']);
  });

  it('inheritance, super, virtual dispatch and linked objects', () => {
    const { out } = simulate({
      't.sv': `module t;
        class Shape;
          int id;
          Shape next;
          function new(int i); id = i; endfunction
          virtual function int area(); return 0; endfunction
          function string kind(); return "shape"; endfunction
          virtual task show(); $display("%0d: %s area=%0d", id, kind(), area()); endtask
        endclass
        class Rect extends Shape;
          int w, h;
          function new(int i, int w_, int h_); super.new(i); w = w_; h = h_; endfunction
          virtual function int area(); return w * h; endfunction
          function string kind(); return "rect"; endfunction
        endclass
        class Square extends Rect;
          function new(int i, int s); super.new(i, s, s); endfunction
          virtual task show(); $display("square:"); super.show(); endtask
        endclass
        initial begin
          Shape head = null, s;
          Rect r;
          Square q;
          s = new(1); r = new(2, 3, 4); q = new(3, 5);
          s.next = r; r.next = q;
          head = s;
          for (Shape p = head; p != null; p = p.next) p.show();
          s = q;
          $display("via base: %0d next-null=%0d", s.area(), s.next == null);
        end
      endmodule`,
    }, 't');
    expect(out).toEqual(['1: shape area=0', '2: shape area=12', 'square:', '3: shape area=25', 'via base: 25 next-null=1']);
  });

  it('reports a method call through a null handle', () => {
    expect(() => simulate({
      't.sv': `module t; class C; function void f(); endfunction endclass
        C h; initial h.f(); endmodule`,
    }, 't')).toThrow(/Null object access: method 'f'/);
  });

  it('classes in packages and the compilation unit, struct and handle properties', () => {
    const { out } = simulate({
      'p.sv': `package pk;
        class Item; int v; function new(int x = 7); v = x; endfunction endclass
      endpackage`,
      't.sv': `class Glob; bit [3:0] n = 4'hA; endclass
      module t; import pk::*;
        typedef struct packed { logic [3:0] hi, lo; } pair_t;
        class Holder; pair_t p; Item it; endclass
        initial begin
          Item i = new; Glob g = new; Holder h = new;
          h.it = i; h.p = 8'h5c;
          $display("%0d %h %h %0d", i.v, g.n, h.p.lo, h.it.v);
        end
      endmodule`,
    }, 't');
    expect(out).toEqual(['7 a c 7']);
  });
});
