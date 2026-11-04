import { describe, it, expect } from 'vitest';
import { Session } from '../src/engine/commands';
import { EXAMPLES } from '../src/ui/samples';

const session = () => {
  const fs: Record<string, string> = { ...EXAMPLES.find(e => e.id === 'cpu')!.files };
  const out: string[] = [];
  const s = new Session({ read: n => fs[n], list: () => Object.keys(fs), write: (n, t) => { fs[n] = t; } }, m => out.push(m));
  return { fs, out, s };
};

describe('asic -auto (#67)', () => {
  it('retries with more layers and lower utilization until the layout is clean', async () => {
    const { out, s } = session();
    await s.exec('vlog cpu.v');
    expect(await s.exec('asic -util 0.95 -layers 2')).toBe(false);
    expect(out.join('\n')).toMatch(/the core is too small for the cells/);
    out.length = 0;
    expect(await s.exec('asic -util 0.95 -layers 2 -auto'), out.join('\n')).toBe(true);
    const t = out.join('\n');
    expect(t).toMatch(/-- asic -auto: attempt 2\/8 with utilization 0\.95 and 4 routing layers/);
    expect(t).toMatch(/-- asic -auto: attempt 3\/8 with utilization 0\.85 and 4 routing layers/);
    expect(t).toMatch(/-- asic -auto: clean layout with -util 0\.85 -layers 4/);
    expect(t).toMatch(/Checks: 0 shorts, 0 opens, 0 unrouted nets/);
    expect(s.lastAsic!.ok).toBe(true);
    expect(s.lastAsic!.result!.r.layers).toBe(4);
    // synthesis ran once
    expect(out.filter(l => l.startsWith('-- Synthesizing')).length).toBe(1);
  }, 180_000);
});
