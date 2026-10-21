import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';
import { floorplan, tileKind, utilRows } from '../src/ui/pnr';

// nextpnr-ice40 (WebAssembly) places and routes the Yosys ice40 netlist (#48).
describe('FPGA place and route with nextpnr (#48, #50)', () => {
  it('synthesizes, places, routes and packs a bitstream; reports utilization, Fmax and pin locations', async () => {
    const fs: Record<string, string> = {
      'blink.v': 'module blink(input clk, output [3:0] led); reg [23:0] c = 0; always @(posedge clk) c <= c + 1; assign led = c[23:20]; endmodule',
      'blink.pcf': 'set_io clk 35\nset_io led[0] 39\nset_io led[1] 40\nset_io led[2] 41\nset_io led[3] 42\n',
    };
    const out: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, m => out.push(m));
    await s.exec('vlog blink.v');
    expect(await s.exec('pnr -device up5k -freq 12')).toBe(true);
    expect(out).toContain('-- Place and route blink on iCE40 UP5K (sg48), pins from blink.pcf');
    expect(out.find(l => l.startsWith('ICESTORM_LC'))).toMatch(/ICESTORM_LC\s+\d+ \/ 5280/);
    expect(out.find(l => l.startsWith('Max frequency'))).toMatch(/MHz \(PASS at 12 MHz\)/);
    expect(fs['pnr/blink.asc']).toContain('.device 5k');
    const p = s.lastPnr!;
    expect(p.ok).toBe(true);
    expect(p.bin!.length).toBeGreaterThan(1000);
    expect(p.run).toBe(1);
    // floorplan of the placed design: the 5 SB_IO cells sit on edge tiles, logic cells inside, nets link tiles
    const fp = floorplan(fs['pnr/blink.placed.json']);
    const cells = [...fp.tiles.values()].flatMap(t => t.cells.map(c => ({ ...c, x: t.x, y: t.y })));
    const io = cells.filter(c => c.type === 'SB_IO');
    expect(io.length).toBe(5);
    for (const c of io) expect(c.x === 0 || c.y === 0 || c.x === 25 || c.y === 31).toBe(true);
    const lcs = cells.filter(c => c.type === 'ICESTORM_LC');
    expect(lcs.length).toBeGreaterThan(20);
    for (const c of lcs) expect(c.x > 0 && c.x < 25 && c.y > 0 && c.y < 31).toBe(true);
    expect(fp.nets.length).toBeGreaterThan(5);
    // an impossible clock constraint fails timing (command returns false but still writes the results)
    out.length = 0;
    expect(await s.exec('pnr -device up5k -freq 2000')).toBe(false);
    expect(out.find(l => l.startsWith('Max frequency'))).toMatch(/FAIL at 2000 MHz/);
    expect(await s.exec('pnr -device xc7')).toBe(false);
  }, 240_000);

  const BLINK = 'module blink(input clk, output [3:0] led); reg [23:0] c = 0; always @(posedge clk) c <= c + 1; assign led = c[23:20]; endmodule';
  const session = (files: Record<string, string>) => {
    const out: string[] = [];
    const s = new Session({ read: n => files[n], list: () => Object.keys(files), write: (n, t) => { files[n] = t; } }, m => out.push(m));
    return { s, out };
  };
  const ioOnEdge = (placed: string) => {
    const fp = floorplan(placed);
    const tiles = [...fp.tiles.values()];
    const W = Math.max(...tiles.map(t => t.x)), H = Math.max(...tiles.map(t => t.y));
    const io = tiles.filter(t => tileKind(t.cells.map(c => c.type)) === 'io');
    return { io: io.length, edge: io.every(t => t.x === 0 || t.y === 0 || t.x === W || t.y === H), logic: tiles.filter(t => tileKind(t.cells.map(c => c.type)) === 'lc').length };
  };

  it('places and routes for Lattice ECP5 with an .lpf and packs a .bit bitstream (#50)', async () => {
    const fs: Record<string, string> = {
      'blink.v': BLINK,
      'blink.lpf': 'LOCATE COMP "clk" SITE "G2";\nIOBUF PORT "clk" IO_TYPE=LVCMOS33;\n' + [0, 1, 2, 3].map(i => `LOCATE COMP "led[${i}]" SITE "${['B2', 'C2', 'C1', 'D2'][i]}";`).join('\n') + '\n',
    };
    const { s, out } = session(fs);
    await s.exec('vlog blink.v');
    expect(await s.exec('pnr -device lfe5u-25f -freq 25'), out.join('\n')).toBe(true);
    expect(out).toContain('-- Place and route blink on ECP5 LFE5U-25F (CABGA381), pins from blink.lpf');
    expect(out.find(l => l.startsWith('TRELLIS_COMB'))).toMatch(/\/ 24288/);
    expect(out.find(l => l.startsWith('Max frequency'))).toMatch(/PASS at 25 MHz/);
    expect(fs['pnr/blink.config']).toContain('.device LFE5U-25F');
    expect(fs['synth/blink_ecp5.json']).toBeDefined();
    const p = s.lastPnr!;
    expect(p.family).toBe('ecp5');
    expect(p.bitstream).toBe('blink.bit');
    expect(p.bin!.length).toBeGreaterThan(100_000);
    const g = ioOnEdge(fs['pnr/blink.placed.json']);
    expect(g.io).toBeGreaterThan(0);
    expect(g.edge).toBe(true);
    expect(g.logic).toBeGreaterThan(0);
  }, 300_000);

  it('places and routes for Gowin with a .cst and packs an .fs bitstream with gowin_pack on Pyodide (#50)', async () => {
    const fs: Record<string, string> = { 'blink.v': BLINK };
    const { s, out } = session(fs);
    await s.exec('vlog blink.v');
    // every Gowin IO needs a location
    expect(await s.exec('pnr -device gw1n-9c')).toBe(false);
    expect(out.join('\n')).toMatch(/Unconstrained IO[\s\S]*Gowin needs a pin for every top-level port/);
    fs['blink.cst'] = 'IO_LOC "clk" 52;\n' + [10, 11, 13, 14].map((p, i) => `IO_LOC "led[${i}]" ${p};`).join('\n') + '\n';
    out.length = 0;
    expect(await s.exec('pnr -device gw1n-9c -freq 27'), out.join('\n')).toBe(true);
    expect(out).toContain('-- Place and route blink on Gowin GW1NR-9C (Tang Nano 9K) (GW1NR-LV9QN88PC6/I5), pins from blink.cst');
    expect(out.find(l => l.startsWith('Max frequency'))).toMatch(/PASS at 27 MHz/);
    const p = s.lastPnr!;
    expect(p.bitstream).toBe('blink.fs');
    // the .fs bitstream is text: rows of 0/1
    const fsText = new TextDecoder().decode(p.bin!);
    expect(fsText.length).toBeGreaterThan(100_000);
    expect(/^[01\r\n]+$/.test(fsText.slice(0, 2000))).toBe(true);
    const g = ioOnEdge(fs['pnr/blink.placed.json']);
    expect(g.io).toBeGreaterThan(0);
    expect(g.edge).toBe(true);
  }, 300_000);
});

describe('P&R window helpers (#50)', () => {
  it('classifies floorplan tiles and picks utilization rows', () => {
    expect(tileKind(['SB_IO'])).toBe('io');
    expect(tileKind(['TRELLIS_IO', 'TRELLIS_COMB'])).toBe('io');
    expect(tileKind(['IOB'])).toBe('io');
    expect(tileKind(['DP16KD'])).toBe('ram');
    expect(tileKind(['EHXPLLL'])).toBe('special');
    expect(tileKind(['TRELLIS_COMB', 'TRELLIS_FF'])).toBe('lc');
    expect(tileKind(['LUT4', 'DFF'])).toBe('lc');
    expect(utilRows([['DCCA', 0, 56], ['TRELLIS_COMB', 6, 24288], ['DP16KD', 0, 56], ['TRELLIS_IO', 8, 197], ['JTAGG', 0, 1], ['GSR', 1, 1]]).map(r => r[0]))
      .toEqual(['TRELLIS_COMB', 'TRELLIS_IO', 'GSR', 'DP16KD']);
  });
});
