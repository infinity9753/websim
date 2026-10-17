// Browser-persisted flat file store for project sources.
import type { VFS } from '../engine/commands';

const KEY = 'websim.files.v1';

export class BrowserFS implements VFS {
  files = new Map<string, string>();
  order: string[] = [];
  private listeners = new Set<() => void>();

  constructor() { this.load(); }

  private load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { order: string[]; files: Record<string, string> };
      for (const n of data.order) if (n in data.files) { this.files.set(n, data.files[n]); this.order.push(n); }
    } catch { /* storage unavailable */ }
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ order: this.order, files: Object.fromEntries(this.files) }));
    } catch { /* storage unavailable or full */ }
    for (const l of this.listeners) l();
  }

  onChange(f: () => void) { this.listeners.add(f); }

  get empty() { return this.files.size === 0; }
  read(name: string) { return this.files.get(name); }
  list() { return [...this.order]; }
  has(name: string) { return this.files.has(name); }

  write(name: string, text: string) {
    if (!this.files.has(name)) this.order.push(name);
    this.files.set(name, text);
    this.save();
  }

  remove(name: string) {
    this.files.delete(name);
    this.order = this.order.filter(n => n !== name);
    this.save();
  }

  rename(from: string, to: string) {
    const t = this.files.get(from);
    if (t === undefined || this.files.has(to)) return false;
    this.files.delete(from);
    this.files.set(to, t);
    this.order = this.order.map(n => (n === from ? to : n));
    this.save();
    return true;
  }

  move(name: string, delta: number) {
    const i = this.order.indexOf(name);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.order.length) return;
    [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    this.save();
  }

  clear() { this.files.clear(); this.order = []; this.save(); }
}

export function langOf(name: string): 'verilog' | 'vhdl' | 'do' | 'text' {
  if (/\.(v|sv|vh|svh|vlg)$/i.test(name)) return 'verilog';
  if (/\.(vhd|vhdl)$/i.test(name)) return 'vhdl';
  if (/\.(do|tcl)$/i.test(name)) return 'do';
  return 'text';
}

const STATE_KEY = 'websim.state.v1';
export function loadState<T>(def: T): T {
  try { const r = localStorage.getItem(STATE_KEY); return r ? { ...def, ...JSON.parse(r) } : def; } catch { return def; }
}
export function saveState(s: unknown) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
