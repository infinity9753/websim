import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';
import { EXAMPLES } from '../src/ui/samples';
import { crc32, unzip, zip } from '../src/engine/zip';
import { defaultSdc, guessClock } from '../src/engine/openlane';

const dec = new TextDecoder();

describe('zip writer (#59)', () => {
  it('CRC-32 and a stored archive that reads back', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const z = zip({ 'a/b.txt': 'hello', 'c.bin': new Uint8Array([0, 1, 2, 255]), '한글.md': '# 제목' });
    expect([...z.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const files = unzip(z);
    expect(Object.keys(files)).toEqual(['a/b.txt', 'c.bin', '한글.md']);
    expect(dec.decode(files['a/b.txt'])).toBe('hello');
    expect([...files['c.bin']]).toEqual([0, 1, 2, 255]);
    expect(dec.decode(files['한글.md'])).toBe('# 제목');
  });
});

describe('OpenLane export (#59)', () => {
  it('guesses the clock from edge expressions and writes a default SDC', () => {
    const src = { 'x.v': 'always @(posedge clk or posedge rst) if (rst) q <= 0; // negedge a\nalways @(posedge clk) r <= d;' };
    expect(guessClock(src, ['rst', 'clk', 'd'])).toBe('clk');
    expect(guessClock({ 'y.v': 'assign y = a & b;' }, ['a', 'b'])).toBeUndefined();
    const sdc = defaultSdc({ clockPort: 'clk', period: 10, inputs: ['clk', 'rst', 'd'] });
    expect(sdc).toContain('create_clock -name clk -period 10 [get_ports clk]');
    expect(sdc).toContain('set_input_delay -clock clk 2.000 [get_ports {rst d}]');
    expect(defaultSdc({ period: 5, inputs: ['a'] })).toContain('create_clock -name virtual_clk -period 5\n');
  });

  const session = () => {
    const fs: Record<string, string> = { ...EXAMPLES.find(e => e.id === 'cpu')!.files };
    const out: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, m => out.push(m));
    return { fs, out, s };
  };

  it('exports the CPU: config.json, sources, SDC and README in the project and as a zip', async () => {
    const { fs, out, s } = session();
    await s.exec('vlog cpu.v tb_cpu.v');
    expect(await s.exec('openlane'), out.join('\n')).toBe(true);
    expect(out.join('\n')).toMatch(/OpenLane project for cpu: clock clk, period 10 ns, utilization 40%, 1 source file\(s\)/);
    const cfg = JSON.parse(fs['openlane/cpu/config.json']);
    expect(cfg).toEqual({
      meta: { version: 2 }, DESIGN_NAME: 'cpu', VERILOG_FILES: ['dir::src/cpu.v'], CLOCK_PORT: 'clk', CLOCK_PERIOD: 10,
      PNR_SDC_FILE: 'dir::cpu.sdc', SIGNOFF_SDC_FILE: 'dir::cpu.sdc', FP_CORE_UTIL: 40,
    });
    expect(fs['openlane/cpu/src/cpu.v']).toBe(fs['cpu.v']);
    expect(fs['openlane/cpu/cpu.sdc']).toMatch(/create_clock -name clk -period 10 \[get_ports clk\]\nset_clock_uncertainty 0\.25\nset_input_delay -clock clk 2\.000 \[get_ports \{rst rdata\}\]/);
    expect(fs['openlane/cpu/README.md']).toMatch(/^# cpu — OpenLane 2 \/ LibreLane project/);
    const z = unzip(s.lastExport!.data);
    expect(s.lastExport!.name).toBe('cpu_openlane.zip');
    expect(Object.keys(z).sort()).toEqual(['cpu/README.md', 'cpu/config.json', 'cpu/cpu.sdc', 'cpu/src/cpu.v']);
    expect(dec.decode(z['cpu/config.json'])).toBe(fs['openlane/cpu/config.json']);
  });

  it('takes the period from a project SDC and accepts options; reports bad ones', async () => {
    const { fs, out, s } = session();
    await s.exec('vlog cpu.v tb_cpu.v');
    expect(await s.exec('openlane -sdc cpu.sdc -util 55')).toBe(true);
    const cfg = JSON.parse(fs['openlane/cpu/config.json']);
    expect([cfg.CLOCK_PORT, cfg.CLOCK_PERIOD, cfg.FP_CORE_UTIL]).toEqual(['clk', 4, 55]);
    expect(fs['openlane/cpu/cpu.sdc']).toBe(fs['cpu.sdc']);
    expect(await s.exec('openlane -period 7.5 -top cpu')).toBe(true);
    expect(JSON.parse(fs['openlane/cpu/config.json']).CLOCK_PERIOD).toBe(7.5);
    out.length = 0;
    expect(await s.exec('openlane -util 0')).toBe(false);
    expect(out.join('\n')).toMatch(/openlane: -util expects a core utilization in percent/);
  });

  it('a combinational design gets no clock port and a virtual clock', async () => {
    const fs: Record<string, string> = { 'add.v': 'module add(input [3:0] a, b, output [4:0] y); assign y = a + b; endmodule' };
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, () => {});
    await s.exec('vlog add.v');
    expect(await s.exec('openlane')).toBe(true);
    expect(JSON.parse(fs['openlane/add/config.json']).CLOCK_PORT).toBeNull();
    expect(fs['openlane/add/add.sdc']).toContain('set_input_delay -clock virtual_clk 2.000 [get_ports {a b}]');
  });
});
