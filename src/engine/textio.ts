// VHDL std.textio / ieee.std_logic_textio support (line buffers, text files, read/write procedures).
import type { Expr, Loc } from './ast';
import { CompileError } from './ast';
import * as L from './logic';
import { fmtTime } from './format';
import type { Signal } from './kernel';
import type { Elaborator, RType } from './elab';

export type TextState =
  | { kind: 'line'; buf: string }
  | { kind: 'file'; name: string; mode: 'read' | 'write' | 'append' | 'closed'; lines: string[] | null; pos: number; out: string; special?: 'output' | 'input' };

type Ctx = Parameters<Elaborator['ex']>[1];
interface SC { sync?: () => void }

const PROCS = new Set(['write', 'writeline', 'read', 'readline', 'hwrite', 'hread', 'owrite', 'oread', 'bwrite', 'bread', 'swrite', 'sread', 'deallocate', 'file_close', 'file_open', 'flush', 'tee']);
export function isTextioProc(name: string) { return PROCS.has(name); }

function err(msg: string, loc?: Loc): never { throw new CompileError(msg, loc); }

function bitChar(b: string) { return b === 'x' ? 'X' : b === 'z' ? 'Z' : b; }
function vecStr(v: L.Vec) { let s = ''; for (let i = v.w - 1; i >= 0; i--) s += bitChar(v.bit(i)); return s; }

/** Resolve a line/file variable argument to its state object. */
function stateOf(el: Elaborator, e: Expr, c: Ctx, want: 'line' | 'file', loc?: Loc): () => TextState {
  if (e.k === 'id' && want === 'file' && (e.name.toLowerCase() === 'output' || e.name.toLowerCase() === 'input')) {
    const st: TextState = { kind: 'file', name: e.name, mode: e.name.toLowerCase() === 'output' ? 'write' : 'read', lines: [], pos: 0, out: '', special: e.name.toLowerCase() as 'output' | 'input' };
    return () => st;
  }
  if (e.k !== 'id') err(`Expected a ${want} variable`, loc);
  const sym = el.lookupName(c.scope, e.name);
  if (sym?.k !== 'sig' || !el.textState.has(sym.sig)) err(`'${e.name}' is not a ${want === 'line' ? 'LINE variable' : 'file'}`, loc);
  const sig: Signal = sym.sig;
  return () => el.textState.get(sig)!;
}

/** Format a value for write() according to its static type. */
function formatter(el: Elaborator, e: Expr, c: Ctx, base: 'auto' | 'hex' | 'oct' | 'bin'): () => string {
  // unwrap qualified expressions string'("..."), integer'(x)
  if (e.k === 'call' && ['string', 'character', 'integer', 'std_logic_vector', 'bit_vector'].includes(e.name.toLowerCase()) && e.args.length === 1 && e.args[0].k === 'str') e = e.args[0];
  if (e.k === 'str') { const s = e.s; return () => s; }
  const t: RType | undefined = el.typeOf(e, c);
  const n = el.ex(e, { ...c, strMode: true });
  const f = n.mk(n.w, n.s);
  const k = el.k;
  if (base !== 'auto') {
    return () => {
      const v = f();
      if (base === 'hex') return L.toHex(v.w % 4 ? L.resize(v, Math.ceil(v.w / 4) * 4, false) : v).toUpperCase();
      if (base === 'oct') return L.toOct(v).toUpperCase();
      return vecStr(v);
    };
  }
  if (n.str !== undefined || t?.kind === 'string') return () => L.toAscii(f());
  if (t?.isTime || n.isTime) return () => { const v = f(); return v.known ? fmtTime(Number(v.toBigInt()), k.resolution) : 'X'; };
  if (t?.isBool) return () => (L.isTrue(f()) ? 'TRUE' : 'FALSE');
  const names = t?.enumNames ?? n.enumNames;
  if (names && t?.kind === 'enum') return () => { const v = f(); return v.known ? names[Number(v.a)] ?? '?' : 'X'; };
  if (t?.isInt || (!t && n.s && n.w === 32)) return () => L.toDec(f().withSign(true), true);
  if (t && t.scalar && t.w === 8) return () => String.fromCharCode(Number(f().a & 0xffn));
  return () => vecStr(f());
}

function justify(s: string, side: string | undefined, width: number) {
  if (width <= s.length) return s;
  return side === 'left' ? s + ' '.repeat(width - s.length) : ' '.repeat(width - s.length) + s;
}

/** Compile a textio procedure call; returns null if `name` is not one. */
export function compileTextio(el: Elaborator, name: string, args: Expr[], c: Ctx, loc?: Loc): SC | null {
  if (!PROCS.has(name)) return null;
  const k = el.k;
  const host = k.host;
  const flushFile = (st: Extract<TextState, { kind: 'file' }>) => { if (!st.special) host.writeFile?.(st.name, st.out); };
  switch (name) {
    case 'write': case 'swrite': case 'hwrite': case 'owrite': case 'bwrite': {
      if (args.length < 2) err(`${name}: expected (line, value)`, loc);
      const line = stateOf(el, args[0], c, 'line', loc);
      const fmt = formatter(el, args[1], c, name === 'hwrite' ? 'hex' : name === 'owrite' ? 'oct' : name === 'bwrite' ? 'bin' : 'auto');
      const side = args[2]?.k === 'id' ? args[2].name.toLowerCase() : undefined;
      const width = args[3] ? el.constInt(args[3], c.scope) : 0;
      return { sync: () => { const st = line() as Extract<TextState, { kind: 'line' }>; st.buf += justify(fmt(), side, width); } };
    }
    case 'writeline': {
      if (args.length !== 2) err('writeline: expected (file, line)', loc);
      const file = stateOf(el, args[0], c, 'file', loc);
      const line = stateOf(el, args[1], c, 'line', loc);
      return {
        sync: () => {
          const f = file() as Extract<TextState, { kind: 'file' }>, l = line() as Extract<TextState, { kind: 'line' }>;
          if (f.special === 'output') host.print(l.buf);
          else {
            if (f.mode !== 'write' && f.mode !== 'append') throw new CompileError(`writeline: file '${f.name}' is not open for writing`, loc);
            f.out += l.buf + '\n';
            flushFile(f);
          }
          l.buf = '';
        },
      };
    }
    case 'readline': {
      if (args.length !== 2) err('readline: expected (file, line)', loc);
      const file = stateOf(el, args[0], c, 'file', loc);
      const line = stateOf(el, args[1], c, 'line', loc);
      return {
        sync: () => {
          const f = file() as Extract<TextState, { kind: 'file' }>, l = line() as Extract<TextState, { kind: 'line' }>;
          loadFile(f);
          if (!f.lines || f.pos >= f.lines.length) throw new CompileError(`readline: end of file '${f.name}'`, loc);
          l.buf = f.lines[f.pos++];
        },
      };
    }
    case 'read': case 'sread': case 'hread': case 'oread': case 'bread': {
      if (args.length < 2) err(`${name}: expected (line, target [, good])`, loc);
      const line = stateOf(el, args[0], c, 'line', loc);
      const target = args[1];
      const t = el.typeOf(target, c);
      const lv = el.lv(target, { ...c, driverMode: false });
      const good = args[2] ? el.lv(args[2], { ...c, driverMode: false }) : null;
      const w = lv.w;
      const radix = name === 'hread' ? 16 : name === 'oread' ? 8 : name === 'bread' ? 2 : 0;
      return {
        sync: () => {
          const l = line() as Extract<TextState, { kind: 'line' }>;
          const r = parseFrom(l.buf, t, w, radix);
          if (r) { l.buf = r.rest; el.write(lv.tg(), L.resize(r.v, w)); }
          if (good) el.write(good.tg(), r ? L.ONE : L.ZERO);
          else if (!r) throw new CompileError(`${name}: could not read a value from "${l.buf}"`, loc);
        },
      };
    }
    case 'deallocate': {
      const line = stateOf(el, args[0], c, 'line', loc);
      return { sync: () => { (line() as Extract<TextState, { kind: 'line' }>).buf = ''; } };
    }
    case 'file_close': case 'flush': {
      const file = stateOf(el, args[0], c, 'file', loc);
      return { sync: () => { const f = file() as Extract<TextState, { kind: 'file' }>; flushFile(f); if (name === 'file_close') f.mode = 'closed'; } };
    }
    case 'file_open': {
      // file_open(f, "name", mode) or file_open(status, f, "name", mode)
      const off = args.length === 4 ? 1 : 0;
      const file = stateOf(el, args[off], c, 'file', loc);
      const nameN = el.ex(args[off + 1], { ...c, strMode: true });
      const nf = nameN.mk(nameN.w, nameN.s);
      const mode = args[off + 2]?.k === 'id' ? (args[off + 2] as { name: string }).name.toLowerCase() : 'read_mode';
      return {
        sync: () => {
          const f = file() as Extract<TextState, { kind: 'file' }>;
          f.name = nameN.str ?? L.toAscii(nf());
          f.mode = mode.startsWith('write') ? 'write' : mode.startsWith('append') ? 'append' : 'read';
          f.lines = null; f.pos = 0; f.out = '';
          if (f.mode === 'append') f.out = host.readFile?.(f.name) ?? '';
        },
      };
    }
    case 'tee': return { sync: () => {} };
  }
  return null;

  function loadFile(f: Extract<TextState, { kind: 'file' }>) {
    if (f.lines) return;
    const text = host.readFile?.(f.name);
    if (text === undefined) throw new CompileError(`(vsim-7) Failed to open VHDL file "${f.name}" in rb mode.`, loc);
    f.lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (f.lines.length && f.lines[f.lines.length - 1] === '') f.lines.pop();
  }
}

/** endfile(f) */
export function endfileFn(el: Elaborator, e: Expr, c: Ctx, loc?: Loc): () => boolean {
  const file = stateOf(el, e, c, 'file', loc);
  return () => {
    const f = file() as Extract<TextState, { kind: 'file' }>;
    if (f.special) return true;
    if (!f.lines) {
      const text = el.k.host.readFile?.(f.name);
      if (text === undefined) return true;
      f.lines = text.replace(/\r\n?/g, '\n').split('\n');
      if (f.lines.length && f.lines[f.lines.length - 1] === '') f.lines.pop();
    }
    return f.pos >= f.lines.length;
  };
}

function parseFrom(buf: string, t: RType | undefined, w: number, radix: number): { v: L.Vec; rest: string } | null {
  let s = buf.replace(/^\s+/, '');
  if (radix) {
    const per = radix === 16 ? 4 : radix === 8 ? 3 : 1;
    const n = Math.ceil(w / per);
    const m = new RegExp(`^[0-9a-fA-FxXzZuU_]{${n}}`).exec(s.replace(/_/g, ''));
    if (!m) return null;
    let bits = '';
    for (const ch of m[0]) bits += /[xXuU]/.test(ch) ? 'x'.repeat(per) : /[zZ]/.test(ch) ? 'z'.repeat(per) : parseInt(ch, 16).toString(2).padStart(per, '0');
    return { v: L.resize(L.fromBits(bits.slice(-w).padStart(w, '0')), w), rest: s.slice(m[0].length) };
  }
  if (t?.isInt || t?.isTime) {
    const m = /^-?\d+/.exec(s);
    if (!m) return null;
    return { v: L.fromInt(BigInt(m[0]), w, true), rest: s.slice(m[0].length) };
  }
  if (t?.isBool) {
    const m = /^(true|false)/i.exec(s);
    if (!m) return null;
    return { v: L.bool(m[1].toLowerCase() === 'true'), rest: s.slice(m[0].length) };
  }
  if (t?.kind === 'enum' && t.enumNames) {
    const m = /^[A-Za-z_]\w*/.exec(s);
    const i = m ? t.enumNames.findIndex(n => n.toLowerCase() === m[0].toLowerCase()) : -1;
    if (i < 0) return null;
    return { v: L.fromInt(i, w), rest: s.slice(m![0].length) };
  }
  if (t?.scalar && w === 8) { if (!buf.length) return null; return { v: L.fromInt(buf.charCodeAt(0), 8), rest: buf.slice(1) }; }
  // std_logic / vector: w characters of 01UXZWLH-
  const m = new RegExp(`^[01uxzwlhUXZWLH-]{${w}}`).exec(s);
  if (!m) return null;
  return { v: L.fromBits(m[0]), rest: s.slice(w) };
}
