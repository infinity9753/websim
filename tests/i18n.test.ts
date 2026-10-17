import { describe, it, expect } from 'vitest';
import { KO } from '../src/ui/i18n-ko';

describe('Korean UI strings (#38)', () => {
  it('has a translation for every t() key used in the UI', () => {
    const keys = new Set<string>();
    // Vite raw imports of every UI source file
    const files = (import.meta as unknown as { glob: (p: string, o: object) => Record<string, string> }).glob('../src/ui/*.ts', { query: '?raw', import: 'default', eager: true });
    for (const src of Object.values(files)) {
      for (const m of src.matchAll(/\bt\(('(?:[^'\\]|\\.)*')/g)) keys.add(new Function(`return ${m[1]}`)() as string);
    }
    // palette names are passed through t() dynamically
    for (const n of ['Default', 'Green', 'Yellow', 'Orange', 'Red', 'Magenta', 'Cyan', 'Blue', 'White']) keys.add(n);
    const missing = [...keys].filter(k => !(k in KO));
    expect(missing).toEqual([]);
    expect(keys.size).toBeGreaterThan(250);
  });

  it('keeps {n} placeholders in translations', () => {
    for (const [en, ko] of Object.entries(KO)) {
      const ph = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join();
      expect(ph(ko), en).toBe(ph(en));
    }
  });
});
