// Value Change Dump (IEEE 1364 §18) writer and a small reader for round-trip tests.
import type { Signal } from './kernel';
import type { Vec } from './logic';
import { fmtReal, vecToReal } from './elab';

export interface VcdVar { path: string; sig: Signal }

/** Short printable identifier codes: !, ", #, ... then two-character codes. */
function code(n: number): string {
  let s = '';
  do { s += String.fromCharCode(33 + (n % 94)); n = Math.floor(n / 94); } while (n > 0);
  return s;
}

function bits(v: Vec): string {
  let s = '';
  for (let i = v.w - 1; i >= 0; i--) s += v.bit(i);
  return s;
}

function valueLine(sig: Signal, v: Vec, id: string): string {
  if (sig.isReal) return `r${fmtReal(vecToReal(v))} ${id}`;
  if (sig.w === 1) return bits(v) + id;
  // drop redundant leading zeros as allowed by the format
  const b = bits(v).replace(/^0+(?=[01])/, '');
  return `b${b || '0'} ${id}`;
}

/**
 * Build a VCD document from recorded signal histories.
 * Times (fs internally) are written in the coarsest unit that keeps every change exact.
 */
export function writeVcd(vars: VcdVar[], endTime: number, opts: { date?: string; version?: string } = {}): string {
  const out: string[] = [];
  out.push(`$date\n  ${opts.date ?? new Date().toUTCString()}\n$end`);
  out.push(`$version\n  ${opts.version ?? 'WebSim'}\n$end`);
  const allTimes = vars.flatMap(v => v.sig.times).concat([endTime]);
  let unit = 1, uname = 'fs';
  for (const [f, n] of [[1e6, 'ns'], [1e3, 'ps']] as [number, string][]) if (allTimes.every(t => t % f === 0)) { unit = f; uname = n; break; }
  out.push(`$timescale 1${uname} $end`);

  // scope tree
  interface Node { children: Map<string, Node>; vars: { name: string; sig: Signal }[] }
  const root: Node = { children: new Map(), vars: [] };
  const ids = new Map<Signal, string>();
  for (const v of vars) {
    const parts = v.path.split('/').filter(Boolean);
    const name = parts.pop()!;
    let n = root;
    for (const p of parts) {
      let c = n.children.get(p);
      if (!c) { c = { children: new Map(), vars: [] }; n.children.set(p, c); }
      n = c;
    }
    if (!n.vars.some(x => x.name === name)) n.vars.push({ name, sig: v.sig });
    if (!ids.has(v.sig)) ids.set(v.sig, code(ids.size));
  }
  const emit = (n: Node, depth: number) => {
    for (const v of n.vars) {
      const s = v.sig;
      const range = !s.isReal && (s.w > 1 || s.msb !== 0 || s.lsb !== 0) ? ` [${s.msb}:${s.lsb}]` : '';
      const kind = s.isReal ? 'real' : s.drivers?.length ? 'wire' : 'reg';
      out.push(`${'  '.repeat(depth)}$var ${kind} ${s.w} ${ids.get(s)} ${v.name.replace(/\s/g, '_')}${range} $end`);
    }
    for (const [name, c] of n.children) {
      out.push(`${'  '.repeat(depth)}$scope module ${name.replace(/\s/g, '_')} $end`);
      emit(c, depth + 1);
      out.push(`${'  '.repeat(depth)}$upscope $end`);
    }
  };
  emit(root, 0);
  out.push('$enddefinitions $end');

  // merge histories by time
  const sigs = [...ids.keys()];
  const byTime = new Map<number, string[]>();
  for (const s of sigs) {
    const id = ids.get(s)!;
    for (let i = 0; i < s.times.length; i++) {
      const t = s.times[i];
      if (t > endTime) break;
      if (i === 0 && t === 0) continue; // initial values go to $dumpvars
      let l = byTime.get(t);
      if (!l) { l = []; byTime.set(t, l); }
      l.push(valueLine(s, s.valAt(i), id));
    }
  }
  out.push('#0');
  out.push('$dumpvars');
  for (const s of sigs) out.push(valueLine(s, s.hv.length ? s.valAt(0) : s.value, ids.get(s)!));
  out.push('$end');
  const times = [...byTime.keys()].sort((a, b) => a - b);
  for (const t of times) {
    if (t !== 0) out.push(`#${t / unit}`);
    out.push(...byTime.get(t)!);
  }
  if (!times.length || times[times.length - 1] < endTime) out.push(`#${endTime / unit}`);
  return out.join('\n') + '\n';
}

/** Minimal VCD reader: returns per-variable (full dotted name) list of [time, value-bits]. */
export function readVcd(text: string): Map<string, [number, string][]> {
  const toks = text.split(/\s+/).filter(Boolean);
  const scope: string[] = [];
  const byId = new Map<string, string[]>();
  const res = new Map<string, [number, string][]>();
  let t = 0;
  let i = 0;
  const set = (id: string, v: string) => { for (const n of byId.get(id) ?? []) res.get(n)!.push([t, v]); };
  while (i < toks.length) {
    const k = toks[i];
    if (k === '$scope') { scope.push(toks[i + 2]); i += 4; continue; }
    if (k === '$upscope') { scope.pop(); i += 2; continue; }
    if (k === '$var') {
      const id = toks[i + 3], name = toks[i + 4];
      const full = [...scope, name].join('.');
      (byId.get(id) ?? byId.set(id, []).get(id)!).push(full);
      res.set(full, []);
      while (toks[i] !== '$end') i++;
      i++; continue;
    }
    if (k.startsWith('$')) {
      if (k === '$dumpvars' || k === '$end' || k === '$enddefinitions') { i++; if (k === '$enddefinitions') i++; continue; }
      while (i < toks.length && toks[i] !== '$end') i++;
      i++; continue;
    }
    if (k.startsWith('#')) { t = Number(k.slice(1)); i++; continue; }
    if (k[0] === 'b' || k[0] === 'B') { set(toks[i + 1], k.slice(1).toLowerCase()); i += 2; continue; }
    if (/^[01xzXZ]/.test(k)) { set(k.slice(1), k[0].toLowerCase()); i++; continue; }
    i++;
  }
  return res;
}

// ---------------------------------------------------------------- full reader (VCD import)

export interface VcdVarDecl { name: string; kind: string; width: number; msb: number; lsb: number; id: string }
export interface VcdScopeDecl { name: string; kind: string; vars: VcdVarDecl[]; children: VcdScopeDecl[] }
export interface VcdData {
  /** femtoseconds per VCD time unit */
  unit: number;
  scopes: VcdScopeDecl[];
  /** changes per identifier code: times in fs and value strings ('b' digits, or 'r' + real) */
  changes: Map<string, { t: number[]; v: string[] }>;
  end: number;
  date?: string;
  version?: string;
}

const FS: Record<string, number> = { s: 1e15, ms: 1e12, us: 1e9, ns: 1e6, ps: 1e3, fs: 1 };

/** Parse a VCD file (IEEE 1364 §18). Throws on malformed input. */
export function parseVcd(text: string): VcdData {
  const toks = text.split(/\s+/).filter(Boolean);
  let i = 0;
  const data: VcdData = { unit: 1e6, scopes: [], changes: new Map(), end: 0 };
  const stack: VcdScopeDecl[] = [];
  const untilEnd = () => { const out: string[] = []; while (i < toks.length && toks[i] !== '$end') out.push(toks[i++]); i++; return out; };
  let t = 0;
  let dumpOff = false;
  const ids = new Set<string>();
  const set = (id: string, v: string) => {
    let c = data.changes.get(id);
    if (!c) { c = { t: [], v: [] }; data.changes.set(id, c); }
    if (c.t.length && c.t[c.t.length - 1] === t) c.v[c.v.length - 1] = v; // last value in a time step wins
    else { c.t.push(t); c.v.push(v); }
  };
  while (i < toks.length) {
    const k = toks[i++];
    switch (k) {
      case '$date': data.date = untilEnd().join(' '); continue;
      case '$version': data.version = untilEnd().join(' '); continue;
      case '$comment': untilEnd(); continue;
      case '$timescale': {
        const m = /^(\d+)\s*(s|ms|us|ns|ps|fs)$/.exec(untilEnd().join(''));
        if (!m) throw new Error('VCD: bad $timescale');
        data.unit = Number(m[1]) * FS[m[2]];
        continue;
      }
      case '$scope': {
        const [kind, name] = untilEnd();
        const s: VcdScopeDecl = { name: name ?? 'unnamed', kind: kind ?? 'module', vars: [], children: [] };
        (stack.length ? stack[stack.length - 1].children : data.scopes).push(s);
        stack.push(s);
        continue;
      }
      case '$upscope': untilEnd(); stack.pop(); continue;
      case '$var': {
        const f = untilEnd();
        // $var kind width id name [range]
        const [kind, w, id, name, range] = f;
        const width = Number(w) || 1;
        let msb = width - 1, lsb = 0;
        const m = /^\[(-?\d+)(?::(-?\d+))?\]$/.exec(range ?? '') ?? /\[(-?\d+)(?::(-?\d+))?\]$/.exec(name);
        if (m) { msb = Number(m[1]); lsb = m[2] !== undefined ? Number(m[2]) : msb; }
        const nm = range ? name : name.replace(/\[(-?\d+)(?::(-?\d+))?\]$/, '') || name;
        if (!stack.length) data.scopes.push(stack[0] = { name: 'top', kind: 'module', vars: [], children: [] });
        stack[stack.length - 1].vars.push({ name: nm, kind, width, msb, lsb, id });
        ids.add(id);
        continue;
      }
      case '$enddefinitions': untilEnd(); continue;
      case '$dumpvars': case '$dumpall': case '$end': continue;
      case '$dumpon': dumpOff = false; continue;
      case '$dumpoff': {
        dumpOff = true;
        // all variables become x while dumping is off; the values that follow restate that
        continue;
      }
    }
    if (k[0] === '#') {
      const n = Number(k.slice(1));
      if (!Number.isFinite(n)) throw new Error(`VCD: bad time "${k}"`);
      t = Math.round(n * data.unit);
      if (t > data.end) data.end = t;
      continue;
    }
    if (k[0] === 'b' || k[0] === 'B') { set(toks[i++], k.slice(1).toLowerCase()); continue; }
    if (k[0] === 'r' || k[0] === 'R') { set(toks[i++], 'r' + k.slice(1)); continue; }
    if (k[0] === 's' || k[0] === 'S') { i++; continue; } // string values are not supported
    if (/^[01xzXZuUwWlLhH-]/.test(k)) { set(k.slice(1), k[0].toLowerCase()); continue; }
    if (k.startsWith('$')) { untilEnd(); continue; }
    throw new Error(`VCD: unexpected "${k}"`);
  }
  void dumpOff;
  if (!ids.size) throw new Error('VCD: no variables declared');
  return data;
}

/** Expand a VCD vector value to `w` bits (left extension: 0/1 -> 0, x -> x, z -> z). */
export function vcdBits(v: string, w: number): string {
  if (v.length >= w) return v.slice(v.length - w);
  const pad = v[0] === 'x' || v[0] === 'z' ? v[0] : '0';
  return pad.repeat(w - v.length) + v;
}
