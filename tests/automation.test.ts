import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';
import { EXAMPLES } from '../src/ui/samples';

const session = () => {
  const fs: Record<string, string> = { ...EXAMPLES.find(e => e.id === 'cpu')!.files };
  const out: string[] = [];
  const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, m => out.push(m));
  return { fs, out, s };
};

describe('asic -auto (#67)', () => {
  it('retries with more layers and lower utilization until the layout is clean', async () => {
    const { out, s } = session();
    await s.exec('vlog cpu.v');
    expect(await s.exec('asic -util 0.95 -layers 2')).toBe(false);
    expect(out.join('\n')).toMatch(/the core is too small for the cells/);
    out.length = 0;
    expect(await s.exec('asic -util 0.95 -layers 2 -auto'), out.join('\n')).toBe(true);
    const t = out.join('\n');
    expect(t).toMatch(/-- asic -auto: attempt 2\/8 with utilization 0\.95 and 4 routing layers/);
    expect(t).toMatch(/-- asic -auto: attempt 3\/8 with utilization 0\.85 and 4 routing layers/);
    expect(t).toMatch(/-- asic -auto: clean layout with -util 0\.85 -layers 4/);
    expect(t).toMatch(/Checks: 0 shorts, 0 opens, 0 unrouted nets/);
    expect(s.lastAsic!.ok).toBe(true);
    expect(s.lastAsic!.result!.r.layers).toBe(4);
    // synthesis ran once
    expect(out.filter(l => l.startsWith('-- Synthesizing')).length).toBe(1);
  }, 180_000);
});

describe('timing repair (#68)', () => {
  it('upsizes cells on violating setup paths and the post-layout simulation still passes', async () => {
    const { fs, out, s } = session();
    fs['t.sdc'] = 'create_clock -name clk -period 1.45 [get_ports clk]\nset_input_delay -clock clk 0.3 [get_ports {rdata rst}]\n';
    await s.exec('vlog cpu.v tb_cpu.v');
    await s.exec('asic -sdc t.sdc');
    expect(s.lastAsic!.result!.timing.sta.wns).toBeLessThan(0);
    out.length = 0;
    expect(await s.exec('signoff -sdc t.sdc -repair'), out.join('\n')).toBe(true);
    const a = s.lastAsic!.result!;
    expect(a.repair!.upsized).toBeGreaterThan(0);
    expect(a.timing.sta.wns).toBe(0);
    expect(a.nl.cells.some(c => /_X[24]$/.test(c.type))).toBe(true);
    expect(out.join('\n')).toMatch(/Timing repair: \d+ cells upsized, 0 delay cells; worst before repair WNS -[\d.]+ ns/);
    // the layout's netlist (with the upsized cells) is what the post-layout simulation used
    expect(fs['asic/cpu.v']).toMatch(/\n  \w+_X[24] _\d+_ \(/);
    expect(fs['asic/cpu.rpt']).toMatch(/Timing repair \(before placement, estimated delays\):[\s\S]*-- after routing \(extracted wires\):[\s\S]*upsized _\d+_ \w+ -> \w+_X2/);
  }, 240_000);

  it('inserts delay cells for hold violations', async () => {
    const { fs, out, s } = session();
    fs['h.sdc'] = 'create_clock -name clk -period 4 [get_ports clk]\nset_clock_uncertainty -hold 0.25\nset_input_delay -clock clk 0.1 [get_ports {rdata rst}]\n';
    await s.exec('vlog cpu.v tb_cpu.v');
    out.length = 0;
    expect(await s.exec('signoff -sdc h.sdc -repair'), out.join('\n')).toBe(true);
    const a = s.lastAsic!.result!;
    expect(a.repair!.buffers).toBeGreaterThan(10);
    expect(a.repair!.before.whs).toBeLessThan(-0.1);
    expect(a.timing.sta.whs).toBe(0);
    expect(a.nl.cells.filter(c => c.type === 'DLY').length).toBe(a.repair!.buffers);
    expect(fs['asic/cpu.v']).toMatch(/\n  DLY hold_\d+_ \(\.A\(\S+\), \.Y\(_n\d+_\)\);/);
    expect(fs['asic/cpu_signoff.rpt']).toMatch(/Post-layout simulation: +\d+ output lines, 0 timing-check violations +\[ok\]/);
  }, 240_000);

  it('needs constraints', async () => {
    const { out, s } = session();
    await s.exec('vlog cpu.v');
    expect(await s.exec('asic -repair')).toBe(false);
    expect(out.join('\n')).toMatch(/asic: -repair needs timing constraints \(-sdc file\)/);
  });
});
