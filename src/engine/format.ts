// Verilog-style display formatting and time formatting.
import { Vec, toBin, toHex, toOct, toDec, toAscii, decWidth } from './logic';

export interface FmtArg { v: Vec; isStr?: boolean; real?: number }

const UNITS: [number, string][] = [[1e12, 's'], [1e9, 'ms'], [1e6, 'us'], [1e3, 'ns'], [1, 'ps'], [1e-3, 'fs']];

export function unitName(ps: number): string {
  for (const [v, n] of UNITS) if (Math.abs(ps - v) < 1e-9) return n;
  for (const [v, n] of UNITS) if (ps >= v) return `${ps / v}${n}`;
  return `${ps}ps`;
}

/** Format a time in ps using the given resolution, e.g. "120 ns". */
export function fmtTime(ps: number, resolution: number): string {
  let unit = 1000, name = 'ns';
  for (const [v, n] of UNITS) if (resolution >= v) { unit = v; name = n; break; }
  const v = ps / unit;
  const s = Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  return `${s} ${name}`;
}

/** Parse "10 ns", "10ns", "10" (default unit) into ps. */
export function parseTime(s: string, defaultUnitPs = 1000): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(s|ms|us|ns|ps|fs|sec|min|hr)?\s*$/i.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = (m[2] ?? '').toLowerCase();
  const scale = u === '' ? defaultUnitPs : ({ s: 1e12, sec: 1e12, ms: 1e9, us: 1e6, ns: 1e3, ps: 1, fs: 1e-3, min: 60e12, hr: 3600e12 } as Record<string, number>)[u];
  return Math.round(n * scale);
}

function pad(s: string, width: number, zero: boolean, left: boolean): string {
  if (s.length >= width) return s;
  if (left) return s + ' '.repeat(width - s.length);
  return (zero ? '0' : ' ').repeat(width - s.length) + s;
}

function stripZeros(s: string): string {
  const t = s.replace(/^0+(?=.)/, '');
  return t;
}

/** Format one value per Verilog spec char. */
export function fmtValue(spec: string, a: FmtArg, widthSpec: string, ctx: { scopeName: string; timeFmt: (v: Vec) => string }, prec?: number): string {
  const zeroW = widthSpec === '0';
  const left = widthSpec.startsWith('-');
  const zeroPad = widthSpec.startsWith('0') && widthSpec.length > 1;
  const width = widthSpec === '' ? -1 : Math.abs(parseInt(widthSpec, 10));
  const v = a.v;
  let s: string;
  switch (spec.toLowerCase()) {
    case 'd': case 'i': {
      s = toDec(v);
      if (!zeroW && width < 0) return pad(s, decWidth(v.w, v.signed), false, false);
      break;
    }
    case 'h': case 'x': s = toHex(v); if (zeroW) s = stripZeros(s); break;
    case 'b': s = toBin(v); if (zeroW) s = stripZeros(s); break;
    case 'o': s = toOct(v); if (zeroW) s = stripZeros(s); break;
    case 'c': s = String.fromCharCode(Number(v.a & 0xffn)); break;
    case 's': s = toAscii(v); break;
    case 'm': s = ctx.scopeName; break;
    case 't': s = ctx.timeFmt(v); if (!zeroW && width < 0) return pad(s, 20, false, false); break;
    case 'e': case 'f': case 'g': {
      const n = a.real ?? v.toNumber();
      const p = prec ?? 6;
      const ex = (x: string) => x.replace(/e([+-])(\d)$/, 'e$10$2');
      if (spec.toLowerCase() === 'e') s = ex(n.toExponential(p));
      else if (spec.toLowerCase() === 'f') s = n.toFixed(p);
      else {
        // %g: shortest of %e / %f with p significant digits, trailing zeros removed
        const e = Math.floor(Math.log10(Math.abs(n) || 1));
        s = e < -4 || e >= Math.max(1, p) ? ex(n.toExponential(Math.max(0, p - 1)).replace(/\.?0+e/, 'e')) : String(Number(n.toPrecision(Math.max(1, p))));
      }
      break;
    }
    case 'u': case 'z': case 'v': s = toBin(v); break;
    case 'l': s = 'work'; break;
    default: s = '%' + spec;
  }
  if (width > 0) s = pad(s, width, zeroPad, left);
  return s;
}

/** Expand a format string with args. Returns [text, number of args consumed]. */
export function expandFormat(fmt: string, args: FmtArg[], ctx: { scopeName: string; timeFmt: (v: Vec) => string }): [string, number] {
  let out = '';
  let ai = 0;
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== '%') { out += c; continue; }
    const m = /^(-?\d*)(?:\.(\d+))?([a-zA-Z%])/.exec(fmt.slice(i + 1));
    if (!m) { out += c; continue; }
    i += m[0].length;
    const spec = m[3];
    const prec = m[2] !== undefined ? Number(m[2]) : undefined;
    if (spec === '%') { out += '%'; continue; }
    if (spec === 'm' || spec === 'M' || spec === 'l' || spec === 'L') { out += fmtValue(spec, { v: new Vec(1, 0n, 0n) }, m[1], ctx); continue; }
    const a = args[ai++];
    if (!a) { out += '<missing>'; continue; }
    out += fmtValue(spec, a, m[1], ctx, prec);
  }
  return [out, ai];
}
