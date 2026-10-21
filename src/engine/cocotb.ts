// cocotb-compatible Python testbenches (#46). Pyodide (CPython in WebAssembly) runs in the simulation worker,
// and the Python side (./cocotb/*.py) drives the kernel through the _websim bridge in place of VPI/GPI.
import type { Design, Scope } from './elab';
import type { Memory, Signal } from './kernel';
import { fromBits, fromInt, toBin } from './logic';
import { newPyodide, type Py } from './pyodide';

const PY_SOURCES = import.meta.glob('./cocotb/*.py', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

type Kind = 'out' | 'err' | 'warn' | 'note';
let python: Promise<Py> | null = null;
let print: (msg: string, kind?: Kind) => void = () => {};

/** Load Pyodide once per worker, with the cocotb-compatible package installed in /websim_py. */
function loadPython(): Promise<Py> {
  python ??= (async () => {
    const py = await newPyodide({ stdout: (s: string) => print(s), stderr: (s: string) => print(s, 'err') });
    py.FS.mkdirTree('/websim_py/cocotb');
    for (const [p, src] of Object.entries(PY_SOURCES)) py.FS.writeFile(`/websim_py/cocotb/${p.split('/').pop()}`, src);
    py.runPython("import sys; sys.path[:0] = ['/websim_py', '/websim_proj']");
    return py;
  })();
  python.catch(() => { python = null; });
  return python;
}

export interface CocotbHost {
  out(msg: string, kind?: Kind): void;
  read(name: string): string | undefined;
  list(): string[];
  resolution: number;
}

type Entry = { k: 'scope'; s: Scope } | { k: 'sig'; sig: Signal; vhdl: boolean } | { k: 'mem'; mem: Memory };

/** One cocotb test module attached to a loaded design. */
export class CocotbRun {
  /** Number of failed tests once the regression is over (-1 while running). */
  failures = -1;
  private ids: Entry[] = [];
  private idOf = new Map<object, number>();
  private cancels = new Map<number, () => void>();
  private dispatch: Py = null;
  private ended: Py = null;
  private dead = false;
  /** Region of the callback being dispatched: 'ro' is the postponed region, where new events need a new time slot. */
  private phase: 'a' | 'ro' = 'a';

  constructor(private d: Design, private host: CocotbHost) {}

  private id(e: Entry, key: object): number {
    let i = this.idOf.get(key);
    if (i === undefined) { i = this.ids.push(e) - 1; this.idOf.set(key, i); }
    return i;
  }

  /** Load Python, import the test module and arm the regression to start at time 0. */
  async attach(module: string, testcases: string[]): Promise<boolean> {
    print = (m, k) => this.host.out(m, k);
    this.host.out('Loading Python (Pyodide) for cocotb tests…');
    let py: Py;
    try { py = await loadPython(); } catch (e) { this.host.out(`** Error: (cocotb) cannot load Python: ${(e as Error).message}`, 'err'); return false; }
    if (this.dead) return false;
    py.runPython("import shutil; shutil.rmtree('/websim_proj', ignore_errors=True)");
    py.FS.mkdirTree('/websim_proj');
    for (const f of this.host.list().filter(f => /\.py$/i.test(f))) {
      const i = f.lastIndexOf('/');
      if (i > 0) py.FS.mkdirTree(`/websim_proj/${f.slice(0, i)}`);
      py.FS.writeFile(`/websim_proj/${f}`, this.host.read(f) ?? '');
    }
    const path = module.replace(/\.py$/i, '');
    const slash = path.lastIndexOf('/');
    const name = path.slice(slash + 1);
    if (!this.host.list().some(f => f.replace(/\.py$/i, '') === path)) { this.host.out(`** Error: (cocotb) test module "${path}.py" not found in the project`, 'err'); return false; }
    py.registerJsModule('_websim', this.bridge());
    py.globals.set('_extra_path', slash > 0 ? `/websim_proj/${path.slice(0, slash)}` : '');
    // fresh imports of the package, the bridge and the project modules for every run
    py.runPython(`import sys, importlib
for _m in [m for m, v in list(sys.modules.items()) if m in ('_websim', 'cocotb') or m.startswith('cocotb.') or (getattr(v, '__file__', None) or '').startswith('/websim_proj/')]:
    del sys.modules[_m]
if _extra_path and _extra_path not in sys.path: sys.path.insert(0, _extra_path)
importlib.invalidate_caches()`);
    const core = py.pyimport('cocotb._core');
    const root = this.d.root;
    let n: number;
    try {
      n = core._init(name, { id: this.id({ k: 'scope', s: root }, root), name: root.name, path: root.path }, py.toPy(testcases));
    } catch (e) {
      this.pyError(e);
      return false;
    }
    this.dispatch = core._dispatch;
    this.ended = core._sim_ended;
    const start = core._start_token();
    this.host.out(`cocotb: ${n} test${n === 1 ? '' : 's'} in ${name}`);
    // before the design's own time-0 processes, like a start-of-simulation callback
    const k = this.d.kernel;
    k.active.splice(k.activeHead, 0, () => this.fire(start, 'a'));
    return true;
  }

  /** Python traceback of an import/test-loading error, without the importer's frames. */
  private pyError(e: unknown) {
    const lines = String((e as Error).message ?? e).split('\n');
    let skip = false;
    for (const l of lines) {
      if (/^\s+File "/.test(l)) skip = !l.includes('/websim_proj/');
      else if (!/^\s{4}/.test(l)) skip = false;
      if (!skip && l.trim() && !/^\s*\^+\s*$/.test(l)) this.host.out(l, 'err');
    }
  }

  private fire(tok: number, phase: 'a' | 'ro') {
    if (this.dead) return;
    this.phase = phase;
    try {
      this.dispatch(tok, phase);
    } catch (e) {
      this.pyError(e);
      this.d.kernel.errorMsg = 'cocotb: internal error';
    } finally {
      this.phase = 'a';
    }
  }

  /** The simulation stopped for good (ran out of events or $finish) while tests may still be waiting. */
  simEnded(reason: string) {
    if (this.dead || this.failures >= 0 || !this.ended) return;
    try { this.ended(reason); } catch (e) { this.pyError(e); }
  }

  detach() {
    this.dead = true;
    for (const c of this.cancels.values()) c();
    this.cancels.clear();
    this.dispatch?.destroy(); this.ended?.destroy();
    this.dispatch = this.ended = null;
  }

  private bridge() {
    const k = this.d.kernel;
    const sigOf = (id: number) => { const e = this.ids[id]; if (e?.k !== 'sig' && e?.k !== 'mem') throw new Error('not a signal'); return e; };
    const later = (tok: number, cancel: () => void) => this.cancels.set(tok, cancel);
    const once = (tok: number, phase: 'a' | 'ro' = 'a') => {
      const c = { off: false };
      later(tok, () => { c.off = true; });
      return () => { if (c.off) return; this.cancels.delete(tok); this.fire(tok, phase); };
    };
    const bit0 = (v: { a: bigint; b: bigint }) => ((v.b & 1n) ? -1 : Number(v.a & 1n));
    return {
      now: () => k.now,
      precision: () => this.host.resolution,
      lookup: (id: number, name: string) => {
        const e = this.ids[id];
        if (e?.k !== 'scope') return undefined;
        const s = e.s, lc = name.toLowerCase();
        const pick = <T extends { name: string }>(xs: T[]) => xs.find(x => x.name === name) ?? xs.find(x => x.name.toLowerCase() === lc);
        const c = pick(s.children);
        if (c) return { id: this.id({ k: 'scope', s: c }, c), kind: 'scope' };
        const o = pick(s.objects);
        if (o) {
          const vhdl = s.mod.lang === 'vhdl';
          return { id: this.id({ k: 'sig', sig: o.sig, vhdl }, o.sig), kind: vhdl && o.t.isInt ? 'int' : o.sig.w === 1 ? 'bit' : 'vec', w: o.sig.w, signed: o.sig.signed };
        }
        const m = pick(s.memories);
        if (m) return { id: this.id({ k: 'mem', mem: m.mem }, m.mem), kind: 'mem', w: m.mem.w, lo: m.mem.lo, hi: m.mem.hi };
        if (s.children.some(x => x.name.toLowerCase().startsWith(lc + '[') || x.name.toLowerCase().startsWith(lc + '('))) return { id, kind: 'genarray' };
        return undefined;
      },
      names: (id: number) => {
        const e = this.ids[id];
        return e?.k === 'scope' ? [...e.s.children.map(c => c.name), ...e.s.objects.map(o => o.name), ...e.s.memories.map(m => m.name)] : [];
      },
      get: (id: number, idx: number) => {
        const e = sigOf(id);
        if (e.k === 'sig') return toBin(e.sig.value);
        const i = e.mem.index(idx);
        if (i < 0) throw new Error(`index ${idx} out of range`);
        return toBin(e.mem.words[i]);
      },
      put: (id: number, idx: number, bits: string, action: number) => {
        const e = sigOf(id);
        if (e.k === 'mem') { const i = e.mem.index(idx); if (i >= 0) k.memWrite(e.mem, i, fromBits(bits, e.mem.signed)); return; }
        const sig = e.sig;
        if (action === 2) k.release(sig);
        else if (action === 3) k.force(sig, sig.value);
        else if (action === 1) k.force(sig, fromBits(bits, sig.signed));
        else k.set(sig, fromBits(bits, sig.signed));
      },
      timer: (d: number, tok: number) => k.schedule(k.now + d, once(tok)),
      edge: (id: number, idx: number, kind: number, tok: number) => {
        const e = sigOf(id);
        const target = e.k === 'sig' ? e.sig : e.mem;
        const read = () => (e.k === 'sig' ? e.sig.value : e.mem.words[e.mem.index(idx)]);
        let prev = toBin(read());
        const go = once(tok);
        const waker = () => {
          const v = read();
          if (e.k === 'mem') { const b = toBin(v); if (b === prev) return; prev = b; }
          if ((kind === 1 && bit0(v) !== 1) || (kind === 2 && bit0(v) !== 0)) return;
          k.unlisten(target, waker);
          k.activate(go);
        };
        k.listen(target, waker);
        const cancel = this.cancels.get(tok)!;
        later(tok, () => { cancel(); k.unlisten(target, waker); });
      },
      rw: (tok: number) => { k.readWrite.push(once(tok)); },
      ro: (tok: number) => { k.postponed.push(once(tok, 'ro')); },
      next: (tok: number) => {
        const go = once(tok);
        k.postponed.push(() => { const t = k.nextTime; if (t !== undefined) k.schedule(t, go); });
      },
      soon: (tok: number) => { if (this.phase === 'ro') k.schedule(k.now, once(tok)); else k.activate(once(tok)); },
      cancel: (tok: number) => { this.cancels.get(tok)?.(); this.cancels.delete(tok); },
      clock: (id: number, period: number, high: number, startHigh: boolean, tok: number) => {
        const e = sigOf(id);
        if (e.k !== 'sig') throw new Error('Clock needs a signal');
        const sig = e.sig;
        let level = startHigh, off = false;
        const tick = () => {
          if (off || this.dead) return;
          k.set(sig, fromInt(level ? 1 : 0, sig.w, sig.signed));
          const d = level ? high : period - high;
          level = !level;
          k.schedule(k.now + d, tick);
        };
        later(tok, () => { off = true; });
        tick();
      },
      log: (msg: string, kind: Kind) => this.host.out(msg, kind),
      done: (failed: number) => { this.failures = failed; },
      finish: () => { k.finished = true; },
    };
  }
}
