import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';
import { EXAMPLES } from '../src/ui/samples';

describe('bundled examples', () => {
  for (const ex of EXAMPLES) {
    it(`${ex.title} runs cleanly`, async () => {
      const lines: { m: string; k?: string }[] = [];
      const s = new Session({ read: (n) => ex.files[n], list: () => Object.keys(ex.files) }, (m, k) => lines.push({ m, k }));
      await s.exec(`do ${ex.doFile}`);
      const errs = lines.filter(l => l.k === 'err');
      expect(errs.map(e => e.m)).toEqual([]);
      expect(s.design).not.toBeNull();
      expect(s.waves.length).toBeGreaterThan(0);
      expect(s.now).toBeGreaterThan(0);
      if ((globalThis as any).process?.env?.SHOW) console.log(lines.map(l => l.m).join('\n'));
    });
  }
});
