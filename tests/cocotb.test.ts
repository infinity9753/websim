import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';

// cocotb-compatible Python testbenches run by Pyodide against the WebSim kernel (#46)
const COUNTER = `
module counter(input clk, input rst, input en, output reg [3:0] q, output tc);
  reg [7:0] mem [0:3];
  always @(posedge clk) if (rst) q <= 0; else if (en) q <= q + 1;
  assign tc = &q;
  initial mem[2] = 8'h5a;
endmodule`;

const TESTS = `
import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, FallingEdge, Timer, ClockCycles, ReadOnly, ReadWrite, First, Event, with_timeout, SimTimeoutError
from cocotb.types import LogicArray
from helpers import reset

@cocotb.test()
async def counts(dut):
    """q counts up after reset and tc goes high at 15"""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    for i in range(1, 16):
        await RisingEdge(dut.clk)
        await ReadOnly()
        assert dut.q.value == i, f"q={int(dut.q.value)} expected {i}"
    assert dut.tc.value == 1
    assert cocotb.utils.get_sim_time("ns") == 170
    dut._log.info("q=%s tc=%s", dut.q.value, dut.tc.value)

@cocotb.test()
async def values_and_writes(dut):
    dut.clk.value = 0
    dut.rst.value = 0
    dut.en.value = 0
    await Timer(1, "ns")
    # writes take effect when the coroutine yields, not immediately
    dut.en.value = 1
    assert dut.en.value == 0
    await Timer(1, unit="ns")
    assert dut.en.value == 1
    v = dut.q.value
    assert isinstance(v, LogicArray) and len(v) == 4 and v.is_resolvable
    assert str(dut.tc.value) in "01" and len(dut.q) == 4
    assert dut.mem[2].value == 0x5a and dut.mem[0].value.binstr == "xxxxxxxx".upper()
    dut.mem[1].value = 0x33
    await Timer(1, "ns")
    assert int(dut.mem[1].value) == 0x33
    dut.q.value = LogicArray("1010")
    await ReadWrite()
    assert dut.q.value == "1010" and dut.q.value.integer == 10 and dut.q.value[3] == 1 and dut.q.value[0] == 0
    try:
        dut.q.value = 16
        assert False, "16 does not fit in 4 bits"
    except OverflowError:
        pass

@cocotb.test()
async def tasks_and_triggers(dut):
    cocotb.start_soon(Clock(dut.clk, 4, "ns").start(start_high=False))
    async def worker(n):
        await ClockCycles(dut.clk, n)
        return n * 2
    t = cocotb.start_soon(worker(3))
    assert await t == 6
    ev = Event()
    async def setter():
        await Timer(5, "ns")
        ev.set("hello")
    cocotb.start_soon(setter())
    t0 = cocotb.utils.get_sim_time("ns")
    await ev.wait()
    assert ev.data == "hello" and cocotb.utils.get_sim_time("ns") == t0 + 5
    r = await First(Timer(100, "ns"), RisingEdge(dut.clk))
    assert isinstance(r, RisingEdge)
    try:
        await with_timeout(Timer(50, "ns"), 10, "ns")
        assert False
    except SimTimeoutError:
        pass
    await FallingEdge(dut.clk)
    assert dut.clk.value == 0

@cocotb.test(expect_fail=True)
async def expected_failure(dut):
    await Timer(1, "ns")
    assert dut.q.value == 99

@cocotb.test(skip=True)
async def skipped(dut):
    assert False
`;

const HELPERS = `
from cocotb.triggers import ClockCycles
async def reset(dut):
    dut.rst.value = 1
    dut.en.value = 0
    await ClockCycles(dut.clk, 3)
    dut.rst.value = 0
    dut.en.value = 1
`;

function session(files: Record<string, string>) {
  const out: string[] = [];
  const s = new Session({ read: n => files[n], list: () => Object.keys(files), write: (n, t) => { files[n] = t; } }, m => out.push(m));
  return { s, out };
}

describe('cocotb-compatible Python tests (#46)', () => {
  it('runs the tests of a module against the design and reports the results', async () => {
    const { s, out } = session({ 'counter.v': COUNTER, 'tests/test_counter.py': TESTS, 'tests/helpers.py': HELPERS });
    expect(await s.exec('vlog counter.v')).toBe(true);
    expect(await s.exec('vsim work.counter -cocotb tests/test_counter')).toBe(true);
    expect(out).toContain('cocotb: 5 tests in test_counter');
    const ok = await s.exec('run -all');
    const text = out.join('\n');
    expect(text, text).not.toMatch(/Traceback|\*\* Error/);
    expect(ok).toBe(true);
    expect(text).toMatch(/INFO\s+cocotb\.counter\s+q=1111 tc=1/);
    expect(text).toMatch(/running test_counter\.counts \(1\/5\)/);
    expect(text).toMatch(/test_counter\.counts\s+PASS\s+170\.00/);
    for (const t of ['values_and_writes', 'tasks_and_triggers', 'expected_failure']) expect(text).toMatch(new RegExp(`test_counter\\.${t}\\s+PASS`));
    expect(text).toMatch(/test_counter\.skipped\s+SKIP/);
    expect(out).toContain('** cocotb: TESTS=5 PASS=4 FAIL=0 SKIP=1');
    expect(s.design!.kernel.finished).toBe(true);
  }, 120_000);

  it('reports a failing assertion with the test source line, and runs selected test cases', async () => {
    const files = {
      'counter.v': COUNTER,
      'test_bad.py': `import cocotb\nfrom cocotb.triggers import Timer\n\n@cocotb.test()\nasync def bad(dut):\n    dut.en.value = 1\n    await Timer(3, "ns")\n    assert dut.q.value == 7, "q is not 7"\n\n@cocotb.test()\nasync def good(dut):\n    await Timer(1, "ns")\n`,
    };
    const { s, out } = session(files);
    await s.exec('vlog counter.v');
    await s.exec('vsim counter -cocotb test_bad');
    expect(await s.exec('run -all')).toBe(false);
    const text = out.join('\n');
    expect(text).toMatch(/File "\/websim_proj\/test_bad\.py", line 8, in bad/);
    expect(text).toMatch(/AssertionError: q is not 7/);
    expect(out).toContain('** cocotb: TESTS=2 PASS=1 FAIL=1 SKIP=0');
    // restart re-imports the (edited) module; -testcase selects tests
    out.length = 0;
    files['test_bad.py'] += '    dut._log.info("edited")\n';
    await s.exec('vsim counter -cocotb test_bad -testcase good');
    expect(await s.exec('run -all')).toBe(true);
    expect(out).toContain('** cocotb: TESTS=1 PASS=1 FAIL=0 SKIP=0');
    expect(out.join('\n')).toMatch(/INFO .* edited/);
  }, 120_000);

  it('fails the waiting test when the simulation runs out of events, and reports import errors', async () => {
    const { s, out } = session({
      'counter.v': COUNTER,
      'test_hang.py': 'import cocotb\nfrom cocotb.triggers import RisingEdge\n\n@cocotb.test()\nasync def hang(dut):\n    await RisingEdge(dut.clk)\n',
      'test_syntax.py': 'import cocotb\n\n@cocotb.test()\nasync def x(dut)\n    pass\n',
    });
    await s.exec('vlog counter.v');
    await s.exec('vsim counter -cocotb test_hang');
    expect(await s.exec('run -all')).toBe(false);
    expect(out.join('\n')).toMatch(/the simulation ran out of events before the test finished/);
    expect(out).toContain('** cocotb: TESTS=1 PASS=0 FAIL=1 SKIP=0');
    out.length = 0;
    expect(await s.exec('vsim counter -cocotb test_syntax')).toBe(false);
    expect(out.join('\n')).toMatch(/SyntaxError/);
    expect(await s.exec('vsim counter -cocotb missing')).toBe(false);
    expect(out.join('\n')).toMatch(/test module "missing.py" not found/);
  }, 120_000);

  it('drives VHDL designs: std_logic, unsigned, integer signals and generate blocks', async () => {
    const { s, out } = session({
      'acc.vhd': `library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity acc is port (clk : in std_logic; d : in unsigned(7 downto 0); sum : out unsigned(7 downto 0)); end;
architecture rtl of acc is
  signal total : unsigned(7 downto 0) := (others => '0');
  signal n : integer := 0;
begin
  process (clk) begin
    if rising_edge(clk) then total <= total + d; n <= n + 1; end if;
  end process;
  sum <= total;
  g : for i in 0 to 1 generate
    signal bitv : std_logic;
  begin
    bitv <= total(i);
  end generate;
end;`,
      'test_acc.py': `import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, FallingEdge, ReadOnly, Timer

@cocotb.test()
async def accumulates(dut):
    assert dut.clk.value == "U"
    await cocotb.start(Clock(dut.clk, 2, "ns").start())
    total = 0
    for d in (3, 5, 7, 250):
        dut.d.value = d
        await RisingEdge(dut.clk)
        total = (total + d) % 256
        await ReadOnly()
        assert dut.sum.value == total
        await FallingEdge(dut.clk)
    await ReadOnly()
    try:
        dut.d.value = 1
        assert False, "writes are not allowed in the ReadOnly phase"
    except RuntimeError:
        pass
    assert dut.n.value == 4 and isinstance(dut.n.value, int)
    assert dut.g[1].bitv.value == (total >> 1) & 1
    assert len(dut.g) == 2
`,
    });
    await s.exec('vcom acc.vhd');
    await s.exec('vsim acc -cocotb test_acc');
    const ok = await s.exec('run -all');
    expect(out, out.join('\n')).toContain('** cocotb: TESTS=1 PASS=1 FAIL=0 SKIP=0');
    expect(ok).toBe(true);
  }, 120_000);

  it('supports Combine, NextTimeStep, queues, locks, force/release, hierarchy, timeouts and expect_error', async () => {
    const { s, out } = session({
      'top.v': `module inner(input [3:0] a, output [3:0] y); assign y = ~a; endmodule
module top(input [3:0] a, output [3:0] y); inner u1(.a(a), .y(y)); endmodule`,
      'test_misc.py': `import cocotb
from cocotb.triggers import Timer, Combine, NextTimeStep, Lock
from cocotb.queue import Queue
from cocotb.handle import Force, Release

@cocotb.test()
async def misc(dut):
    dut.a.value = 3
    await Timer(1, "ns")
    assert dut.u1.y.value == 12 and dut.u1.a.value == 3
    t0 = cocotb.utils.get_sim_time("ns")
    await Combine(Timer(2, "ns"), Timer(5, "ns"))
    assert cocotb.utils.get_sim_time("ns") == t0 + 5
    async def later():
        await Timer(7, "ns")
    cocotb.start_soon(later())
    await NextTimeStep()
    assert cocotb.utils.get_sim_time("ns") == t0 + 12
    q = Queue()
    async def producer():
        for i in range(3):
            await Timer(1, "ns")
            await q.put(i)
    cocotb.start_soon(producer())
    assert [await q.get() for _ in range(3)] == [0, 1, 2]
    lock, order = Lock(), []
    async def user(n):
        async with lock:
            order.append(n)
            await Timer(1, "ns")
            order.append(n)
    await Combine(cocotb.start_soon(user(1)), cocotb.start_soon(user(2)))
    assert order == [1, 1, 2, 2]
    dut.u1.y.value = Force(5)
    dut.a.value = 0
    await Timer(1, "ns")
    assert dut.y.value == 5
    dut.u1.y.value = Release()
    await Timer(1, "ns")
    dut.a.value = 1
    await Timer(1, "ns")
    assert dut.y.value == 14

@cocotb.test(timeout_time=10, timeout_unit="ns", expect_error=cocotb.triggers.SimTimeoutError)
async def times_out(dut):
    await Timer(1, "us")

@cocotb.test(expect_error=ZeroDivisionError)
async def raises(dut):
    await Timer(1, "ns")
    1 / 0
`,
    });
    await s.exec('vlog top.v');
    await s.exec('vsim top -cocotb test_misc -testcase misc,times_out,raises');
    const ok = await s.exec('run -all');
    expect(out, out.join('\n')).toContain('** cocotb: TESTS=3 PASS=3 FAIL=0 SKIP=0');
    expect(ok).toBe(true);
  }, 120_000);
});
