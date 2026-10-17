// 4-state bit vectors with optional VHDL std_logic detail.
// Encoding per bit (a, b):  0 = (0,0)  1 = (1,0)  Z = (0,1)  X = (1,1)
// `b` marks unknown bits. Widths are arbitrary (BigInt backed).
// Two extra planes carry the rest of std_logic's 9 values without affecting 4-state logic:
//   u = uninitialized ('U', on an X bit)   k = weak strength ('W' on X, 'L'/'H' on 0/1)

const maskCache: bigint[] = [];
export function mask(w: number): bigint {
  if (w <= 0) return 0n;
  if (w < 512) {
    let m = maskCache[w];
    if (m === undefined) { m = (1n << BigInt(w)) - 1n; maskCache[w] = m; }
    return m;
  }
  return (1n << BigInt(w)) - 1n;
}

export class Vec {
  /** Cached vnum(): -2 = not computed yet. */
  _n = -2;
  constructor(public readonly w: number, public readonly a: bigint, public readonly b: bigint, public readonly signed = false, public readonly u = 0n, public readonly k = 0n) {}

  /** std_logic character of bit i: one of 0 1 x z U W L H (lowercase x/z for strong unknowns). */
  char(i: number): string {
    const bi = BigInt(i);
    const a = (this.a >> bi) & 1n, b = (this.b >> bi) & 1n;
    if (b) {
      if (!a) return 'z';
      if ((this.u >> bi) & 1n) return 'U';
      return (this.k >> bi) & 1n ? 'W' : 'x';
    }
    if ((this.k >> bi) & 1n) return a ? 'H' : 'L';
    return a ? '1' : '0';
  }

  /** True when the u/k planes are in use. */
  get rich(): boolean { return this.u !== 0n || this.k !== 0n; }

  get known(): boolean { return this.b === 0n; }
  get hasZ(): boolean { return (this.b & ~this.a & mask(this.w)) !== 0n; }

  bit(i: number): '0' | '1' | 'x' | 'z' {
    const bi = BigInt(i);
    const a = (this.a >> bi) & 1n, b = (this.b >> bi) & 1n;
    return b ? (a ? 'x' : 'z') : (a ? '1' : '0');
  }

  equals(o: Vec): boolean { return this.w === o.w && this.a === o.a && this.b === o.b && this.u === o.u && this.k === o.k; }

  withSign(s: boolean): Vec { if (s === this.signed) return this; const v = new Vec(this.w, this.a, this.b, s, this.u, this.k); v._n = this._n; return v; }

  /** Value as JS number (two's complement if signed). NaN when unknown. */
  toNumber(): number {
    if (this.b) return NaN;
    return Number(this.toBigInt());
  }

  toBigInt(): bigint {
    if (this.signed && this.w > 0 && ((this.a >> BigInt(this.w - 1)) & 1n)) return this.a - (1n << BigInt(this.w));
    return this.a;
  }

  toString(): string { return toBin(this); }
}

/** Value as a JS number for 2-state values of at most 32 bits; -1 otherwise (X/Z/U/W/L/H or wider). */
export function vnum(v: Vec): number {
  let n = v._n;
  if (n === -2) { n = v.w <= 32 && v.b === 0n && v.u === 0n && v.k === 0n ? Number(v.a) : -1; v._n = n; }
  return n;
}

/** A known value of at most 32 bits from a non-negative number already masked to w bits. */
export function smallVec(w: number, n: number, signed = false): Vec {
  if (w <= 8) {
    // narrow values are shared (Vec is immutable): no allocation for clocks, flags, bytes
    const tab = (signed ? SMALL_S : SMALL_U)[w] ??= new Array(1 << w);
    const c = tab[n];
    if (c) return c;
    const v = new Vec(w, BigInt(n), 0n, signed);
    v._n = n;
    return tab[n] = v;
  }
  const v = new Vec(w, BigInt(n), 0n, signed);
  v._n = n;
  return v;
}
const SMALL_U: Vec[][] = [], SMALL_S: Vec[][] = [];

export const X1 = new Vec(1, 1n, 1n);
export const Z1 = new Vec(1, 0n, 1n);
export const ONE = new Vec(1, 1n, 0n);
export const ZERO = new Vec(1, 0n, 0n);

export function allX(w: number): Vec { const m = mask(w); return new Vec(w, m, m); }
export function allZ(w: number): Vec { return new Vec(w, 0n, mask(w)); }
/** All 'U' (VHDL uninitialized std_logic). */
export function allU(w: number): Vec { const m = mask(w); return new Vec(w, m, m, false, m, 0n); }
export function zeros(w: number): Vec { return new Vec(w, 0n, 0n); }
export function bool(v: boolean): Vec { return v ? ONE : ZERO; }

export function fromInt(n: number | bigint, w = 32, signed = false): Vec {
  let v = typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
  v = v & mask(w);
  return new Vec(w, v, 0n, signed);
}

/** Parse bits like "01xz" (MSB first). Accepts VHDL std_logic chars. */
export function fromBits(s: string, signed = false): Vec {
  let a = 0n, b = 0n, u = 0n, k = 0n;
  const w = s.length;
  for (let i = 0; i < w; i++) {
    const c = s[i];
    a <<= 1n; b <<= 1n; u <<= 1n; k <<= 1n;
    switch (c) {
      case '0': break;
      case '1': a |= 1n; break;
      case 'L': case 'l': k |= 1n; break;
      case 'H': case 'h': a |= 1n; k |= 1n; break;
      case 'z': case 'Z': b |= 1n; break;
      case 'U': case 'u': a |= 1n; b |= 1n; u |= 1n; break;
      case 'W': case 'w': a |= 1n; b |= 1n; k |= 1n; break;
      default: a |= 1n; b |= 1n; // x X - ?
    }
  }
  return new Vec(w, a, b, signed, u, k);
}

export function fromString(s: string): Vec {
  // ASCII string -> 8 bits per char, first char most significant
  let a = 0n;
  for (let i = 0; i < s.length; i++) a = (a << 8n) | BigInt(s.charCodeAt(i) & 0xff);
  return new Vec(Math.max(8, s.length * 8), a, 0n);
}

export function toAscii(v: Vec): string {
  let out = '';
  const n = Math.ceil(v.w / 8);
  for (let i = n - 1; i >= 0; i--) {
    const c = Number((v.a >> BigInt(i * 8)) & 0xffn);
    if (c !== 0) out += String.fromCharCode(c);
  }
  return out;
}

/** Resize to w bits, sign-extending when v.signed (or `sext`). */
export function resize(v: Vec, w: number, sext = v.signed): Vec {
  if (w === v.w) return v;
  if (w < v.w) { const m = mask(w); return new Vec(w, v.a & m, v.b & m, v.signed, v.u & m, v.k & m); }
  if (sext && v.w > 0) {
    const top = BigInt(v.w - 1);
    const ext = mask(w) ^ mask(v.w);
    const ta = (v.a >> top) & 1n, tb = (v.b >> top) & 1n, tu = (v.u >> top) & 1n, tk = (v.k >> top) & 1n;
    return new Vec(w, v.a | (ta ? ext : 0n), v.b | (tb ? ext : 0n), v.signed, v.u | (tu ? ext : 0n), v.k | (tk ? ext : 0n));
  }
  // Verilog: zero-extend, but an unsized X/Z MSB would extend X/Z. Keep zero-extend.
  return new Vec(w, v.a, v.b, v.signed, v.u, v.k);
}

/** Extend with X/Z replication of the MSB when the MSB is X or Z (literal rule). */
export function resizeLiteral(v: Vec, w: number): Vec {
  if (w <= v.w) return resize(v, w, false);
  const top = BigInt(v.w - 1);
  const tb = (v.b >> top) & 1n;
  if (!tb) return resize(v, w);
  const ta = (v.a >> top) & 1n;
  const ext = mask(w) ^ mask(v.w);
  return new Vec(w, v.a | (ta ? ext : 0n), v.b | ext, v.signed);
}

// ---------- predicates ----------

/** 1 if any bit known-1, 0 if all known-0, otherwise X. */
export function truth(v: Vec): 0 | 1 | 'x' {
  const known1 = v.a & ~v.b;
  if (known1) return 1;
  if (v.b === 0n) return 0;
  return 'x';
}
export function isTrue(v: Vec): boolean { return truth(v) === 1; }

// ---------- bitwise ----------

function bitAnd(x: Vec, y: Vec, w: number): Vec {
  const m = mask(w);
  const zero = ((~x.a & ~x.b) | (~y.a & ~y.b)) & m;
  const one = (x.a & ~x.b) & (y.a & ~y.b) & m;
  const unk = m & ~(zero | one);
  return new Vec(w, one | unk, unk, false, unk & (x.u | y.u));
}
function bitOr(x: Vec, y: Vec, w: number): Vec {
  const m = mask(w);
  const one = ((x.a & ~x.b) | (y.a & ~y.b)) & m;
  const zero = (~x.a & ~x.b) & (~y.a & ~y.b) & m;
  const unk = m & ~(zero | one);
  return new Vec(w, one | unk, unk, false, unk & (x.u | y.u));
}
function bitXor(x: Vec, y: Vec, w: number): Vec {
  const m = mask(w);
  const unk = (x.b | y.b) & m;
  return new Vec(w, ((x.a ^ y.a) & m) | unk, unk, false, unk & (x.u | y.u));
}
function bitNot(x: Vec): Vec {
  const m = mask(x.w);
  return new Vec(x.w, ((~x.a) & m) | x.b, x.b, x.signed, x.u & x.b);
}

function prep(x: Vec, y: Vec): [Vec, Vec, number, boolean] {
  const w = Math.max(x.w, y.w);
  const s = x.signed && y.signed;
  return [resize(x, w, s), resize(y, w, s), w, s];
}

export function and(x: Vec, y: Vec): Vec { const [p, q, w, s] = prep(x, y); return bitAnd(p, q, w).withSign(s); }
export function or(x: Vec, y: Vec): Vec { const [p, q, w, s] = prep(x, y); return bitOr(p, q, w).withSign(s); }
export function xor(x: Vec, y: Vec): Vec { const [p, q, w, s] = prep(x, y); return bitXor(p, q, w).withSign(s); }
export function xnor(x: Vec, y: Vec): Vec { return not(xor(x, y)); }
export function nand(x: Vec, y: Vec): Vec { return not(and(x, y)); }
export function nor(x: Vec, y: Vec): Vec { return not(or(x, y)); }
export function not(x: Vec): Vec { return bitNot(x); }

// ---------- reduction ----------
export function redAnd(v: Vec): Vec {
  const m = mask(v.w);
  if ((~v.a & ~v.b & m) !== 0n) return ZERO;
  return v.b ? X1 : ONE;
}
export function redOr(v: Vec): Vec {
  if ((v.a & ~v.b) !== 0n) return ONE;
  return v.b ? X1 : ZERO;
}
export function redXor(v: Vec): Vec {
  if (v.b) return X1;
  let a = v.a, p = 0n;
  while (a) { p ^= a & 1n; a >>= 1n; }
  return p ? ONE : ZERO;
}

// ---------- logical ----------
export function lnot(v: Vec): Vec { const t = truth(v); return t === 'x' ? X1 : bool(t === 0); }
export function land(x: Vec, y: Vec): Vec {
  const a = truth(x), b = truth(y);
  if (a === 0 || b === 0) return ZERO;
  if (a === 1 && b === 1) return ONE;
  return X1;
}
export function lor(x: Vec, y: Vec): Vec {
  const a = truth(x), b = truth(y);
  if (a === 1 || b === 1) return ONE;
  if (a === 0 && b === 0) return ZERO;
  return X1;
}

// ---------- arithmetic ----------
function arith(x: Vec, y: Vec, f: (a: bigint, b: bigint) => bigint | null): Vec {
  const [p, q, w, s] = prep(x, y);
  if (p.b || q.b) return allX(w).withSign(s);
  const r = f(s ? p.toBigInt() : p.a, s ? q.toBigInt() : q.a);
  if (r === null) return allX(w).withSign(s);
  return new Vec(w, r & mask(w), 0n, s);
}
export function add(x: Vec, y: Vec): Vec { return arith(x, y, (a, b) => a + b); }
export function sub(x: Vec, y: Vec): Vec { return arith(x, y, (a, b) => a - b); }
export function mul(x: Vec, y: Vec): Vec { return arith(x, y, (a, b) => a * b); }
export function div(x: Vec, y: Vec): Vec { return arith(x, y, (a, b) => (b === 0n ? null : a / b)); }
export function mod(x: Vec, y: Vec): Vec { return arith(x, y, (a, b) => (b === 0n ? null : a % b)); }
/** VHDL mod: sign of result follows the divisor. */
export function vmod(x: Vec, y: Vec): Vec {
  return arith(x, y, (a, b) => { if (b === 0n) return null; const r = a % b; return r !== 0n && (r < 0n) !== (b < 0n) ? r + b : r; });
}
export function pow(x: Vec, y: Vec): Vec {
  const w = x.w;
  if (x.b || y.b) return allX(w);
  const base = x.signed ? x.toBigInt() : x.a;
  const e = y.signed ? y.toBigInt() : y.a;
  if (e < 0n) return base === 1n ? fromInt(1, w) : zeros(w);
  let r = 1n, b = base, n = e;
  const m = mask(w);
  while (n > 0n) { if (n & 1n) r = (r * b) & m; b = (b * b) & m; n >>= 1n; }
  return new Vec(w, r & m, 0n, x.signed);
}
export function neg(x: Vec): Vec {
  if (x.b) return allX(x.w).withSign(x.signed);
  return new Vec(x.w, (-x.a) & mask(x.w), 0n, x.signed);
}

// ---------- shifts ----------
export function shl(x: Vec, n: Vec): Vec {
  if (n.b) return allX(x.w);
  const k = n.a;
  if (k >= BigInt(x.w)) return zeros(x.w).withSign(x.signed);
  const m = mask(x.w);
  return new Vec(x.w, (x.a << k) & m, (x.b << k) & m, x.signed);
}
export function shr(x: Vec, n: Vec): Vec {
  if (n.b) return allX(x.w);
  const k = n.a;
  if (k >= BigInt(x.w)) return zeros(x.w).withSign(x.signed);
  return new Vec(x.w, x.a >> k, x.b >> k, x.signed);
}
export function ashr(x: Vec, n: Vec): Vec {
  if (!x.signed) return shr(x, n);
  if (n.b) return allX(x.w);
  let k = Number(n.a);
  if (k > x.w) k = x.w;
  const top = BigInt(x.w - 1);
  const ta = (x.a >> top) & 1n, tb = (x.b >> top) & 1n;
  const fill = mask(x.w) ^ mask(x.w - k);
  const bk = BigInt(k);
  return new Vec(x.w, (x.a >> bk) | (ta ? fill : 0n), (x.b >> bk) | (tb ? fill : 0n), true);
}

// ---------- comparison ----------
export function eq(x: Vec, y: Vec): Vec {
  const [p, q, w] = prep(x, y);
  const m = mask(w);
  const known = ~(p.b | q.b) & m;
  if (((p.a ^ q.a) & known) !== 0n) return ZERO;
  if (known !== m) return X1;
  return ONE;
}
export function neq(x: Vec, y: Vec): Vec { return lnot(eq(x, y)); }
export function caseEq(x: Vec, y: Vec): Vec {
  const [p, q] = prep(x, y);
  return bool(p.a === q.a && p.b === q.b && p.u === q.u && p.k === q.k);
}
export function caseNeq(x: Vec, y: Vec): Vec { return lnot(caseEq(x, y)); }
/** Verilog ===: compares the 4-state value only (drive strength is not part of it). */
export function caseEq4(x: Vec, y: Vec): Vec {
  const [p, q] = prep(x, y);
  return bool(p.a === q.a && p.b === q.b);
}
export function caseNeq4(x: Vec, y: Vec): Vec { return lnot(caseEq4(x, y)); }

export type Strength = 'supply' | 'strong' | 'pull' | 'weak' | 'highz';
/**
 * Apply a drive strength pair to a driven value: weak/pull drivers produce L/H/W (they lose
 * to strong drivers in resolution), highz turns that value into Z (open-drain style).
 */
export function withStrength(v: Vec, s0: Strength, s1: Strength): Vec {
  const m = mask(v.w);
  const zero = ~v.a & ~v.b & m, one = v.a & ~v.b & m, x = v.a & v.b & m;
  const weak = (s: Strength) => s === 'pull' || s === 'weak';
  let a = v.a & m, b = v.b & m, k = 0n;
  if (weak(s0)) k |= zero;
  else if (s0 === 'highz') b |= zero;
  if (weak(s1)) k |= one;
  else if (s1 === 'highz') { a &= ~one; b |= one; }
  if (weak(s0) && weak(s1)) k |= x;
  else if (s0 === 'highz' && s1 === 'highz') a &= ~x;
  return new Vec(v.w, a, b, v.signed, 0n, k);
}
/** casez/casex match: bits where either side has Z (casez) or X/Z (casex) are don't-care. */
export function wildEq(x: Vec, y: Vec, kind: 'casez' | 'casex'): boolean {
  const [p, q, w] = prep(x, y);
  const m = mask(w);
  let dc: bigint;
  if (kind === 'casex') dc = (p.b | q.b) & m;
  else dc = ((p.b & ~p.a) | (q.b & ~q.a)) & m;
  const care = m & ~dc;
  return ((p.a ^ q.a) & care) === 0n && ((p.b ^ q.b) & care) === 0n;
}
function rel(x: Vec, y: Vec, f: (a: bigint, b: bigint) => boolean): Vec {
  const [p, q, , s] = prep(x, y);
  if (p.b || q.b) return X1;
  return bool(f(s ? p.toBigInt() : p.a, s ? q.toBigInt() : q.a));
}
export function lt(x: Vec, y: Vec): Vec { return rel(x, y, (a, b) => a < b); }
export function le(x: Vec, y: Vec): Vec { return rel(x, y, (a, b) => a <= b); }
export function gt(x: Vec, y: Vec): Vec { return rel(x, y, (a, b) => a > b); }
export function ge(x: Vec, y: Vec): Vec { return rel(x, y, (a, b) => a >= b); }

// ---------- structure ----------
export function concat(parts: Vec[]): Vec {
  let a = 0n, b = 0n, u = 0n, k = 0n, w = 0;
  for (const p of parts) {
    const s = BigInt(p.w);
    const m = mask(p.w);
    a = (a << s) | (p.a & m);
    b = (b << s) | (p.b & m);
    u = (u << s) | (p.u & m);
    k = (k << s) | (p.k & m);
    w += p.w;
  }
  return new Vec(w, a, b, false, u, k);
}
export function replicate(n: number, v: Vec): Vec {
  const parts: Vec[] = [];
  for (let i = 0; i < n; i++) parts.push(v);
  return parts.length ? concat(parts) : new Vec(0, 0n, 0n);
}
/** Extract `w` bits starting at bit offset `off` (from LSB). Out-of-range bits read X. */
export function slice(v: Vec, off: number, w: number): Vec {
  if (off >= 0 && off + w <= v.w) {
    const m = mask(w), o = BigInt(off);
    return new Vec(w, (v.a >> o) & m, (v.b >> o) & m, false, (v.u >> o) & m, (v.k >> o) & m);
  }
  let a = 0n, b = 0n, u = 0n, kk = 0n;
  for (let i = w - 1; i >= 0; i--) {
    const k = off + i;
    a <<= 1n; b <<= 1n; u <<= 1n; kk <<= 1n;
    if (k < 0 || k >= v.w) { a |= 1n; b |= 1n; }
    else { const bk = BigInt(k); a |= (v.a >> bk) & 1n; b |= (v.b >> bk) & 1n; u |= (v.u >> bk) & 1n; kk |= (v.k >> bk) & 1n; }
  }
  return new Vec(w, a, b, false, u, kk);
}
/** Return v with bits [off, off+part.w) replaced by `part` (out-of-range bits are dropped). */
export function insert(v: Vec, off: number, part: Vec): Vec {
  const pm = mask(part.w);
  let pa = part.a & pm, pb = part.b & pm, pu = part.u & pm, pk = part.k & pm, pw = part.w;
  if (off < 0) { const s = BigInt(-off); pa >>= s; pb >>= s; pu >>= s; pk >>= s; pw += off; off = 0; }
  if (pw <= 0 || off >= v.w) return v;
  if (off + pw > v.w) pw = v.w - off;
  const m = mask(pw) << BigInt(off);
  const o = BigInt(off);
  const a = (v.a & ~m) | ((pa << o) & m);
  const b = (v.b & ~m) | ((pb << o) & m);
  const u = (v.u & ~m) | ((pu << o) & m);
  const k = (v.k & ~m) | ((pk << o) & m);
  return new Vec(v.w, a, b, v.signed, u, k);
}

/** Resolve several drivers of a net (wire semantics). */
export function resolve(w: number, drivers: Vec[]): Vec {
  if (drivers.length === 1) return drivers[0];
  if (drivers.some(d => d.rich)) return resolveStdLogic(w, drivers);
  const m = mask(w);
  let acc: Vec = allZ(w);
  let first = true;
  for (const d of drivers) {
    if (first) { acc = d; first = false; continue; }
    // per bit: z yields; equal stays; conflict -> x
    const az = acc.b & ~acc.a, dz = d.b & ~d.a;
    let a = 0n, b = 0n;
    // where acc is z take d
    a |= d.a & az; b |= d.b & az;
    // where d is z (and acc not) take acc
    const onlyAcc = dz & ~az;
    a |= acc.a & onlyAcc; b |= acc.b & onlyAcc;
    // both non-z
    const both = m & ~az & ~dz;
    const same = ~(acc.a ^ d.a) & ~(acc.b ^ d.b) & both;
    a |= acc.a & same; b |= acc.b & same;
    const conflict = both & ~same;
    a |= conflict; b |= conflict;
    acc = new Vec(w, a & m, b & m);
  }
  return acc;
}

// IEEE 1164 resolution table, index order U X 0 1 Z W L H
const SL = 'UX01ZWLH';
const RES = [
  'UUUUUUUU',
  'UXXXXXXX',
  'UX0X0000',
  'UXX11111',
  'UX01ZWLH',
  'UX01WWWW',
  'UX01LWLW',
  'UX01HWWH',
];
function slIndex(c: string): number { const i = SL.indexOf(c === 'x' ? 'X' : c === 'z' ? 'Z' : c); return i < 0 ? 1 : i; }

/** Bit-by-bit std_logic resolution (used when weak or 'U' values are present). */
function resolveStdLogic(w: number, drivers: Vec[]): Vec {
  let out = '';
  for (let i = w - 1; i >= 0; i--) {
    let r = 4; // 'Z'
    for (const d of drivers) r = SL.indexOf(RES[r][slIndex(d.char(i))]);
    out += SL[r];
  }
  return fromBits(out);
}

// ---------- formatting ----------
export function toBin(v: Vec): string {
  let s = '';
  if (v.rich) for (let i = v.w - 1; i >= 0; i--) s += v.char(i);
  else for (let i = v.w - 1; i >= 0; i--) s += v.bit(i);
  return s;
}

function groupDigits(v: Vec, bits: number): string {
  const n = Math.ceil(v.w / bits);
  let s = '';
  const digits = '0123456789abcdef';
  for (let i = n - 1; i >= 0; i--) {
    const off = i * bits;
    const gw = Math.min(bits, v.w - off);
    const g = slice(v, off, gw);
    const gm = mask(gw);
    if (g.b === 0n) s += digits[Number(g.a)];
    else if (g.u === gm) s += 'U';
    else if (g.b === gm && g.a === gm) s += 'x';
    else if (g.b === gm && g.a === 0n) s += 'z';
    else s += (g.a & g.b) ? 'X' : 'Z';
  }
  return s;
}
export function toHex(v: Vec): string { return groupDigits(v, 4); }
export function toOct(v: Vec): string { return groupDigits(v, 3); }
export function toDec(v: Vec, signed = v.signed): string {
  if (v.b) {
    const m = mask(v.w);
    if (v.b === m) return v.a === m ? 'x' : 'z';
    return 'X';
  }
  return (signed ? v.withSign(true).toBigInt() : v.a).toString();
}

export type Radix = 'binary' | 'hex' | 'unsigned' | 'decimal' | 'octal' | 'ascii' | 'symbolic';

export function format(v: Vec, radix: Radix, enumNames?: string[]): string {
  if (enumNames) {
    if (v.b) return 'X';
    const i = Number(v.a);
    return enumNames[i] ?? String(i);
  }
  switch (radix) {
    case 'binary': return toBin(v);
    case 'hex': return toHex(v);
    case 'octal': return toOct(v);
    case 'unsigned': return toDec(v, false);
    case 'decimal': return toDec(v, true);
    case 'ascii': return toAscii(v);
    default: return toBin(v);
  }
}

/** Number of decimal digits needed to print a w-bit unsigned value. */
export function decWidth(w: number, signed = false): number {
  if (w <= 0) return 1;
  const n = (signed ? mask(w - 1) + 1n : mask(w)).toString().length;
  return signed ? n + 1 : n;
}
