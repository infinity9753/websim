// Cross-sections of the layout (#75): the invented process stack (heights in nm), the shapes a cut line crosses, and
// the two ways of drawing them: true scale (1:1) and an educational schematic scale in which every layer gets a band of
// the same height and small features are widened, so gates and contacts stay visible next to long wires.
import { ROW_H } from './cells';
import { instanceRects, type Layout, type Rect } from './layout';

import { STACK } from './process';
export { STACK, STACK_TOP, STACK_BOTTOM } from './process';

export interface XSeg {
  layer: string;
  /** Distance along the cut line (nm). */
  s0: number; s1: number;
  /** Net of a routing / power shape, or the cell instance of a shape inside a cell. */
  net?: string; inst?: string; type?: string;
}
export interface XSection { a: [number, number]; b: [number, number]; length: number; segs: XSeg[] }

/** Parameter interval [t0, t1] of the segment a-b inside a rectangle (Liang-Barsky), or null. */
export function clip(a: [number, number], b: [number, number], x0: number, y0: number, x1: number, y1: number): [number, number] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return t1 > t0 ? [t0, t1] : null;
}

/** The layers crossed by the line a-b (nm), as intervals along it; overlapping shapes of one layer are merged. */
export function crossSection(l: Layout, cells: Record<string, Rect[]>, a: [number, number], b: [number, number]): XSection {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const raw: XSeg[] = [];
  const add = (r: Rect, tag: Partial<XSeg>) => {
    if (!(r[0] in STACK)) return;
    const c = clip(a, b, r[1], r[2], r[3], r[4]);
    if (c) raw.push({ layer: r[0], s0: c[0] * length, s1: c[1] * length, ...tag });
  };
  for (const i of l.instances) {
    if (!clip(a, b, i.x, i.y, i.x + i.w, i.y + ROW_H)) continue;
    const rects = cells[i.type] ? cells[i.type].map(([ly, x0, y0, x1, y1]): Rect => (i.flip ? [ly, i.x + x0, i.y + ROW_H - y1, i.x + x1, i.y + ROW_H - y0] : [ly, i.x + x0, i.y + y0, i.x + x1, i.y + y1])) : instanceRects(i);
    for (const r of rects) add(r, { inst: i.name, type: i.type });
  }
  for (const s of l.shapes) add(s.r, { net: s.net });
  // merge overlapping intervals of a layer (a via pad on a wire, abutting cells' rails, ...): the first owner names it
  const segs: XSeg[] = [];
  for (const layer of Object.keys(STACK)) {
    const list = raw.filter(x => x.layer === layer).sort((p, q) => p.s0 - q.s0);
    for (const x of list) {
      const last = segs[segs.length - 1];
      if (last && last.layer === layer && x.s0 <= last.s1 + 1e-6) { last.s1 = Math.max(last.s1, x.s1); if (!last.net && x.net) last.net = x.net; }
      else segs.push({ ...x });
    }
  }
  return { a, b, length, segs };
}

// ---------------------------------------------------------------- the two scales

/** Schematic bands from the bottom: silicon (wells, diffusions), gate, contact, then each via and metal. */
export const BANDS = ['SUB', 'POLY', 'CONT', 'M1', 'VIA1', 'M2', 'VIA2', 'M3', 'VIA3', 'M4', 'VIA4', 'M5'];
const BAND_H = (b: string) => (b === 'SUB' ? 2 : b.startsWith('VIA') || b === 'CONT' ? 0.7 : 1);

/** Schematic height of a layer: [bottom, top] in band units (the silicon band holds the n-well and, above, the diffusions). */
export function schematicZ(layer: string): [number, number] {
  let z = 0;
  const base: Record<string, number> = {};
  for (const b of BANDS) { base[b] = z; z += BAND_H(b) + 0.15; }
  if (layer === 'NWELL') return [0, 1.8];
  if (layer === 'DIFF') return [1.2, 2];
  return [base[layer], base[layer] + BAND_H(layer)];
}
export const SCHEMATIC_TOP = BANDS.reduce((s, b) => s + BAND_H(b) + 0.15, 0);

/**
 * Schematic position along the line: the interval between two consecutive shape edges of width w (nm) is drawn
 * 25 + 6 sqrt(w) units wide, so a 70 nm gate gets about a third of the width of a 2 µm wire instead of 3.5%.
 */
export function schematicX(x: XSection): (s: number) => number {
  const edges = [...new Set([0, x.length, ...x.segs.flatMap(g => [g.s0, g.s1])].map(v => Math.round(v * 1000) / 1000))].sort((p, q) => p - q);
  const pos = [0];
  for (let i = 1; i < edges.length; i++) { const w = edges[i] - edges[i - 1]; pos.push(pos[i - 1] + (w > 0 ? 25 + 6 * Math.sqrt(w) : 0)); }
  return (s: number) => {
    let i = 1;
    while (i < edges.length - 1 && s > edges[i]) i++;
    const w = edges[i] - edges[i - 1];
    return w > 0 ? pos[i - 1] + ((s - edges[i - 1]) / w) * (pos[i] - pos[i - 1]) : pos[i - 1];
  };
}
