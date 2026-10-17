// Browser-persisted project file store. Names may contain folders ("rtl/alu.v"); `order` is the compile order.
import type { VFS } from '../engine/commands';

const KEY = 'websim.files.v1';
const PROJECTS_KEY = 'websim.projects.v1';
const STATE_KEY = 'websim.state.v1';

// ---------------------------------------------------------------- projects

export interface ProjectInfo { id: string; name: string }
interface Registry { current: string; list: ProjectInfo[] }

/** Storage key of a project's data; the first project keeps the original (pre-projects) keys. */
function keyFor(base: string, id: string) { return id === 'default' ? base : `${base}:${id}`; }

function readRegistry(): Registry {
  try {
    const r = JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? 'null') as Registry | null;
    if (r?.list?.length) return r;
  } catch { /* ignore */ }
  return { current: 'default', list: [{ id: 'default', name: 'Default' }] };
}
function writeRegistry(r: Registry) { try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(r)); } catch { /* ignore */ } }

export const projects = {
  list(): ProjectInfo[] { return readRegistry().list; },
  current(): ProjectInfo { const r = readRegistry(); return r.list.find(p => p.id === r.current) ?? r.list[0]; },
  /** Create an empty project (no example is loaded into it) and return its id. */
  create(name: string): string {
    const r = readRegistry();
    const id = 'p' + Date.now().toString(36);
    r.list.push({ id, name });
    writeRegistry(r);
    try { localStorage.setItem(keyFor(STATE_KEY, id), JSON.stringify({ seen: true })); } catch { /* ignore */ }
    return id;
  },
  rename(id: string, name: string) { const r = readRegistry(); const p = r.list.find(x => x.id === id); if (p) { p.name = name; writeRegistry(r); } },
  /** Make another project current; the caller reloads the page. */
  select(id: string) { const r = readRegistry(); if (r.list.some(p => p.id === id)) { r.current = id; writeRegistry(r); } },
  remove(id: string) {
    const r = readRegistry();
    if (r.current === id || r.list.length < 2) return false;
    r.list = r.list.filter(p => p.id !== id);
    writeRegistry(r);
    try { localStorage.removeItem(keyFor(KEY, id)); localStorage.removeItem(keyFor(STATE_KEY, id)); } catch { /* ignore */ }
    return true;
  },
};

// ---------------------------------------------------------------- files

export function dirOf(name: string) { const i = name.lastIndexOf('/'); return i < 0 ? '' : name.slice(0, i); }
export function baseOf(name: string) { return name.slice(name.lastIndexOf('/') + 1); }

export class BrowserFS implements VFS {
  files = new Map<string, string>();
  order: string[] = [];
  /** Folders that exist without files in them (folders of files are implicit). */
  folders = new Set<string>();
  private listeners = new Set<() => void>();
  private key: string;

  constructor(projectId = projects.current().id) { this.key = keyFor(KEY, projectId); this.load(); }

  private load() {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return;
      const data = JSON.parse(raw) as { order: string[]; files: Record<string, string>; folders?: string[] };
      for (const n of data.order) if (n in data.files) { this.files.set(n, data.files[n]); this.order.push(n); }
      for (const d of data.folders ?? []) this.folders.add(d);
    } catch { /* storage unavailable */ }
  }

  private save() {
    try {
      localStorage.setItem(this.key, JSON.stringify({ order: this.order, files: Object.fromEntries(this.files), folders: [...this.folders] }));
    } catch { /* storage unavailable or full */ }
    for (const l of this.listeners) l();
  }

  /** Every folder: explicit ones and the parents of all files, sorted. */
  allFolders(): string[] {
    const out = new Set(this.folders);
    for (const f of this.order) for (let d = dirOf(f); d; d = dirOf(d)) out.add(d);
    return [...out].sort();
  }

  addFolder(path: string) { path = path.replace(/^\/+|\/+$/g, ''); if (path) { this.folders.add(path); this.save(); } }

  /** Remove a folder and everything in it. */
  removeFolder(path: string) {
    const inside = (n: string) => n === path || n.startsWith(path + '/');
    for (const f of this.order.filter(inside)) this.files.delete(f);
    this.order = this.order.filter(n => !inside(n));
    for (const d of [...this.folders]) if (inside(d)) this.folders.delete(d);
    this.save();
  }

  /** Rename a folder (moves its files and subfolders); false if a target name is taken. */
  renameFolder(from: string, to: string) {
    to = to.replace(/^\/+|\/+$/g, '');
    const map = (n: string) => (n === from ? to : n.startsWith(from + '/') ? to + n.slice(from.length) : n);
    if (this.order.some(n => map(n) !== n && this.files.has(map(n)))) return false;
    const files = new Map<string, string>();
    for (const [n, t] of this.files) files.set(map(n), t);
    this.files = files;
    this.order = this.order.map(map);
    this.folders = new Set([...this.folders].map(map));
    this.save();
    return true;
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

  clear() { this.files.clear(); this.order = []; this.folders.clear(); this.save(); }
}

export function langOf(name: string): 'verilog' | 'vhdl' | 'do' | 'text' {
  if (/\.(v|sv|vh|svh|vlg)$/i.test(name)) return 'verilog';
  if (/\.(vhd|vhdl)$/i.test(name)) return 'vhdl';
  if (/\.(do|tcl)$/i.test(name)) return 'do';
  return 'text';
}

/** Appearance settings shared by all projects. */
const GLOBAL_KEYS = ['theme', 'layout', 'hideLeft', 'hideMid'];
const UI_KEY = 'websim.ui.v1';

/** Per-project UI state (open files, compiled sources, breakpoints ...) plus the shared appearance settings. */
export function loadState<T>(def: T): T {
  try {
    const r = localStorage.getItem(keyFor(STATE_KEY, projects.current().id));
    const g = localStorage.getItem(UI_KEY);
    return { ...def, ...(r ? JSON.parse(r) : {}), ...(g ? JSON.parse(g) : {}) };
  } catch { return def; }
}
export function saveState(s: object) {
  try {
    localStorage.setItem(keyFor(STATE_KEY, projects.current().id), JSON.stringify(s));
    const rec = s as Record<string, unknown>;
    localStorage.setItem(UI_KEY, JSON.stringify(Object.fromEntries(GLOBAL_KEYS.filter(k => k in rec).map(k => [k, rec[k]]))));
  } catch { /* ignore */ }
}
