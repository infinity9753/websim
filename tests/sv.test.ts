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
