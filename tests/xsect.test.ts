import { describe, it, expect } from 'vitest';
import { CELL, ROW_H, TRACK } from '../src/engine/asic/cells';
import { cellLayout, type Layout } from '../src/engine/asic/layout';
import { BANDS, clip, crossSection, schematicX, schematicZ, STACK } from '../src/engine/asic/xsect';

/** One NAND2 at the origin, an M2 wire above it and an M3 wire crossing it. */
function tiny(): { l: Layout; cells: Record<string, ReturnType<typeof cellLayout>['rects']> } {
  const nand = CELL.get('NAND2')!;
  const l: Layout = {
    top: 't', die: [10_000, 10_000], core: [0, 0, 10_000, 10_000], layers: 3, labels: [],
    instances: [{ name: 'u1', type: 'NAND2', x: 0, y: 0, flip: false, w: nand.width * TRACK }],
    shapes: [
      { r: ['M2', 0, 1000, 4000, 1160], net: 'a' },
      { r: ['M2', 3000, 1000, 6000, 1160], net: 'a' },   // overlaps the first: merged
      { r: ['M3', 2000, 0, 2160, 5000], net: 'b' },
    ],
  };
  return { l, cells: { NAND2: cellLayout(nand).rects } };
}

describe('layout cross-sections (#75)', () => {
  it('clips a segment against a rectangle', () => {
    expect(clip([0, 0], [10, 0], 2, -1, 4, 1)).toEqual([0.2, 0.4]);
    expect(clip([0, 0], [10, 10], 2, 2, 4, 4)).toEqual([0.2, 0.4]);
    expect(clip([0, 5], [10, 5], 2, -1, 4, 1)).toBeNull();
    expect(clip([3, 0], [3, 10], 2, 2, 4, 4)).toEqual([0.2, 0.4]);
  });

  it('the process stack is ordered from the silicon up and the bands from the bottom', () => {
    const metals = ['M1', 'M2', 'M3', 'M4', 'M5'];
    for (let i = 1; i < metals.length; i++) {
      expect(STACK[metals[i]].z0).toBe(STACK[`VIA${i}`].z1);
      expect(STACK[`VIA${i}`].z0).toBe(STACK[metals[i - 1]].z1);
      expect(STACK[metals[i]].z1 - STACK[metals[i]].z0).toBeGreaterThanOrEqual(STACK[metals[i - 1]].z1 - STACK[metals[i - 1]].z0);
    }
    expect(STACK.CONT.z1).toBe(STACK.M1.z0);
    expect(STACK.DIFF.z1).toBe(0);
    for (let i = 1; i < BANDS.length; i++) expect(schematicZ(BANDS[i])[0]).toBeGreaterThan(schematicZ(BANDS[i - 1] === 'SUB' ? 'NWELL' : BANDS[i - 1])[1]);
  });

  it('a horizontal cut through the n diffusion crosses the gates of the cell, the wire and nothing else', () => {
    const { l, cells } = tiny();
    const y = 0.28 * ROW_H;   // inside the n diffusion (0.16 .. 0.4 of the row)
    const xs = crossSection(l, cells, [-500, y], [6500, y]);
    expect(xs.length).toBe(7000);
    const nand = CELL.get('NAND2')!;
    const gates = xs.segs.filter(g => g.layer === 'POLY');
    expect(gates.length).toBe(2);                 // inputs A and B
    for (const [i, p] of nand.inputs.entries()) {
      const cx = (nand.pins[p].x + 0.5) * TRACK;
      expect(gates[i].s0).toBeCloseTo(cx - 0.09 * TRACK + 500, 6);
      expect(gates[i].s1 - gates[i].s0).toBeCloseTo(0.18 * TRACK, 6);
      expect(gates[i]).toMatchObject({ inst: 'u1', type: 'NAND2' });
    }
    expect(xs.segs.filter(g => g.layer === 'DIFF').length).toBe(1);
    const m3 = xs.segs.find(g => g.layer === 'M3')!;
    expect([m3.s0, m3.s1, m3.net]).toEqual([2500, 2660, 'b']);
    expect(xs.segs.some(g => g.layer === 'M2' || g.layer === 'NWELL')).toBe(false);
  });

  it('overlapping shapes of a layer merge, and a cut along a wire gives one long interval', () => {
    const { l, cells } = tiny();
    const xs = crossSection(l, cells, [0, 1080], [6000, 1080]);
    const m2 = xs.segs.filter(g => g.layer === 'M2');
    expect(m2).toEqual([{ layer: 'M2', s0: 0, s1: 6000, net: 'a' }]);
  });

  it('the schematic scale widens small features and keeps the order', () => {
    const { l, cells } = tiny();
    const y = 0.28 * ROW_H;
    const xs = crossSection(l, cells, [-500, y], [6500, y]);
    const X = schematicX(xs);
    let prev = -1;
    for (let s = 0; s <= xs.length; s += 50) { expect(X(s)).toBeGreaterThanOrEqual(prev); prev = X(s); }
    const gate = xs.segs.find(g => g.layer === 'POLY')!;
    const share = (a: number, b: number, f: (s: number) => number) => (f(b) - f(a)) / (f(xs.length) - f(0));
    // on the true scale a gate is ~1% of the cut; on the schematic scale several times more
    expect(share(gate.s0, gate.s1, s => s)).toBeLessThan(0.011);
    expect(share(gate.s0, gate.s1, X)).toBeGreaterThan(0.04);
  });
});
