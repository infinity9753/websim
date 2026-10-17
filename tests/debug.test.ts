import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';

const files: Record<string, string> = {
  'tb.v': `\`timescale 1ns/1ps
module tb;
  reg clk = 0;
  integer i, sum = 0;
  task add(input integer v);
    begin
      sum = sum + v;
    end
  endtask
  always #5 clk = ~clk;
  initial begin
    for (i = 0; i < 4; i = i + 1) begin
      @(posedge clk);
      add(i);
    end
    $display("sum=%0d", sum);
    $finish;
  end
endmodule`,
  'p.vhd': `entity p is end;
architecture a of p is
  signal n : integer := 0;
begin
  process
    variable v : integer := 0;
  begin
    v := v + 1;
    n <= v;
    wait for 10 ns;
  end process;
end;`,
};

function mk() {
  const lines: string[] = [];
  const s = new Session({ read: n => files[n], list: () => Object.keys(files) }, m => lines.push(m));
  return { s, lines };
}

describe('breakpoints and stepping (#5, #6)', () => {
  it('stops at a breakpoint on every loop iteration and continues', async () => {
    const { s, lines } = mk();
    await s.exec('vlog tb.v; vsim tb');
    await s.exec('bp tb.v 14');
    const hits: number[] = [];
    for (let n = 0; n < 4; n++) {
      await s.exec('run -all');
      expect(s.paused?.line).toBe(14);
      hits.push(s.now);
    }
    expect(hits).toEqual([5000, 15000, 25000, 35000]);
    await s.exec('bd all');
    await s.exec('run -all');
    expect(lines).toContain('sum=6');
  });

  it('supports conditional breakpoints and snaps to executable lines', async () => {
    const { s } = mk();
    await s.exec('vlog tb.v; vsim tb');
    await s.exec('bp tb.v 14 {/tb/i == 2}');
    await s.exec('run -all');
    expect(s.paused?.line).toBe(14);
    expect(s.now).toBe(25000);
    await s.exec('bd all');
    const b = s.addBreakpoint('tb.v', 12); // "initial begin" line -> next executable line
    expect(b?.line).toBe(12);
  });

  it('step into enters the task, step over skips it', async () => {
    const { s } = mk();
    await s.exec('vlog tb.v; vsim tb');
    await s.exec('bp tb.v 14');
    await s.exec('run -all');
    await s.exec('step');
    expect(s.paused?.line).toBe(7);           // inside task add
    await s.exec('step -over');
    expect(s.paused?.line).toBe(12);          // back at the for loop step/condition
  });

  it('works in VHDL processes', async () => {
    const { s } = mk();
    await s.exec('vcom p.vhd; vsim p');
    await s.exec('bp p.vhd 9');
    await s.exec('run -all');
    expect(s.paused?.line).toBe(9);
    await s.exec('step');
    expect(s.paused?.line).toBe(10);
    await s.exec('run -all');
    expect(s.paused?.line).toBe(9);
    expect(s.now).toBe(10000);
  });

  it('-nodebug disables hooks', async () => {
    const { s } = mk();
    await s.exec('vlog tb.v; vsim -nodebug tb; bp tb.v 14; run -all');
    expect(s.paused).toBeNull();
    expect(s.design!.kernel.finished).toBe(true);
  });
});

describe('locals and call stack (#15)', () => {
  it('reports task locals and the inlined call chain when paused', async () => {
    const { s } = mk();
    await s.exec('vlog tb.v; vsim tb; bp tb.v 7; run -all');
    expect(s.paused?.line).toBe(7);
    const locals = s.locals();
    expect(locals.map(l => l.name)).toContain('v');
    expect(Number(locals.find(l => l.name === 'v')!.value.a)).toBe(0);
    const st = s.callStack();
    expect(st[0]).toMatch(/add \(tb\.v:14\)  @ tb\.v:7/);
    expect(st[1]).toMatch(/\/tb\/#INITIAL#11/);
  });

  it('shows VHDL process variables', async () => {
    const { s } = mk();
    await s.exec('vcom p.vhd; vsim p; bp p.vhd 9; run -all; run -all');
    expect(s.locals().find(l => l.name === 'v')!.value.toNumber()).toBe(2); // second pass through the process
  });
});

describe('when (#16)', () => {
  it('stops when the condition becomes true and runs other commands without stopping', async () => {
    const { s, lines } = mk();
    await s.exec('vlog tb.v; vsim tb');
    await s.exec('when -label hit2 {/tb/i == 2} {echo "i is two"; stop}');
    await s.exec('run -all');
    expect(s.now).toBe(15000);
    expect(lines).toContain('i is two');
    expect(lines.some(l => /stop requested by when "hit2"/.test(l))).toBe(true);
    await s.exec('nowhen hit2');
    await s.exec('when {/tb/sum == 6} {echo sum reached}');
    await s.exec('run -all');
    expect(lines).toContain('sum reached');
    expect(lines).toContain('sum=6');
    expect(s.design!.kernel.finished).toBe(true);
  });
});
