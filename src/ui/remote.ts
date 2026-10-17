// UI-side proxy for the Session running in the simulation worker.
// It mirrors the worker's state (hierarchy, signal histories, waves, libraries, debug state)
// so panels can read it synchronously, and forwards commands and edits to the worker.
import { Vec, type Radix } from '../engine/logic';
import type { MsgKind, Breakpoint } from '../engine/commands';
import type { UnitInfo } from '../engine/library';
import type { FromWorker, PScope, PState, PVec, ToWorker } from '../engine/protocol';
import { fmtTime } from '../engine/format';
import { fmtReal, vecToReal } from '../engine/elab';
import * as L from '../engine/logic';
import { globRe } from '../engine/commands';
import type { BrowserFS } from './vfs';

const vec = (p: PVec) => new Vec(p.w, p.a, p.b, p.s, p.u ?? 0n, p.k ?? 0n);

export class MSignal {
  value: Vec;
  prev: Vec;
  times: number[] = [];
  vals: Vec[] = [];
  forced: Vec | null = null;
  drivers: unknown[] | null;
  isReal = false;
  constructor(public id: number, public path: string, public name: string, public w: number, public msb: number, public lsb: number, public signed: boolean, public enumNames: string[] | undefined, driven: boolean) {
    this.value = new Vec(w, 0n, 0n);
    this.prev = this.value;
    this.drivers = driven ? [true] : null;
  }
  valueAt(t: number): Vec {
    const ts = this.times;
    if (!ts.length || t < ts[0]) return this.vals[0] ?? this.value;
    let lo = 0, hi = ts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ts[m] <= t) lo = m; else hi = m - 1; }
    return this.vals[lo];
  }
}

export interface MProc { info: { name: string; scope: string; file?: string; line?: number }; done: boolean; gen: boolean | null; idx: number }
export interface MObj { name: string; sig: MSignal; dir: 'in' | 'out' | 'inout' | 'internal' }
export interface MScope {
  name: string; path: string; kind: string;
  mod: { unit: { name: string; lang: 'verilog' | 'vhdl' }; arch?: string; lang: 'verilog' | 'vhdl' };
  objects: MObj[];
  memories: { name: string; mem: { lo: number; hi: number; w: number } }[];
  procs: MProc[];
  children: MScope[];
  up: MScope | null;
}
export interface MDesign {
  top: string; loaded: string[]; root: MScope; allScopes: MScope[];
  kernel: { now: number; resolution: number; deltaCount: number; finished: boolean; signals: MSignal[] };
}
export interface MWave { id: number; path: string; name: string; sig: MSignal; radix: Radix; dividerLabel?: string; expanded?: boolean }

type Ev = 'library' | 'sim' | 'time' | 'wave' | 'zoomfull' | 'scope' | 'running' | 'files' | 'compiled' | 'debug';

export class RemoteSession {
  private worker: Worker;
  private listeners = new Map<Ev, Set<() => void>>();
  private seq = 1;
  private calls = new Map<number, (v: unknown) => void>();
  private sigs = new Map<number, MSignal>();
  private procs: MProc[] = [];
  private tops = new Map<string, string[]>();
  private applying = false;

  design: MDesign | null = null;
  scope: MScope | null = null;
  waves: MWave[] = [];
  running = false;
  defaultRadix: Radix = 'binary';
  history: string[] = [];
  breakpoints: Breakpoint[] = [];
  fileStatus = new Map<string, 'ok' | 'error'>();
  compiledSources: { file: string; lang: 'verilog' | 'vhdl'; lib: string }[] = [];
  lastVsim: { top: string; lib?: string } | null = null;
  prompt = 'WebSim>';
  paused: { file: string; line: number; proc: string } | null = null;
  locals: { name: string; value: Vec; enumNames?: string[]; where: string }[] = [];
  stack: string[] = [];
  emitClear?: () => void;
  libs = {
    libs: new Map<string, { list: () => UnitInfo[] }>([['work', { list: () => [] }]]),
    topLevels: (lib = 'work') => this.tops.get(lib) ?? [],
    ensure: (n: string) => { void this.call('ensureLib', n); },
  };

  constructor(public fs: BrowserFS, private print: (msg: string, kind?: MsgKind) => void) {
    this.worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.print(`** Error: simulation worker failed: ${e.message}`, 'err');
    const pushFiles = () => this.send({ type: 'files', files: fs.list().map(n => [n, fs.read(n)!]) });
    pushFiles();
    fs.onChange(pushFiles);
  }

  private send(m: ToWorker) { this.worker.postMessage(m); }

  private call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.seq++;
    return new Promise<T>(res => { this.calls.set(id, res as (v: unknown) => void); this.send({ type: 'call', id, method, args }); });
  }

  on(ev: Ev, f: () => void) { (this.listeners.get(ev) ?? this.listeners.set(ev, new Set()).get(ev)!).add(f); return () => this.listeners.get(ev)!.delete(f); }
  emit(ev: Ev) {
    // UI-side wave edits (reorder, radix, delete, dividers) are pushed to the worker
    if (ev === 'wave' && !this.applying) void this.call('setWaves', this.waves.map(w => ({ id: w.id, path: w.path, name: w.name, radix: w.radix, dividerLabel: w.dividerLabel })));
    for (const f of this.listeners.get(ev) ?? []) f();
  }

  get now() { return this.design?.kernel.now ?? 0; }
  get resolution() { return this.design?.kernel.resolution ?? 1000; }
  fmt(ps: number) { return fmtTime(ps, this.resolution); }

  exec(cmd: string, echo = true): Promise<boolean> {
    const id = this.seq++;
    return new Promise<boolean>(res => { this.calls.set(id, res as (v: unknown) => void); this.send({ type: 'exec', id, cmd, echo }); });
  }

  breakRun() { this.send({ type: 'break' }); }
  setScope(s: MScope) { this.scope = s; this.emitLocal('scope'); void this.call('setScope', s.path); }
  addWavePaths(paths: string[]) { void this.call('addWavePaths', paths); }
  toggleBreakpoint(file: string, line: number) { void this.call('toggleBreakpoint', file, line); }
  loadBreakpoints(list: { file: string; line: number; cond?: string }[]) { void this.call('loadBreakpoints', list); }
  rebuild(list: { file: string; lang: 'verilog' | 'vhdl'; lib: string }[]) { void this.call('rebuild', list); }
  quitSim() { void this.call('quitSim'); }
  resetLibraries() { void this.call('resetLibraries'); }
  vcdText(all: boolean): Promise<string> { return this.call<string>('vcdText', all); }
  listMemories() { return this.call<{ path: string; lo: number; hi: number; w: number }[]>('listMemories'); }
  async memWords(path: string, from: number, count: number) {
    const r = await this.call<{ lo: number; hi: number; w: number; words: PVec[] } | null>('memWords', path, from, count);
    return r && { ...r, words: r.words.map(vec) };
  }
  memDeposit(path: string, addr: number, value: string) { return this.call('memDeposit', path, addr, value); }

  private emitLocal(ev: Ev) { for (const f of this.listeners.get(ev) ?? []) f(); }

  // ------------------------------------------------------------ messages
  private onMessage(m: FromWorker) {
    switch (m.type) {
      case 'print': this.print(m.msg, m.kind); break;
      case 'clear': this.emitClear?.(); break;
      case 'fileWrite': this.fs.write(m.name, m.text); break;
      case 'done': {
        const f = this.calls.get(m.id);
        this.calls.delete(m.id);
        if (m.error) this.print(`** Error: ${m.error}`, 'err');
        f?.(m.value);
        break;
      }
      case 'state': this.apply(m.state); break;
    }
  }

  private apply(st: PState) {
    this.applying = true;
    try {
      if (st.libs) {
        this.libs.libs = new Map(st.libs.map(l => [l.name, { list: () => l.units }]));
        this.tops = new Map(st.libs.map(l => [l.name, l.tops]));
      }
      if (st.fileStatus) this.fileStatus = new Map(st.fileStatus);
      if (st.compiled) this.compiledSources = st.compiled;
      if (st.design !== undefined) this.buildDesign(st.design);
      if (st.hist) for (const h of st.hist) {
        const s = this.sigs.get(h.id);
        if (!s) continue;
        s.times.length = Math.min(s.times.length, h.from);
        s.vals.length = Math.min(s.vals.length, h.from);
        for (let i = 0; i < h.t.length; i++) { s.times.push(h.t[i]); s.vals.push(vec(h.v[i])); }
        s.value = vec(h.value);
        s.forced = h.forced ? s.value : null;
      }
      if (st.time && this.design) {
        const k = this.design.kernel;
        k.now = st.time.now; k.deltaCount = st.time.delta; k.finished = st.time.finished;
        const ps = st.time.procStates;
        for (const p of this.procs) { const c = ps[p.idx]; p.done = c === 'd'; p.gen = c === 'w' ? true : null; }
      }
      if (st.scope !== undefined) this.scope = st.scope && this.design ? this.findScope(st.scope) : this.design?.root ?? null;
      if (st.waves) {
        this.waves = st.waves.flatMap(w => {
          const sig = this.sigs.get(w.sigId) ?? (w.dividerLabel !== undefined ? [...this.sigs.values()][0] : undefined);
          return sig ? [{ id: w.id, path: w.path, name: w.name, sig, radix: w.radix, dividerLabel: w.dividerLabel }] : [];
        });
      }
      if (st.running !== undefined) this.running = st.running;
      if (st.paused !== undefined) this.paused = st.paused;
      if (st.locals) this.locals = st.locals.map(l => ({ ...l, value: vec(l.value) }));
      if (st.stack) this.stack = st.stack;
      if (st.breakpoints) this.breakpoints = st.breakpoints;
      if (st.prompt) this.prompt = st.prompt;
      if (st.history) this.history = st.history;
      if (st.defaultRadix) this.defaultRadix = st.defaultRadix;
      if (st.lastVsim !== undefined) this.lastVsim = st.lastVsim;
      const order: Ev[] = ['library', 'compiled', 'sim', 'scope', 'wave', 'time', 'running', 'debug', 'zoomfull'];
      for (const ev of order) if (st.events.includes(ev)) this.emitLocal(ev);
      if (st.hist?.length && !st.events.includes('time')) this.emitLocal('time');
    } finally {
      this.applying = false;
    }
  }

  private buildDesign(d: PState['design']) {
    this.sigs.clear();
    this.procs = [];
    if (!d) { this.design = null; this.scope = null; return; }
    for (const s of d.signals) { const m = new MSignal(s.id, s.path, s.name, s.w, s.msb, s.lsb, s.signed, s.enumNames, s.driven); m.isReal = !!s.isReal; this.sigs.set(s.id, m); }
    const all: MScope[] = [];
    const mk = (p: PScope, up: MScope | null): MScope => {
      const sc: MScope = {
        name: p.name, path: p.path, kind: p.kind,
        mod: { unit: { name: p.unit, lang: p.lang }, arch: p.arch, lang: p.lang },
        objects: p.objects.map(o => ({ name: o.name, sig: this.sigs.get(o.sigId)!, dir: o.dir })).filter(o => o.sig),
        memories: p.memories.map(m => ({ name: m.name, mem: { lo: m.lo, hi: m.hi, w: m.w } })),
        procs: p.procs.map(pr => { const mp: MProc = { info: { name: pr.name, scope: pr.scope, file: pr.file, line: pr.line }, done: false, gen: null, idx: pr.idx }; this.procs.push(mp); return mp; }),
        children: [], up,
      };
      all.push(sc);
      sc.children = p.children.map(c => mk(c, sc));
      return sc;
    };
    const root = mk(d.root, null);
    this.design = { top: d.top, loaded: d.loaded, root, allScopes: all, kernel: { now: 0, resolution: d.resolution, deltaCount: 0, finished: false, signals: [...this.sigs.values()] } };
    this.scope = root;
  }

  // ------------------------------------------------------------ hierarchy lookups (mirror of Session's)
  findScope(path: string): MScope | null {
    const d = this.design;
    if (!d) return null;
    path = path.replace(/^sim:/, '');
    let cur: MScope | null;
    let parts: string[];
    if (path.startsWith('/')) {
      parts = path.split('/').filter(Boolean);
      if (!parts.length) return d.root;
      if (parts[0] !== d.root.name) return null;
      cur = d.root; parts = parts.slice(1);
    } else { cur = this.scope ?? d.root; parts = path.split('/').filter(Boolean); }
    for (const p of parts) {
      if (p === '..') { cur = cur!.up ?? cur; continue; }
      const nx: MScope | undefined = cur!.children.find(c => c.name === p || c.name.toLowerCase() === p.toLowerCase());
      if (!nx) return null;
      cur = nx;
    }
    return cur;
  }

  findSignal(path: string): { scope: MScope; obj: MObj } | null {
    path = path.replace(/^sim:/, '');
    const i = path.lastIndexOf('/');
    const sc = i < 0 ? (this.scope ?? this.design?.root ?? null) : this.findScope(path.slice(0, i) || '/');
    if (!sc) return null;
    const leaf = path.slice(i + 1);
    const obj = sc.objects.find(o => o.name === leaf) ?? sc.objects.find(o => o.name.toLowerCase() === leaf.toLowerCase());
    return obj ? { scope: sc, obj } : null;
  }

  matchSignals(pattern: string, recursive: boolean): { scope: MScope; obj: MObj }[] {
    const i = pattern.lastIndexOf('/');
    const base = i < 0 ? (this.scope ?? this.design?.root ?? null) : this.findScope(pattern.slice(0, i) || '/');
    if (!base) return [];
    const re = globRe(pattern.slice(i + 1));
    const out: { scope: MScope; obj: MObj }[] = [];
    const visit = (s: MScope) => { for (const o of s.objects) if (re.test(o.name)) out.push({ scope: s, obj: o }); if (recursive) for (const c of s.children) visit(c); };
    visit(base);
    return out;
  }
}

/** Display text for a signal value (reals as numbers, enums by name). */
export function fmtSig(sig: MSignal, v: Vec, radix: Radix, enumNames?: string[]): string {
  if (sig.isReal) return fmtReal(vecToReal(v));
  return L.format(v, radix, enumNames);
}
