import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';
import { EXAMPLES } from '../src/ui/samples';

describe('signoff (#66)', () => {
  const session = () => {
    const fs: Record<string, string> = { ...EXAMPLES.find(e => e.id === 'cpu')!.files };
    const out: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, m => out.push(m));
    return { fs, out, s };
  };

  it('RTL simulation, layout, STA and post-layout simulation of the CPU agree', async () => {
    const { fs, out, s } = session();
    await s.exec('vlog cpu.v tb_cpu.v');
    out.length = 0;
    expect(await s.exec('signoff -sdc cpu.sdc'), out.join('\n')).toBe(true);
    const rep = fs['asic/cpu_signoff.rpt'];
    expect(rep).toMatch(/^Signoff of cpu \(testbench tb_cpu, instance \/tb_cpu\/dut\)\n/);
    expect(rep).toMatch(/RTL simulation: +(\d+) output lines/);
    const n = /RTL simulation: +(\d+)/.exec(rep)![1];
    expect(Number(n)).toBeGreaterThan(10);
    expect(rep).toContain(`Post-layout simulation:  ${n} output lines, 0 timing-check violations  [ok]`);
    expect(rep).toMatch(/Timing: +setup WNS 0\.000 ns, hold WHS 0\.000 ns \(SDC\) +\[ok\]/);
    expect(rep).toMatch(/RTL vs post-layout: +identical +\[ok\]\nSignoff: PASS\n$/);
    expect(out.some(l => l.startsWith('Loading SDF file asic/cpu.sdf for region /tb_cpu/dut (typ)'))).toBe(true);
    // the library holds the RTL again: synthesis is not refused
    out.length = 0;
    expect(await s.exec('synth -target generic'), out.join('\n')).toBe(true);
  }, 180_000);

  it('fails when timing is not met, and names the problem', async () => {
    const { fs, out, s } = session();
    fs['fast.sdc'] = 'create_clock -name clk -period 1 [get_ports clk]\nset_input_delay -clock clk 0.5 [get_ports {rdata rst}]\n';
    await s.exec('vlog cpu.v tb_cpu.v');
    expect(await s.exec('signoff -sdc fast.sdc')).toBe(false);
    expect(fs['asic/cpu_signoff.rpt']).toMatch(/Timing: +setup WNS -[\d.]+ ns.*\[FAIL\]/);
    expect(out).toContain('Signoff: FAIL');
    out.length = 0;
    expect(await s.exec('signoff -tb nothere')).toBe(false);
  }, 180_000);
});
