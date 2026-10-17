import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';
import { floorplan } from '../src/ui/pnr';

// nextpnr-ice40 (WebAssembly) places and routes the Yosys ice40 netlist (#48).
describe('FPGA place and route with nextpnr-ice40 (#48)', () => {
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
});
