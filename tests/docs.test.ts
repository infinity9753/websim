import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Session } from '../src/engine/commands';

// Every transcript command must be in the help text, the specification and the user guide (#61).
const src = readFileSync('src/engine/commands.ts', 'utf8');
const body = src.slice(src.indexOf('private async run1('), src.indexOf('emitClear?: () => void;'));
// accepted for compatibility with existing scripts, but they do nothing: not documented one by one
const compat = new Set(['transcript', 'onfinish', 'onbreak', 'onerror', 'set', 'configure', 'update', 'quietly', 'treeupdate', 'waverestorecursors', 'waverestorezoom', 'view']);
// aliases of a documented command
const alias = new Set(['exit', 'exa', 'cls', 'source']);
const commands = [...new Set([...body.matchAll(/case '([\w.]+)'/g)].map(m => m[1].toLowerCase()))].filter(c => !compat.has(c) && !alias.has(c)).sort();
const spec = readFileSync('docs/SPEC.md', 'utf8'), guide = readFileSync('docs/GUIDE.md', 'utf8');
const mentions = (doc: string, c: string) => new RegExp('`' + c + '(\\b[^`]*)?`').test(doc);

describe('documentation consistency (#61)', () => {
  const out: string[] = [];
  new Session({ read: () => undefined, list: () => [] }, m => out.push(m)).help();
  const help = out.join('\n');

  it('finds the commands', () => { expect(commands.length).toBeGreaterThan(40); expect(commands).toContain('sta'); });
  for (const c of commands) {
    it(`${c} is documented`, () => {
      const missing = [
        ...(new RegExp(`(^|[\\s,|])${c}\\b`, 'm').test(help) ? [] : ['help']),
        ...(mentions(spec, c) ? [] : ['SPEC.md']),
        ...(mentions(guide, c) ? [] : ['GUIDE.md']),
      ];
      expect(missing, `${c} is missing from`).toEqual([]);
    });
  }

  it('the compatibility no-ops are mentioned as a group in the specification', () => {
    for (const c of ['onbreak', 'quietly', 'WaveRestoreZoom']) expect(spec).toContain(c);
  });
});
