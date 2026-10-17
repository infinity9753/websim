// Discrete-event simulation kernel: time wheel, delta cycles, regions.
import { Vec, resolve, resize } from './logic';

export type Waker = (sig: Signal | Memory) => void;

let nextSigId = 1;

export class Signal {
  readonly id = nextSigId++;
  value: Vec;
  prev: Vec;
  lastEvent = -1;
  lastStamp = -1;
  drivers: Driver[] | null = null;
  forced: Vec | null = null;
  listeners: Set<Waker> | null = null;
  times: number[] = [];
  vals: Vec[] = [];
  enumNames?: string[];
  kind: 'in' | 'out' | 'inout' | 'internal' = 'internal';
  isReal = false;

  constructor(
    public path: string,
    public name: string,
    public w: number,
    public msb: number,
    public lsb: number,
    public signed: boolean,
    init: Vec,
    /** Plain variables (function locals, VHDL variables) are not traced. */
    public isVar = false,
  ) {
    this.value = init;
    this.prev = init;
  }

  /** Bit offset (from LSB) of a declared index; -1 when out of range. */
  offsetOf(i: number): number {
    if (this.msb >= this.lsb) return i >= this.lsb && i <= this.msb ? i - this.lsb : -1;
    return i <= this.lsb && i >= this.msb ? this.lsb - i : -1;
  }

  /** Value at a given time (from the recorded history). */
  valueAt(t: number): Vec {
    const ts = this.times;
    if (ts.length === 0 || t < ts[0]) return this.vals.length ? this.vals[0] : this.value;
    let lo = 0, hi = ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return this.vals[lo];
  }
}

export class Memory {
  listeners: Set<Waker> | null = null;
  constructor(public path: string, public name: string, public w: number, public lo: number, public hi: number, public signed: boolean, public words: Vec[], public elemMsb: number, public elemLsb: number, public enumNames?: string[]) {}
  index(i: number): number { return i >= this.lo && i <= this.hi ? i - this.lo : -1; }
}

export class Driver {
  constructor(public sig: Signal, public value: Vec, public owner: string) {}
}

export type Wait =
  | { t: 'delay'; d: number }
  | { t: 'sens'; sigs: (Signal | Memory)[]; test?: () => boolean; timeout?: number }
  | { t: 'stop' }
  | { t: 'done' };

export class FinishEx { constructor(public code = 0) {} }
/** Thrown to terminate the current process without ending the simulation. */
export class StopProcEx { }

export interface ProcInfo { name: string; scope: string; file?: string; line?: number }

export class Process {
  gen: Generator<Wait, void, void> | null = null;
  done = false;
  waitingOn: (Signal | Memory)[] | null = null;
  waker: Waker | null = null;
  timer: { cancelled: boolean } | null = null;
  constructor(public k: Kernel, public info: ProcInfo, public start: () => Generator<Wait, void, void>) {}
}

interface TimedEvent { fn: () => void; nba: boolean }

/** Binary min-heap of numbers. */
class TimeHeap {
  a: number[] = [];
  get size() { return this.a.length; }
  peek() { return this.a[0]; }
  push(v: number) {
    const a = this.a; a.push(v);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p] <= v) break; a[i] = a[p]; i = p; }
    a[i] = v;
  }
  pop(): number {
    const a = this.a; const top = a[0]; const last = a.pop()!;
    if (a.length) {
      let i = 0; const n = a.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        let mv = last;
        if (l < n && a[l] < mv) { m = l; mv = a[l]; }
        if (r < n && a[r] < mv) { m = r; mv = a[r]; }
        if (m === i) break;
        a[i] = a[m]; i = m;
      }
      a[i] = last;
    }
    return top;
  }
}

export type RunResult = 'paused' | 'finished' | 'stopped' | 'idle' | 'error' | 'budget';

export interface KernelHost {
  print(msg: string): void;
  readFile?(name: string): string | undefined;
  writeFile?(name: string, text: string): void;
}

export class Kernel {
  now = 0;
  deltaCount = 0;
  /** Increments every delta cycle; used for 'event / rising_edge. */
  stamp = 0;
  iterationLimit = 10000;
  active: (() => void)[] = [];
  activeHead = 0;
  inactive: (() => void)[] = [];
  nba: (() => void)[] = [];
  postponed: (() => void)[] = [];
  monitors: (() => void)[] = [];
  heap = new TimeHeap();
  timed = new Map<number, TimedEvent[]>();
  finished = false;
  stopRequested = false;
  breakRequested = false;
  errorMsg: string | null = null;
  current: Process | null = null;
  signals: Signal[] = [];
  processes: Process[] = [];
  resolution = 1000; // ps per display unit
  monitorOn = true;
  randSeed = 0;
  started = false;
  lastStopInfo = '';
  // ---- debugging: breakpoints and stepping
  breakpoints = new Map<string, { cond?: () => boolean }>();
  stepMode: { kind: 'into' } | { kind: 'over'; proc: Process; depth: number } | null = null;
  /** Location where execution is currently paused (for the UI). */
  pausedAt: { file: string; line: number; proc: ProcInfo; scope?: unknown; stack?: string[] } | null = null;
  /** Statements executed in the current process activation (zero-delay loop guard). */
  ops = 0;
  get dbgOn() { return this.stepMode !== null || this.breakpoints.size > 0; }

  /** Called before every statement when debugging is active; yields 'stop' to pause there. */
  *hook(file: string, line: number, depth: number, scope?: unknown, stack?: string[]): Generator<Wait, void, void> {
    const p = this.current;
    let hit = false;
    const sm = this.stepMode;
    if (sm) hit = sm.kind === 'into' || (sm.proc === p && depth <= sm.depth);
    if (!hit) {
      const bp = this.breakpoints.get(`${file}:${line}`);
      if (bp && (!bp.cond || bp.cond())) hit = true;
    }
    if (!hit || !p) return;
    this.stepMode = null;
    this.pausedAt = { file, line, proc: p.info, scope, stack };
    this.lastStopInfo = `${sm ? 'Stepped to' : 'Break in Process'} ${p.info.name} at ${file} line ${line}`;
    (p as any).depthAtStop = depth;
    yield { t: 'stop' };
    this.pausedAt = null;
  }

  /** $dumpfile / $dumpvars requests: written out by the session after each run. */
  dumpFile = 'dump.vcd';
  dumpItems: { path: string; levels: number }[] | null = null;

  constructor(public host: KernelHost) {}

  // ---------- scheduling ----------
  schedule(at: number, fn: () => void, nba = false) {
    let list = this.timed.get(at);
    if (!list) { list = []; this.timed.set(at, list); this.heap.push(at); }
    list.push({ fn, nba });
  }
  activate(fn: () => void) { this.active.push(fn); }

  // ---------- signal updates ----------
  set(sig: Signal, v: Vec) {
    if (v.w !== sig.w) v = fixWidth(v, sig.w);
    if (sig.signed !== v.signed) v = v.withSign(sig.signed);
    if (sig.forced) { sig.prev = v; return; } // remember underlying value? (deposit while forced is ignored)
    this.commit(sig, v);
  }

  commit(sig: Signal, v: Vec) {
    const old = sig.value;
    if (old.a === v.a && old.b === v.b) return;
    sig.prev = old;
    sig.value = v;
    if (sig.isVar) return;
    sig.lastEvent = this.now;
    sig.lastStamp = this.stamp;
    const ts = sig.times;
    if (ts.length && ts[ts.length - 1] === this.now) {
      sig.vals[sig.vals.length - 1] = v;
      // collapse no-op glitch inside one time step
      if (sig.vals.length > 1 && sig.vals[sig.vals.length - 2].equals(v)) { ts.pop(); sig.vals.pop(); }
    } else { ts.push(this.now); sig.vals.push(v); }
    if (sig.listeners) for (const l of [...sig.listeners]) l(sig);
  }

  updateDriver(d: Driver, v: Vec) {
    if (v.w !== d.sig.w) v = fixWidth(v, d.sig.w);
    d.value = v;
    const sig = d.sig;
    const drv = sig.drivers!;
    const r = drv.length === 1 ? v : resolve(sig.w, drv.map(x => x.value));
    this.set(sig, r);
  }

  memWrite(m: Memory, idx: number, v: Vec) {
    const old = m.words[idx];
    if (old.a === v.a && old.b === v.b) return;
    m.words[idx] = v;
    if (m.listeners) for (const l of [...m.listeners]) l(m);
  }

  /** Run `fn` once, the next time a sensitivity wait is satisfied (no process is suspended). */
  onceEvent(w: Extract<Wait, { t: 'sens' }>, fn: () => void, nba = false) {
    const waker: Waker = () => {
      if (w.test && !w.test()) return;
      for (const s of w.sigs) this.unlisten(s, waker);
      if (nba) this.nba.push(fn); else this.activate(fn);
    };
    for (const s of w.sigs) this.listen(s, waker);
  }

  listen(s: Signal | Memory, w: Waker) { (s.listeners ??= new Set()).add(w); }
  unlisten(s: Signal | Memory, w: Waker) { s.listeners?.delete(w); }

  force(sig: Signal, v: Vec) {
    v = fixWidth(v, sig.w);
    if (!sig.forced) sig.prev = sig.value; // underlying
    const underlying = sig.forced ? sig.prev : sig.value;
    sig.forced = null;
    this.commit(sig, v);
    sig.prev = underlying;
    sig.forced = v;
  }
  release(sig: Signal) {
    if (!sig.forced) return;
    const underlying = sig.prev;
    sig.forced = null;
    if (sig.drivers) this.commit(sig, sig.drivers.length === 1 ? sig.drivers[0].value : resolve(sig.w, sig.drivers.map(x => x.value)));
    else this.commit(sig, underlying);
  }

  // ---------- processes ----------
  addProcess(p: Process) {
    this.processes.push(p);
    this.activate(() => this.resume(p));
  }

  resume(p: Process) {
    if (p.done) return;
    if (!p.gen) p.gen = p.start();
    this.current = p;
    this.ops = 0;
    let r: IteratorResult<Wait, void>;
    try {
      r = p.gen.next();
    } catch (e) {
      this.current = null;
      p.done = true;
      if (e instanceof FinishEx) { this.finished = true; return; }
      if (e instanceof StopProcEx) return;
      this.errorMsg = `${(e as Error)?.message ?? String(e)} (process ${p.info.scope}/${p.info.name})`;
      return;
    }
    this.current = null;
    if (r.done) { p.done = true; return; }
    const w = r.value;
    switch (w.t) {
      case 'delay':
        if (w.d <= 0) this.inactive.push(() => this.resume(p));
        else this.schedule(this.now + w.d, () => this.resume(p));
        return;
      case 'sens': {
        const timer = w.timeout !== undefined ? { cancelled: false } : null;
        const waker: Waker = () => {
          if (w.test && !w.test()) return;
          for (const s of w.sigs) this.unlisten(s, waker);
          if (timer) timer.cancelled = true;
          this.activate(() => this.resume(p));
        };
        for (const s of w.sigs) this.listen(s, waker);
        if (timer) {
          this.schedule(this.now + w.timeout!, () => {
            if (timer.cancelled) return;
            for (const s of w.sigs) this.unlisten(s, waker);
            this.resume(p);
          });
        }
        return;
      }
      case 'stop':
        this.stopRequested = true;
        this.activate(() => this.resume(p));
        return;
      case 'done':
        p.done = true;
        return;
    }
  }

  // ---------- main loop ----------
  /** Advance until `until` (ps, inclusive of events at that time? no: events at `until` are not run) */
  run(until: number, budgetMs = 50): RunResult {
    const t0 = Date.now();
    this.started = true;
    for (;;) {
      if (this.finished) return 'finished';
      const r = this.settle();
      if (r) return r;
      if (this.finished) return 'finished';
      if (this.heap.size === 0) return 'idle';
      const next = this.heap.peek();
      if (next > until) { this.now = until; return 'paused'; }
      if (this.breakRequested) { this.breakRequested = false; return 'stopped'; }
      if (Date.now() - t0 > budgetMs) return 'budget';
      this.heap.pop();
      this.now = next;
      this.deltaCount = 0;
      this.stamp++;
      const evs = this.timed.get(next)!;
      this.timed.delete(next);
      for (const e of evs) { if (e.nba) this.nba.push(e.fn); else this.active.push(e.fn); }
    }
  }

  /** Run all regions of the current time step until quiescent. */
  private settle(): RunResult | null {
    for (;;) {
      while (this.activeHead < this.active.length) {
        const fn = this.active[this.activeHead++];
        fn();
        if (this.finished) { this.compact(); this.runPostponed(); return 'finished'; }
        if (this.stopRequested) { this.stopRequested = false; this.compact(); return 'stopped'; }
        if (this.errorMsg) { this.compact(); return 'error'; }
      }
      this.active.length = 0; this.activeHead = 0;
      if (this.inactive.length) { const x = this.inactive; this.inactive = this.active; this.active = x; continue; }
      if (this.nba.length) {
        if (++this.deltaCount > this.iterationLimit) {
          this.errorMsg = `Iteration limit ${this.iterationLimit} reached at time ${this.now} ps.`;
          return 'error';
        }
        this.stamp++;
        const n = this.nba; this.nba = [];
        for (const f of n) f();
        continue;
      }
      break;
    }
    this.runPostponed();
    return null;
  }

  private compact() {
    if (this.activeHead > 0) { this.active.splice(0, this.activeHead); this.activeHead = 0; }
  }

  private runPostponed() {
    if (this.postponed.length) { const p = this.postponed; this.postponed = []; for (const f of p) f(); }
    if (this.monitorOn) for (const m of this.monitors) m();
  }

  get pending(): boolean { return this.heap.size > 0 || this.active.length > this.activeHead || this.nba.length > 0; }
  get nextTime(): number | undefined { return this.heap.size ? this.heap.peek() : undefined; }

  random(): number {
    // 32-bit LCG (deterministic per run)
    this.randSeed = (Math.imul(this.randSeed, 1103515245) + 12345) | 0;
    return this.randSeed;
  }
}

export function fixWidth(v: Vec, w: number): Vec {
  return v.w === w ? v : resize(v, w, false);
}
