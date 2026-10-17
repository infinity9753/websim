// Verilog preprocessor + lexer.
import { CompileError, type Loc } from '../ast';
import { Vec, mask } from '../logic';

export type TokType = 'id' | 'sys' | 'num' | 'real' | 'str' | 'op' | 'dir' | 'eof';
export interface Token { t: TokType; v: string; loc: Loc; num?: { v: Vec; unsized: boolean }; real?: number }

export interface PPOptions {
  defines?: Map<string, Macro>;
  include?: (name: string) => string | undefined;
}
export interface Macro { args?: string[]; body: string }

const KEYWORDS = new Set(`module endmodule macromodule input output inout wire reg integer real realtime time logic bit byte int shortint longint
parameter localparam assign always always_ff always_comb always_latch initial begin end if else case casez casex endcase default
for while repeat forever function endfunction task endtask posedge negedge or and nand nor xor xnor not buf signed unsigned
generate endgenerate genvar tri tri0 tri1 wand wor supply0 supply1 wait disable automatic typedef enum return specify endspecify
defparam force release fork join join_any join_none string void struct packed event deassign package endpackage import foreach do inside`.split(/\s+/));

export function isKeyword(s: string) { return KEYWORDS.has(s); }

const OPS = [
  '<<<=', '>>>=', '===', '!==', '<<<', '>>>', '<<=', '>>=', '->',
  '==', '!=', '<=', '>=', '&&', '||', '**', '<<', '>>', '~&', '~|', '~^', '^~', '+:', '-:', '::',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '++', '--', '.*', "'{",
  '+', '-', '*', '/', '%', '<', '>', '!', '~', '&', '|', '^', '?', ':', ';', ',', '.', '(', ')', '[', ']', '{', '}', '#', '@', '=', "'",
];

/** Text-level preprocessor. Keeps line structure; emits `\u0001line N file` markers for includes. */
export function preprocess(src: string, file: string, opts: PPOptions = {}, depth = 0): string {
  const defines = opts.defines ?? new Map<string, Macro>();
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  // stack of [active, taken]
  const cond: { active: boolean; taken: boolean; parent: boolean }[] = [];
  const active = () => cond.length === 0 || cond[cond.length - 1].active;
  let inBlockComment = false;

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    // strip comments while respecting strings, so directives can be found reliably
    let res = '';
    let i = 0;
    while (i < line.length) {
      if (inBlockComment) {
        const e = line.indexOf('*/', i);
        if (e < 0) { i = line.length; break; }
        i = e + 2; inBlockComment = false; res += ' ';
        continue;
      }
      const c = line[i];
      if (c === '"') {
        let j = i + 1;
        while (j < line.length && line[j] !== '"') { if (line[j] === '\\') j++; j++; }
        res += line.slice(i, j + 1); i = j + 1; continue;
      }
      if (c === '/' && line[i + 1] === '/') break;
      if (c === '/' && line[i + 1] === '*') { inBlockComment = true; i += 2; continue; }
      res += c; i++;
    }
    line = res;
    const m = /^\s*`(\w+)\s*(.*)$/.exec(line);
    if (m) {
      const d = m[1], rest = m[2];
      if (d === 'ifdef' || d === 'ifndef') {
        const name = rest.trim().split(/\s+/)[0];
        const def = defines.has(name);
        const t = d === 'ifdef' ? def : !def;
        const parent = active();
        cond.push({ active: parent && t, taken: t, parent });
        out.push(''); continue;
      }
      if (d === 'elsif') {
        const top = cond[cond.length - 1];
        if (!top) throw new CompileError('`elsif without `ifdef', { file, line: li + 1 });
        const name = rest.trim().split(/\s+/)[0];
        const t = !top.taken && defines.has(name);
        top.active = top.parent && t; if (t) top.taken = true;
        out.push(''); continue;
      }
      if (d === 'else') {
        const top = cond[cond.length - 1];
        if (!top) throw new CompileError('`else without `ifdef', { file, line: li + 1 });
        top.active = top.parent && !top.taken; top.taken = true;
        out.push(''); continue;
      }
      if (d === 'endif') { cond.pop(); out.push(''); continue; }
      if (!active()) { out.push(''); continue; }
      if (d === 'define') {
        // multi-line continuation
        let body = rest;
        while (body.endsWith('\\') && li + 1 < lines.length) { body = body.slice(0, -1) + '\n'; li++; body += lines[li]; out.push(''); }
        const dm = /^(\w+)(\(([^)]*)\))?\s*(.*)$/s.exec(body);
        if (dm) defines.set(dm[1], { args: dm[2] ? dm[3].split(',').map(s => s.trim()).filter(Boolean) : undefined, body: dm[4].replace(/\n/g, ' ') });
        out.push(''); continue;
      }
      if (d === 'undef') { defines.delete(rest.trim()); out.push(''); continue; }
      if (d === 'include') {
        const nm = /"([^"]+)"/.exec(rest)?.[1] ?? rest.trim();
        const inc = opts.include?.(nm);
        if (inc === undefined) throw new CompileError(`Cannot open \`include file "${nm}"`, { file, line: li + 1 });
        if (depth > 20) throw new CompileError('`include nesting too deep', { file, line: li + 1 });
        out.push(`\u0001line 1 ${nm}`);
        out.push(preprocess(inc, nm, { ...opts, defines }, depth + 1));
        out.push(`\u0001line ${li + 2} ${file}`);
        continue;
      }
      if (d === 'timescale') { out.push(`\u0001timescale ${rest.trim()}`); continue; }
      if (['resetall', 'celldefine', 'endcelldefine', 'default_nettype', 'nounconnected_drive', 'unconnected_drive', 'pragma', 'line'].includes(d)) { out.push(''); continue; }
      // otherwise: a macro usage at start of line — fall through to expansion
    }
    if (!active()) { out.push(''); continue; }
    out.push(expandMacros(line, defines, file, li + 1));
  }
  return out.join('\n');
}

function expandMacros(line: string, defines: Map<string, Macro>, file: string, lineNo: number, depth = 0): string {
  if (!line.includes('`')) return line;
  if (depth > 50) throw new CompileError('macro expansion too deep', { file, line: lineNo });
  let out = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') { if (line[j] === '\\') j++; j++; }
      out += line.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '`') {
      const m = /^`(\w+)/.exec(line.slice(i));
      if (!m) { out += c; i++; continue; }
      const name = m[1];
      const mac = defines.get(name);
      if (!mac) {
        if (['__FILE__'].includes(name)) { out += `"${file}"`; i += m[0].length; continue; }
        if (['__LINE__'].includes(name)) { out += String(lineNo); i += m[0].length; continue; }
        throw new CompileError(`Undefined macro \`${name}`, { file, line: lineNo });
      }
      i += m[0].length;
      let body = mac.body;
      if (mac.args) {
        // parse actual args
        while (line[i] === ' ') i++;
        if (line[i] !== '(') throw new CompileError(`Macro \`${name} requires arguments`, { file, line: lineNo });
        let lvl = 0; let cur = ''; const actuals: string[] = [];
        i++;
        for (; i < line.length; i++) {
          const ch = line[i];
          if (ch === '(' || ch === '{' || ch === '[') lvl++;
          if (ch === ')' || ch === '}' || ch === ']') { if (lvl === 0) { i++; break; } lvl--; }
          if (ch === ',' && lvl === 0) { actuals.push(cur); cur = ''; continue; }
          cur += ch;
        }
        actuals.push(cur);
        mac.args.forEach((a, idx) => {
          body = body.replace(new RegExp(`\\b${a}\\b`, 'g'), (actuals[idx] ?? '').trim());
        });
      }
      out += expandMacros(body, defines, file, lineNo, depth + 1);
      continue;
    }
    out += c; i++;
  }
  return out;
}

const UNIT_PS: Record<string, number> = { s: 1e12, ms: 1e9, us: 1e6, ns: 1e3, ps: 1, fs: 1e-3 };
export function parseTimescale(s: string, loc: Loc): { unit: number; prec: number } {
  const m = /^(\d+)\s*(s|ms|us|ns|ps|fs)\s*\/\s*(\d+)\s*(s|ms|us|ns|ps|fs)/.exec(s);
  if (!m) throw new CompileError(`Bad \`timescale "${s}"`, loc);
  return { unit: Number(m[1]) * UNIT_PS[m[2]], prec: Number(m[3]) * UNIT_PS[m[4]] };
}

export function parseVerilogNumber(size: string | null, signed: boolean, base: string, digits: string, loc: Loc): Vec {
  digits = digits.replace(/_/g, '').toLowerCase();
  const bits = { b: 1, o: 3, h: 4, d: 0 }[base]!;
  let a = 0n, b = 0n, w: number;
  if (bits === 0) {
    if (/^[xz?]$/.test(digits)) {
      w = size ? Number(size) : 32;
      const m = mask(w);
      return new Vec(w, digits === 'x' ? m : 0n, m, signed);
    }
    if (!/^\d+$/.test(digits)) throw new CompileError(`Illegal decimal digits '${digits}'`, loc);
    a = BigInt(digits);
    w = size ? Number(size) : 32;
  } else {
    const radix = 1 << bits;
    for (const ch of digits) {
      a <<= BigInt(bits); b <<= BigInt(bits);
      const dm = BigInt(radix - 1);
      if (ch === 'x') { a |= dm; b |= dm; }
      else if (ch === 'z' || ch === '?') { b |= dm; }
      else {
        const d = parseInt(ch, 16);
        if (isNaN(d) || d >= radix) throw new CompileError(`Illegal digit '${ch}' in based number`, loc);
        a |= BigInt(d);
      }
    }
    const natural = digits.length * bits;
    w = size ? Number(size) : Math.max(32, natural);
    if (w > natural && natural > 0) {
      // extend with x/z if MSB digit is x/z
      const top = BigInt(natural - 1);
      if ((b >> top) & 1n) {
        const ext = mask(w) ^ mask(natural);
        b |= ext; if ((a >> top) & 1n) a |= ext;
      }
    }
  }
  if (w <= 0 || w > 1 << 20) throw new CompileError(`Bad number size ${w}`, loc);
  const m = mask(w);
  return new Vec(w, a & m, b & m, signed);
}

export function lexVerilog(text: string, file: string): Token[] {
  const toks: Token[] = [];
  let i = 0, line = 1;
  let curFile = file;
  const n = text.length;
  const loc = (): Loc => ({ file: curFile, line });
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '\u0001') {
      const e = text.indexOf('\n', i);
      const dirLine = text.slice(i + 1, e < 0 ? n : e);
      const lm = /^line (\d+) (.*)$/.exec(dirLine);
      if (lm) { line = Number(lm[1]) - 1; curFile = lm[2]; }
      else if (dirLine.startsWith('timescale ')) toks.push({ t: 'dir', v: dirLine, loc: loc() });
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\') {
          const e = text[j + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === '\\' ? '\\' : e === '"' ? '"' : e;
          j += 2; continue;
        }
        if (text[j] === '\n') line++;
        s += text[j++];
      }
      toks.push({ t: 'str', v: s, loc: loc() });
      i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
      toks.push({ t: 'id', v: text.slice(i, j), loc: loc() });
      i = j; continue;
    }
    if (c === '\\') {
      let j = i + 1;
      while (j < n && !/\s/.test(text[j])) j++;
      toks.push({ t: 'id', v: text.slice(i + 1, j), loc: loc() });
      i = j; continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
      toks.push({ t: 'sys', v: text.slice(i, j), loc: loc() });
      i = j; continue;
    }
    // numbers
    const rest = text.slice(i, i + 200);
    let m: RegExpExecArray | null;
    if (/[0-9']/.test(c)) {
      // sized/based: [size] ' [s] base digits
      m = /^(?:(\d[\d_]*)\s*)?'([sS]?)([bBoOdDhH])\s*([0-9a-fA-FxXzZ?_]+)/.exec(rest);
      if (m) {
        const l = loc();
        const v = parseVerilogNumber(m[1] ? m[1].replace(/_/g, '') : null, !!m[2], m[3].toLowerCase(), m[4], l);
        toks.push({ t: 'num', v: m[0], loc: l, num: { v, unsized: !m[1] } });
        i += m[0].length; continue;
      }
      if (c === "'" && /^'[01xXzZ](?![0-9a-zA-Z_])/.test(rest)) {
        toks.push({ t: 'op', v: "'fill", loc: loc(), real: 0, num: undefined });
        toks[toks.length - 1].v = "'" + rest[1].toLowerCase();
        toks[toks.length - 1].t = 'num';
        toks[toks.length - 1].num = undefined;
        i += 2; continue;
      }
      m = /^\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?/.exec(rest);
      if (m && c !== "'") {
        const s = m[0].replace(/_/g, '');
        if (m[1] || m[2]) {
          toks.push({ t: 'real', v: s, loc: loc(), real: parseFloat(s) });
        } else {
          const v = BigInt(s);
          toks.push({ t: 'num', v: s, loc: loc(), num: { v: new Vec(32, v & mask(32), 0n, true), unsized: true } });
        }
        i += m[0].length; continue;
      }
    }
    let op: string | undefined;
    for (const o of OPS) { if (text.startsWith(o, i)) { op = o; break; } }
    if (!op) throw new CompileError(`Unexpected character '${c}'`, loc());
    toks.push({ t: 'op', v: op, loc: loc() });
    i += op.length;
  }
  toks.push({ t: 'eof', v: '<EOF>', loc: { file: curFile, line } });
  return toks;
}
