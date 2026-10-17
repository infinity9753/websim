// VHDL lexer. Identifiers are case-insensitive and returned in lowercase.
import { CompileError, type Loc } from '../ast';

export type VTokType = 'id' | 'int' | 'real' | 'char' | 'str' | 'bits' | 'op' | 'eof';
export interface VToken { t: VTokType; v: string; loc: Loc; n?: number; based?: bigint }

const OPS = ['?/=', '?<=', '?>=', '**', ':=', '<=', '>=', '=>', '/=', '<>', '??', '?=', '?<', '?>', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/', ':', ';', '<', '=', '>', '|', '[', ']', '@'];

export function lexVhdl(text: string, file: string): VToken[] {
  const toks: VToken[] = [];
  let i = 0, line = 1;
  const n = text.length;
  const loc = (): Loc => ({ file, line });
  const prevAllowsTick = () => {
    const p = toks[toks.length - 1];
    if (!p) return false;
    return p.t === 'id' || p.t === 'str' || (p.t === 'op' && (p.v === ')' || p.v === ']'));
  };
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === ' ') { i++; continue; }
    if (c === '-' && text[i + 1] === '-') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    // bit string literal: [size]B"..." X"..." O"..." D"..."  (also UB/SB/UX/SX in 2008)
    let m = /^(\d*)([uUsS]?[bBoOxXdD])"([^"]*)"/.exec(text.slice(i, i + 4096));
    if (m && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
      toks.push({ t: 'bits', v: m[2].toLowerCase().slice(-1) + ':' + m[3] + ':' + m[1], loc: loc() });
      i += m[0].length; continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
      toks.push({ t: 'id', v: text.slice(i, j).toLowerCase(), loc: loc() });
      i = j; continue;
    }
    if (c === '\\') {
      const j = text.indexOf('\\', i + 1);
      if (j < 0) throw new CompileError('Unterminated extended identifier', loc());
      toks.push({ t: 'id', v: text.slice(i + 1, j), loc: loc() });
      i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1, s = '';
      for (;;) {
        if (j >= n || text[j] === '\n') throw new CompileError('Unterminated string literal', loc());
        if (text[j] === '"') { if (text[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
        s += text[j++];
      }
      toks.push({ t: 'str', v: s, loc: loc() });
      i = j + 1; continue;
    }
    if (c === "'" && !prevAllowsTick() && text[i + 2] === "'") {
      toks.push({ t: 'char', v: text[i + 1], loc: loc() });
      i += 3; continue;
    }
    if (/[0-9]/.test(c)) {
      const rest = text.slice(i, i + 256);
      m = /^(\d[\d_]*)#([0-9a-fA-F_]+)#([eE][+]?\d+)?/.exec(rest);
      if (m) {
        const base = parseInt(m[1].replace(/_/g, ''), 10);
        let v = 0n;
        for (const ch of m[2].replace(/_/g, '')) v = v * BigInt(base) + BigInt(parseInt(ch, 16));
        if (m[3]) v *= BigInt(base) ** BigInt(parseInt(m[3].slice(1), 10));
        toks.push({ t: 'int', v: m[0], loc: loc(), based: v, n: Number(v) });
        i += m[0].length; continue;
      }
      m = /^\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?/.exec(rest)!;
      const s = m[0].replace(/_/g, '');
      if (m[1]) toks.push({ t: 'real', v: s, loc: loc(), n: parseFloat(s) });
      else {
        const e = m[2] ? parseInt(m[2].slice(1), 10) : 0;
        const base = BigInt(s.replace(/[eE].*$/, ''));
        const val = e >= 0 ? base * 10n ** BigInt(e) : base;
        toks.push({ t: 'int', v: s, loc: loc(), based: val, n: Number(val) });
      }
      i += m[0].length; continue;
    }
    let op: string | undefined;
    for (const o of OPS) if (text.startsWith(o, i)) { op = o; break; }
    if (!op) throw new CompileError(`Unexpected character '${c}'`, loc());
    toks.push({ t: 'op', v: op, loc: loc() });
    i += op.length;
  }
  toks.push({ t: 'eof', v: '<EOF>', loc: { file, line } });
  return toks;
}
