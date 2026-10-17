// Transcript command interpreter (simulator command language subset).
import { LibraryManager } from './library';
import { Elaborator, type Design, type Scope, type ObjEntry } from './elab';
import type { Signal, Memory } from './kernel';
import { fmtTime, parseTime } from './format';
import * as L from './logic';
import type { Radix } from './logic';
import './vhdl';
import { writeVcd, type VcdVar } from './vcd';

export interface VFS {
  read(name: string): string | undefined;
  list(): string[];
  write?(name: string, text: string): void;
}

export type MsgKind = 'cmd' | 'out' | 'err' | 'warn' | 'note' | 'echo';

export interface WaveEntry {
  id: number;
  path: string;
  name: string;
  sig: Signal;
  radix: Radix;
  color?: string;
  expanded?: boolean;
  dividerLabel?: string;
}

type Ev = 'library' | 'sim' | 'time' | 'wave' | 'zoomfull' | 'scope' | 'running' | 'files' | 'compiled' | 'debug';

export interface Breakpoint { id: number; file: string; line: number; cond?: string; enabled: boolean }

interface CompiledSrc { file: string; lang: 'verilog' | 'vhdl'; lib: string }

export class Session {
  libs = new LibraryManager();
  design: Design | null = null;
  scope: Scope | null = null;
  waves: WaveEntry[] = [];
  runLength = 100_000; // ps
  defaultRadix: Radix = 'binary';
  history: string[] = [];
  running = false;
  promptN = 1;
  lastVsim: { top: string; lib?: string; generics: Map<string, string>; res?: number } | null = null;
  compiledSources: CompiledSrc[] = [];
  fileStatus = new Map<string, 'ok' | 'error'>();
  private listeners = new Map<Ev, Set<() => void>>();
  private waveSeq = 1;
  breakpoints: Breakpoint[] = [];
  private bpSeq = 1;
  /** Compile designs with statement hooks (breakpoints / stepping). */
  debug = true;
  private forceTimers: { cancelled: boolean }[] = [];

  constructor(public fs: VFS, public print: (msg: string, kind?: MsgKind) => void) {}

  on(ev: Ev, f: () => void) { (this.listeners.get(ev) ?? this.listeners.set(ev, new Set()).get(ev)!).add(f); return () => this.listeners.get(ev)!.delete(f); }
  emit(ev: Ev) { for (const f of this.listeners.get(ev) ?? []) f(); }

  get prompt(): string { return this.design ? `VSIM ${this.promptN}>` : 'WebSim>'; }
  get now(): number { return this.design?.kernel.now ?? 0; }
  get resolution(): number { return this.design?.kernel.resolution ?? 1000; }
  fmt(ps: number) { return fmtTime(ps, this.resolution); }

  out(msg: string, kind: MsgKind = 'out') { for (const l of msg.split('\n')) this.print(l, kind); }

  // ------------------------------------------------------------ entry
  async exec(line: string, echo = true): Promise<boolean> {
    const trimmed = line.trim();
    if (echo) this.print(`${this.prompt} ${trimmed}`, 'cmd');
    if (!trimmed) return true;
    if (echo) { this.history.push(trimmed); if (this.design) this.promptN++; }
    let ok = true;
    for (const cmd of splitCommands(trimmed)) {
      if (!cmd.trim() || cmd.trim().startsWith('#')) continue;
      try {
        ok = (await this.run1(tokenize(cmd))) !== false && ok;
      } catch (e) {
        this.out(`** Error: ${(e as Error).message}`, 'err');
        ok = false;
      }
    }
    return ok;
  }

  private async run1(args: string[]): Promise<boolean | void> {
    const [cmd, ...rest] = args;
    switch (cmd.toLowerCase()) {
      case 'vlib': return this.vlib(rest);
      case 'vmap': this.out(`Modifying library mapping: ${rest.join(' ')}`); return;
      case 'vdel': return this.vdel(rest);
      case 'vlog': return this.compile('verilog', rest);
      case 'vcom': return this.compile('vhdl', rest);
      case 'vsim': return this.vsim(rest);
      case 'run': return this.run(rest);
      case 'restart': return this.restart();
      case 'quit': case 'exit':
        if (rest.includes('-sim') || this.design) { this.quitSim(); return; }
        this.out('Use the browser tab to close WebSim.'); return;
      case 'add': return this.add(rest);
      case 'delete': return this.del(rest);
      case 'force': return this.force(rest);
      case 'noforce': return this.noforce(rest);
      case 'examine': case 'exa': return this.examine(rest);
      case 'env': return this.env(rest);
      case 'pwd': this.out(this.scope?.path ?? '/'); return;
      case 'ls': this.out(this.fs.list().join('\n') || '(no files)'); return;
      case 'echo': this.out(rest.join(' '), 'echo'); return;
      case 'clear': case 'cls': this.emitClear?.(); return;
      case 'history': this.out(this.history.map((h, i) => `${i + 1}  ${h}`).join('\n')); return;
      case 'help': this.help(); return;
      case 'do': case 'source': return this.doFile(rest);
      case 'radix': this.radix(rest); return;
      case 'wave': if (rest[0] === 'zoom' || rest[0] === 'zoomfull') this.emit('zoomfull'); return;
      case 'view': return;
      case 'log': case 'transcript': case 'onfinish': case 'onbreak': case 'onerror': case 'set': case 'configure': case 'update': case 'quietly': case 'TreeUpdate': case 'WaveRestoreCursors': case 'WaveRestoreZoom': return;
      case 'bp': return this.bp(rest);
      case 'bd': return this.bd(rest);
      case 'step': return this.step(rest);
      case 'when': this.out(`** Warning: '${cmd}' is not implemented in this version.`, 'warn'); return;
      case 'show': return this.show(rest);
      case 'describe': return this.describe(rest);
      case 'find': return this.find(rest);
      case 'now': this.out(this.fmt(this.now)); return;
      case 'vcd': return this.vcd(rest);
      case 'write': return this.writeCmd(rest);
      case 'mem': return this.memCmd(rest);
    }
    throw new Error(`invalid command name "${cmd}"`);
  }

  emitClear?: () => void;

  help() {
    this.out([
      'Commands:',
      '  vlib <lib>                         create a library',
      '  vlog [-work lib] <files...>        compile Verilog / SystemVerilog',
      '  vcom [-work lib] <files...>        compile VHDL',
      '  vsim [-t res] [-gN=V] [lib.]top    load a design',
      '  run [<time>] | -all | -continue    advance simulation',
      '  restart [-f]                       back to time 0',
      '  quit -sim                          unload design',
      '  add wave [-radix r] [-r] <paths>   add signals to wave window',
      '  delete wave <paths> | *            remove waves',
      '  force [-deposit] <sig> <val> [t]   force a value (also "v1 t1, v2 t2 -repeat p")',
      '  noforce <sig>                      release a force',
      '  examine [-radix r] <sigs>          print values',
      '  env [<scope>]                      show/change current scope',
      '  find signals <pattern>             list signals',
      '  do <file>                          run a script',
      '  vcd export [-all] [file.vcd]       write wave (or all) signals as VCD',
      '  write format wave <file.do>        save the wave window setup (restore with "do")',
      '  mem list | display | save -outfile f | load -infile f  <memory>',
      '  bp [<file> <line> [{cond}]]        set / list breakpoints;  bd <id>|<file> <line>|all',
      '  step [-over]                       execute one statement (step into / over)',
      '  radix <binary|hex|unsigned|decimal|octal|ascii>',
      '  ls, pwd, echo, history, clear, help',
    ].join('\n'));
  }

  // ------------------------------------------------------------ libraries
  vlib(args: string[]) {
    const name = args.find(a => !a.startsWith('-'));
    if (!name) throw new Error('vlib: missing library name');
    if (this.libs.libs.has(name)) this.out(`** Warning: (vlib-34) Library already exists at "${name}".`, 'warn');
    this.libs.ensure(name);
    this.emit('library');
  }

  vdel(args: string[]) {
    let lib = 'work';
    const i = args.indexOf('-lib'); if (i >= 0) lib = args[i + 1];
    const l = this.libs.libs.get(lib);
    if (!l) throw new Error(`(vdel-134) Library "${lib}" not found.`);
    if (args.includes('-all')) { l.clear(); this.compiledSources = this.compiledSources.filter(s => s.lib !== lib); }
    else for (const u of args.filter((a, j) => !a.startsWith('-') && args[j - 1] !== '-lib')) l.remove(u);
    this.emit('library');
  }

  compile(lang: 'verilog' | 'vhdl', args: string[], quiet = false): boolean {
    let lib = 'work';
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-work') { lib = args[++i]; continue; }
      if (a.startsWith('+define+')) {
        for (const d of a.slice(8).split('+')) { const [k, v] = d.split('='); this.libs.defines.set(k, { body: v ?? '' }); }
        continue;
      }
      if (a.startsWith('+incdir+')) continue;
      if (a.startsWith('-') || a.startsWith('+')) continue;
      // simple glob support
      if (a.includes('*')) {
        const re = globRe(a);
        files.push(...this.fs.list().filter(f => re.test(f)));
      } else files.push(a);
    }
    if (!files.length) throw new Error(`${lang === 'verilog' ? 'vlog' : 'vcom'}: no input files`);
    if (!this.libs.libs.has(lib)) {
      if (lib !== 'work') throw new Error(`(vlog-7) Failed to open design unit file "${lib}" in read mode. Library does not exist.`);
      this.libs.ensure(lib);
    }
    let errors = 0;
    const tops = new Set<string>();
    for (const f of files) {
      const src = this.fs.read(f);
      if (src === undefined) { this.out(`** Error: (${lang === 'verilog' ? 'vlog' : 'vcom'}-7) Failed to open design unit file "${f}" in read mode.`, 'err'); errors++; continue; }
      if (!quiet) this.out(`-- Compiling file ${f}`, 'out');
      const r = this.libs.compile(lang, src, f, lib, (n) => this.fs.read(n));
      if (!quiet) for (const l of r.log) this.out(l);
      if (!r.ok) {
        errors += r.errors.length;
        for (const e of r.errors) this.out(`** Error: ${e.file}(${e.line}): ${e.msg}`, 'err');
        this.fileStatus.set(f, 'error');
      } else {
        this.fileStatus.set(f, 'ok');
        this.compiledSources = this.compiledSources.filter(s => s.file !== f);
        this.compiledSources.push({ file: f, lang, lib });
        for (const u of r.units) if (u.kind === 'module' || u.kind === 'entity') tops.add(u.name);
      }
    }
    if (!quiet) {
      const t = this.libs.topLevels(lib).filter(n => tops.has(n));
      if (t.length && lang === 'verilog') this.out(`\nTop level modules:\n${t.map(x => '\t' + x).join('\n')}`);
      this.out(`End of compile. Errors: ${errors}, Warnings: 0`, errors ? 'err' : 'out');
    }
    this.emit('library');
    this.emit('compiled');
    return errors === 0;
  }

  /** Recompile everything recorded (used after page reload). */
  rebuild(list: CompiledSrc[]) {
    for (const s of list) {
      this.libs.ensure(s.lib);
      const src = this.fs.read(s.file);
      if (src === undefined) continue;
      const r = this.libs.compile(s.lang, src, s.file, s.lib, (n) => this.fs.read(n));
      if (r.ok) { this.compiledSources.push(s); this.fileStatus.set(s.file, 'ok'); }
      else this.fileStatus.set(s.file, 'error');
    }
    this.emit('library');
    this.emit('compiled');
  }

  // ------------------------------------------------------------ simulation
  vsim(args: string[]) {
    this.debug = !args.includes('-nodebug');
    let res: number | undefined;
    const generics = new Map<string, string>();
    let lib: string | undefined;
    let top: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-t') { const r = parseTime('1' + args[++i].replace(/^\d+/, ''), 1); res = r ?? undefined; const n = parseInt(args[i], 10); if (!isNaN(n) && r) res = n * r; continue; }
      if (a.startsWith('-g') || a.startsWith('-G')) { const [k, v] = a.slice(2).split('='); generics.set(k, v); continue; }
      if (a === '-lib') { lib = args[++i]; continue; }
      if (a === '-do') { i++; continue; }
      if (a === '-nodebug' || a === '-debug') continue;
      if (a.startsWith('-') || a.startsWith('+')) continue;
      top = a;
    }
    if (!top) throw new Error('vsim: no design specified. Usage: vsim [lib.]top');
    const m = /^(\w+)\.(.+)$/.exec(top);
    if (m) { lib = m[1]; top = m[2]; }
    const sameTop = this.lastVsim?.top === top;
    if (this.design) this.quitSim(true);
    if (!sameTop) this.waves = [];
    this.load({ top, lib, generics, res });
  }

  private load(o: { top: string; lib?: string; generics: Map<string, string>; res?: number }) {
    this.out(`vsim ${o.lib ? o.lib + '.' : ''}${o.top}`, 'out');
    const el = new Elaborator(this.libs, { print: (s) => this.simPrint(s), readFile: (n) => this.fs.read(n), writeFile: (n, t) => this.fs.write?.(n, t) }, { generics: o.generics, resolutionPs: o.res, debug: this.debug });
    let d: Design;
    try {
      d = el.elaborate(o.top, o.lib);
    } catch (e) {
      const ce = e as Error & { loc?: { file: string; line: number } };
      this.out(`** Error: ${ce.loc ? `${ce.loc.file}(${ce.loc.line}): ` : ''}${ce.message}`, 'err');
      this.out('Error loading design', 'err');
      return;
    }
    for (const l of d.loaded) this.out(`Loading ${l}`);
    for (const w of d.warnings) this.out(`** Warning: ${w}`, 'warn');
    this.design = d;
    this.scope = d.root;
    this.installBreakpoints();
    this.lastVsim = o;
    this.promptN = 1;
    // rebind existing waves by path (restart)
    this.waves = this.waves.map(w => { if (w.dividerLabel !== undefined) return { ...w, sig: d.kernel.signals[0] ?? w.sig }; const s = this.findSignal(w.path); return s ? { ...w, sig: s.obj.sig } : null; }).filter((w): w is WaveEntry => !!w);
    this.emit('sim');
    this.emit('wave');
    this.emit('time');
  }

  private simPrint(s: string) {
    if (s.startsWith('** Error') || s.startsWith('** Failure') || s.startsWith('** Fatal')) this.out(s, 'err');
    else if (s.startsWith('** Warning')) this.out(s, 'warn');
    else if (s.startsWith('** ')) this.out(s, 'note');
    else this.out(s);
  }

  quitSim(silent = false) {
    if (!this.design) return;
    this.design.kernel.breakRequested = true;
    this.design = null;
    this.scope = null;
    for (const t of this.forceTimers) t.cancelled = true;
    this.forceTimers = [];
    if (!silent) this.waves = [];
    this.emit('sim');
    this.emit('wave');
    this.emit('time');
  }

  restart() {
    if (!this.lastVsim) throw new Error('No design loaded.');
    const saved = this.waves;
    this.quitSim(true);
    this.waves = saved;
    this.load(this.lastVsim);
  }

  requireDesign(): Design {
    if (!this.design) throw new Error('No design is loaded. Use "vsim <top>" first.');
    return this.design;
  }

  breakRun() { if (this.design && this.running) this.design.kernel.breakRequested = true; }

  async run(args: string[]) {
    const d = this.requireDesign();
    const k = d.kernel;
    if (this.running) throw new Error('Simulation is already running.');
    if (k.finished) { this.out('** Note: Simulation has finished. Use "restart" to run again.', 'note'); return; }
    let until: number;
    let all = false;
    if (args.includes('-all') || args.includes('-a')) { all = true; until = Number.MAX_SAFE_INTEGER; }
    else if (args.includes('-continue')) { all = true; until = Number.MAX_SAFE_INTEGER; }
    else {
      const spec = args.filter(a => !a.startsWith('-')).join(' ');
      const len = spec ? parseTime(spec, this.resolution) : this.runLength;
      if (len === null || len < 0) throw new Error(`Invalid time "${spec}"`);
      until = k.now + len;
    }
    this.running = true;
    this.emit('running');
    const t0 = Date.now();
    let r;
    try {
      for (;;) {
        r = k.run(until, 40);
        this.emit('time');
        if (r !== 'budget') break;
        await new Promise(res => setTimeout(res, 0));
        if (!this.design || this.design !== d) return;
      }
    } finally {
      this.running = false;
      this.emit('running');
    }
    switch (r) {
      case 'idle':
        if (!all) k.now = until;
        break;
      case 'paused': break;
      case 'finished':
        this.out(`End time: ${new Date().toLocaleTimeString()}  (simulated ${this.fmt(k.now)} in ${((Date.now() - t0) / 1000).toFixed(2)} s)`);
        break;
      case 'stopped':
        if (k.lastStopInfo) { this.out(k.lastStopInfo); k.lastStopInfo = ''; }
        else this.out('Simulation stop requested.');
        this.emit('debug');
        break;
      case 'error':
        this.out(`** Fatal: ${k.errorMsg}`, 'err');
        k.finished = true;
        break;
    }
    if (k.dumpItems) this.writeDump();
    this.emit('time');
  }

  // ------------------------------------------------------------ breakpoints / stepping
  get paused() { return this.design?.kernel.pausedAt ?? null; }

  installBreakpoints() {
    const k = this.design?.kernel;
    if (!k) return;
    k.breakpoints.clear();
    for (const b of this.breakpoints) {
      if (!b.enabled) continue;
      let cond: (() => boolean) | undefined;
      if (b.cond) {
        try { cond = this.compileCond(b.cond); }
        catch (e) { this.out(`** Warning: breakpoint ${b.id} condition ignored: ${(e as Error).message}`, 'warn'); }
      }
      k.breakpoints.set(`${b.file}:${b.line}`, { cond });
    }
  }

  /** Variables visible at the paused statement (process / block / task locals), innermost first. */
  locals(): { name: string; value: L.Vec; enumNames?: string[]; where: string }[] {
    const p = this.design?.kernel.pausedAt;
    if (!p?.scope) return [];
    const out: { name: string; value: L.Vec; enumNames?: string[]; where: string }[] = [];
    const seen = new Set<string>();
    for (let s = p.scope as Scope | null; s && s.kind !== 'instance' && s.kind !== 'generate'; s = s.lex) {
      for (const [name, sym] of s.syms) {
        if (sym.k !== 'sig' || seen.has(name) || name.startsWith('__')) continue;
        seen.add(name);
        out.push({ name, value: sym.sig.value, enumNames: sym.sig.enumNames, where: s.kind === 'func' ? s.name : 'process' });
      }
    }
    return out;
  }

  callStack(): string[] {
    const p = this.design?.kernel.pausedAt;
    if (!p) return [];
    return [`${p.proc.scope}/${p.proc.name}`, ...(p.stack ?? [])].reverse().map((f, i) => (i === 0 ? `${f}  @ ${p.file}:${p.line}` : f));
  }

  /** Nearest executable line at or after `line` (within 10 lines), or null. */
  executableLine(file: string, line: number): number | null {
    const lines = this.design?.execLines;
    if (!lines) return line;
    for (let l = line; l < line + 10; l++) if (lines.has(`${file}:${l}`)) return l;
    return null;
  }

  loadBreakpoints(list: { file: string; line: number; cond?: string }[]) {
    this.breakpoints = list.map(b => ({ id: this.bpSeq++, file: b.file, line: b.line, cond: b.cond, enabled: true }));
    this.installBreakpoints();
    this.emit('debug');
  }

  addBreakpoint(file: string, line: number, cond?: string): Breakpoint | null {
    const l = this.executableLine(file, line);
    if (l === null) { this.out(`** Warning: No executable statement at ${file}:${line}.`, 'warn'); return null; }
    let b = this.breakpoints.find(x => x.file === file && x.line === l);
    if (b) { b.cond = cond; b.enabled = true; }
    else { b = { id: this.bpSeq++, file, line: l, cond, enabled: true }; this.breakpoints.push(b); }
    this.installBreakpoints();
    this.emit('debug');
    return b;
  }

  removeBreakpoint(file: string, line: number) {
    this.breakpoints = this.breakpoints.filter(b => !(b.file === file && b.line === line));
    this.installBreakpoints();
    this.emit('debug');
  }

  toggleBreakpoint(file: string, line: number) {
    if (this.breakpoints.some(b => b.file === file && b.line === line)) this.removeBreakpoint(file, line);
    else this.addBreakpoint(file, line);
  }

  bp(args: string[]) {
    const pos = args.filter(a => !a.startsWith('-'));
    if (args.includes('-del') || args.includes('-delete')) return this.bd(pos);
    if (!pos.length) {
      if (!this.breakpoints.length) { this.out('No breakpoints.'); return; }
      for (const b of this.breakpoints) this.out(`bp ${b.id}: ${b.file}:${b.line}${b.cond ? ` {${b.cond}}` : ''}${b.enabled ? '' : ' (disabled)'}`);
      return;
    }
    let file = pos[0], lineS = pos[1], cond = pos[2];
    const m = /^(.+):(\d+)$/.exec(file);
    if (m) { file = m[1]; cond = pos[1]; lineS = m[2]; }
    const line = Number(lineS);
    if (!file || !Number.isInteger(line) || line <= 0) throw new Error('Usage: bp <file> <line> [{condition}]');
    if (this.fs.read(file) === undefined) throw new Error(`bp: unknown file "${file}"`);
    const b = this.addBreakpoint(file, line, cond);
    if (b) this.out(`bp ${b.id}: ${b.file}:${b.line}${b.cond ? ` {${b.cond}}` : ''}`);
  }

  bd(args: string[]) {
    const pos = args.filter(a => !a.startsWith('-'));
    if (!pos.length || pos[0] === 'all' || pos[0] === '*') { this.breakpoints = []; }
    else if (pos.length === 1 && /^\d+$/.test(pos[0])) { const id = Number(pos[0]); this.breakpoints = this.breakpoints.filter(b => b.id !== id); }
    else {
      const m = /^(.+):(\d+)$/.exec(pos[0]);
      const file = m ? m[1] : pos[0], line = Number(m ? m[2] : pos[1]);
      this.breakpoints = this.breakpoints.filter(b => !(b.file === file && b.line === line));
    }
    this.installBreakpoints();
    this.emit('debug');
  }

  async step(args: string[]) {
    const d = this.requireDesign();
    const k = d.kernel;
    if (args.includes('-over') || args.includes('-next')) {
      const p = k.processes.find(x => x.info === k.pausedAt?.proc);
      k.stepMode = p ? { kind: 'over', proc: p, depth: (p as any).depthAtStop ?? 0 } : { kind: 'into' };
    } else k.stepMode = { kind: 'into' };
    if (!this.debug) this.out('** Warning: design was loaded with -nodebug; stepping is unavailable.', 'warn');
    await this.run(['-continue']);
    k.stepMode = null;
  }

  /** Compile a condition such as "/tb/q == 9 && rst != 1" into a predicate over current values. */
  compileCond(text: string): () => boolean {
    const toks = text.match(/\s*(==|!=|<=|>=|&&|\|\||[()<>!]|[^\s()<>!=&|]+)/g)?.map(t => t.trim()).filter(Boolean) ?? [];
    let i = 0;
    type F = () => L.Vec;
    const primary = (): F => {
      const t = toks[i++];
      if (t === undefined) throw new Error('unexpected end of condition');
      if (t === '(') { const e = or(); if (toks[i++] !== ')') throw new Error("missing ')'"); return e; }
      if (t === '!') { const e = primary(); return () => L.lnot(e()); }
      const sig = this.findSignal(t);
      if (sig) { const sg = sig.obj.sig; return () => sg.value; }
      if (/^[a-zA-Z_]/.test(t) && sig === null && !/^[xXzZ]$/.test(t)) throw new Error(`unknown signal "${t}"`);
      const v = parseValue(t, 64);
      return () => v;
    };
    const cmp = (): F => {
      const l = primary();
      const op = toks[i];
      if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
        i++;
        const r = primary();
        const f = { '==': L.caseEq, '!=': L.caseNeq, '<': L.lt, '>': L.gt, '<=': L.le, '>=': L.ge }[op]!;
        return () => f(l().withSign(false), r().withSign(false));
      }
      return l;
    };
    const and = (): F => { let l = cmp(); while (toks[i] === '&&') { i++; const a = l, b = cmp(); l = () => L.land(a(), b()); } return l; };
    const or = (): F => { let l = and(); while (toks[i] === '||') { i++; const a = l, b = and(); l = () => L.lor(a(), b()); } return l; };
    const e = or();
    if (i < toks.length) throw new Error(`unexpected "${toks[i]}" in condition`);
    return () => L.isTrue(e());
  }

  // ------------------------------------------------------------ VCD
  /** Signals selected by $dumpvars-style items (path prefix + depth; levels 0 = all below). */
  dumpVars(items: { path: string; levels: number }[]): VcdVar[] {
    const d = this.requireDesign();
    const out: VcdVar[] = [];
    const seen = new Set<string>();
    const add = (path: string, sig: Signal) => { if (!seen.has(path)) { seen.add(path); out.push({ path, sig }); } };
    for (const it of items) {
      for (const s of d.allScopes) {
        const sigMatch = s.objects.find(o => `${s.path}/${o.name}` === it.path);
        if (sigMatch) { add(it.path, sigMatch.sig); continue; }
        const rel = it.path === '' ? s.path : s.path === it.path ? '' : s.path.startsWith(it.path + '/') ? s.path.slice(it.path.length) : null;
        if (rel === null) continue;
        const depth = rel.split('/').filter(Boolean).length + (it.path === '' ? 0 : 1);
        if (it.levels > 0 && depth > it.levels) continue;
        for (const o of s.objects) add(`${s.path}/${o.name}`, o.sig);
      }
    }
    return out;
  }

  vcdText(all: boolean): string {
    const d = this.requireDesign();
    const vars: VcdVar[] = all
      ? this.dumpVars([{ path: '', levels: 0 }])
      : this.waves.filter(w => w.dividerLabel === undefined).map(w => ({ path: w.path, sig: w.sig }));
    return writeVcd(vars, d.kernel.now);
  }

  private writeDump() {
    const k = this.design!.kernel;
    if (!this.fs.write) return;
    const text = writeVcd(this.dumpVars(k.dumpItems!), k.now);
    this.fs.write(k.dumpFile, text);
  }

  // ------------------------------------------------------------ memories
  findMemory(path: string): { path: string; mem: Memory } | null {
    path = path.replace(/^sim:/, '');
    const i = path.lastIndexOf('/');
    const sc = i < 0 ? (this.scope ?? this.design?.root ?? null) : this.findScope(path.slice(0, i) || '/');
    const m = sc?.memories.find(x => x.name === path.slice(i + 1) || x.name.toLowerCase() === path.slice(i + 1).toLowerCase());
    return m && sc ? { path: `${sc.path}/${m.name}`, mem: m.mem } : null;
  }

  listMemories(): { path: string; lo: number; hi: number; w: number }[] {
    const d = this.design;
    if (!d) return [];
    return d.allScopes.flatMap(s => s.memories.map(m => ({ path: `${s.path}/${m.name}`, lo: m.mem.lo, hi: m.mem.hi, w: m.mem.w })));
  }

  memWords(path: string, from: number, count: number): { lo: number; hi: number; w: number; words: L.Vec[] } | null {
    const f = this.findMemory(path);
    if (!f) return null;
    const m = f.mem;
    const a = Math.max(m.lo, from), b = Math.min(m.hi, from + count - 1);
    return { lo: m.lo, hi: m.hi, w: m.w, words: b >= a ? m.words.slice(a - m.lo, b - m.lo + 1) : [] };
  }

  memDeposit(path: string, addr: number, value: string) {
    const d = this.requireDesign();
    const f = this.findMemory(path);
    if (!f) throw new Error(`(vsim-3140) Unable to find memory "${path}".`);
    const i = f.mem.index(addr);
    if (i < 0) throw new Error(`Address ${addr} is outside [${f.mem.lo}:${f.mem.hi}].`);
    d.kernel.memWrite(f.mem, i, parseValue(value, f.mem.w).withSign(f.mem.signed));
    this.emit('time');
  }

  memCmd(args: string[]) {
    this.requireDesign();
    const sub = args[0];
    const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
    const path = args.slice(1).filter((a, i, arr) => !a.startsWith('-') && !(arr[i - 1] ?? '').startsWith('-')).pop();
    if (sub === 'list') { for (const m of this.listMemories()) this.out(`${m.path}  [${m.lo}:${m.hi}] x ${m.w} bits`); return; }
    if (!path) throw new Error('Usage: mem display|save|load [options] <memory>');
    const f = this.findMemory(path);
    if (!f) throw new Error(`(vsim-3140) Unable to find memory "${path}".`);
    const m = f.mem;
    const radix: Radix = opt('-format') === 'bin' || opt('-radix')?.startsWith('b') ? 'binary' : opt('-radix') ? parseRadix(opt('-radix')!) : 'hex';
    const fmtW = (v: L.Vec) => L.format(v, radix);
    switch (sub) {
      case 'display': {
        const a = Number(opt('-startaddress') ?? m.lo), b = Number(opt('-endaddress') ?? Math.min(m.hi, a + 63));
        const lines: string[] = [];
        for (let x = a; x <= b; x += 8) {
          const vals: string[] = [];
          for (let y = x; y <= Math.min(b, x + 7); y++) vals.push(fmtW(m.words[y - m.lo]));
          lines.push(`${x.toString(16).padStart(4, '0')}: ${vals.join(' ')}`);
        }
        this.out(lines.join('\n'));
        return;
      }
      case 'save': {
        const file = opt('-outfile') ?? opt('-o');
        if (!file || !this.fs.write) throw new Error('mem save: -outfile <file> required');
        const lines = [`// memory data file: ${f.path}`, `// format=${radix === 'binary' ? 'bin' : 'hex'} addressradix=h`];
        m.words.forEach((v, i) => lines.push(`@${(i + m.lo).toString(16)} ${fmtW(v)}`));
        this.fs.write(file, lines.join('\n') + '\n');
        this.out(`Saved ${m.words.length} words to ${file}`);
        return;
      }
      case 'load': {
        const file = opt('-infile') ?? opt('-i');
        const text = file ? this.fs.read(file) : undefined;
        if (text === undefined) throw new Error(`mem load: cannot read "${file}"`);
        const base = radix === 'binary' ? 2 : 16;
        let addr = m.lo, n = 0;
        for (const tok of text.replace(/\/\/.*$/gm, '').split(/\s+/).filter(Boolean)) {
          if (tok.startsWith('@')) { addr = parseInt(tok.slice(1), 16); continue; }
          const i = m.index(addr++);
          if (i < 0) continue;
          this.design!.kernel.memWrite(m, i, parseValue(base === 16 ? `16#${tok}` : tok, m.w).withSign(m.signed));
          n++;
        }
        this.out(`Loaded ${n} words into ${f.path}`);
        this.emit('time');
        return;
      }
    }
    throw new Error(`mem: unknown subcommand "${sub}"`);
  }

  /** Wave window setup as a re-runnable do-file. */
  waveFormat(): string {
    const lines = ['# WebSim wave format', 'onerror {resume}', 'quietly WaveActivateNextPane {} 0'];
    for (const w of this.waves) {
      if (w.dividerLabel !== undefined) lines.push(`add wave -noupdate -divider {${w.dividerLabel}}`);
      else lines.push(`add wave -noupdate${w.radix !== this.defaultRadix ? ` -radix ${w.radix}` : ''} ${w.path}`);
    }
    lines.push('update', 'wave zoom full');
    return lines.join('\n') + '\n';
  }

  writeCmd(args: string[]) {
    // write format wave [-window ...] <file>
    if (args[0] !== 'format' || args[1] !== 'wave') throw new Error('Usage: write format wave <file.do>');
    const rest = args.slice(2);
    const file = rest.filter((a, i) => !a.startsWith('-') && rest[i - 1] !== '-window').pop() ?? 'wave.do';
    if (!this.fs.write) throw new Error('write: file system is read-only');
    this.fs.write(file, this.waveFormat());
    this.out(`Saved wave format to ${file}`);
  }

  vcd(args: string[]) {
    const sub = args[0];
    if (sub !== 'export' && sub !== 'file') throw new Error('Usage: vcd export [-all] [file.vcd]');
    const all = args.includes('-all');
    const file = args.slice(1).find(a => !a.startsWith('-')) ?? 'wave.vcd';
    if (!this.fs.write) throw new Error('vcd: file system is read-only');
    if (!all && !this.waves.length) throw new Error('vcd: the wave window is empty (use -all to dump every signal)');
    this.fs.write(file, this.vcdText(all));
    this.out(`Wrote ${file}`);
  }

  // ------------------------------------------------------------ hierarchy helpers
  findScope(path: string): Scope | null {
    const d = this.design;
    if (!d) return null;
    path = path.replace(/^sim:/, '');
    let cur: Scope | null;
    let parts: string[];
    if (path.startsWith('/')) {
      parts = path.split('/').filter(Boolean);
      if (!parts.length) return d.root;
      if (parts[0] !== d.root.name) return null;
      cur = d.root; parts = parts.slice(1);
    } else { cur = this.scope ?? d.root; parts = path.split('/').filter(Boolean); }
    for (const p of parts) {
      if (p === '..') { cur = cur!.up ?? cur; continue; }
      const nx: Scope | undefined = cur!.children.find(c => c.name === p || c.name.toLowerCase() === p.toLowerCase());
      if (!nx) return null;
      cur = nx;
    }
    return cur;
  }

  findSignal(path: string): { scope: Scope; obj: ObjEntry } | null {
    path = path.replace(/^sim:/, '');
    const i = path.lastIndexOf('/');
    const sc = i < 0 ? (this.scope ?? this.design?.root ?? null) : this.findScope(path.slice(0, i) || '/');
    if (!sc) return null;
    const leaf = path.slice(i + 1);
    const obj = sc.objects.find(o => o.name === leaf) ?? sc.objects.find(o => o.name.toLowerCase() === leaf.toLowerCase());
    return obj ? { scope: sc, obj } : null;
  }

  matchSignals(pattern: string, recursive: boolean): { scope: Scope; obj: ObjEntry }[] {
    pattern = pattern.replace(/^sim:/, '');
    const i = pattern.lastIndexOf('/');
    const dirPath = i < 0 ? null : pattern.slice(0, i) || '/';
    const leaf = pattern.slice(i + 1);
    const base = dirPath === null ? (this.scope ?? this.design?.root ?? null) : this.findScope(dirPath);
    if (!base) return [];
    const re = globRe(leaf);
    const out: { scope: Scope; obj: ObjEntry }[] = [];
    const visit = (s: Scope) => {
      for (const o of s.objects) if (re.test(o.name)) out.push({ scope: s, obj: o });
      if (recursive) for (const c of s.children) visit(c);
    };
    visit(base);
    return out;
  }

  // ------------------------------------------------------------ wave commands
  add(args: string[]) {
    const what = args[0];
    if (what !== 'wave' && what !== 'log' && what !== 'list') throw new Error(`add: unknown target "${what}" (use "add wave")`);
    if (what !== 'wave') return;
    this.requireDesign();
    let radix: Radix | undefined;
    let recursive = false;
    let divider: string | null = null;
    const pats: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '-radix') { radix = parseRadix(args[++i]); continue; }
      if (a === '-r' || a === '-recursive') { recursive = true; continue; }
      if (a === '-divider') { divider = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : ''; continue; }
      if (a === '-position' || a === '-color' || a === '-label' || a === '-height' || a === '-group') { i++; continue; }
      if (a.startsWith('-')) continue;
      pats.push(a);
    }
    if (divider !== null) {
      const dummy = this.waves[0]?.sig ?? this.design!.kernel.signals[0];
      this.waves.push({ id: this.waveSeq++, path: '', name: divider, sig: dummy, radix: 'binary', dividerLabel: divider || '-' });
      this.emit('wave');
      if (!pats.length) return;
    }
    if (!pats.length) pats.push('*');
    let n = 0;
    for (const p of pats) {
      const found = this.matchSignals(p, recursive);
      if (!found.length) this.out(`** Warning: (vsim-WLF-5000) No objects found matching '${p}'.`, 'warn');
      for (const f of found) {
        const path = `${f.scope.path}/${f.obj.name}`;
        if (this.waves.some(w => w.path === path)) continue;
        this.waves.push({ id: this.waveSeq++, path, name: path, sig: f.obj.sig, radix: radix ?? (f.obj.sig.enumNames ? 'symbolic' : this.defaultRadix) });
        n++;
      }
    }
    this.emit('wave');
    return n > 0 || pats.length === 0;
  }

  addWavePaths(paths: string[]) {
    for (const p of paths) {
      const f = this.findSignal(p);
      if (!f || this.waves.some(w => w.path === p)) continue;
      this.waves.push({ id: this.waveSeq++, path: p, name: p, sig: f.obj.sig, radix: f.obj.sig.enumNames ? 'symbolic' : this.defaultRadix });
    }
    this.emit('wave');
  }

  del(args: string[]) {
    if (args[0] !== 'wave') throw new Error('delete: use "delete wave <paths>|*"');
    const pats = args.slice(1).filter(a => !a.startsWith('-'));
    if (!pats.length || pats.includes('*')) this.waves = [];
    else {
      const res = pats.map(p => globRe(p));
      this.waves = this.waves.filter(w => !res.some(r => r.test(w.path) || r.test(w.path.split('/').pop()!)));
    }
    this.emit('wave');
  }

  radix(args: string[]) {
    const r = args.filter(a => !a.startsWith('-'))[0];
    if (!r) { this.out(this.defaultRadix); return; }
    this.defaultRadix = parseRadix(r);
    this.emit('wave');
  }

  // ------------------------------------------------------------ force / examine
  force(args: string[]) {
    const d = this.requireDesign();
    const k = d.kernel;
    let deposit = false;
    let repeat: number | null = null;
    let cancel: number | null = null;
    const pos: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-deposit') { deposit = true; continue; }
      if (a === '-freeze' || a === '-drive') continue;
      if (a === '-repeat' || a === '-r') { repeat = parseTime(args[++i], this.resolution); continue; }
      if (a === '-cancel') { cancel = parseTime(args[++i], this.resolution); continue; }
      pos.push(a);
    }
    const path = pos.shift();
    if (!path) throw new Error('force: missing signal name');
    const f = this.findSignal(path);
    if (!f) throw new Error(`(vsim-3140) Unable to find signal "${path}".`);
    const sig = f.obj.sig;
    // remaining: "v1 [t1][, v2 t2 ...]"
    const spec = pos.join(' ').split(',').map(s => s.trim()).filter(Boolean);
    const pairs = spec.map(s => {
      const [v, t] = s.split(/\s+/);
      return { v: parseValue(v, sig.w), t: t ? parseTime(t.replace(/^@/, ''), this.resolution) ?? 0 : 0 };
    });
    if (!pairs.length) throw new Error('force: missing value');
    const timer = { cancelled: false };
    this.forceTimers.push(timer);
    const base = k.now;
    const apply = (v: L.Vec) => {
      if (timer.cancelled) return;
      if (deposit) k.set(sig, v); else k.force(sig, v);
    };
    const schedCycle = (start: number) => {
      for (const p of pairs) {
        const at = start + p.t;
        if (at === k.now && start === base) apply(p.v);
        else k.schedule(at, () => apply(p.v));
      }
      if (repeat && repeat > 0) k.schedule(start + repeat, () => { if (!timer.cancelled) schedCycle(start + repeat!); });
    };
    schedCycle(base);
    if (cancel !== null) k.schedule(base + cancel, () => { timer.cancelled = true; if (!deposit) k.release(sig); });
    this.emit('time');
  }

  noforce(args: string[]) {
    const d = this.requireDesign();
    for (const p of args) {
      const f = this.findSignal(p);
      if (!f) throw new Error(`(vsim-3140) Unable to find signal "${p}".`);
      d.kernel.release(f.obj.sig);
    }
    this.emit('time');
  }

  examine(args: string[]) {
    this.requireDesign();
    let radix: Radix | undefined;
    let time: number | null = null;
    const vals: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-radix') { radix = parseRadix(args[++i]); continue; }
      if (a === '-time') { time = parseTime(args[++i], this.resolution); continue; }
      if (a.startsWith('-')) continue;
      const f = this.findSignal(a);
      if (!f) { const ms = this.matchSignals(a, false); if (!ms.length) throw new Error(`(vsim-3140) Unable to find signal "${a}".`); for (const m of ms) vals.push(this.fmtSig(m.obj.sig, radix, time)); continue; }
      vals.push(this.fmtSig(f.obj.sig, radix, time));
    }
    this.out(vals.length > 1 ? vals.map(v => (v.includes(' ') ? `{${v}}` : v)).join(' ') : vals[0] ?? '');
  }

  fmtSig(sig: Signal, radix?: Radix, time: number | null = null) {
    const v = time === null ? sig.value : sig.valueAt(time);
    return L.format(v, radix ?? this.defaultRadix, radix ? undefined : sig.enumNames);
  }

  env(args: string[]) {
    const d = this.requireDesign();
    if (!args.length) { this.out(this.scope?.path ?? d.root.path); return; }
    const s = this.findScope(args[0]);
    if (!s) throw new Error(`(vsim-3180) Unable to find region "${args[0]}".`);
    this.scope = s;
    this.out(`sim:${s.path}`);
    this.emit('scope');
  }

  setScope(s: Scope) { this.scope = s; this.emit('scope'); }

  show(args: string[]) {
    const d = this.requireDesign();
    const s = args[0] ? this.findScope(args[0]) : (this.scope ?? d.root);
    if (!s) throw new Error(`Unable to find region "${args[0]}".`);
    for (const c of s.children) this.out(`${c.name}  (${c.kind === 'instance' ? c.mod.unit.name : 'generate'})`);
    for (const o of s.objects) this.out(`${o.name}  ${o.dir === 'internal' ? 'Signal' : o.dir === 'in' ? 'In' : o.dir === 'out' ? 'Out' : 'InOut'}`);
  }

  describe(args: string[]) {
    for (const a of args) {
      const f = this.findSignal(a);
      if (!f) throw new Error(`Unable to find "${a}".`);
      const s = f.obj.sig;
      this.out(`${a}: ${s.w === 1 && s.msb === 0 && s.lsb === 0 ? 'Scalar' : `Array [${s.msb}:${s.lsb}]`}${s.signed ? ' signed' : ''}${s.enumNames ? ` enum (${s.enumNames.join(', ')})` : ''}`);
    }
  }

  find(args: string[]) {
    const recursive = args.includes('-r') || args.includes('-recursive');
    const pats = args.filter(a => !a.startsWith('-') && !['signals', 'nets', 'instances', 'objects'].includes(a));
    for (const p of pats.length ? pats : ['*']) for (const m of this.matchSignals(p, recursive)) this.out(`${m.scope.path}/${m.obj.name}`);
  }

  async doFile(args: string[]) {
    const name = args[0];
    if (!name) throw new Error('do: missing file name');
    const text = this.fs.read(name);
    if (text === undefined) throw new Error(`couldn't read file "${name}": no such file or directory`);
    // join continuation lines
    const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
    for (const l of lines) {
      const t = l.trim();
      if (!t || t.startsWith('#')) continue;
      const ok = await this.exec(t, true);
      if (!ok && /^(vlog|vcom|vsim)\b/.test(t)) { this.out(`** Error: Script "${name}" aborted at "${t}".`, 'err'); return false; }
    }
  }
}

// ------------------------------------------------------------ helpers

export function parseRadix(r: string): Radix {
  switch ((r ?? '').toLowerCase()) {
    case 'b': case 'bin': case 'binary': return 'binary';
    case 'h': case 'hex': case 'hexadecimal': return 'hex';
    case 'u': case 'unsigned': return 'unsigned';
    case 'd': case 'dec': case 'decimal': case 'signed': return 'decimal';
    case 'o': case 'oct': case 'octal': return 'octal';
    case 'a': case 'ascii': return 'ascii';
    case 's': case 'symbolic': return 'symbolic';
  }
  throw new Error(`Unknown radix "${r}"`);
}

export function parseValue(s: string, w: number): L.Vec {
  s = s.replace(/^"|"$/g, '').replace(/_/g, '');
  let m: RegExpExecArray | null;
  if ((m = /^(\d+)#([0-9a-fA-F]+)#?$/.exec(s))) return L.fromInt(BigInt(parseInt(m[2], parseInt(m[1], 10))), w);
  if ((m = /^(\d*)'([sS]?)([bBhHdDoO])([0-9a-fA-FxXzZ]+)$/.exec(s))) {
    const base = m[3].toLowerCase();
    if (base === 'd') return L.fromInt(BigInt(m[4]), w);
    const per = base === 'b' ? 1 : base === 'o' ? 3 : 4;
    let bits = '';
    for (const ch of m[4]) bits += /[xXzZ]/.test(ch) ? ch.repeat(per) : parseInt(ch, 16).toString(2).padStart(per, '0');
    return L.resize(L.fromBits(bits), w);
  }
  if ((m = /^[xX]"?([0-9a-fA-F]+)"?$/.exec(s)) && s.length > 1 && !/^[xX]+$/.test(s)) return L.resize(L.fromInt(BigInt('0x' + m[1]), Math.max(w, m[1].length * 4)), w);
  if (/^[01xXzZuUwWlLhH-]+$/.test(s) && (s.length > 1 || w === 1 || /[xXzZ]/.test(s))) {
    const v = L.fromBits(s);
    return v.w === 1 && w > 1 && !v.known ? (v.a ? L.allX(w) : L.allZ(w)) : L.resize(v, w);
  }
  if (/^-?\d+$/.test(s)) return L.fromInt(BigInt(s), w);
  if (s.toLowerCase() === 'true') return L.fromInt(1, w);
  if (s.toLowerCase() === 'false') return L.fromInt(0, w);
  throw new Error(`Invalid value "${s}"`);
}

export function globRe(p: string): RegExp {
  return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

function splitCommands(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false, brace = 0;
  for (const c of line) {
    if (c === '"' && brace === 0) q = !q;
    if (!q && c === '{') brace++;
    if (!q && c === '}') brace--;
    if (c === ';' && !q && brace === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

export function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') { const j = cmd.indexOf('"', i + 1); out.push(cmd.slice(i + 1, j < 0 ? undefined : j)); i = j < 0 ? cmd.length : j + 1; continue; }
    if (c === '{') {
      let depth = 1, j = i + 1;
      while (j < cmd.length && depth) { if (cmd[j] === '{') depth++; else if (cmd[j] === '}') depth--; j++; }
      out.push(cmd.slice(i + 1, j - 1)); i = j; continue;
    }
    let j = i;
    while (j < cmd.length && !/\s/.test(cmd[j])) j++;
    out.push(cmd.slice(i, j)); i = j;
  }
  return out;
}
