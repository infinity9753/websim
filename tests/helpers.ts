import { LibraryManager } from '../src/engine/library';
import { Elaborator } from '../src/engine/elab';
export const DEBUG = { on: false };
import '../src/engine/vhdl';

/** Compile sources into a fresh library, elaborate `top`, run to completion and return the transcript lines. */
export function simulate(files: Record<string, string>, top: string, maxPs = 1e9, files2: Record<string, string> = {}) {
  const lm = new LibraryManager();
  for (const [name, src] of Object.entries(files)) {
    const lang = /\.(vhd|vhdl)$/.test(name) ? 'vhdl' : 'verilog';
    const r = lm.compile(lang, src, name);
    if (!r.ok) throw new Error(`compile ${name}: ${r.errors.map(e => `${e.file}(${e.line}): ${e.msg}`).join('\n')}`);
  }
  const out: string[] = [];
  const el = new Elaborator(lm, { print: (m) => out.push(m), readFile: (n) => files2[n] ?? files[n] }, { debug: DEBUG.on });
  const d = el.elaborate(top);
  let r;
  do r = d.kernel.run(maxPs, 10_000); while (r === 'budget');
  if (r === 'error') throw new Error(d.kernel.errorMsg!);
  return { out, design: d, result: r };
}
