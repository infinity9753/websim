// List window model: one row per time at which any listed signal changes (deltas collapsed).
import * as L from './logic';
import type { Radix, Vec } from './logic';

export interface ListSource { times: number[]; at: (i: number) => Vec }
export interface ListRow { t: number; vals: Vec[] }

/** Merge the change times of all sources (up to `end`) and sample every source at each of them. */
export function listRows(srcs: ListSource[], end: number): ListRow[] {
  const ts = new Set<number>();
  for (const s of srcs) for (const t of s.times) { if (t > end) break; ts.add(t); }
  const times = [...ts].sort((a, b) => a - b);
  const idx = srcs.map(() => -1);
  return times.map(t => {
    const vals = srcs.map((s, i) => {
      let j = idx[i];
      while (j + 1 < s.times.length && s.times[j + 1] <= t) j++;
      idx[i] = j;
      return j < 0 ? L.allX(1) : s.at(j);
    });
    return { t, vals };
  });
}

/** Largest standard unit that divides the resolution, e.g. 1 ns -> ns, 10 ps -> ps. */
export function listUnit(resolution: number): [number, string] {
  for (const u of [[1e15, 's'], [1e12, 'ms'], [1e9, 'us'], [1e6, 'ns'], [1e3, 'ps']] as [number, string][]) if (resolution % u[0] === 0) return u;
  return [1, 'fs'];
}

export interface ListColumn { name: string; fmt: (v: Vec) => string }

/** Plain-text table as written by "write list". */
export function listText(cols: ListColumn[], rows: ListRow[], resolution: number): string {
  const [f, unit] = listUnit(resolution);
  const cells = rows.map(r => [String(r.t / f), ...r.vals.map((v, i) => cols[i].fmt(v))]);
  const head = [unit, ...cols.map(c => c.name)];
  const w = head.map((h, i) => Math.max(h.length, ...cells.map(c => c[i].length)));
  const line = (c: string[]) => c.map((x, i) => x.padStart(w[i])).join('  ').trimEnd();
  return [line(head), ...cells.map(line)].join('\n') + '\n';
}

export function fmtListValue(v: Vec, radix: Radix, enumNames?: string[]): string {
  return L.format(v, radix, enumNames);
}
