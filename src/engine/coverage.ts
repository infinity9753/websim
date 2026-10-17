// Code coverage: aggregation of statement / branch counters and toggle coverage from signal history.
import type { Coverage } from './elab';
import type { Signal } from './kernel';

export interface FileCoverage {
  /** line -> executions summed over all copies (instances, task call sites) */
  lines: Map<number, number>;
  /** line -> branch arms (summed by arm index) */
  branches: Map<number, { kind: 'if' | 'case'; arms: { label: string; n: number }[] }>;
}

export function aggregate(cov: Coverage): Map<string, FileCoverage> {
  const out = new Map<string, FileCoverage>();
  const get = (f: string) => { let c = out.get(f); if (!c) { c = { lines: new Map(), branches: new Map() }; out.set(f, c); } return c; };
  for (const s of cov.stmts) { const c = get(s.file); c.lines.set(s.line, (c.lines.get(s.line) ?? 0) + s.n); }
  for (const b of cov.branches) {
    const c = get(b.file);
    const cur = c.branches.get(b.line);
    if (!cur || cur.arms.length !== b.arms.length) { if (!cur) c.branches.set(b.line, { kind: b.kind, arms: b.arms.map(a => ({ ...a })) }); continue; }
    b.arms.forEach((a, i) => { cur.arms[i].n += a.n; });
  }
  return out;
}

function popcount(x: bigint): number { let n = 0; while (x) { x &= x - 1n; n++; } return n; }

export interface ToggleInfo { sig: Signal; bits: number; rise: bigint; fall: bigint; covered: number }

/** Bits that went 0->1 and 1->0 in the recorded history (x/z transitions do not count). */
export function toggles(sigs: Signal[]): ToggleInfo[] {
  const out: ToggleInfo[] = [];
  for (const s of sigs) {
    if (s.isReal || s.isVar) continue;
    let rise = 0n, fall = 0n;
    for (let i = 1; i < s.times.length; i++) {
      const p = s.valAt(i - 1), n = s.valAt(i);
      const known = ~p.b & ~n.b;
      rise |= ~p.a & n.a & known;
      fall |= p.a & ~n.a & known;
    }
    const m = (1n << BigInt(s.w)) - 1n;
    rise &= m; fall &= m;
    out.push({ sig: s, bits: s.w, rise, fall, covered: popcount(rise & fall) });
  }
  return out;
}

const pct = (hit: number, all: number) => (all ? ((100 * hit) / all).toFixed(2) + '%' : '-');
const row = (name: string, bins: number, hits: number) =>
  `    ${name.padEnd(22)}${String(bins).padStart(8)}${String(hits).padStart(10)}${String(bins - hits).padStart(10)}${pct(hits, bins).padStart(11)}`;

/** Text report like "coverage report [-details]". */
export function coverageReport(cov: Coverage, sigs: Signal[], details: boolean): string {
  const lines: string[] = ['Coverage Report Summary Data by file', ''];
  const head = ['    Enabled Coverage            Bins      Hits    Misses   Coverage', '    ----------------            ----      ----    ------   --------'];
  let ts = 0, th = 0, tb = 0, tbh = 0;
  for (const [file, fc] of [...aggregate(cov)].sort((a, b) => a[0].localeCompare(b[0]))) {
    const stmtHits = [...fc.lines.values()].filter(n => n > 0).length;
    const arms = [...fc.branches.values()].flatMap(b => b.arms);
    const armHits = arms.filter(a => a.n > 0).length;
    ts += fc.lines.size; th += stmtHits; tb += arms.length; tbh += armHits;
    lines.push(`=== File: ${file}`, ...head, row('Statements', fc.lines.size, stmtHits), row('Branches', arms.length, armHits));
    if (details) {
      const missed = [...fc.lines].filter(([, n]) => n === 0).map(([l]) => l).sort((a, b) => a - b);
      if (missed.length) lines.push(`    Statements not executed: line${missed.length > 1 ? 's' : ''} ${missed.join(', ')}`);
      for (const [l, b] of [...fc.branches].sort((a, b) => a[0] - b[0])) {
        const miss = b.arms.filter(a => a.n === 0);
        if (miss.length) lines.push(`    Branch (${b.kind}) at line ${l} never took: ${miss.map(a => a.label).join(', ')}`);
      }
    }
    lines.push('');
  }
  const tg = toggles(sigs);
  const bits = tg.reduce((s, x) => s + x.bits, 0), cov2 = tg.reduce((s, x) => s + x.covered, 0);
  lines.push('=== Toggle coverage (each bit rising and falling)', ...head, row('Toggle bits', bits, cov2));
  if (details) {
    for (const x of tg) {
      if (x.covered === x.bits) continue;
      const missing: string[] = [];
      for (let i = 0; i < x.bits && missing.length < 8; i++) {
        const b = 1n << BigInt(i);
        const r = (x.rise & b) !== 0n, f = (x.fall & b) !== 0n;
        if (!(r && f)) missing.push(`${x.bits > 1 ? `[${x.sig.lsb <= x.sig.msb ? x.sig.lsb + i : x.sig.lsb - i}]` : ''}${!r && !f ? ' no toggle' : !r ? ' no 0->1' : ' no 1->0'}`);
      }
      lines.push(`    ${x.sig.path}${missing.length ? ':' : ''}${missing.join(',')}${x.bits - x.covered > missing.length ? ' ...' : ''}`);
    }
  }
  lines.push('', `Total: statements ${pct(th, ts)}, branches ${pct(tbh, tb)}, toggles ${pct(cov2, bits)}`);
  return lines.join('\n');
}
