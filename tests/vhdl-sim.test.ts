import { describe, it, expect } from 'vitest';
import { simulate } from './helpers';

const COUNTER = `
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity counter is
  generic (WIDTH : integer := 4);
  port (
    clk, rst : in  std_logic;
    en       : in  std_logic;
    q        : out std_logic_vector(WIDTH-1 downto 0)
  );
end entity counter;

architecture rtl of counter is
  signal cnt : unsigned(WIDTH-1 downto 0);
begin
  process (clk, rst)
  begin
    if rst = '1' then
      cnt <= (others => '0');
    elsif rising_edge(clk) then
      if en = '1' then
        cnt <= cnt + 1;
      end if;
    end if;
  end process;
  q <= std_logic_vector(cnt);
end architecture rtl;
`;

const TB = `
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity tb is end entity;

architecture sim of tb is
  constant PERIOD : time := 10 ns;
  signal clk : std_logic := '0';
  signal rst : std_logic := '1';
  signal en  : std_logic := '1';
  signal q   : std_logic_vector(3 downto 0);
begin
  clk <= not clk after PERIOD / 2;

  dut : entity work.counter
    generic map (WIDTH => 4)
    port map (clk => clk, rst => rst, en => en, q => q);

  stim : process
  begin
    wait for 12 ns;
    rst <= '0';
    wait for 100 ns;
    report "q = " & integer'image(to_integer(unsigned(q)));
    assert q = "1010" report "bad count" severity error;
    std.env.finish;
  end process;
end architecture;
`;

describe('VHDL simulation', () => {
  it('runs a counter testbench', () => {
    const { out, result } = simulate({ 'counter.vhd': COUNTER, 'tb.vhd': TB }, 'tb');
    expect(result).toBe('finished');
    expect(out[0]).toBe('** Note: q = 10');
    expect(out.some(l => l.includes('bad count'))).toBe(false);
  });

  it('enums, case, variables, loops, functions', () => {
    const src = `
library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity t is end;
architecture a of t is
  type state_t is (IDLE, RUN, DONE);
  signal st : state_t := IDLE;
  signal v8 : std_logic_vector(7 downto 0) := x"A5";
  function popcount(v : std_logic_vector) return integer is
    variable n : integer := 0;
  begin
    for i in v'range loop
      if v(i) = '1' then n := n + 1; end if;
    end loop;
    return n;
  end function;
begin
  process
    variable acc : integer := 0;
  begin
    for i in 1 to 4 loop acc := acc + i; end loop;
    report "acc=" & integer'image(acc);
    report "pop=" & integer'image(popcount(v8));
    st <= RUN; wait for 1 ns;
    case st is
      when IDLE => report "idle";
      when RUN => report "run";
      when others => report "other";
    end case;
    report "nib=" & integer'image(to_integer(unsigned(v8(7 downto 4))));
    report "slice ok" severity note;
    wait for 1 ns;
    assert false report "end" severity failure;
    wait;
  end process;
end;`;
    const { out, result } = simulate({ 't.vhd': src }, 't');
    expect(out.filter(l => l.startsWith('**'))).toEqual([
      '** Note: acc=10', '** Note: pop=4', '** Note: run', '** Note: nib=10', '** Note: slice ok', '** Failure: end',
    ]);
    expect(result).toBe('stopped');
  });

  it('when/else, with/select, generate, wait until', () => {
    const src = `
library ieee; use ieee.std_logic_1164.all;
entity mux is port (a, b, c, d : in std_logic; s : in std_logic_vector(1 downto 0); y, z : out std_logic); end;
architecture rtl of mux is begin
  y <= a when s = "00" else b when s = "01" else c when s = "10" else d;
  with s select z <= a when "00", b when "01", c when "10", d when others;
end;
library ieee; use ieee.std_logic_1164.all;
entity t is end;
architecture a of t is
  signal a, b, c, d, y, z : std_logic := '0';
  signal s : std_logic_vector(1 downto 0) := "00";
  signal bus4 : std_logic_vector(3 downto 0);
  signal inv : std_logic_vector(3 downto 0);
begin
  u : entity work.mux port map (a, b, c, d, s, y, z);
  g : for i in 0 to 3 generate
    inv(i) <= not bus4(i);
  end generate;
  process begin
    c <= '1'; s <= "10"; bus4 <= "0011";
    wait until y = '1';
    report "y=" & std_logic'image(y) & " z=" & std_logic'image(z) & " inv=" & to_string(inv);
    wait;
  end process;
end;`;
    const { out } = simulate({ 't.vhd': src }, 't');
    expect(out[0]).toBe("** Note: y='1' z='1' inv=1100");
  });

  it('packages with constants and functions', () => {
    const pkg = `
library ieee; use ieee.std_logic_1164.all;
package util is
  constant DEPTH : integer := 8;
  function max2(a, b : integer) return integer;
end package;
package body util is
  function max2(a, b : integer) return integer is begin
    if a > b then return a; else return b; end if;
  end function;
end package body;`;
    const src = `
use work.util.all;
entity t is end;
architecture a of t is begin
  process begin
    report integer'image(max2(DEPTH, 3) * 2);
    wait;
  end process;
end;`;
    const { out } = simulate({ 'p.vhd': pkg, 't.vhd': src }, 't');
    expect(out[0]).toBe('** Note: 16');
  });

  it('mixed language: VHDL testbench instantiating a Verilog module', () => {
    const v = `module andg(input a, input b, output y); assign y = a & b; endmodule`;
    const tb = `
library ieee; use ieee.std_logic_1164.all;
entity t is end;
architecture a of t is
  signal a, b, y : std_logic := '0';
begin
  u : entity work.andg port map (a => a, b => b, y => y);
  process begin
    a <= '1'; b <= '1'; wait for 1 ns;
    report "y=" & std_logic'image(y);
    wait;
  end process;
end;`;
    const { out } = simulate({ 'and.v': v, 't.vhd': tb }, 't');
    expect(out[0]).toBe("** Note: y='1'");
  });

  it('memories via array types and integer signals', () => {
    const src = `
library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity t is end;
architecture a of t is
  type mem_t is array (0 to 15) of std_logic_vector(7 downto 0);
  signal mem : mem_t := (others => (others => '0'));
  signal idx : integer range 0 to 15 := 0;
begin
  process begin
    for i in 0 to 15 loop
      mem(i) <= std_logic_vector(to_unsigned(i * 3, 8));
    end loop;
    wait for 1 ns;
    idx <= 5; wait for 1 ns;
    report "m=" & integer'image(to_integer(unsigned(mem(idx))));
    wait;
  end process;
end;`;
    const { out } = simulate({ 't.vhd': src }, 't');
    expect(out[0]).toBe('** Note: m=15');
  });
});

describe('whole-array assignment (#2)', () => {
  it('assigns every word from an aggregate and from another array', () => {
    const src = `
library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity t is end;
architecture a of t is
  type mem_t is array (0 to 3) of std_logic_vector(7 downto 0);
  signal m, m2 : mem_t;
begin
  process
    variable v : mem_t;
  begin
    m <= (others => x"AA");
    wait for 1 ns;
    m <= (1 => x"11", others => x"00");
    v := (x"01", x"02", x"03", x"04");
    wait for 1 ns;
    m2 <= m;
    wait for 1 ns;
    report to_hstring(m(0)) & " " & to_hstring(m(1)) & " " & to_hstring(m(3)) & " " & to_hstring(v(2)) & " " & to_hstring(m2(1));
    wait;
  end process;
end;`;
    const { out } = simulate({ 't.vhd': src }, 't');
    expect(out[0]).toBe('** Note: 00 11 00 03 11');
  });
});

describe('record types (#7)', () => {
  it('declares, reads, writes, nests and passes records through ports', () => {
    const src = `
library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
package types is
  type hdr_t is record
    valid : std_logic;
    tag   : unsigned(3 downto 0);
  end record;
  type pkt_t is record
    hdr  : hdr_t;
    data : std_logic_vector(7 downto 0);
    cnt  : integer range 0 to 255;
  end record;
  constant EMPTY : pkt_t := (hdr => (valid => '0', tag => (others => '0')), data => x"00", cnt => 0);
end package;

library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
use work.types.all;
entity stage is port (i : in pkt_t; o : out pkt_t); end;
architecture rtl of stage is begin
  process (i) begin
    o <= i;
    o.data <= not i.data;
    o.cnt <= i.cnt + 1;
  end process;
end;

library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
use work.types.all;
entity t is end;
architecture a of t is
  signal a, b : pkt_t := EMPTY;
  type fifo_t is array (0 to 3) of pkt_t;
  signal fifo : fifo_t := (others => EMPTY);
begin
  u : entity work.stage port map (i => a, o => b);
  process
    variable p : pkt_t;
  begin
    a.hdr.valid <= '1';
    a.hdr.tag <= x"5";
    a.data <= x"0F";
    a.cnt <= 41;
    wait for 1 ns;
    p := b;
    fifo(2) <= p;
    wait for 1 ns;
    report std_logic'image(b.hdr.valid) & " " & integer'image(to_integer(b.hdr.tag)) & " " & to_hstring(b.data) & " " & integer'image(b.cnt);
    report to_hstring(fifo(2).data) & " " & integer'image(fifo(2).cnt) & " " & std_logic'image(fifo(1).hdr.valid);
    a <= (hdr => (valid => '0', tag => x"A"), data => x"AA", cnt => 7);
    wait for 1 ns;
    report integer'image(to_integer(b.hdr.tag)) & " " & to_hstring(b.data);
    wait;
  end process;
end;`;
    const { out } = simulate({ 't.vhd': src }, 't');
    const notes = out.filter(l => l.startsWith('**'));
    expect(notes).toEqual(["** Note: '1' 5 F0 42", "** Note: F0 42 '0'", '** Note: 10 55']);
  });
});
