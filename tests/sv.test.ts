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
