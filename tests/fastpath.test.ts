import { describe, it, expect, afterAll } from 'vitest';
import { simulate } from './helpers';
import { setFastPath } from '../src/engine/elab';

// Differential test: random expressions must give identical results with and without
// the 2-state number fast path (#30), including X/Z operands, signedness and widths > 32.
function rng(seed: number) { return () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; }; }

function design(seed: number) {
  const r = rng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const sigs = Array.from({ length: 8 }, (_, i) => ({ n: `s${i}`, w: pick([1, 3, 8, 13, 16, 31, 32, 40]), signed: r() < 0.3 }));
  const lit = () => { const w = pick([1, 4, 8, 32]); return `${w}'${r() < 0.5 ? 's' : ''}d${Math.floor(r() * 2 ** Math.min(w, 20))}`; };
  const leafE = (): string => {
    const s = pick(sigs);
    const k = r();
    if (k < 0.15 && s.w > 1) { const b = Math.floor(r() * s.w); return `${s.n}[${b}]`; }
    if (k < 0.25 && s.w > 2) { const hi = Math.floor(r() * s.w), lo = Math.floor(r() * (hi + 1)); return `${s.n}[${hi}:${lo}]`; }
    if (k < 0.35) return lit();
    return s.n;
  };
  const expr = (d: number): string => {
    if (d <= 0) return leafE();
    const k = r();
    if (k < 0.45) return `(${expr(d - 1)} ${pick(['+', '-', '*', '&', '|', '^', '~^', '==', '!=', '<', '<=', '>', '>=', '&&', '||', '===', '!=='])} ${expr(d - 1)})`;
    if (k < 0.55) return `(${expr(d - 1)} ${pick(['<<', '>>', '>>>', '<<<'])} ${Math.floor(r() * 36)})`;
    if (k < 0.7) return `(${pick(['~', '-', '!', '&', '|', '^', '~&', '~|', '~^'])}${expr(d - 1)})`;
    if (k < 0.8) return `(${expr(d - 1)} ? ${expr(d - 1)} : ${expr(d - 1)})`;
    if (k < 0.9) return `{${expr(d - 1)}, ${expr(d - 1)}}`;
    return expr(d - 1);
  };
  const outs = Array.from({ length: 40 }, (_, i) => ({ n: `o${i}`, w: pick([1, 5, 8, 16, 32, 33, 48]), signed: r() < 0.3, e: expr(1 + Math.floor(r() * 3)) }));
  const decl = (s: { n: string; w: number; signed: boolean }) => `reg ${s.signed ? 'signed ' : ''}[${s.w - 1}:0] ${s.n};`;
  const vals = (step: number) => sigs.map(s => {
    if (r() < 0.12) return `${s.n} = ${s.w}'b${'x'.repeat(Math.min(s.w, 2))}${'1'.repeat(Math.max(0, s.w - 2))};`;
    if (r() < 0.05) return `${s.n} = ${s.w}'bz;`;
    return `${s.n} = ${s.w}'d${Math.floor(r() * 2 ** Math.min(s.w, 31))} ^ ${s.w}'d${step};`;
  }).join(' ');
  return `module t;
  ${sigs.map(decl).join('\n  ')}
  ${outs.map(decl).join('\n  ')}
  always @* begin
    ${outs.map(o => `${o.n} = ${o.e};`).join('\n    ')}
  end
  initial begin
    ${[0, 1, 2, 3, 4, 5].map(i => `${vals(i)} #1 $display("%b", {${outs.map(o => o.n).join(', ')}});`).join('\n    ')}
    if (${outs[0].e}) $display("if-true"); else $display("if-false");
  end
endmodule`;
}

describe('number fast path (#30)', () => {
  afterAll(() => setFastPath(true));
  for (const seed of Array.from({ length: 40 }, (_, i) => i + 1)) {
    it(`matches the 4-state path (seed ${seed})`, () => {
      const src = design(seed);
      setFastPath(false);
      const slow = simulate({ 't.v': src }, 't').out;
      setFastPath(true);
      const fast = simulate({ 't.v': src }, 't').out;
      expect(fast).toEqual(slow);
      expect(slow.length).toBe(7);
    });
  }

  it('writing the same value again is not an event', () => {
    const { out, design } = simulate({
      't.v': `module t; reg [3:0] a = 4'd0, b = 4'd2; integer n = 0;
        always @(a) n = n + 1;
        initial begin #1 a = (b + 8) / 2; #1 a = b + 3; #1 a = 4'd5; #1 $display("%0d", n); end
      endmodule`,
    }, 't');
    // "/" has no fast path, so a holds a BigInt-only value when the fast path writes the same 5
    expect(out).toEqual(['1']);
    expect(design.root.objects.find(o => o.name === 'a')!.sig.times).toEqual([0, 1e6]);
  });
});
