// GDSII stream writer (and a small reader for checks) for the ASIC flow (#51).
// One structure per library cell plus the top structure with cell references, routing and power shapes, and pin labels.
import { cellLayout, LAYER, usedCells, type Layout, type Rect } from './layout';
import { ROW_H } from './cells';

const R = {
  HEADER: 0x0002, BGNLIB: 0x0102, LIBNAME: 0x0206, UNITS: 0x0305, ENDLIB: 0x0400, BGNSTR: 0x0502, STRNAME: 0x0606, ENDSTR: 0x0700,
  BOUNDARY: 0x0800, SREF: 0x0a00, TEXT: 0x0c00, LAYER: 0x0d02, DATATYPE: 0x0e02, XY: 0x1003, ENDEL: 0x1100, SNAME: 0x1206,
  TEXTTYPE: 0x1602, STRING: 0x1906, STRANS: 0x1a01,
};

/** GDSII 8-byte real: sign, excess-64 base-16 exponent, 56-bit mantissa. */
export function gdsReal(v: number): Uint8Array {
  const out = new Uint8Array(8);
  if (v === 0) return out;
  let sign = 0;
  if (v < 0) { sign = 0x80; v = -v; }
  let exp = 64;
  while (v >= 1) { v /= 16; exp++; }
  while (v < 1 / 16) { v *= 16; exp--; }
  out[0] = sign | exp;
  for (let i = 1; i < 8; i++) { v *= 256; const b = Math.floor(v); out[i] = b; v -= b; }
  return out;
}

export function readGdsReal(b: Uint8Array, o: number): number {
  const sign = b[o] & 0x80 ? -1 : 1, exp = (b[o] & 0x7f) - 64;
  let m = 0;
  for (let i = 1; i < 8; i++) m = m * 256 + b[o + i];
  return sign * (m / 2 ** 56) * 16 ** exp;
}

class Writer {
  private chunks: Uint8Array[] = [];
  private len = 0;
  rec(type: number, data: Uint8Array = new Uint8Array(0)) {
    const h = new Uint8Array(4);
    const n = 4 + data.length;
    h[0] = n >> 8; h[1] = n & 0xff; h[2] = type >> 8; h[3] = type & 0xff;
    this.chunks.push(h, data);
    this.len += n;
  }
  int2(type: number, ...v: number[]) { const d = new DataView(new ArrayBuffer(2 * v.length)); v.forEach((x, i) => d.setInt16(2 * i, x)); this.rec(type, new Uint8Array(d.buffer)); }
  int4(type: number, v: number[]) { const d = new DataView(new ArrayBuffer(4 * v.length)); v.forEach((x, i) => d.setInt32(4 * i, Math.round(x))); this.rec(type, new Uint8Array(d.buffer)); }
  str(type: number, s: string) { const b = new TextEncoder().encode(s.length % 2 ? s + '\0' : s); this.rec(type, b); }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

/** Structure names must be unique and plain; library cell names already are. */
const date = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];

export function writeGds(l: Layout, when = new Date(0)): Uint8Array {
  const w = new Writer();
  w.int2(R.HEADER, 600);
  w.int2(R.BGNLIB, ...date(when), ...date(when));
  w.str(R.LIBNAME, `${l.top}.DB`);
  // user unit 1 um = 1000 database units of 1 nm
  const units = new Uint8Array(16);
  units.set(gdsReal(1e-3), 0); units.set(gdsReal(1e-9), 8);
  w.rec(R.UNITS, units);
  const rect = (r: Rect) => {
    const [layer, x0, y0, x1, y1] = r;
    w.rec(R.BOUNDARY);
    w.int2(R.LAYER, LAYER.get(layer)!.gds);
    w.int2(R.DATATYPE, 0);
    w.int4(R.XY, [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0]);
    w.rec(R.ENDEL);
  };
  const text = (layer: string, x: number, y: number, s: string) => {
    w.rec(R.TEXT);
    w.int2(R.LAYER, LAYER.get(layer)!.gds);
    w.int2(R.TEXTTYPE, 0);
    w.int4(R.XY, [x, y]);
    w.str(R.STRING, s);
    w.rec(R.ENDEL);
  };
  const begin = (name: string) => { w.int2(R.BGNSTR, ...date(when), ...date(when)); w.str(R.STRNAME, name); };
  for (const def of usedCells(l)) {
    begin(def.name);
    const c = cellLayout(def);
    for (const r of c.rects) rect(r);
    for (const t of c.labels) text(t.layer, t.x, t.y, t.text);
    w.rec(R.ENDSTR);
  }
  begin(l.top);
  for (const i of l.instances) {
    w.rec(R.SREF);
    w.str(R.SNAME, i.type);
    // FS: reflected about the x axis, so the origin moves to the top edge of the row
    if (i.flip) w.rec(R.STRANS, new Uint8Array([0x80, 0]));
    w.int4(R.XY, [i.x, i.flip ? i.y + ROW_H : i.y]);
    w.rec(R.ENDEL);
  }
  for (const s of l.shapes) rect(s.r);
  for (const t of l.labels) text(t.layer, t.x, t.y, t.text);
  rect(['BOUNDARY', 0, 0, l.die[0], l.die[1]]);
  w.rec(R.ENDSTR);
  w.rec(R.ENDLIB);
  return w.bytes();
}

export interface GdsStructure { name: string; boundaries: { layer: number; xy: number[] }[]; srefs: { name: string; x: number; y: number; reflect: boolean }[]; texts: { layer: number; x: number; y: number; text: string }[] }

/** Minimal reader (BOUNDARY, SREF, TEXT) used to check written files. */
export function readGds(b: Uint8Array): { lib: string; units: [number, number]; structures: GdsStructure[] } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const res = { lib: '', units: [0, 0] as [number, number], structures: [] as GdsStructure[] };
  let cur: GdsStructure | null = null;
  let el: { kind: number; layer: number; xy: number[]; name: string; reflect: boolean; text: string } | null = null;
  for (let o = 0; o < b.length;) {
    const n = dv.getUint16(o), type = dv.getUint16(o + 2);
    if (n < 4) throw new Error(`bad GDS record at ${o}`);
    const d = o + 4, len = n - 4;
    const str = () => new TextDecoder().decode(b.subarray(d, d + len)).replace(/\0+$/, '');
    switch (type) {
      case R.LIBNAME: res.lib = str(); break;
      case R.UNITS: res.units = [readGdsReal(b, d), readGdsReal(b, d + 8)]; break;
      case R.BGNSTR: cur = { name: '', boundaries: [], srefs: [], texts: [] }; res.structures.push(cur); break;
      case R.STRNAME: cur!.name = str(); break;
      case R.BOUNDARY: case R.SREF: case R.TEXT: el = { kind: type, layer: 0, xy: [], name: '', reflect: false, text: '' }; break;
      case R.LAYER: el!.layer = dv.getInt16(d); break;
      case R.XY: for (let i = 0; i < len; i += 4) el!.xy.push(dv.getInt32(d + i)); break;
      case R.SNAME: el!.name = str(); break;
      case R.STRANS: el!.reflect = (b[d] & 0x80) !== 0; break;
      case R.STRING: el!.text = str(); break;
      case R.ENDEL:
        if (el!.kind === R.BOUNDARY) cur!.boundaries.push({ layer: el!.layer, xy: el!.xy });
        else if (el!.kind === R.SREF) cur!.srefs.push({ name: el!.name, x: el!.xy[0], y: el!.xy[1], reflect: el!.reflect });
        else cur!.texts.push({ layer: el!.layer, x: el!.xy[0], y: el!.xy[1], text: el!.text });
        el = null;
        break;
    }
    o += n;
  }
  return res;
}
