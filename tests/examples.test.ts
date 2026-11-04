import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';
import { EXAMPLES, exampleFiles } from '../src/ui/samples';

describe('bundled examples', () => {
  for (const ex of EXAMPLES) {
    it(`${ex.title} runs cleanly`, async () => {
      const lines: { m: string; k?: string }[] = [];
      const files = await exampleFiles(ex);
      const s = new Session({ read: (n) => files[n], list: () => Object.keys(files) }, (m, k) => lines.push({ m, k }));
      await s.exec(`do ${ex.doFile}`);
      const errs = lines.filter(l => l.k === 'err');
      expect(errs.map(e => e.m)).toEqual([]);
      expect(s.design).not.toBeNull();
      expect(s.waves.length).toBeGreaterThan(0);
      expect(s.now).toBeGreaterThan(0);
      if (ex.id === 'opentpu') {
        // the results of OpenTPU's own hardware (PyRTL) and functional simulators for simplemult
        expect(lines.map(l => l.m)).toContain('HLT after 429 cycles; host memory:');
        expect(lines.map(l => l.m)).toContain('  host[0] =  100    0    0    0    0    0    0    0');
        expect(lines.map(l => l.m)).toContain('PASS');
      }
      if (ex.id === 'cpu') {
        const outs = lines.map(l => l.m).filter(m => / OUT \d+$/.test(m)).map(m => Number(m.split(' ').pop()));
        expect(outs).toEqual([1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]);
        expect(lines.map(l => l.m)).toContain('PASS');
      }
      if (ex.id === 'cocotb') expect(lines.map(l => l.m)).toContain('** cocotb: TESTS=3 PASS=3 FAIL=0 SKIP=0');
      if ((globalThis as any).process?.env?.SHOW) console.log(lines.map(l => l.m).join('\n'));
    }, 60_000);
  }

  it('the 8-bit CPU passes its testbench as generic, asic and ice40 gate-level netlists', async () => {
    const ex = EXAMPLES.find(e => e.id === 'cpu')!;
    const fs: Record<string, string> = { ...ex.files };
    const out: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, m => out.push(m));
    await s.exec('vlog cpu.v tb_cpu.v; vsim work.tb_cpu; run -all');
    const ref = out.filter(l => / OUT |^PASS$|^Halted/.test(l));
    expect(ref).toContain('PASS');
    for (const [target, models] of [['generic', ''], ['asic', 'synth/websim_edu.v '], ['ice40', 'synth/ice40_cells.v ']]) {
      await s.exec('quit -sim; vlog cpu.v');
      out.length = 0;
      expect(await s.exec(`synth -target ${target}`), out.join("\n")).toBe(true);
      out.length = 0;
      expect(await s.exec(`vlog ${models}synth/cpu${target === 'generic' ? '' : '_' + target}.v; vsim work.tb_cpu; run -all`)).toBe(true);
      expect(out.filter(l => / OUT |^PASS$|^Halted/.test(l)), target).toEqual(ref);
    }
    // post-layout: the asic flow writes an SDF with the load-dependent delays of every cell
    await s.exec('quit -sim; vlog cpu.v');
    out.length = 0;
    expect(await s.exec('asic'), out.join('\n')).toBe(true);
    const sdf = fs['asic/cpu.sdf'];
    const a = s.lastAsic!.result!;
    const timed = a.nl.cells.filter(c => c.def.inputs.length).length;
    expect((sdf.match(/\(INSTANCE /g) ?? []).length).toBe(timed);
    expect(sdf).toMatch(/\(IOPATH \(posedge CLK\) Q \([\d.:]+\) \([\d.:]+\)\)/);
    expect(sdf).toMatch(/\(SETUPHOLD D \(posedge CLK\) \(0\.0500:0\.0500:0\.0500\) \(0\.0200:0\.0200:0\.0200\)\)/);
    out.length = 0;
    expect(await s.exec('vlog synth/websim_edu.v synth/cpu_asic.v; vsim -sdftyp /tb_cpu/dut=asic/cpu.sdf work.tb_cpu; run -all')).toBe(true);
    expect(out.filter(l => /^\*\* Warning/.test(l))).toEqual([]);
    expect(out.find(l => l.startsWith('Loading SDF file asic/cpu.sdf'))).toMatch(new RegExp(`: ${a.nl.cells.filter(c => c.def.output && c.def.inputs.length).length} path delays, \\d+ timing checks`));
    expect(out.filter(l => / OUT |^PASS$|^Halted/.test(l))).toEqual(ref);
    // the library holds the asic netlist now: synthesizing it again is refused
    await s.exec('quit -sim');
    out.length = 0;
    expect(await s.exec('synth -target asic')).toBe(false);
    expect(out.join('\n')).toMatch(/'cpu' in the library is the gate-level netlist synth\/cpu_asic\.v; compile the RTL source again first/);
  }, 120_000);
});
