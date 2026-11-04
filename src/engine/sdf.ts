// SDF (IEEE 1497 Standard Delay Format) reader and back-annotation (#56): IOPATH delays replace module path delays
// of the instances, TIMINGCHECK values replace the limits of their specify timing checks.
import type { Kernel, TCheck } from './kernel';

type SExp = string | SExp[];

/** Tokens: parentheses, quoted strings, and atoms (numbers, triples a:b:c, names with escapes). */
function parse(text: string): SExp[] {
  const stack: SExp[][] = [[]];
  const n = text.length;
  for (let i = 0; i < n;) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { const l: SExp[] = []; stack[stack.length - 1].push(l); stack.push(l); i++; continue; }
    if (c === ')') { if (stack.length > 1) stack.pop(); i++; continue; }
    if (c === '"') { const e = text.indexOf('"', i + 1); stack[stack.length - 1].push(text.slice(i + 1, e < 0 ? n : e)); i = e < 0 ? n : e + 1; continue; }
    let j = i;
    while (j < n && !/[\s()"]/.test(text[j])) j += text[j] === '\\' ? 2 : 1;
    stack[stack.length - 1].push(text.slice(i, j));
    i = j;
  }
  return stack[0];
}

const head = (e: SExp): string => (Array.isArray(e) && typeof e[0] === 'string' ? e[0].toUpperCase() : '');
const unescape = (s: string) => s.replace(/\\(.)/g, '$1');

/** fs per unit of a TIMESCALE such as "1ns", "100 ps" or "1.0e-12" style numbers with a unit. */
function timescale(e: SExp[]): number {
  const t = e.slice(1).join('');
  const m = /^([\d.]+)?\s*(s|ms|us|ns|ps|fs)$/i.exec(t);
  if (!m) throw new Error(`SDF: bad TIMESCALE "${t}"`);
  const unit = { s: 1e15, ms: 1e12, us: 1e9, ns: 1e6, ps: 1e3, fs: 1 }[m[2].toLowerCase() as 's'];
  return Number(m[1] ?? 1) * unit;
}

export type Mtm = 0 | 1 | 2;

/** One delay value "(1.2)", "(1:2:3)" or "()" in fs, picking min / typ / max. */
function rvalue(e: SExp, mtm: Mtm, ts: number): number | null {
  if (!Array.isArray(e)) return null;
  const s = e.filter((x): x is string => typeof x === 'string').join('');
  if (!s) return null;
  const parts = s.split(':');
  const v = parts.length === 3 ? parts[mtm] : parts[0];
  return v === '' || v === undefined ? null : Math.round(Number(v) * ts);
}

/** Port of a delay or check: "A", "D[3]", "(posedge CLK)" or "(COND expr (posedge CLK))". */
function port(e: SExp): { name: string; edge?: string } {
  if (typeof e === 'string') return { name: unescape(e).replace(/\[.*$/, '') };
  const h = head(e);
  if (h === 'POSEDGE' || h === 'NEGEDGE') return { ...port(e[1]), edge: h.toLowerCase() };
  if (h === 'COND') return port(e[e.length - 1]);
  return port(e[e.length - 1]);
}

export interface SdfResult { paths: number; checks: number; warnings: string[] }

/**
 * Apply an SDF file to the design under `region` (an instance path like "/tb/dut"). Several IOPATHs to the same
 * output keep the largest delays, since each output of a cell has one path delay here.
 */
export function annotate(k: Kernel, text: string, region: string, mtm: Mtm = 1): SdfResult {
  const top = parse(text).find(x => head(x) === 'DELAYFILE');
  if (!top || !Array.isArray(top)) throw new Error('SDF: no DELAYFILE');
  let ts = 1e6, divider = '.';
  const res: SdfResult = { paths: 0, checks: 0, warnings: [] };
  const paths = new Map<string, [number, number, number]>();
  const warn = (m: string) => { if (res.warnings.length < 50) res.warnings.push(m); };
  const checksByScope = new Map<string, TCheck[]>();
  for (const c of k.tchecks) (checksByScope.get(c.scope) ?? checksByScope.set(c.scope, []).get(c.scope)!).push(c);
  for (const item of top.slice(1)) {
    const h = head(item);
    if (h === 'TIMESCALE') ts = timescale(item as SExp[]);
    else if (h === 'DIVIDER') divider = String((item as SExp[])[1] ?? '.');
    if (h !== 'CELL') continue;
    const cell = item as SExp[];
    const inst = cell.find(x => head(x) === 'INSTANCE') as SExp[] | undefined;
    const iname = inst && typeof inst[1] === 'string' ? inst[1] : '';
    if (iname === '*') { warn('SDF: wildcard INSTANCE * is not supported'); continue; }
    const parts = iname ? iname.split(new RegExp(`(?<!\\\\)\\${divider}`)).map(unescape) : [];
    const scope = [region.replace(/\/$/, ''), ...parts].join('/');
    for (const sec of cell) {
      if (head(sec) === 'DELAY') {
        for (const kind of (sec as SExp[]).slice(1)) {
          const kh = head(kind);
          if (kh === 'INCREMENT') { warn(`SDF: INCREMENT delays are not supported (${scope})`); continue; }
          if (kh !== 'ABSOLUTE') continue;
          for (const d of (kind as SExp[]).slice(1)) {
            const dh = head(d);
            if (dh === 'INTERCONNECT' || dh === 'PORT' || dh === 'NETDELAY') { warn(`SDF: ${dh} delays are not supported; put them into the IOPATH of the driver (${scope})`); continue; }
            // (COND expr (IOPATH ...)) applies like the plain IOPATH
            const io = dh === 'COND' ? (d as SExp[]).find(x => head(x) === 'IOPATH') : dh === 'IOPATH' ? d : undefined;
            if (!io) continue;
            const a = io as SExp[];
            const out = port(a[2]).name;
            const vals = a.slice(3).map(v => rvalue(v, mtm, ts));
            const known = vals.filter((v): v is number => v !== null);
            if (!known.length) continue;
            const r = vals[0] ?? known[0], f = vals[1] ?? r, z = vals[2] ?? Math.min(r, f);
            const key = `${scope}/${out}`;
            if (!k.paths.has(key)) { warn(`SDF: no specify path to ${key}`); continue; }
            const cur = paths.get(key);
            paths.set(key, cur ? [Math.max(cur[0], r), Math.max(cur[1], f), Math.max(cur[2], z)] : [r, f, z]);
          }
        }
      } else if (head(sec) === 'TIMINGCHECK') {
        for (const t of (sec as SExp[]).slice(1)) {
          const th = head(t), a = t as SExp[];
          const checks = checksByScope.get(scope) ?? [];
          // SETUP/HOLD/SETUPHOLD: data first, reference second; RECOVERY/REMOVAL/RECREM: control first, clock second
          const set = (kinds: string[], idx: number, refPort: SExp, dataPort: SExp | undefined, v: number | null) => {
            if (v === null) return;
            const ref = port(refPort).name, data = dataPort ? port(dataPort).name : undefined;
            const hit = checks.filter(c => kinds.includes(c.kind) && c.ref === ref && (data === undefined || c.data === data));
            if (!hit.length) { warn(`SDF: no ${th} check of ${scope} for ${ref}${data ? '/' + data : ''}`); return; }
            for (const c of hit) {
              const i = c.kind === '$setuphold' || c.kind === '$recrem' ? idx : 0;
              c.limits[i] = Math.max(0, v);
            }
            res.checks++;
          };
          if (th === 'SETUP') set(['$setup', '$setuphold'], 0, a[2], a[1], rvalue(a[3], mtm, ts));
          else if (th === 'HOLD') set(['$hold', '$setuphold'], 1, a[2], a[1], rvalue(a[3], mtm, ts));
          else if (th === 'SETUPHOLD') { set(['$setup', '$setuphold'], 0, a[2], a[1], rvalue(a[3], mtm, ts)); set(['$hold', '$setuphold'], 1, a[2], a[1], rvalue(a[4], mtm, ts)); }
          else if (th === 'RECOVERY') set(['$recovery', '$recrem'], 0, a[1], a[2], rvalue(a[3], mtm, ts));
          else if (th === 'REMOVAL') set(['$removal', '$recrem'], 1, a[1], a[2], rvalue(a[3], mtm, ts));
          else if (th === 'RECREM') { set(['$recovery', '$recrem'], 0, a[1], a[2], rvalue(a[3], mtm, ts)); set(['$removal', '$recrem'], 1, a[1], a[2], rvalue(a[4], mtm, ts)); }
          else if (th === 'WIDTH') set(['$width'], 0, a[1], undefined, rvalue(a[2], mtm, ts));
          else if (th === 'PERIOD') set(['$period'], 0, a[1], undefined, rvalue(a[2], mtm, ts));
          else if (th) warn(`SDF: ${th} checks are not supported`);
        }
      }
    }
  }
  for (const [key, v] of paths) k.pathDelay.set(key, v);
  res.paths = paths.size;
  return res;
}
