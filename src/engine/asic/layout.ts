// Physical layout of the ASIC flow (#51): an invented layer stack, generated cell layouts, and the placed and routed
// design as rectangles (nm). Used by the GDSII / DEF writers and the layout viewer.
import { CELL, CELLS, ROW_H, ROW_TRACKS, TRACK, type CellDef } from './cells';
import type { Netlist } from './netlist';
import { flipped, rowY, type Placement } from './place';
import { powerGrid, type Routing } from './route';

export interface LayerDef { name: string; gds: number; color: string; kind: 'base' | 'metal' | 'cut' | 'marker' }
export const LAYERS: LayerDef[] = [
  { name: 'NWELL', gds: 1, color: '#6a8d3a', kind: 'base' },
  { name: 'DIFF', gds: 2, color: '#3fae5a', kind: 'base' },
  { name: 'POLY', gds: 3, color: '#d9473c', kind: 'base' },
  { name: 'CONT', gds: 4, color: '#e8e8e8', kind: 'cut' },
  { name: 'M1', gds: 10, color: '#4f7fd9', kind: 'metal' },
  { name: 'VIA1', gds: 11, color: '#9aa8c4', kind: 'cut' },
  { name: 'M2', gds: 12, color: '#c2569b', kind: 'metal' },
  { name: 'VIA2', gds: 13, color: '#b9a3c9', kind: 'cut' },
  { name: 'M3', gds: 14, color: '#d9a13c', kind: 'metal' },
  { name: 'VIA3', gds: 15, color: '#d6c79a', kind: 'cut' },
  { name: 'M4', gds: 16, color: '#3cc0c2', kind: 'metal' },
  { name: 'VIA4', gds: 17, color: '#9ad6d4', kind: 'cut' },
  { name: 'M5', gds: 18, color: '#9a7ad9', kind: 'metal' },
  { name: 'BOUNDARY', gds: 99, color: '#7a7a7a', kind: 'marker' },
];
export const LAYER = new Map(LAYERS.map(l => [l.name, l]));
/** Routing layer number (1 = M1 ... 5 = M5) to layer name; via k connects Mk and Mk+1. */
export const metal = (k: number) => `M${k}`;
export const cut = (k: number) => `VIA${k}`;

export const WIRE_W = 160, VIA_CUT = 120, VIA_PAD = 220, RAIL_W = 240, STRAP_W = 400, PIN_W = 140;

/** A rectangle [layer, x0, y0, x1, y1] in nm. */
export type Rect = [string, number, number, number, number];
export interface Label { layer: string; x: number; y: number; text: string }

/** Track index -> centre coordinate in nm. */
export const tc = (i: number) => i * TRACK + TRACK / 2;

/** The drawn layout of one library cell in its own coordinates (origin bottom-left, N orientation). */
export function cellLayout(def: CellDef): { rects: Rect[]; labels: Label[] } {
  const W = def.width * TRACK, H = ROW_H;
  const rects: Rect[] = [['BOUNDARY', 0, 0, W, H], ['NWELL', 0, H / 2, W, H]];
  const labels: Label[] = [];
  // power rails along the bottom (VSS) and top (VDD) edge, shared with the abutting rows
  rects.push(['M1', 0, 0, W, RAIL_W / 2], ['M1', 0, H - RAIL_W / 2, W, H]);
  if (def.kind === 'fill') return { rects, labels };
  const x0 = 0.25 * TRACK, x1 = W - 0.25 * TRACK;
  // p diffusion in the n-well, n diffusion below
  rects.push(['DIFF', x0, 0.6 * H, x1, 0.84 * H], ['DIFF', x0, 0.16 * H, x1, 0.4 * H]);
  // gates: one poly finger per input column (flip-flops get extra internal fingers)
  const gateCols = new Set<number>();
  for (const p of def.inputs) gateCols.add(def.pins[p].x);
  if (def.kind === 'ff') for (let c = 1; c < def.width - 1; c += 2) if (c !== def.pins[def.output!].x) gateCols.add(c);
  for (const c of gateCols) rects.push(['POLY', tc(c) - 0.09 * TRACK, 0.1 * H, tc(c) + 0.09 * TRACK, 0.9 * H]);
  // straps from the rails into the diffusions at column 0, with contacts
  rects.push(['M1', tc(0) - 0.15 * TRACK, 0, tc(0) + 0.15 * TRACK, 0.3 * H], ['M1', tc(0) - 0.15 * TRACK, 0.7 * H, tc(0) + 0.15 * TRACK, H]);
  rects.push(['CONT', tc(0) - 0.12 * TRACK, 0.22 * H, tc(0) + 0.12 * TRACK, 0.22 * H + 0.24 * TRACK], ['CONT', tc(0) - 0.12 * TRACK, 0.7 * H, tc(0) + 0.12 * TRACK, 0.7 * H + 0.24 * TRACK]);
  for (const [name, p] of Object.entries(def.pins)) {
    const cx = tc(p.x), cy = tc(p.y);
    if (name === def.output) {
      // output: a vertical M1 bar joining both diffusions
      rects.push(['M1', cx - PIN_W / 2, 0.24 * H, cx + PIN_W / 2, 0.76 * H]);
      rects.push(['CONT', cx - 0.12 * TRACK, 0.26 * H, cx + 0.12 * TRACK, 0.26 * H + 0.24 * TRACK], ['CONT', cx - 0.12 * TRACK, 0.68 * H, cx + 0.12 * TRACK, 0.68 * H + 0.24 * TRACK]);
    } else {
      rects.push(['M1', cx - PIN_W / 2, cy - 0.45 * TRACK, cx + PIN_W / 2, cy + 0.45 * TRACK]);
      if (def.kind !== 'tie') rects.push(['CONT', cx - 0.1 * TRACK, cy - 0.1 * TRACK, cx + 0.1 * TRACK, cy + 0.1 * TRACK]);
    }
    labels.push({ layer: 'M1', x: cx, y: cy, text: name });
  }
  return { rects, labels };
}

export interface Instance { name: string; type: string; x: number; y: number; flip: boolean; w: number }
export interface Layout {
  top: string;
  die: [number, number];
  core: [number, number, number, number];
  instances: Instance[];
  /** Routing and power shapes, tagged with their net. */
  shapes: { r: Rect; net: string }[];
  labels: Label[];
  layers: number;
}

/** Placed instances plus every routed shape in nm. */
export function buildLayout(nl: Netlist, p: Placement, r: Routing): Layout {
  const inst = (name: string, type: string, x: number, row: number): Instance => ({ name, type, x: x * TRACK, y: rowY(p, row) * TRACK, flip: flipped(row), w: CELL.get(type)!.width * TRACK });
  const instances = [
    ...nl.cells.map((c, i) => inst(c.name, c.type, p.cells[i].x, p.cells[i].row)),
    ...p.fillers.map((f, i) => inst(`FILLER_${i}`, f.type, f.x, f.row)),
  ];
  const shapes: Layout['shapes'] = [];
  const labels: Label[] = [];
  const box = (layer: string, cx: number, cy: number, s: number, net: string) => shapes.push({ r: [layer, cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2], net });
  for (const rn of r.nets) {
    for (const w of rn.wires) shapes.push({ r: [metal(w.layer), tc(w.x1) - WIRE_W / 2, tc(w.y1) - WIRE_W / 2, tc(w.x2) + WIRE_W / 2, tc(w.y2) + WIRE_W / 2], net: rn.name });
    for (const v of rn.vias) {
      box(cut(v.layer), tc(v.x), tc(v.y), VIA_CUT, rn.name);
      box(metal(v.layer + 1), tc(v.x), tc(v.y), VIA_PAD, rn.name);
      if (v.layer > 1) box(metal(v.layer), tc(v.x), tc(v.y), VIA_PAD, rn.name);
    }
  }
  // IO pins: a pad on the pin layer at the die edge, labelled with the port name
  nl.ports.forEach((q, i) => {
    const pp = p.ports[i];
    box(metal(pp.layer), tc(pp.x), tc(pp.y), VIA_PAD, nl.nets.find(n => n.id === q.net)?.name ?? q.name);
    labels.push({ layer: metal(pp.layer), x: tc(pp.x), y: tc(pp.y), text: q.name });
  });
  // power: rails across the core and margins to the straps, straps on M3, via stacks down to the rails
  const pg = powerGrid(p);
  const x0 = tc(pg.straps[0].x) - STRAP_W / 2, x1 = tc(pg.straps[1].x) + STRAP_W / 2;
  for (let b = 0; b <= p.rows; b++) {
    const y = (p.margin + ROW_TRACKS * b) * TRACK;
    shapes.push({ r: ['M1', x0, y - RAIL_W / 2, x1, y + RAIL_W / 2], net: b % 2 ? 'VDD' : 'VSS' });
  }
  const ys = p.margin * TRACK - RAIL_W / 2, ye = (p.margin + p.rows * ROW_TRACKS) * TRACK + RAIL_W / 2;
  for (const s of pg.straps) {
    shapes.push({ r: ['M3', tc(s.x) - STRAP_W / 2, ys, tc(s.x) + STRAP_W / 2, ye], net: s.net });
    labels.push({ layer: 'M3', x: tc(s.x), y: (ys + ye) / 2, text: s.net });
  }
  for (const v of pg.vias) {
    // the rail sits on the row boundary; an M1 pad bridges to the via stack on the reserved track next to it
    const cy = tc(v.y), ry = (p.margin + ROW_TRACKS * Math.round((v.y - p.margin) / ROW_TRACKS)) * TRACK;
    shapes.push({ r: ['M1', tc(v.x) - VIA_PAD / 2, Math.min(ry, cy) - VIA_PAD / 2, tc(v.x) + VIA_PAD / 2, Math.max(ry, cy) + VIA_PAD / 2], net: v.net });
    for (const k of [1, 2]) box(cut(k), tc(v.x), cy, VIA_CUT, v.net);
    box('M2', tc(v.x), cy, VIA_PAD, v.net);
  }
  return {
    top: nl.top, die: [p.dieW * TRACK, p.dieH * TRACK],
    core: [p.margin * TRACK, p.margin * TRACK, (p.margin + p.cols) * TRACK, (p.margin + p.rows * ROW_TRACKS) * TRACK],
    instances, shapes, labels, layers: r.layers + 1,
  };
}

/** Library cells used by a layout (for the GDS structures / LEF macros). */
export function usedCells(l: Layout): CellDef[] {
  const used = new Set(l.instances.map(i => i.type));
  return CELLS.filter(c => used.has(c.name));
}

/** Instance shapes in design coordinates (rows in FS orientation are mirrored about their own centre line). */
export function instanceRects(i: Instance): Rect[] {
  const def = CELL.get(i.type)!;
  return cellLayout(def).rects.map(([l, a, b, c, d]) => (i.flip ? [l, i.x + a, i.y + ROW_H - d, i.x + c, i.y + ROW_H - b] : [l, i.x + a, i.y + b, i.x + c, i.y + d]));
}

/** What the Layout window needs: the layout, the drawn shapes of each used cell, and the critical path's cells. */
export interface LayoutData { layout: Layout; cells: Record<string, Rect[]>; critical: string[]; criticalDelay: number | null }

export function layoutData(l: Layout, critical?: { delay: number; points: { cell?: string }[] } | null): LayoutData {
  return {
    layout: l,
    cells: Object.fromEntries(usedCells(l).map(c => [c.name, cellLayout(c).rects])),
    critical: critical ? critical.points.map(p => p.cell).filter((c): c is string => !!c) : [],
    criticalDelay: critical?.delay ?? null,
  };
}
