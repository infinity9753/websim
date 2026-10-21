// Bundled example designs.

export interface Example { id: string; title: string; files: Record<string, string>; top: string; doFile: string }

const counterV = `\`timescale 1ns/1ps
// 4-bit synchronous counter with enable and synchronous reset
module counter #(
  parameter WIDTH = 4
) (
  input  wire             clk,
  input  wire             rst,
  input  wire             en,
  output reg  [WIDTH-1:0] q,
  output wire             tc     // terminal count
);
  always @(posedge clk) begin
    if (rst)
      q <= {WIDTH{1'b0}};
    else if (en)
      q <= q + 1'b1;
  end

  assign tc = &q;
endmodule
`;

const cpuV = `\`timescale 1ns/1ps
// A tiny 8-bit accumulator CPU (two clock cycles per instruction).
//
//   instruction = {opcode[3:0], operand[3:0]}, 16 bytes of memory
//   0 NOP          1 LDA a  acc = M[a]      2 ADD a  acc = acc + M[a]   3 SUB a  acc = acc - M[a]
//   4 STA a  M[a] = acc     5 LDI n  acc = n            6 JMP a              7 JC a   jump if carry
//   8 JZ a   jump if zero   E OUT    out = acc          F HLT    stop
module cpu (
  input  wire       clk,
  input  wire       rst,       // synchronous, active high
  // memory bus (asynchronous read, write on the clock edge)
  output wire [3:0] addr,
  input  wire [7:0] rdata,
  output wire [7:0] wdata,
  output wire       we,
  // output port
  output reg  [7:0] out,
  output reg        out_valid,
  output wire       halted
);
  localparam FETCH = 2'd0, EXEC = 2'd1, HALT = 2'd2;
  localparam NOP = 4'h0, LDA = 4'h1, ADD = 4'h2, SUB = 4'h3, STA = 4'h4, LDI = 4'h5,
             JMP = 4'h6, JC = 4'h7, JZ = 4'h8, OUT = 4'hE, HLT = 4'hF;

  reg [1:0] state;
  reg [3:0] pc;
  reg [7:0] ir;
  reg [7:0] acc;
  reg       c, z;              // carry and zero flags

  wire [3:0] op  = ir[7:4];
  wire [3:0] arg = ir[3:0];
  wire [8:0] sum = op == SUB ? {1'b0, acc} - {1'b0, rdata} : {1'b0, acc} + {1'b0, rdata};

  assign addr   = state == FETCH ? pc : arg;
  assign wdata  = acc;
  assign we     = state == EXEC && op == STA;
  assign halted = state == HALT;

  always @(posedge clk) begin
    out_valid <= 1'b0;
    if (rst) begin
      state <= FETCH; pc <= 4'd0; ir <= 8'h00; acc <= 8'h00; c <= 1'b0; z <= 1'b0; out <= 8'h00;
    end else case (state)
      FETCH: begin
        ir    <= rdata;
        pc    <= pc + 4'd1;
        state <= EXEC;
      end
      EXEC: begin
        state <= FETCH;
        case (op)
          LDA: begin acc <= rdata; z <= rdata == 8'h00; end
          ADD, SUB: begin acc <= sum[7:0]; c <= sum[8]; z <= sum[7:0] == 8'h00; end
          LDI: begin acc <= {4'h0, arg}; z <= arg == 4'h0; end
          JMP: pc <= arg;
          JC:  if (c) pc <= arg;
          JZ:  if (z) pc <= arg;
          OUT: begin out <= acc; out_valid <= 1'b1; end
          HLT: state <= HALT;
          default: ;  // NOP, STA (memory write through we)
        endcase
      end
      default: state <= HALT;
    endcase
  end
endmodule
`;

const tbCpuV = `\`timescale 1ns/1ps
// Testbench: 16-byte memory with a program that prints the Fibonacci numbers until they overflow 8 bits.
module tb_cpu;
  reg        clk = 1'b0;
  reg        rst = 1'b1;
  wire [3:0] addr;
  wire [7:0] rdata, wdata, out;
  wire       we, out_valid, halted;

  reg [7:0] mem [0:15];
  assign rdata = mem[addr];
  always @(posedge clk) if (we) mem[addr] <= wdata;

  cpu dut (
    .clk(clk), .rst(rst), .addr(addr), .rdata(rdata), .wdata(wdata), .we(we),
    .out(out), .out_valid(out_valid), .halted(halted)
  );

  // 100 MHz clock
  always #5 clk = ~clk;

  initial begin
    //            program                     x = 14, y = 15
    mem[0]  = 8'h1F;  // LDA 15     acc = y
    mem[1]  = 8'hE0;  // OUT
    mem[2]  = 8'h2E;  // ADD 14     loop: acc = y + x
    mem[3]  = 8'h7C;  // JC  12     overflow: done
    mem[4]  = 8'h4E;  // STA 14     x = acc
    mem[5]  = 8'hE0;  // OUT
    mem[6]  = 8'h2F;  // ADD 15     acc = x + y
    mem[7]  = 8'h7C;  // JC  12
    mem[8]  = 8'h4F;  // STA 15     y = acc
    mem[9]  = 8'hE0;  // OUT
    mem[10] = 8'h62;  // JMP 2
    mem[11] = 8'h00;
    mem[12] = 8'hF0;  // HLT
    mem[13] = 8'h00;
    mem[14] = 8'h00;  // x
    mem[15] = 8'h01;  // y
  end

  integer n = 0;
  always @(posedge clk) if (out_valid) begin
    n = n + 1;
    $display("[%0t] OUT %0d", $time, out);
  end

  initial begin
    $display("Starting CPU: Fibonacci numbers up to 255");
    #22 rst = 1'b0;
    wait (halted);
    @(posedge clk);
    $display("Halted at %0t after %0d outputs (last = %0d)", $time, n, out);
    if (n == 13 && out == 8'd233) $display("PASS");
    else $display("FAIL");
    $finish;
  end
endmodule
`;

const runCpu = `# 8-bit CPU example: runs a Fibonacci program and checks the outputs
vlib work
vlog cpu.v tb_cpu.v
vsim work.tb_cpu
add wave /tb_cpu/clk /tb_cpu/rst
add wave /tb_cpu/dut/state
add wave -radix unsigned /tb_cpu/dut/pc
add wave -radix hex /tb_cpu/dut/ir
add wave -radix unsigned /tb_cpu/dut/acc
add wave /tb_cpu/dut/c /tb_cpu/dut/z
add wave -radix hex /tb_cpu/addr /tb_cpu/rdata
add wave /tb_cpu/we
add wave -radix unsigned /tb_cpu/out
add wave /tb_cpu/out_valid /tb_cpu/halted
run -all
wave zoom full
`;

const counterVhd = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- Up/down counter with load
entity updown is
  generic (WIDTH : positive := 8);
  port (
    clk  : in  std_logic;
    rst  : in  std_logic;
    up   : in  std_logic;
    load : in  std_logic;
    d    : in  std_logic_vector(WIDTH-1 downto 0);
    q    : out std_logic_vector(WIDTH-1 downto 0)
  );
end entity updown;

architecture rtl of updown is
  signal cnt : unsigned(WIDTH-1 downto 0);
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if rst = '1' then
        cnt <= (others => '0');
      elsif load = '1' then
        cnt <= unsigned(d);
      elsif up = '1' then
        cnt <= cnt + 1;
      else
        cnt <= cnt - 1;
      end if;
    end if;
  end process;

  q <= std_logic_vector(cnt);
end architecture rtl;
`;

const tbVhd = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity tb_updown is
end entity;

architecture sim of tb_updown is
  constant PERIOD : time := 10 ns;
  signal clk  : std_logic := '0';
  signal rst  : std_logic := '1';
  signal up   : std_logic := '1';
  signal load : std_logic := '0';
  signal d    : std_logic_vector(7 downto 0) := (others => '0');
  signal q    : std_logic_vector(7 downto 0);
  signal done : boolean := false;
begin
  clk <= not clk after PERIOD / 2 when not done else '0';

  dut : entity work.updown
    generic map (WIDTH => 8)
    port map (clk => clk, rst => rst, up => up, load => load, d => d, q => q);

  stimulus : process
  begin
    wait for 2 * PERIOD;
    rst <= '0';
    wait for 10 * PERIOD;
    report "count after 10 up cycles: " & integer'image(to_integer(unsigned(q)));
    d <= x"F0"; load <= '1';
    wait for PERIOD;
    load <= '0'; up <= '0';
    wait for 5 * PERIOD;
    assert unsigned(q) = 16#EB#
      report "unexpected value " & to_hstring(q) severity error;
    report "test finished";
    done <= true;
    wait;
  end process;
end architecture;
`;

const runVhd = `# VHDL up/down counter example
vlib work
vcom updown.vhd tb_updown.vhd
vsim work.tb_updown
add wave -r /*
run -all
wave zoom full
`;

const fsmSv = `\`timescale 1ns/1ps
// Traffic light controller (SystemVerilog style FSM)
module traffic (
  input  logic       clk,
  input  logic       rst_n,
  input  logic       car,        // car waiting on side road
  output logic [2:0] main_light, // {red, yellow, green}
  output logic [2:0] side_light
);
  typedef enum logic [1:0] { MAIN_GO, MAIN_WARN, SIDE_GO, SIDE_WARN } state_t;
  state_t state, next;
  logic [3:0] timer;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      state <= MAIN_GO;
      timer <= '0;
    end else begin
      state <= next;
      timer <= (state != next) ? '0 : timer + 1;
    end
  end

  always_comb begin
    next = state;
    case (state)
      MAIN_GO:   if (car && timer >= 4) next = MAIN_WARN;
      MAIN_WARN: if (timer == 1)        next = SIDE_GO;
      SIDE_GO:   if (timer == 3)        next = SIDE_WARN;
      SIDE_WARN: if (timer == 1)        next = MAIN_GO;
    endcase
  end

  always_comb begin
    main_light = 3'b100; side_light = 3'b100;
    case (state)
      MAIN_GO:   main_light = 3'b001;
      MAIN_WARN: main_light = 3'b010;
      SIDE_GO:   side_light = 3'b001;
      SIDE_WARN: side_light = 3'b010;
    endcase
  end
endmodule

module tb_traffic;
  logic clk = 0, rst_n = 0, car = 0;
  logic [2:0] main_light, side_light;
  traffic dut (.*);
  always #5 clk = ~clk;
  initial begin
    $monitor("%4d ns  state=%s main=%b side=%b", $time, dut.state == 0 ? "MAIN_GO  " : dut.state == 1 ? "MAIN_WARN" : dut.state == 2 ? "SIDE_GO  " : "SIDE_WARN", main_light, side_light);
    #12 rst_n = 1;
    #40 car = 1;
    #20 car = 0;
    #150 $finish;
  end
endmodule
`;

const runFsm = `vlib work
vlog traffic.sv
vsim work.tb_traffic
add wave /tb_traffic/clk /tb_traffic/rst_n /tb_traffic/car
add wave -radix symbolic /tb_traffic/dut/state
add wave /tb_traffic/dut/timer /tb_traffic/main_light /tb_traffic/side_light
run -all
wave zoom full
`;

const aluVhd = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity alu is
  port (
    a, b : in  std_logic_vector(7 downto 0);
    op   : in  std_logic_vector(2 downto 0);
    y    : out std_logic_vector(7 downto 0);
    zero : out std_logic
  );
end entity;

architecture rtl of alu is
  signal r : std_logic_vector(7 downto 0);
begin
  with op select r <=
    std_logic_vector(unsigned(a) + unsigned(b)) when "000",
    std_logic_vector(unsigned(a) - unsigned(b)) when "001",
    a and b                                     when "010",
    a or b                                      when "011",
    a xor b                                     when "100",
    not a                                       when "101",
    std_logic_vector(shift_left(unsigned(a), 1)) when "110",
    std_logic_vector(shift_right(unsigned(a), 1)) when others;
  y    <= r;
  zero <= '1' when r = x"00" else '0';
end architecture;
`;

const aluTbV = `\`timescale 1ns/1ps
// Verilog testbench driving a VHDL ALU (mixed-language)
module tb_alu;
  reg  [7:0] a, b;
  reg  [2:0] op;
  wire [7:0] y;
  wire       zero;
  integer i;

  alu dut (.a(a), .b(b), .op(op), .y(y), .zero(zero));

  initial begin
    a = 8'h3C; b = 8'h0F;
    for (i = 0; i < 8; i = i + 1) begin
      op = i;
      #10 $display("op=%b a=%h b=%h -> y=%h zero=%b", op, a, b, y, zero);
    end
    a = 8'h0F; op = 3'b001; #10 $display("a-b = %h zero=%b", y, zero);
    $finish;
  end
endmodule
`;

const runAlu = `vlib work
vcom alu.vhd
vlog tb_alu.v
vsim work.tb_alu
add wave -radix hex /tb_alu/a /tb_alu/b
add wave /tb_alu/op
add wave -radix hex /tb_alu/y
add wave /tb_alu/zero
run -all
wave zoom full
`;

const cocotbPy = `# cocotb testbench (Python) for counter.v — runs in the browser with Pyodide.
# Start it with "vsim work.counter -cocotb test_counter", then "run -all".
import cocotb
from cocotb.clock import Clock
from cocotb.triggers import ClockCycles, FallingEdge, ReadOnly, RisingEdge


async def reset(dut, cycles=2):
    dut.rst.value = 1
    dut.en.value = 0
    await ClockCycles(dut.clk, cycles)
    await FallingEdge(dut.clk)
    dut.rst.value = 0


@cocotb.test()
async def counts_when_enabled(dut):
    """q increments on every rising clock edge while en is high"""
    cocotb.start_soon(Clock(dut.clk, 10, unit="ns").start())
    await reset(dut)
    dut.en.value = 1
    for expected in range(1, 10):
        await RisingEdge(dut.clk)
        await ReadOnly()
        assert dut.q.value == expected, f"q = {dut.q.value}, expected {expected}"
    dut._log.info("q = %d after 9 cycles", dut.q.value.to_unsigned())


@cocotb.test()
async def holds_when_disabled(dut):
    cocotb.start_soon(Clock(dut.clk, 10, unit="ns").start())
    await reset(dut)
    await ClockCycles(dut.clk, 3)
    await ReadOnly()
    assert dut.q.value == 0


@cocotb.test()
async def terminal_count(dut):
    """tc is high exactly when q is all ones, and q wraps around to 0"""
    cocotb.start_soon(Clock(dut.clk, 10, unit="ns").start())
    await reset(dut)
    dut.en.value = 1
    for _ in range(16):
        await RisingEdge(dut.clk)
        await ReadOnly()
        assert dut.tc.value == (dut.q.value == 15)
    assert dut.q.value == 0
`;

const runCocotb = `# Python (cocotb) tests of the counter: the tests drive the clock and inputs
vlib work
vlog counter.v
vsim work.counter -cocotb test_counter
add wave /counter/*
run -all
wave zoom full
`;

export const EXAMPLES: Example[] = [
  { id: 'cpu', title: '8-bit CPU + testbench (Verilog)', files: { 'cpu.v': cpuV, 'tb_cpu.v': tbCpuV, 'run_cpu.do': runCpu }, top: 'tb_cpu', doFile: 'run_cpu.do' },
  { id: 'updown', title: 'VHDL up/down counter + testbench', files: { 'updown.vhd': counterVhd, 'tb_updown.vhd': tbVhd, 'run_updown.do': runVhd }, top: 'tb_updown', doFile: 'run_updown.do' },
  { id: 'traffic', title: 'SystemVerilog FSM (traffic light)', files: { 'traffic.sv': fsmSv, 'run_traffic.do': runFsm }, top: 'tb_traffic', doFile: 'run_traffic.do' },
  { id: 'cocotb', title: 'Python (cocotb) tests of the Verilog counter', files: { 'counter.v': counterV, 'test_counter.py': cocotbPy, 'run_cocotb.do': runCocotb }, top: 'counter', doFile: 'run_cocotb.do' },
  { id: 'alu', title: 'Mixed language: VHDL ALU + Verilog TB', files: { 'alu.vhd': aluVhd, 'tb_alu.v': aluTbV, 'run_alu.do': runAlu }, top: 'tb_alu', doFile: 'run_alu.do' },
];
