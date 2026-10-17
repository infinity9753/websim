// Project / Library / Structure / Objects / Processes panels.
import { h, icon, clear, contextMenu } from './dom';
import { fmtSig, type RemoteSession as Session, type MScope as Scope, type MSignal } from './remote';
import * as L from '../engine/logic';
import { langOf, type BrowserFS } from './vfs';
import { DND_TYPE } from './wave';


/** Renders only the rows of a long table that are in view (fixed row height). */
export class VRows {
  private count = 0;
  private renderRow: (i: number) => HTMLElement = () => h('tr');
  private first = -1;
  private last = -1;
  private raf = 0;
  constructor(private scroller: HTMLElement, private tbody: HTMLElement, private cols: number, private rowH = 21) {
    scroller.addEventListener('scroll', () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(scroller);
  }
  set(count: number, render: (i: number) => HTMLElement) {
    this.count = count; this.renderRow = render;
    this.paint(true);
  }
  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(false); });
  }
  private pad(px: number) { return h('tr', { class: 'vpad' }, h('td', { colspan: String(this.cols), style: { height: px + 'px', padding: '0', border: '0' } })); }
  paint(force: boolean) {
    const head = 24;
    const top = Math.max(0, this.scroller.scrollTop - head);
    const vis = Math.max(20, Math.ceil(this.scroller.clientHeight / this.rowH));
    const first = Math.max(0, Math.floor(top / this.rowH) - 10);
    const last = Math.min(this.count, first + vis + 20);
    if (!force && first === this.first && last === this.last) return;
    this.first = first; this.last = last;
    const rows: HTMLElement[] = [];
    if (first > 0) rows.push(this.pad(first * this.rowH));
    for (let i = first; i < last; i++) rows.push(this.renderRow(i));
    if (last < this.count) rows.push(this.pad((this.count - last) * this.rowH));
    this.tbody.replaceChildren(...rows);
  }
}

function bar(...items: (HTMLElement | string)[]) { return h('div', { class: 'subbar' }, ...items); }
function tbtn(ic: string, title: string, f: () => void) { return h('button', { class: 'tb-btn', title, 'aria-label': title, onclick: f }, icon(ic)); }

// ------------------------------------------------------------------ project

export class ProjectPanel {
  el: HTMLElement;
  private tbody: HTMLElement;
  sel: string | null = null;
  onOpen?: (f: string) => void;
  onCompile?: (files: string[]) => void;
  onNew?: () => void;
  onImport?: () => void;
  onRename?: (f: string) => void;
  onDelete?: (f: string) => void;
  onExport?: (f: string) => void;
  onRunDo?: (f: string) => void;

  constructor(private fs: BrowserFS, private session: Session) {
    this.tbody = h('tbody');
    this.el = h('div', {},
      bar(
        tbtn('newfile', 'New file', () => this.onNew?.()),
        tbtn('upload', 'Import files from disk', () => this.onImport?.()),
        tbtn('download', 'Download selected file', () => this.sel && this.onExport?.(this.sel)),
        tbtn('rename', 'Rename selected file', () => this.sel && this.onRename?.(this.sel)),
        tbtn('trash', 'Remove selected file', () => this.sel && this.onDelete?.(this.sel)),
        h('span', { class: 'tb-sep' }),
        tbtn('up', 'Move up in compile order', () => { if (this.sel) { fs.move(this.sel, -1); this.render(); } }),
        tbtn('down', 'Move down in compile order', () => { if (this.sel) { fs.move(this.sel, 1); this.render(); } }),
        h('span', { class: 'tb-sep' }),
        tbtn('compile', 'Compile selected', () => this.sel && this.onCompile?.([this.sel])),
        tbtn('compileall', 'Compile all (in order)', () => this.onCompile?.(this.hdlFiles())),
      ),
      h('div', { class: 'scroll' }, h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', { title: 'Compile status' }, 'Status'), h('th', {}, 'Type'), h('th', { title: 'Compile order' }, 'Order'))),
        this.tbody)));
    fs.onChange(() => this.render());
    session.on('compiled', () => this.render());
    this.render();
  }

  hdlFiles() { return this.fs.list().filter(f => langOf(f) === 'verilog' || langOf(f) === 'vhdl'); }

  render() {
    clear(this.tbody);
    const files = this.fs.list();
    if (!files.length) {
      this.tbody.appendChild(h('tr', {}, h('td', { colspan: '4', class: 'empty' }, 'No files. Use File ▸ New or Import.')));
      return;
    }
    let order = 0;
    for (const f of files) {
      const lang = langOf(f);
      const st = this.session.fileStatus.get(f);
      const isHdl = lang === 'verilog' || lang === 'vhdl';
      const row = h('tr', {
        class: this.sel === f ? 'sel' : '',
        onclick: () => { this.sel = f; this.render(); },
        ondblclick: () => { if (/\.vcd$/i.test(f)) void this.session.exec(`vcd load ${f}`); else this.onOpen?.(f); },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault(); this.sel = f; this.render();
          contextMenu(e.clientX, e.clientY, [
            { label: 'Open', action: () => this.onOpen?.(f) },
            ...(isHdl ? [{ label: 'Compile', action: () => this.onCompile?.([f]) }] : []),
            ...(lang === 'do' ? [{ label: 'Execute script', action: () => this.onRunDo?.(f) }] : []),
            ...(/\.vcd$/i.test(f) ? [{ label: 'Open as waveform', action: () => { void this.session.exec(`vcd load ${f}`); } }] : []),
            { label: 'Compile all', action: () => this.onCompile?.(this.hdlFiles()) },
            '-',
            { label: 'Rename…', action: () => this.onRename?.(f) },
            { label: 'Download', action: () => this.onExport?.(f) },
            { label: 'Remove from project', action: () => this.onDelete?.(f) },
          ]);
        },
      },
        h('td', {}, f),
        h('td', { class: st === 'ok' ? 'st-ok' : st === 'error' ? 'st-err' : 'st-none' }, isHdl ? (st === 'ok' ? '✓' : st === 'error' ? '✗' : '?') : ''),
        h('td', { class: 'kind' }, lang === 'verilog' ? (/\.sv$/i.test(f) ? 'SystemVerilog' : 'Verilog') : lang === 'vhdl' ? 'VHDL' : lang === 'do' ? 'Macro' : 'Text'),
        h('td', { class: 'kind' }, isHdl ? String(order++) : ''));
      this.tbody.appendChild(row);
    }
  }
}

// ------------------------------------------------------------------ library

export class LibraryPanel {
  el: HTMLElement;
  private tbody: HTMLElement;
  private collapsed = new Set<string>();
  sel: string | null = null;
  onSimulate?: (lib: string, unit: string) => void;
  onOpenFile?: (file: string) => void;

  constructor(private session: Session) {
    this.tbody = h('tbody');
    this.el = h('div', {},
      h('div', { class: 'scroll' }, h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Path'))),
        this.tbody)));
    session.on('library', () => this.render());
    this.render();
  }

  render() {
    clear(this.tbody);
    for (const [name, lib] of this.session.libs.libs) {
      const open = !this.collapsed.has(name);
      const units = lib.list();
      this.tbody.appendChild(h('tr', { ondblclick: () => this.toggle(name) },
        h('td', {}, h('span', { class: 'tree-toggle', onclick: () => this.toggle(name) }, units.length ? (open ? '▾' : '▸') : ''), icon('lib'), ' ', name),
        h('td', { class: 'kind' }, 'Library'),
        h('td', { class: 'kind' }, name === 'work' ? '$WORK' : name)));
      if (!open) continue;
      for (const u of units) {
        const key = `${name}.${u.name}.${u.kind}`;
        const simable = u.kind === 'module' || u.kind === 'entity' || u.kind === 'configuration';
        const label = u.kind === 'architecture' ? `${u.of}(${u.name})` : u.name;
        this.tbody.appendChild(h('tr', {
          class: this.sel === key ? 'sel' : '',
          title: simable ? 'Double-click to simulate' : '',
          onclick: () => { this.sel = key; this.render(); },
          ondblclick: () => { if (simable) this.onSimulate?.(name, u.name); else if (u.kind === 'architecture') this.onSimulate?.(name, `${u.of}(${u.name})`); },
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault(); this.sel = key; this.render();
            contextMenu(e.clientX, e.clientY, [
              { label: 'Simulate', disabled: !simable && u.kind !== 'architecture', action: () => this.onSimulate?.(name, u.kind === 'architecture' ? `${u.of}(${u.name})` : u.name) },
              { label: 'Edit source', action: () => this.onOpenFile?.(u.file) },
              { label: 'Delete', action: () => { void this.session.exec(`vdel -lib ${name} ${u.name}`); } },
            ]);
          },
        },
          h('td', { style: { paddingLeft: '26px' } }, label),
          h('td', { class: 'kind' }, u.iface ? 'Interface' : kindLabel(u.kind, u.lang)),
          h('td', { class: 'kind' }, u.file)));
      }
    }
  }

  toggle(n: string) { if (this.collapsed.has(n)) this.collapsed.delete(n); else this.collapsed.add(n); this.render(); }
}

function kindLabel(k: string, lang: string) {
  switch (k) {
    case 'module': return 'Module';
    case 'entity': return 'Entity';
    case 'architecture': return 'Architecture';
    case 'package': return 'Package';
    case 'package_body': return 'Package body';
    case 'configuration': return 'Configuration';
  }
  return lang;
}

// ------------------------------------------------------------------ structure (sim)

export class StructurePanel {
  el: HTMLElement;
  private tbody: HTMLElement;
  private collapsed = new Set<string>();

  private vr: VRows;

  constructor(private session: Session) {
    this.tbody = h('tbody');
    const scroll = h('div', { class: 'scroll' }, h('table', { class: 'grid vt' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Instance'), h('th', {}, 'Design unit'), h('th', {}, 'Type'))),
      this.tbody));
    this.el = h('div', {}, scroll);
    this.vr = new VRows(scroll, this.tbody, 3);
    session.on('sim', () => this.render());
    session.on('scope', () => this.render());
    this.render();
  }

  render() {
    const d = this.session.design;
    if (!d) { this.vr.set(1, () => h('tr', {}, h('td', { colspan: '3', class: 'empty' }, 'No design loaded.'))); return; }
    const nodes: { s: Scope; depth: number }[] = [];
    const visit = (s: Scope, depth: number) => {
      nodes.push({ s, depth });
      if (!this.collapsed.has(s.path)) for (const c of s.children) visit(c, depth + 1);
    };
    visit(d.root, 0);
    this.vr.set(nodes.length, (i) => {
      const { s, depth } = nodes[i];
      const open = !this.collapsed.has(s.path);
      const isInst = s.kind === 'instance';
      const unit = s.mod.unit;
      return h('tr', {
        class: this.session.scope === s ? 'sel' : '',
        onclick: () => this.session.setScope(s),
        ondblclick: () => this.toggle(s.path),
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault(); this.session.setScope(s);
          contextMenu(e.clientX, e.clientY, [
            { label: 'Add signals of this region to wave', action: () => { void this.session.exec(`add wave ${s.path}/*`); } },
            { label: 'Add recursively to wave', action: () => { void this.session.exec(`add wave -r ${s.path}/*`); } },
          ]);
        },
      },
        h('td', { style: { paddingLeft: 4 + depth * 14 + 'px' } },
          h('span', { class: 'tree-toggle', onclick: (e: MouseEvent) => { e.stopPropagation(); this.toggle(s.path); } }, s.children.length ? (open ? '▾' : '▸') : ''),
          isInst ? icon('chip') : '', ' ', s.name),
        h('td', { class: 'kind' }, isInst ? `${unit.name}${s.mod.arch ? `(${s.mod.arch})` : ''}` : ''),
        h('td', { class: 'kind' }, isInst ? (unit.lang === 'vhdl' ? 'Architecture' : 'Module') : 'Generate'));
    });
  }

  toggle(p: string) { if (this.collapsed.has(p)) this.collapsed.delete(p); else this.collapsed.add(p); this.render(); }
}

// ------------------------------------------------------------------ objects

export class ObjectsPanel {
  el: HTMLElement;
  private tbody: HTMLElement;
  private filter: HTMLInputElement;
  private sel = new Set<string>();
  private valueCells = new Map<HTMLElement, MSignal>();
  private vr: VRows;
  onForce?: (path: string) => void;

  constructor(private session: Session) {
    this.tbody = h('tbody');
    this.filter = h('input', { type: 'search', class: 'tb-field', placeholder: 'Filter', style: { width: '110px' }, 'aria-label': 'Filter objects', oninput: () => this.render() });
    const scroll = h('div', { class: 'scroll' }, h('table', { class: 'grid vt' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Value'), h('th', {}, 'Kind'), h('th', {}, 'Mode'))),
      this.tbody));
    this.el = h('div', {},
      bar(
        tbtn('addwave', 'Add selected to wave (or all if none selected)', () => this.addToWave()),
        h('span', { class: 'grow' }),
        this.filter),
      scroll);
    this.vr = new VRows(scroll, this.tbody, 4);
    session.on('sim', () => { this.sel.clear(); this.render(); });
    session.on('scope', () => { this.sel.clear(); this.render(); });
    session.on('time', () => this.updateValues());
    this.render();
  }

  private pathOf(s: Scope, name: string) { return `${s.path}/${name}`; }

  addToWave() {
    const s = this.session.scope;
    if (!s) return;
    const paths = this.sel.size ? [...this.sel] : s.objects.map(o => this.pathOf(s, o.name));
    this.session.addWavePaths(paths);
  }

  render() {
    this.valueCells.clear();
    const s = this.session.scope;
    if (!s) { this.vr.set(1, () => h('tr', {}, h('td', { colspan: '4', class: 'empty' }, 'No design loaded.'))); return; }
    const f = this.filter.value.trim().toLowerCase();
    const objs = f ? s.objects.filter(o => o.name.toLowerCase().includes(f)) : s.objects;
    const mems = f ? s.memories.filter(m => m.name.toLowerCase().includes(f)) : s.memories;
    if (!objs.length && !mems.length) { this.vr.set(1, () => h('tr', {}, h('td', { colspan: '4', class: 'empty' }, 'No objects in this region.'))); return; }
    // cells of rows scrolled out of view are dropped from the update map
    this.valueCells = new Map();
    this.vr.set(objs.length + mems.length, (i) => {
      for (const [cell] of this.valueCells) if (!cell.isConnected) this.valueCells.delete(cell);
      if (i >= objs.length) {
        const m = mems[i - objs.length];
        return h('tr', { title: `${s.path}/${m.name}` },
          h('td', {}, m.name), h('td', { class: 'mono kind' }, `[${m.mem.lo}:${m.mem.hi}] × ${m.mem.w}b`), h('td', { class: 'kind' }, 'Memory'), h('td', { class: 'kind' }, 'Internal'));
      }
      const o = objs[i];
      const path = this.pathOf(s, o.name);
      const val = h('td', { class: 'mono' }, this.fmt(o.sig));
      this.valueCells.set(val, o.sig);
      return h('tr', {
        class: this.sel.has(path) ? 'sel' : '',
        draggable: 'true',
        title: path,
        onclick: (e: MouseEvent) => {
          if (e.ctrlKey || e.metaKey) { if (this.sel.has(path)) this.sel.delete(path); else this.sel.add(path); }
          else this.sel = new Set([path]);
          this.render();
        },
        ondblclick: () => this.session.addWavePaths([path]),
        ondragstart: (e: DragEvent) => {
          const paths = this.sel.has(path) ? [...this.sel] : [path];
          e.dataTransfer!.setData(DND_TYPE, JSON.stringify(paths));
          e.dataTransfer!.setData('text/plain', paths.join(' '));
          e.dataTransfer!.effectAllowed = 'copy';
        },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          if (!this.sel.has(path)) { this.sel = new Set([path]); this.render(); }
          contextMenu(e.clientX, e.clientY, [
            { label: 'Add to Wave', action: () => this.session.addWavePaths([...this.sel]) },
            { label: 'Add to List', action: () => { void this.session.exec(`add list ${[...this.sel].join(' ')}`); } },
            { label: 'Force…', action: () => this.onForce?.(path) },
            { label: 'NoForce', action: () => { void this.session.exec(`noforce ${path}`); }, disabled: !o.sig.forced },
            { label: 'Examine', action: () => { void this.session.exec(`examine ${path}`); } },
          ]);
        },
      },
        h('td', {}, o.sig.forced ? h('span', { title: 'Forced' }, o.name, ' ⚑') : o.name),
        val,
        h('td', { class: 'kind' }, kindOf(s, o.sig)),
        h('td', { class: 'kind' }, o.dir === 'in' ? 'In' : o.dir === 'out' ? 'Out' : o.dir === 'inout' ? 'InOut' : 'Internal'));
    });
  }

  private fmt(sig: MSignal) {
    const radix = this.session.defaultRadix === 'binary' && sig.w > 16 ? 'hex' : this.session.defaultRadix;
    return fmtSig(sig, sig.value, radix, sig.enumNames);
  }

  updateValues() {
    for (const [cell, sig] of this.valueCells) {
      if (!cell.isConnected) { this.valueCells.delete(cell); continue; }
      const txt = this.fmt(sig);
      if (cell.textContent !== txt) cell.textContent = txt;
    }
  }
}

function kindOf(s: Scope, sig: MSignal): string {
  if (sig.isReal) return 'Real';
  const base = sig.enumNames ? 'Enum' : s.mod.lang === 'vhdl' ? 'Signal' : sig.drivers?.length ? 'Net' : 'Reg';
  return sig.w > 1 || sig.msb !== 0 ? `${base} [${sig.msb}:${sig.lsb}]` : base;
}

// ------------------------------------------------------------------ processes

export class ProcessesPanel {
  el: HTMLElement;
  private tbody: HTMLElement;
  private all: HTMLInputElement;
  private vr: VRows;

  constructor(private session: Session) {
    this.tbody = h('tbody');
    this.all = h('input', { type: 'checkbox', onchange: () => this.render() });
    const scroll = h('div', { class: 'scroll' }, h('table', { class: 'grid vt' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Region'), h('th', {}, 'State'), h('th', {}, 'Source'))),
      this.tbody));
    this.el = h('div', {}, bar(h('label', { class: 'hint' }, this.all, ' Show all regions')), scroll);
    this.vr = new VRows(scroll, this.tbody, 4);
    session.on('sim', () => this.render());
    session.on('scope', () => this.render());
    // states change constantly while running: only refresh when visible
    session.on('time', () => { if (this.el.offsetParent !== null) this.render(); });
    this.render();
  }

  render() {
    const d = this.session.design;
    if (!d) { this.vr.set(1, () => h('tr', {}, h('td', { colspan: '4', class: 'empty' }, 'No design loaded.'))); return; }
    const scopes = this.all.checked ? d.allScopes : this.session.scope ? [this.session.scope] : [];
    const procs = scopes.flatMap(s => s.procs);
    if (!procs.length) { this.vr.set(1, () => h('tr', {}, h('td', { colspan: '4', class: 'empty' }, 'No processes in this region.'))); return; }
    this.vr.set(procs.length, (i) => {
      const p = procs[i];
      return h('tr', {},
        h('td', {}, p.info.name),
        h('td', { class: 'kind' }, p.info.scope),
        h('td', { class: 'kind' }, p.done ? 'Done' : !p.gen ? 'Ready' : 'Wait'),
        h('td', { class: 'kind' }, p.info.file ? `${p.info.file}:${p.info.line}` : ''));
    });
  }
}

// ------------------------------------------------------------------ memory

export class MemoryPanel {
  el: HTMLElement;
  private sel: HTMLSelectElement;
  private addr: HTMLInputElement;
  private radix: HTMLSelectElement;
  private tbody: HTMLElement;
  private start = 0;
  private pending = false;
  private static PAGE = 256;
  onEdit?: (path: string, addr: number, current: string) => void;

  constructor(private session: Session) {
    this.sel = h('select', { class: 'tb-field', style: { width: '170px' }, 'aria-label': 'Memory', onchange: () => { this.start = 0; void this.refresh(); } });
    this.addr = h('input', { class: 'tb-field', placeholder: 'Go to addr', style: { width: '80px' }, 'aria-label': 'Go to address', onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') this.goto(); } });
    this.radix = h('select', { class: 'tb-field', style: { width: '80px' }, 'aria-label': 'Radix', onchange: () => void this.refresh() },
      ['hex', 'binary', 'unsigned', 'decimal', 'octal'].map(r => h('option', { value: r }, r)));
    this.tbody = h('tbody');
    this.el = h('div', {},
      bar(this.sel, this.addr, this.radix,
        tbtn('up', 'Previous page', () => { this.start -= MemoryPanel.PAGE; void this.refresh(); }),
        tbtn('down', 'Next page', () => { this.start += MemoryPanel.PAGE; void this.refresh(); })),
      h('div', { class: 'scroll' }, h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Address'), h('th', {}, 'Value'))),
        this.tbody)));
    session.on('sim', () => void this.reload());
    session.on('time', () => this.schedule());
    void this.reload();
  }

  private schedule() {
    if (this.pending || !this.el.isConnected || this.el.offsetParent === null) return;
    this.pending = true;
    setTimeout(() => { this.pending = false; void this.refresh(); }, 150);
  }

  private goto() {
    const v = this.addr.value.trim();
    const n = /^(0x|16#)/i.test(v) ? parseInt(v.replace(/^(0x|16#)/i, '').replace(/#$/, ''), 16) : parseInt(v, 10);
    if (!isNaN(n)) { this.start = n; void this.refresh(); }
  }

  async reload() {
    clear(this.sel);
    if (!this.session.design) { this.empty('No design loaded.'); return; }
    const mems = await this.session.listMemories();
    for (const m of mems) this.sel.appendChild(h('option', { value: m.path }, `${m.path.split('/').slice(-2).join('/')} [${m.lo}:${m.hi}]`));
    this.start = mems[0]?.lo ?? 0;
    if (!mems.length) { this.empty('No memories in this design.'); return; }
    await this.refresh();
  }

  show() { void this.reload(); }

  private empty(msg: string) { clear(this.tbody); this.tbody.appendChild(h('tr', {}, h('td', { colspan: '2', class: 'empty' }, msg))); }

  async refresh() {
    const path = this.sel.value;
    if (!path) return;
    const r = await this.session.memWords(path, this.start, MemoryPanel.PAGE);
    if (!r) return;
    this.start = Math.max(r.lo, Math.min(this.start, r.hi));
    clear(this.tbody);
    const digits = Math.max(2, r.hi.toString(16).length);
    r.words.forEach((v, i) => {
      const a = Math.max(r.lo, this.start) + i;
      const txt = L.format(v, this.radix.value as L.Radix);
      this.tbody.appendChild(h('tr', { title: 'Double-click to change', ondblclick: () => this.onEdit?.(path, a, txt) },
        h('td', { class: 'mono kind' }, a.toString(16).padStart(digits, '0')),
        h('td', { class: 'mono' }, txt)));
    });
  }
}

// ------------------------------------------------------------------ locals / call stack

export class LocalsPanel {
  el: HTMLElement;
  private stackEl: HTMLElement;
  private tbody: HTMLElement;

  constructor(private session: Session) {
    this.stackEl = h('div', { class: 'callstack' });
    this.tbody = h('tbody');
    this.el = h('div', {},
      h('div', { class: 'subbar' }, h('span', { class: 'hint' }, 'Call stack')),
      this.stackEl,
      h('div', { class: 'scroll' }, h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Value'), h('th', {}, 'Frame'))),
        this.tbody)));
    session.on('debug', () => this.render());
    session.on('time', () => this.render());
    session.on('sim', () => this.render());
    this.render();
  }

  render() {
    clear(this.stackEl); clear(this.tbody);
    const s = this.session;
    if (!s.paused) {
      this.stackEl.appendChild(h('div', { class: 'empty' }, 'Not paused. Set a breakpoint (click the editor gutter) or use Step.'));
      return;
    }
    s.stack.forEach((f, i) => this.stackEl.appendChild(h('div', { class: 'frame' + (i === 0 ? ' top' : '') }, f)));
    if (!s.locals.length) this.tbody.appendChild(h('tr', {}, h('td', { colspan: '3', class: 'empty' }, 'No local variables in this frame (module signals are in Objects).')));
    for (const l of s.locals) {
      const radix = s.defaultRadix === 'binary' && l.value.w > 16 ? 'hex' : s.defaultRadix;
      const v = l.value.signed && l.value.w === 32 ? L.toDec(l.value, true) : L.format(l.value, radix, l.enumNames);
      this.tbody.appendChild(h('tr', {}, h('td', {}, l.name), h('td', { class: 'mono' }, v), h('td', { class: 'kind' }, l.where)));
    }
  }
}
