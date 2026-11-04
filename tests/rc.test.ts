import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';
import { PIN_CAP } from '../src/engine/asic/cells';
import { elmore, trackRC, viaR, wireSlew } from '../src/engine/asic/rc';
import { MATERIAL, STACK, sheetR, wireCap } from '../src/engine/asic/process';
import { VIA_CUT, WIRE_W } from '../src/engine/asic/layout';
import { TRACK } from '../src/engine/asic/cells';
import { writeLef } from '../src/engine/asic/def';
import { analyze } from '../src/engine/asic/sta';

describe('RC extraction (#58)', () => {
  it('one track of wire: R and C follow from the process table (#76)', () => {
    // M2: 200 nm thick, 160 nm drawn wide, 240 nm above M1, 400 nm per track
    const t = STACK.M2.z1 - STACK.M2.z0, h = STACK.M2.z0 - STACK.M1.z1, w = WIRE_W, L = TRACK;
    expect([t, h, w, L]).toEqual([200, 240, 160, 400]);
    const m2 = trackRC(2);
    expect(m2.r).toBeCloseTo(MATERIAL.rhoMetal * L / (w * t), 12);                 // rho L / (W T)
    const eps = 8.854e-3 * MATERIAL.epsR;                                         // fF / um
    const yt = (w / h) + 0.77 + 1.06 * Math.pow(w / h, 0.25) + 1.06 * Math.sqrt(t / h);   // Yuan-Trick
    expect(m2.c).toBeCloseTo(eps * yt * (L / 1000), 12);
    expect(wireCap(2).area).toBeCloseTo(eps * w / h, 12);
    // thicker upper metals: lower resistance; M1 sits far above the silicon: the least area capacitance
    expect(trackRC(5).r).toBeLessThan(trackRC(4).r);
    expect(trackRC(4).r).toBeLessThan(trackRC(2).r);
    expect(wireCap(1).area).toBeLessThan(wireCap(2).area);
    expect(sheetR(2)).toBeCloseTo(MATERIAL.rhoMetal / 200, 12);
    // vias: tungsten through the via height over the cut area, plus the interface
    expect(viaR(1)).toBeCloseTo(MATERIAL.rhoVia * (STACK.VIA1.z1 - STACK.VIA1.z0) / (VIA_CUT * VIA_CUT) + MATERIAL.viaInterface, 12);
    expect(viaR(4)).toBeGreaterThan(viaR(1));   // a taller via
  });

  it('the LEF carries the same electrical numbers', () => {
    const lef = writeLef(5);
    expect(lef).toMatch(new RegExp(`LAYER M2[\\s\\S]*?HEIGHT 1 ;\\n  THICKNESS 0\\.2 ;\\n  RESISTANCE RPERSQ ${sheetR(2)} ;`));
    expect(lef).toContain(`  CAPACITANCE CPERSQDIST ${(wireCap(2).area / 0.16 / 1000).toExponential(4)} ;`);
    expect(lef).toMatch(new RegExp(`LAYER VIA1\\n  TYPE CUT ;\\n  WIDTH 0\\.12 ;\\n  RESISTANCE ${+viaR(1).toFixed(3)} ;`));
  });

  it('Elmore delay of a branching RC tree', () => {
    // root -R1- a -R2- b, a -R3- c; capacitances on a, b, c (fF), resistances (ohm)
    const cap = [0, 2, 3, 5], res = [{ a: 0, b: 1, r: 10 }, { a: 1, b: 2, r: 20 }, { a: 3, b: 1, r: 40 }];
    const d = elmore(cap, res, 0);
    const da = 10 * (2 + 3 + 5) * 1e-6;
    expect(d[0]).toBe(0);
    expect(d[1]).toBeCloseTo(da, 15);
    expect(d[2]).toBeCloseTo(da + 20 * 3 * 1e-6, 15);
    expect(d[3]).toBeCloseTo(da + 40 * 5 * 1e-6, 15);
    // the same network seen from b
    expect(elmore(cap, res, 2)[3]).toBeCloseTo(20 * (2 + 5) * 1e-6 + 40 * 5 * 1e-6, 15);
  });

  it('wire slew combines the driver transition with the wire', () => {
    expect(wireSlew(0.1, 0)).toBe(0.1);
    expect(wireSlew(0.03, 0.01)).toBeCloseTo(Math.hypot(0.03, Math.log(9) * 0.01), 12);
  });

  it('the asic flow extracts every routed net, writes SPEF and times with wire delays', async () => {
    const fs: Record<string, string> = { 'c.v': `module c(input clk, input rst_n, input [3:0] a, output reg [3:0] acc, output z);
  always @(posedge clk or negedge rst_n) if (!rst_n) acc <= 0; else acc <= acc + a;
  assign z = ~|acc;
endmodule` };
    const out: string[] = [];
    const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, m => out.push(m));
    await s.exec('vlog c.v');
    expect(await s.exec('asic'), out.join('\n')).toBe(true);
    expect(out.join('\n')).toMatch(/Parasitics: wire [\d.]+ fF, \d+ resistors; worst wire delay [\d.]+ ps/);
    expect(out.join('\n')).toMatch(/Wrote asic\/c\.v, asic\/c\.def, asic\/c\.sdf, asic\/c\.spef/);
    const a = s.lastAsic!.result!;
    expect(a.px.nets.size).toBe(a.r.nets.length);
    for (const rn of a.r.nets) {
      const n = a.px.nets.get(rn.id)!;
      const tracks = (w: { x1: number; x2: number; y1: number; y2: number }) => w.x2 - w.x1 + w.y2 - w.y1;
      expect(n.res.length).toBe(rn.wires.reduce((t, w) => t + tracks(w), 0) + rn.vias.length);
      expect(n.wireC).toBeCloseTo(rn.wires.reduce((t, w) => t + tracks(w) * trackRC(w.layer).c, 0), 9);
      // the driver is node 0; every sink sees a positive delay, larger for longer nets
      const drv = n.terms.find(t => t.dir === 'O' && !t.port) ?? n.terms.find(t => t.port);
      expect(drv!.node).toBe(0);
      for (const t of n.terms) if (t !== drv && rn.wires.length) expect(t.elmore, `${rn.name} ${t.name}`).toBeGreaterThan(0);
      expect(n.totalC).toBeCloseTo(n.wireC + n.terms.filter(t => !t.port && t.dir === 'I').length * PIN_CAP * 1000, 9);
    }
    // SPEF: header, name map, one D_NET per net with its connections, caps and resistors
    const spef = fs['asic/c.spef'];
    expect(spef).toMatch(/^\*SPEF "IEEE 1481-1998"\n\*DESIGN "c"\n/);
    expect(spef).toMatch(/\*T_UNIT 1 NS\n\*C_UNIT 1 FF\n\*R_UNIT 1 OHM/);
    expect((spef.match(/^\*D_NET /gm) ?? []).length).toBe(a.r.nets.length);
    expect((spef.match(/^\*END$/gm) ?? []).length).toBe(a.r.nets.length);
    expect(spef).toMatch(/\*PORTS\n(?:\S+ [IO]\n)+/);
    const blk = spef.split('*D_NET ').slice(1).find(b => /\*I \S+:Q O \*D DFFR/.test(b))!;
    const total = Number(blk.split(/\s/)[1]);
    const caps = blk.slice(blk.indexOf('*CAP'), blk.indexOf('*RES')).split('\n').slice(1).filter(Boolean).reduce((t, l) => t + Number(l.split(' ')[2]), 0);
    expect(caps).toBeCloseTo(total, 3);
    expect(blk).toMatch(/\*I \S+:[A-Z]\w* I \*L 2\n/);
    // STA: wire delays appear on input pins and make paths slower than without parasitics
    const withRc = a.timing.critical!.delay, without = analyze(a.nl, a.r).critical!.delay;
    expect(withRc).toBeGreaterThan(without);
    const path = a.timing.sta.setup[0];
    expect(path.points.some(p => !p.out && p.cell && p.incr > 0)).toBe(true);
  }, 120_000);
});
