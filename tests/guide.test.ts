import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';

// The tutorial code in docs/GUIDE.md must keep working.
const guide = (import.meta as unknown as { glob: (p: string, o: object) => Record<string, string> }).glob('../docs/GUIDE.md', { query: '?raw', import: 'default', eager: true });
const text = Object.values(guide)[0];
const blocks = (lang: string) => [...text.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map(m => m[1]);

describe('user guide tutorials (#44)', () => {
  it('Verilog tutorial compiles and runs', async () => {
    const [counter, tb] = blocks('verilog');
    const fs: Record<string, string> = { 'up_counter.v': counter, 'tb_up.v': tb, 'run.do': blocks('tcl')[2] };
    const out: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, m => out.push(m));
    await s.exec('vlib work; vlog up_counter.v tb_up.v; vsim work.tb_up; add wave -r /*; run -all');
    expect(out).toContain('q = 4'); // 20 ns reset, then 20 clock edges in 200 ns: 20 mod 16
    out.length = 0;
    await s.exec('do run.do');
    expect(out.join("\n")).not.toMatch(/\*\* Error/);
  });

  it('VHDL tutorial compiles and runs', async () => {
    const [blink, tb] = blocks('vhdl');
    const fs: Record<string, string> = { 'blink.vhd': blink, 'tb_blink.vhd': tb };
    const out: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs) }, m => out.push(m));
    await s.exec('vcom blink.vhd tb_blink.vhd; vsim work.tb_blink; add wave -r /*; run -all');
    expect(out.join("\n")).not.toMatch(/\*\* Error/);
    expect(out.some(l => /led = '[01]'/.test(l))).toBe(true);
  });
});
