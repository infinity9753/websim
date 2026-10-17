// Simulation worker: runs the Session off the UI thread and streams state to it.
import { Session, isMarker, waveAttrs } from './commands';
import type { Scope } from './elab';
import type { Signal } from './kernel';
import type { Vec } from './logic';
import type { FromWorker, PDesign, PHist, PScope, PState, PVec, ToWorker } from './protocol';

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
const pv = (v: Vec): PVec => (v.rich ? { w: v.w, a: v.a, b: v.b, s: v.signed, u: v.u, k: v.k } : { w: v.w, a: v.a, b: v.b, s: v.signed });

const files = new Map<string, string>();
const session = new Session(
  {
    read: n => files.get(n),
    list: () => [...files.keys()],
    write: (n, t) => { files.set(n, t); post({ type: 'fileWrite', name: n, text: t }); },
  },
  (msg, kind) => post({ type: 'print', msg, kind }),
);
session.emitClear = () => post({ type: 'clear' });

// ---------------------------------------------------------------- state sync
const pending = new Set<string>();
let scheduled = false;
let sent = new Map<number, number>(); // signal id -> history length already sent
let designRef: unknown = null;

for (const ev of ['library', 'sim', 'time', 'wave', 'zoomfull', 'scope', 'running', 'compiled', 'debug', 'list', 'coverage', 'synth']) {
  session.on(ev as never, () => { pending.add(ev); schedule(); });
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(flush);
}

function snapScope(s: Scope, procIdx: Map<unknown, number>): PScope {
  return {
    name: s.name, path: s.path, kind: s.kind,
    unit: s.mod.unit.name, arch: s.mod.arch, lang: s.mod.lang,
    objects: s.objects.map(o => ({ name: o.name, sigId: o.sig.id, dir: o.dir })),
    memories: s.memories.map(m => ({ name: m.name, lo: m.mem.lo, hi: m.mem.hi, w: m.mem.w })),
    procs: s.procs.map(p => ({ idx: procIdx.get(p)!, name: p.info.name, scope: p.info.scope, file: p.info.file, line: p.info.line })),
    children: s.children.map(c => snapScope(c, procIdx)),
  };
}

function snapDesign(): PDesign | null {
  const d = session.design;
  if (!d) return null;
  const procIdx = new Map<unknown, number>();
  d.kernel.processes.forEach((p, i) => procIdx.set(p, i));
  const sigs = new Map<number, Signal>();
  for (const s of d.allScopes) for (const o of s.objects) sigs.set(o.sig.id, o.sig);
  return {
    top: d.top, loaded: d.loaded, resolution: d.kernel.resolution,
    root: snapScope(d.root, procIdx),
    signals: [...sigs.values()].map(s => ({ id: s.id, path: s.path, name: s.name, w: s.w, msb: s.msb, lsb: s.lsb, signed: s.signed, enumNames: s.enumNames, driven: !!s.drivers?.length, isReal: s.isReal })),
    df: (d.dataflow ?? []).map(n => ({
      kind: n.kind, name: n.name, scope: n.scope, file: n.file, line: n.line,
      reads: n.reads.filter(s => sigs.has(s.id)).map(s => s.id), writes: n.writes.filter(s => sigs.has(s.id)).map(s => s.id),
    })),
  };
}

function histDeltas(): PHist[] {
  const d = session.design;
  if (!d) return [];
  const out: PHist[] = [];
  for (const s of d.kernel.signals) {
    const n = s.times.length;
    let was = sent.get(s.id) ?? 0;
    if (epochs.get(s.id) !== s.histEpoch) { epochs.set(s.id, s.histEpoch); if (s.histEpoch) was = 0; }
    // always resend the last entry we sent: it may have been overwritten within the same time step
    const from = Math.max(0, Math.min(was - 1, n));
    if (n === was && was > 0 && s.hv[n - 1] === lastSentVal.get(s.id) && !s.forced === !forcedSent.get(s.id)) continue;
    const v: PVec[] = [];
    for (let i = from; i < n; i++) v.push(pv(s.valAt(i)));
    out.push({ id: s.id, from, t: s.times.slice(from), v, forced: !!s.forced, value: pv(s.value) });
    sent.set(s.id, n);
    lastSentVal.set(s.id, s.hv[n - 1]);
    forcedSent.set(s.id, !!s.forced);
  }
  return out;
}
const lastSentVal = new Map<number, Vec | number>();
const epochs = new Map<number, number>();
const forcedSent = new Map<number, boolean>();

function flush() {
  scheduled = false;
  const ev = [...pending];
  pending.clear();
  const st: PState = { events: ev, prompt: session.prompt, running: session.running, history: session.history };
  if (ev.includes('library') || ev.includes('compiled')) {
    st.libs = [...session.libs.libs].map(([name, l]) => ({ name, units: l.list(), tops: session.libs.topLevels(name) }));
    st.fileStatus = [...session.fileStatus];
    st.compiled = session.compiledSources;
  }
  const d = session.design;
  if (ev.includes('sim') || d !== designRef) {
    designRef = d;
    sent = new Map();
    lastSentVal.clear(); forcedSent.clear();
    st.design = snapDesign();
    st.lastVsim = session.lastVsim ? { top: session.lastVsim.top, lib: session.lastVsim.lib, cocotb: session.lastVsim.cocotb } : null;
    if (!ev.includes('sim')) st.events.push('sim');
  }
  if (d) {
    const k = d.kernel;
    const hs = k.historyStats();
    st.time = { now: k.now, delta: k.deltaCount, finished: k.finished, procStates: k.processes.map(p => (p.done ? 'd' : p.gen || p.armed ? 'w' : 'r')).join(''), histBytes: hs.bytes, histEntries: hs.entries };
    st.hist = histDeltas();
    const p = k.pausedAt;
    st.paused = p ? { file: p.file, line: p.line, proc: p.proc.name } : null;
    st.locals = p ? session.locals().map(l => ({ ...l, value: pv(l.value) })) : [];
    st.stack = p ? session.callStack() : [];
  } else st.paused = null;
  // these are also edited on the UI side: only send them when they changed here
  const simEv = st.events.includes('sim');
  if (simEv || ev.includes('scope')) st.scope = session.scope?.path ?? null;
  if (simEv || ev.includes('wave')) st.waves = session.waves.map(w => ({ id: w.id, path: w.path, name: w.name, sigId: w.sig?.id ?? 0, radix: w.radix, ...waveAttrs(w) }));
  if (simEv || ev.includes('debug')) st.breakpoints = session.breakpoints;
  if (ev.includes('synth')) {
    st.synth = session.lastSynth;
    const p = session.lastPnr;
    st.pnr = p && { run: p.run, top: p.top, device: p.device, base: p.base, ok: p.ok, util: p.util, fmax: p.fmax };
  }
  if (simEv || ev.includes('list')) st.lists = session.lists.map(l => ({ path: l.path, name: l.name, sigId: l.sig.id, radix: l.radix }));
  st.defaultRadix = session.defaultRadix;
  post({ type: 'state', state: st });
}

// ---------------------------------------------------------------- RPC
const methods: Record<string, (...a: any[]) => unknown> = {
  setScope: (path: string) => { const s = session.findScope(path); if (s) session.setScope(s); },
  addWavePaths: (paths: string[]) => session.addWavePaths(paths),
  setWaves: (ws: { id: number; path: string; name: string; radix: never; dividerLabel?: string; groupLabel?: string }[]) => {
    const fallback = session.design?.kernel.signals[0];
    session.waves = ws.flatMap(w => {
      const sig = isMarker(w) ? fallback : session.findSignal(w.path)?.obj.sig;
      return sig ? [{ ...w, sig }] : [];
    });
    session.emit('wave');
  },
  toggleBreakpoint: (f: string, l: number) => session.toggleBreakpoint(f, l),
  loadBreakpoints: (list: never) => session.loadBreakpoints(list),
  rebuild: (list: never) => session.rebuild(list),
  vcdText: (all: boolean) => session.vcdText(all),
  coverageLines: () => session.coverageLines(),
  pnrBitstream: () => session.lastPnr?.bin ?? null,
  listMemories: () => session.listMemories(),
  memWords: (path: string, from: number, count: number) => { const r = session.memWords(path, from, count); return r && { ...r, words: r.words.map(pv) }; },
  memDeposit: (path: string, addr: number, value: string) => session.memDeposit(path, addr, value),
  resetLibraries: () => { for (const l of session.libs.libs.values()) l.clear(); session.compiledSources = []; session.fileStatus.clear(); session.emit('library'); },
  quitSim: () => session.quitSim(),
  ensureLib: (n: string) => { session.libs.ensure(n); session.emit('library'); },
};

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'files':
      files.clear();
      for (const [n, t] of m.files) files.set(n, t);
      break;
    case 'break': session.breakRun(); break;
    case 'exec': {
      const ok = await session.exec(m.cmd, m.echo);
      flush();
      post({ type: 'done', id: m.id, value: ok });
      break;
    }
    case 'call': {
      try {
        const v = methods[m.method](...m.args);
        flush();
        post({ type: 'done', id: m.id, value: v });
      } catch (err) {
        post({ type: 'done', id: m.id, value: undefined, error: (err as Error).message });
      }
      break;
    }
  }
};
