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

describe('std.textio (#8)', () => {
  it('writes lines to the transcript and to files, reads files back', () => {
    const src = `
library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
use std.textio.all;
use ieee.std_logic_textio.all;
entity t is end;
architecture a of t is
  type st_t is (IDLE, BUSY);
  signal q : std_logic_vector(7 downto 0) := x"A5";
  procedure log(msg : string; v : integer) is
    variable l : line;
  begin
    write(l, msg);
    write(l, v, right, 5);
    writeline(output, l);
  end procedure;
begin
  process
    variable l : line;
    variable i, n, sum : integer := 0;
    variable b : std_logic;
    variable v4 : std_logic_vector(3 downto 0);
    variable ok : boolean;
    file fo : text open write_mode is "out.txt";
    file fi : text open read_mode is "in.txt";
  begin
    wait for 3 ns;
    write(l, string'("q="));
    write(l, q);
    write(l, string'(" hex="));
    hwrite(l, q);
    write(l, string'(" t="));
    write(l, now);
    write(l, string'(" st="));
    write(l, st_t'(BUSY));
    write(l, string'(" "));
    write(l, true);
    writeline(output, l);
    log("val:", 42);
    for k in 1 to 3 loop
      write(l, k * 10);
      writeline(fo, l);
    end loop;
    while not endfile(fi) loop
      readline(fi, l);
      read(l, n);
      read(l, b);
      hread(l, v4);
      read(l, i, ok);
      sum := sum + n + to_integer(unsigned(v4));
      if ok then sum := sum + 1000; end if;
    end loop;
    write(l, sum);
    writeline(output, l);
    wait;
  end process;
end;`;
    const files2: Record<string, string> = { 'in.txt': '5 1 A\n7 0 F 9\n' };
    const { out } = simulate({ 't.vhd': src }, 't', 1e9, files2);
    expect(out[0]).toBe('q=10100101 hex=A5 t=3 ns st=busy TRUE');
    expect(out[1]).toBe('val:   42');
    expect(out[2]).toBe(String(5 + 10 + 7 + 15 + 1000));
    expect(files2['out.txt']).toBe('10\n20\n30\n');
  });
});

describe('unconstrained arrays (#21)', () => {
  it('constrains at declaration and infers bounds from constant aggregates', () => {
    const src = `
library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
package p is
  type byte_arr is array (natural range <>) of std_logic_vector(7 downto 0);
  type int_arr is array (integer range <>) of integer;
end package;
library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
use work.p.all;
entity t is end;
architecture a of t is
  signal buf : byte_arr(0 to 7) := (others => x"00");
  constant ROM : int_arr := (10, 20, 30, 40);
  subtype small_t is byte_arr(0 to 1);
  signal s : small_t;
begin
  process begin
    buf(3) <= x"3c";
    s(1) <= x"ff";
    wait for 1 ns;
    report to_hstring(buf(3)) & " " & integer'image(ROM(2)) & " " & integer'image(buf'length) & " " & integer'image(ROM'high) & " " & to_hstring(s(1));
    wait;
  end process;
end;`;
    const { out } = simulate({ 't.vhd': src }, 't');
    expect(out[0]).toBe('** Note: 3C 30 8 3 FF');
  });
});

describe('subprogram default parameters (#22)', () => {
  it('fills omitted positional and named parameters from defaults', () => {
    const src = `
entity t is end;
architecture a of t is
  function scale(x : integer; k : integer := 10; off : integer := 1) return integer is
  begin return x * k + off; end function;
  procedure say(msg : string; n : integer := 7) is
  begin report msg & integer'image(n); end procedure;
begin
  process begin
    report integer'image(scale(2)) & " " & integer'image(scale(2, 3)) & " " & integer'image(scale(2, off => 0)) & " " & integer'image(scale(x => 1, k => 5));
    say("n=");
    say("n=", 3);
    wait;
  end process;
end;`;
    const { out } = simulate({ 't.vhd': src }, 't');
    expect(out.filter(l => l.startsWith('**'))).toEqual(['** Note: 21 7 20 6', '** Note: n=7', '** Note: n=3']);
  });
});

describe('aliases (#23)', () => {
  it('reads and writes through object, element and slice aliases', () => {
    const src = `
library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity t is end;
architecture a of t is
  signal data : std_logic_vector(7 downto 0) := x"A5";
  alias msb : std_logic is data(7);
  alias hi_nib : std_logic_vector(3 downto 0) is data(7 downto 4);
  alias lo_rev : std_logic_vector(0 to 3) is data(3 downto 0);
  alias d : std_logic_vector(7 downto 0) is data;
begin
  process begin
    report std_logic'image(msb) & " " & to_hstring(hi_nib) & " " & std_logic'image(hi_nib(0)) & " " & std_logic'image(lo_rev(0));
    hi_nib <= x"3";
    wait for 1 ns;
    report to_hstring(d) & " " & std_logic'image(msb);
    hi_nib(3) <= '1';
    wait for 1 ns;
    report to_hstring(data);
    wait;
  end process;
end;`;
    const { out } = simulate({ 't.vhd': src }, 't');
    expect(out.filter(l => l.startsWith('**'))).toEqual(["** Note: '1' A '0' '0'", "** Note: 35 '0'", '** Note: B5']);
  });
});

describe('operator overloading and overloads (#24)', () => {
  it('uses user operators for record types and resolves overloaded functions by type', () => {
    const src = `
library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
package cplx is
  type complex is record re : integer; im : integer; end record;
  function "+" (a, b : complex) return complex;
  function "*" (a, b : complex) return complex;
  function "=" (a, b : complex) return boolean;
  function img(x : complex) return string;
  function img(x : integer) return string;
end package;
package body cplx is
  function "+" (a, b : complex) return complex is begin return (re => a.re + b.re, im => a.im + b.im); end function;
  function "*" (a, b : complex) return complex is
  begin return (re => a.re * b.re - a.im * b.im, im => a.re * b.im + a.im * b.re); end function "*";
  function "=" (a, b : complex) return boolean is begin return a.re = b.re and a.im = b.im; end function;
  function img(x : complex) return string is begin return integer'image(x.re) & "+" & integer'image(x.im) & "i"; end function;
  function img(x : integer) return string is begin return "int " & integer'image(x); end function;
end package body;
use work.cplx.all;
entity t is end;
architecture a of t is begin
  process
    variable x : complex := (re => 1, im => 2);
    variable y : complex := (re => 3, im => -1);
  begin
    report img(x + y) & " " & img(x * y) & " " & img(7 + 5) & " " & boolean'image(x = x) & " " & boolean'image(x = y);
    wait;
  end process;
end;`;
    const { out } = simulate({ 't.vhd': src }, 't');
    expect(out[0]).toBe('** Note: 4+1i 5+5i int 12 true false');
  });
});

describe('partial port associations (#25)', () => {
  it('connects formal slices and elements to different actuals', () => {
    const src = `
library ieee; use ieee.std_logic_1164.all;
entity swap is port (i : in std_logic_vector(7 downto 0); o : out std_logic_vector(7 downto 0)); end;
architecture rtl of swap is begin o <= i(3 downto 0) & i(7 downto 4); end;
library ieee; use ieee.std_logic_1164.all;
entity t is end;
architecture a of t is
  signal hi, lo, ohi, olo : std_logic_vector(3 downto 0);
  signal b0 : std_logic;
begin
  u : entity work.swap port map (i(7 downto 4) => hi, i(3 downto 0) => lo, o(7 downto 4) => ohi, o(3 downto 1) => olo(3 downto 1), o(0) => b0);
  process begin
    hi <= x"A"; lo <= x"3";
    wait for 1 ns;
    report to_hstring(ohi) & " " & to_string(olo(3 downto 1)) & " " & std_logic'image(b0);
    wait;
  end process;
end;`;
    const { out } = simulate({ 't.vhd': src }, 't');
    expect(out[0]).toBe("** Note: 3 101 '0'");
  });
});

describe('std_logic 9-value system (#26)', () => {
  it('starts at U, resolves weak drivers and prints 9-value characters', () => {
    const src = `
library ieee; use ieee.std_logic_1164.all;
entity t is end;
architecture a of t is
  signal s : std_logic;
  signal v : std_logic_vector(3 downto 0);
  signal bus_line : std_logic;
  signal n : std_logic := 'U';
begin
  bus_line <= 'H';               -- pull-up
  process begin
    bus_line <= 'Z';
    wait for 1 ns;
    report std_logic'image(s) & " " & to_string(v) & " " & std_logic'image(bus_line) & " " & std_logic'image(not n);
    bus_line <= '0';
    v(1 downto 0) <= "L1";
    wait for 1 ns;
    report std_logic'image(bus_line) & " " & to_string(v) & " " & boolean'image(v(1) = '0') & " " & boolean'image(v(1) = 'L');
    bus_line <= 'L';
    wait for 1 ns;
    report std_logic'image(bus_line);
    wait;
  end process;
end;`;
    const { out, design } = simulate({ 't.vhd': src }, 't');
    expect(out.filter(l => l.startsWith('**'))).toEqual([
      "** Note: 'U' UUUU 'H' 'U'",
      "** Note: '0' UUL1 false true",
      "** Note: 'W'",
    ]);
    const s = design.root.objects.find(o => o.name === 's')!.sig;
    expect(s.vals[0].toString()).toBe('U');
  });

  it('Verilog stays 4-state', () => {
    const { out } = simulate({ 'v.v': 'module v; reg [3:0] r; wire w; initial #1 $display("%b %b", r, w); endmodule' }, 'v');
    expect(out[0]).toBe('xxxx z');
  });
});

describe('inertial and transport delays (#27)', () => {
  it('filters short pulses with inertial delay, keeps them with transport and reject', () => {
    const src = `
library ieee; use ieee.std_logic_1164.all;
entity t is end;
architecture a of t is
  signal a : std_logic := '0';
  signal yi, yt, yr : std_logic := '0';
  signal n_i, n_t, n_r : integer := 0;
begin
  yi <= a after 10 ns;                       -- inertial (reject = 10 ns)
  yt <= transport a after 10 ns;             -- transport
  yr <= reject 2 ns inertial a after 10 ns;  -- only pulses < 2 ns rejected
  process (yi) begin if yi'event then n_i <= n_i + 1; end if; end process;
  process (yt) begin if yt'event then n_t <= n_t + 1; end if; end process;
  process (yr) begin if yr'event then n_r <= n_r + 1; end if; end process;
  process begin
    wait for 20 ns;
    a <= '1'; wait for 5 ns; a <= '0';      -- 5 ns pulse
    wait for 50 ns;
    a <= '1'; wait for 1 ns; a <= '0';      -- 1 ns pulse
    wait for 50 ns;
    report integer'image(n_i) & " " & integer'image(n_t) & " " & integer'image(n_r);
    wait;
  end process;
end;`;
    const { out } = simulate({ 't.vhd': src }, 't');
    expect(out[0]).toBe('** Note: 0 4 2');
  });

  it('a later delta assignment cancels a pending delayed one', () => {
    const src = `
library ieee; use ieee.std_logic_1164.all;
entity t is end;
architecture a of t is signal s : std_logic := '0'; begin
  process begin
    s <= '1' after 10 ns;
    s <= '0';
    wait for 20 ns;
    report std_logic'image(s);
    wait;
  end process;
end;`;
    expect(simulate({ 't.vhd': src }, 't').out[0]).toBe("** Note: '0'");
  });
});
