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

const tbCounterV = `\`timescale 1ns/1ps
module tb_counter;
  reg        clk = 1'b0;
  reg        rst = 1'b1;
  reg        en  = 1'b0;
  wire [3:0] q;
  wire       tc;

  counter #(.WIDTH(4)) dut (
    .clk(clk), .rst(rst), .en(en), .q(q), .tc(tc)
  );

  // 100 MHz clock
  always #5 clk = ~clk;

  initial begin
    $display("Starting counter test");
    #22 rst = 1'b0;
    #10 en  = 1'b1;
    repeat (20) @(posedge clk);
    en = 1'b0;
    #30;
    $display("Final count = %0d (tc=%b) at %0t", q, tc, $time);
    $finish;
  end

  always @(posedge tc) $display("[%0t] terminal count reached", $time);
endmodule
`;

const runCounter = `# Verilog counter example
vlib work
vlog counter.v tb_counter.v
vsim work.tb_counter
add wave -r /*
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
  { id: 'counter', title: 'Verilog counter + testbench', files: { 'counter.v': counterV, 'tb_counter.v': tbCounterV, 'run_counter.do': runCounter }, top: 'tb_counter', doFile: 'run_counter.do' },
  { id: 'updown', title: 'VHDL up/down counter + testbench', files: { 'updown.vhd': counterVhd, 'tb_updown.vhd': tbVhd, 'run_updown.do': runVhd }, top: 'tb_updown', doFile: 'run_updown.do' },
  { id: 'traffic', title: 'SystemVerilog FSM (traffic light)', files: { 'traffic.sv': fsmSv, 'run_traffic.do': runFsm }, top: 'tb_traffic', doFile: 'run_traffic.do' },
  { id: 'cocotb', title: 'Python (cocotb) tests of the Verilog counter', files: { 'counter.v': counterV, 'test_counter.py': cocotbPy, 'run_cocotb.do': runCocotb }, top: 'counter', doFile: 'run_cocotb.do' },
  { id: 'alu', title: 'Mixed language: VHDL ALU + Verilog TB', files: { 'alu.vhd': aluVhd, 'tb_alu.v': aluTbV, 'run_alu.do': runAlu }, top: 'tb_alu', doFile: 'run_alu.do' },
];
