// SDC reader for the educational STA (#57): a small Tcl subset (words, {braces}, "quotes", [commands], $variables, set)
// and the constraint commands the ASIC flow uses. Times are in ns and capacitances in pF, as in the library.
import type { Netlist } from './netlist';

export interface Clock { name: string; period: number; /** Rising and falling edge times within the period. */ waveform: [number, number]; port?: string }
export type Obj = { kind: 'port' | 'cell' | 'clock' | 'pin'; name: string };
export interface PortDelay { clock?: string; max: number; min: number }
export interface Exception { kind: 'false' | 'max' | 'min'; value: number; from: Obj[]; to: Obj[]; through: Obj[]; setup: boolean; hold: boolean; text: string }
export interface Sdc {
  clocks: Clock[];
  inputDelay: Map<string, PortDelay>;
  outputDelay: Map<string, PortDelay>;
  /** Extra load on output ports, pF. */
  load: Map<string, number>;
  /** Transition time at input ports, ns. */
  transition: Map<string, number>;
  uncertainty: { setup: number; hold: number };
  exceptions: Exception[];
  warnings: string[];
}

export const emptySdc = (): Sdc => ({ clocks: [], inputDelay: new Map(), outputDelay: new Map(), load: new Map(), transition: new Map(), uncertainty: { setup: 0, hold: 0 }, exceptions: [], warnings: [] });

type Word = string | Obj[];

/** Split a script into commands of raw words (brackets kept for evaluation). */
function commands(text: string): { words: string[]; line: number }[] {
  const out: { words: string[]; line: number }[] = [];
  let words: string[] = [], line = 1, start = 1;
  const n = text.length;
  const end = () => { if (words.length) out.push({ words, line: start }); words = []; };
  for (let i = 0; i < n;) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '\n') { i += 2; line++; continue; }
    if (c === '\n' || c === ';') { if (c === '\n') line++; end(); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#' && !words.length) { while (i < n && text[i] !== '\n') i++; continue; }
    if (!words.length) start = line;
    // one word: balanced braces / brackets, quotes, or plain characters
    let j = i, w = '';
    if (c === '{') {
      let depth = 0;
      for (; j < n; j++) { if (text[j] === '{') depth++; else if (text[j] === '}' && --depth === 0) break; else if (text[j] === '\n') line++; }
      w = '\u0001' + text.slice(i + 1, j); j++;
    } else {
      let depth = 0, q = false;
      for (; j < n; j++) {
        const d = text[j];
        if (d === '\\' && j + 1 < n) { j++; continue; }
        if (d === '"' && !depth) { q = !q; continue; }
        if (d === '[') depth++;
        else if (d === ']') depth--;
        else if (!depth && !q && /[\s;]/.test(d)) break;
        if (d === '\n') line++;
      }
      w = text.slice(i, j).replace(/^"(.*)"$/s, '$1');
    }
    words.push(w);
    i = j;
  }
  end();
  return out;
}

const glob = (p: string) => new RegExp('^' + p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');

export function readSdc(text: string, nl: Netlist): Sdc {
  const sdc = emptySdc();
  const vars = new Map<string, string>();
  const warn = (line: number, m: string) => sdc.warnings.push(`line ${line}: ${m}`);
  const portNames = nl.ports.map(p => p.name);
  const base = (s: string) => s.replace(/\[\d+\]$/, '');
  const find = (kind: Obj['kind'], pats: string[], line: number): Obj[] => {
    const res: Obj[] = [];
    for (const p of pats) {
      const re = glob(p);
      const names = kind === 'port' ? portNames.filter(n => re.test(n) || re.test(base(n)))
        : kind === 'cell' ? nl.cells.map(c => c.name).filter(n => re.test(n))
        : kind === 'clock' ? sdc.clocks.map(c => c.name).filter(n => re.test(n))
        : nl.cells.flatMap(c => Object.keys(c.def.pins).map(pin => `${c.name}/${pin}`)).filter(n => re.test(n));
      if (!names.length) warn(line, `no ${kind} matches "${p}"`);
      for (const name of names) res.push({ kind, name });
    }
    return res;
  };
  const list = (s: string) => s.trim().split(/\s+/).filter(Boolean);
  const subst = (w: string, line: number): Word => {
    if (w.startsWith('\u0001')) return w.slice(1);
    if (w.startsWith('[') && w.endsWith(']')) return run(commands(w.slice(1, -1))[0]?.words ?? [], line) ?? '';
    return w.replace(/\$\{?(\w+)\}?/g, (_, v) => vars.get(v) ?? (warn(line, `unknown variable $${v}`), ''));
  };
  const objs = (w: Word | undefined, kind: Obj['kind'], line: number): Obj[] => w === undefined ? [] : typeof w === 'string' ? find(kind, list(w), line) : w;
  const num = (w: Word | undefined, line: number, what: string) => {
    const v = typeof w === 'string' ? Number(w) : NaN;
    if (!Number.isFinite(v)) { warn(line, `${what}: expected a number`); return 0; }
    return v;
  };
  /** Options (-name value / -flag) and positional words of a command. */
  const opts = (words: Word[], flags: string[]) => {
    const o = new Map<string, Word>(), pos: Word[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (typeof w === 'string' && /^-[a-z_]+$/.test(w) && Number.isNaN(Number(w))) { o.set(w, flags.includes(w) ? '1' : words[++i] ?? ''); continue; }
      pos.push(w);
    }
    return { o, pos };
  };
  function run(raw: string[], line: number): Word | undefined {
    if (!raw.length) return;
    const cmd = raw[0];
    const args = raw.slice(1).map(w => subst(w, line));
    switch (cmd) {
      case 'set': { if (typeof args[1] === 'string') vars.set(String(args[0]), args[1]); return args[1]; }
      case 'get_ports': return find('port', args.filter((a): a is string => typeof a === 'string' && !a.startsWith('-')).flatMap(list), line);
      case 'get_cells': return find('cell', args.filter((a): a is string => typeof a === 'string' && !a.startsWith('-')).flatMap(list), line);
      case 'get_pins': return find('pin', args.filter((a): a is string => typeof a === 'string' && !a.startsWith('-')).flatMap(list), line);
      case 'get_clocks': return find('clock', args.filter((a): a is string => typeof a === 'string' && !a.startsWith('-')).flatMap(list), line);
      case 'all_inputs': return nl.ports.filter(p => p.dir === 'input').map(p => ({ kind: 'port' as const, name: p.name }));
      case 'all_outputs': return nl.ports.filter(p => p.dir === 'output').map(p => ({ kind: 'port' as const, name: p.name }));
      case 'all_clocks': return sdc.clocks.map(c => ({ kind: 'clock' as const, name: c.name }));
      case 'all_registers': return nl.cells.filter(c => c.def.ff).map(c => ({ kind: 'cell' as const, name: c.name }));
      case 'create_clock': {
        const { o, pos } = opts(args, ['-add']);
        const period = num(o.get('-period'), line, 'create_clock -period');
        if (period <= 0) { warn(line, 'create_clock: the period must be positive'); return; }
        const ports = objs(pos[0], 'port', line);
        const name = String(o.get('-name') ?? ports[0]?.name ?? '');
        if (!name) { warn(line, 'create_clock: needs -name or a port'); return; }
        const wf = typeof o.get('-waveform') === 'string' ? list(o.get('-waveform') as string).map(Number) : [0, period / 2];
        sdc.clocks = sdc.clocks.filter(c => c.name !== name);
        sdc.clocks.push({ name, period, waveform: [wf[0] ?? 0, wf[1] ?? period / 2], port: ports[0]?.name });
        return [{ kind: 'clock', name }];
      }
      case 'set_input_delay': case 'set_output_delay': {
        const { o, pos } = opts(args, ['-max', '-min', '-add_delay', '-clock_fall']);
        const v = num(pos[0], line, cmd);
        if (pos.length > 2) warn(line, `${cmd}: unexpected argument ${String(pos[2])}`);
        const clk = o.get('-clock');
        const clock = clk === undefined ? undefined : typeof clk === 'string' ? clk : clk[0]?.name;
        if (clock !== undefined && !sdc.clocks.some(c => c.name === clock)) warn(line, `${cmd}: unknown clock ${clock}`);
        const map = cmd === 'set_input_delay' ? sdc.inputDelay : sdc.outputDelay;
        for (const p of objs(pos[1], 'port', line)) {
          const cur = map.get(p.name) ?? { clock, max: v, min: v };
          if (o.has('-max') && !o.has('-min')) cur.max = v; else if (o.has('-min') && !o.has('-max')) cur.min = v; else { cur.max = v; cur.min = v; }
          cur.clock = clock;
          map.set(p.name, cur);
        }
        return;
      }
      case 'set_load': { const { pos } = opts(args, ['-pin_load', '-wire_load']); const v = num(pos[0], line, cmd); for (const p of objs(pos[1], 'port', line)) sdc.load.set(p.name, v); return; }
      case 'set_input_transition': { const { pos } = opts(args, ['-max', '-min', '-rise', '-fall']); const v = num(pos[0], line, cmd); for (const p of objs(pos[1], 'port', line)) sdc.transition.set(p.name, v); return; }
      case 'set_clock_uncertainty': {
        const { o, pos } = opts(args, ['-setup', '-hold']);
        const v = num(pos[0], line, cmd);
        if (!o.has('-hold')) sdc.uncertainty.setup = v;
        if (!o.has('-setup')) sdc.uncertainty.hold = v;
        return;
      }
      case 'set_false_path': case 'set_max_delay': case 'set_min_delay': {
        const { o, pos } = opts(args, ['-setup', '-hold']);
        const kind = cmd === 'set_false_path' ? 'false' : cmd === 'set_max_delay' ? 'max' : 'min';
        const value = kind === 'false' ? 0 : num(pos[0], line, cmd);
        const pick = (k: string) => { const w = o.get(k); return w === undefined ? [] : typeof w === 'string' ? [...find('port', list(w).filter(n => portNames.some(p => glob(n).test(p) || glob(n).test(base(p)))), line), ...find('cell', list(w).filter(n => nl.cells.some(c => glob(n).test(c.name))), line)] : w; };
        const from = pick('-from'), to = pick('-to'), through = pick('-through');
        if (!o.has('-from') && !o.has('-to') && !o.has('-through')) { warn(line, `${cmd}: needs -from, -to or -through`); return; }
        const setup = kind === 'max' || (kind === 'false' && !o.has('-hold')), hold = kind === 'min' || (kind === 'false' && !o.has('-setup'));
        sdc.exceptions.push({ kind, value, from, to, through, setup, hold, text: raw.join(' ').replace(/\u0001/g, '') });
        return;
      }
      case 'set_units': case 'current_design': case 'set_driving_cell': case 'set_max_fanout': case 'set_max_transition': case 'set_propagated_clock': case 'set_clock_transition': case 'set_clock_latency':
        warn(line, `${cmd} is ignored by the WebSim STA`);
        return;
      default:
        warn(line, `unknown SDC command ${cmd}`);
    }
  }
  for (const c of commands(text)) run(c.words, c.line);
  return sdc;
}
