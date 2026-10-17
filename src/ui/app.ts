// Application shell: menus, toolbar, panes, dialogs, persistence.
import { h, icon, modal, promptText, confirmBox, alertBox, download, clear } from './dom';
import { Pane } from './pane';
import { RemoteSession } from './remote';
import { BrowserFS, langOf, loadState, saveState } from './vfs';
import { Transcript } from './transcript';
import { Editors } from './editor';
import { WaveView } from './wave';
import { ListView } from './list';
import { ProjectPanel, LibraryPanel, StructurePanel, ObjectsPanel, ProcessesPanel, MemoryPanel, LocalsPanel } from './panels';
import { EXAMPLES } from './samples';
import { fmtTime } from '../engine/format';
import { t, getLang, setLang } from './i18n';

interface AppState {
  compiled: { file: string; lang: 'verilog' | 'vhdl'; lib: string }[];
  libs: string[];
  runLength: string;
  layout: Record<string, string>;
  openFiles: string[];
  seen: boolean;
  theme: 'auto' | 'light' | 'dark';
  hideLeft: boolean;
  hideMid: boolean;
  breakpoints: { file: string; line: number; cond?: string }[];
}

const DEFAULT_STATE: AppState = { compiled: [], libs: ['work'], runLength: '100 ns', layout: {}, openFiles: [], seen: false, theme: 'auto', hideLeft: false, hideMid: false, breakpoints: [] };

export class App {
  fs = new BrowserFS();
  session: RemoteSession;
  transcript: Transcript;
  editors: Editors;
  wave: WaveView;
  list: ListView;
  left = new Pane('pane-left');
  mid = new Pane('pane-mid');
  right = new Pane('pane-right');
  bottom = new Pane('pane-bottom');
  project: ProjectPanel;
  library: LibraryPanel;
  structure: StructurePanel;
  objects: ObjectsPanel;
  processes: ProcessesPanel;
  memory: MemoryPanel;
  locals: LocalsPanel;
  state: AppState;
  main!: HTMLElement;
  runField!: HTMLInputElement;
  status!: Record<string, HTMLElement>;
  runBtns: HTMLButtonElement[] = [];
  simBtns: HTMLButtonElement[] = [];
  brkBtn!: HTMLButtonElement;
  private openMenu: HTMLElement | null = null;

  constructor(private root: HTMLElement) {
    this.state = loadState(DEFAULT_STATE);
    this.applyTheme();
    // the transcript needs the session and vice versa: route prints through a late-bound function
    let sink: (m: string, k?: any) => void = () => {};
    this.session = new RemoteSession(this.fs, (m, k) => sink(m, k));
    this.transcript = new Transcript(this.session);
    sink = (m, k) => this.transcript.print(m, k);
    this.editors = new Editors(this.right, this.fs);
    this.wave = new WaveView(this.session);
    this.list = new ListView(this.session);
    this.project = new ProjectPanel(this.fs, this.session);
    this.library = new LibraryPanel(this.session);
    this.structure = new StructurePanel(this.session);
    this.objects = new ObjectsPanel(this.session);
    this.processes = new ProcessesPanel(this.session);
    this.memory = new MemoryPanel(this.session);
    this.locals = new LocalsPanel(this.session);
    this.build();
    this.wire();
    this.start();
  }

  // ------------------------------------------------------------ layout
  private build() {
    this.left.add('project', t('Project'), this.project.el, { activate: true });
    this.left.add('library', t('Library'), this.library.el, { activate: false });
    this.left.add('sim', 'sim', this.structure.el, { activate: false });
    this.mid.add('objects', t('Objects'), this.objects.el);
    this.mid.add('processes', t('Processes'), this.processes.el, { activate: false });
    this.mid.add('memory', t('Memory'), this.memory.el, { activate: false });
    this.mid.add('locals', t('Locals'), this.locals.el, { activate: false });
    this.mid.onActivate = (id) => { if (id === 'memory') this.memory.show(); };
    this.right.add('wave', t('Wave'), this.wave.el);
    this.right.add('list', t('List'), this.list.el, { activate: false });
    this.bottom.add('transcript', t('Transcript'), this.transcript.el);

    const s1 = h('div', { class: 'split-v1', role: 'separator', 'aria-orientation': 'vertical' });
    const s2 = h('div', { class: 'split-v2', role: 'separator', 'aria-orientation': 'vertical' });
    const s3 = h('div', { class: 'split-h', role: 'separator', 'aria-orientation': 'horizontal' });
    this.main = h('div', { class: 'main' }, this.left.el, s1, this.mid.el, s2, this.right.el, s3, this.bottom.el);
    for (const [k, v] of Object.entries(this.state.layout)) this.main.style.setProperty(k, v);
    this.main.classList.toggle('hide-left', this.state.hideLeft);
    this.main.classList.toggle('hide-mid', this.state.hideMid);
    this.splitter(s1, '--left-w', 'x', this.left.el, 120, 700);
    this.splitter(s2, '--mid-w', 'x', this.mid.el, 120, 700);
    this.splitter(s3, '--bottom-h', 'y', this.bottom.el, 60, 800);

    this.status = {
      ind: h('span', { class: 'run-ind' }),
      state: h('b', {}, t('No design')),
      now: h('b', {}, '0 ns'),
      delta: h('b', {}, '0'),
      scope: h('b', {}, '—'),
      mem: h('b', {}, '—'),
      lib: h('b', {}, 'work'),
    };
    const st = this.status;
    const statusbar = h('div', { class: 'statusbar' },
      h('span', {}, st.ind, st.state),
      h('span', {}, t('Now: '), st.now),
      h('span', {}, t('Delta: '), st.delta),
      h('span', {}, t('Region: '), st.scope),
      h('span', { title: t('Recorded waveform history (estimate). Use "log -cap" / "nolog" to limit.') }, t('History: '), st.mem),
      h('span', { class: 'grow' }),
      h('span', {}, t('Library: '), st.lib),
      h('span', {}, t('WebSim — clean-room HDL simulator')));

    this.root.append(this.buildMenus(), this.buildToolbar(), this.main, statusbar);
  }

  private splitter(el: HTMLElement, v: string, axis: 'x' | 'y', target: HTMLElement, min: number, max: number) {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const r = target.getBoundingClientRect();
      const start = axis === 'x' ? e.clientX : e.clientY;
      const size0 = axis === 'x' ? r.width : r.height;
      const sign = axis === 'y' ? -1 : 1;
      const mv = (ev: MouseEvent) => {
        const d = ((axis === 'x' ? ev.clientX : ev.clientY) - start) * sign;
        const val = Math.max(min, Math.min(max, size0 + d)) + 'px';
        this.main.style.setProperty(v, val);
        this.state.layout[v] = val;
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); this.persist(); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }

  // ------------------------------------------------------------ menus
  private buildMenus(): HTMLElement {
    type MI = { label: string; kbd?: string; action?: () => void; sub?: MI[]; disabled?: () => boolean } | '-';
    const menus: [string, MI[]][] = [
      [t('File'), [
        { label: t('New File…'), kbd: 'Ctrl+Alt+N', action: () => this.newFile() },
        { label: t('Import Files…'), action: () => this.importFiles() },
        { label: t('Open VCD Waveform…'), action: () => this.openVcd() },
        { label: t('Save'), kbd: 'Ctrl+S', action: () => { const n = this.editors.activeName; if (n) this.editors.save(n); } },
        { label: t('Save All'), action: () => this.editors.saveAll() },
        '-',
        { label: t('Load Example'), sub: EXAMPLES.map(ex => ({ label: ex.title, action: () => void this.loadExample(ex.id, true) })) },
        { label: t('Download Project (.json)'), action: () => this.exportProject() },
        { label: t('Export Transcript'), action: () => download('transcript.txt', this.transcript.text()) },
        '-',
        { label: t('Reset Workspace…'), action: () => void this.resetWorkspace() },
      ]],
      [t('View'), [
        { label: t('Toggle Project/Library pane'), action: () => this.togglePane('left') },
        { label: t('Toggle Objects/Processes pane'), action: () => this.togglePane('mid') },
        '-',
        { label: t('Project'), action: () => { this.showLeft(); this.left.activate('project'); } },
        { label: t('Library'), action: () => { this.showLeft(); this.left.activate('library'); } },
        { label: t('Structure (sim)'), action: () => { this.showLeft(); this.left.activate('sim'); } },
        { label: t('Objects'), action: () => { this.showMid(); this.mid.activate('objects'); } },
        { label: t('Processes'), action: () => { this.showMid(); this.mid.activate('processes'); } },
        { label: t('Memory'), action: () => { this.showMid(); this.mid.activate('memory'); } },
        { label: t('Wave'), action: () => this.right.activate('wave') },
        { label: t('List'), action: () => this.right.activate('list') },
        '-',
        { label: t('Theme: Auto'), action: () => this.setTheme('auto') },
        { label: t('Theme: Light'), action: () => this.setTheme('light') },
        { label: t('Theme: Dark'), action: () => this.setTheme('dark') },
        '-',
        { label: `${getLang() === 'en' ? '✓ ' : ''}English`, action: () => setLang('en') },
        { label: `${getLang() === 'ko' ? '✓ ' : ''}한국어 (Korean)`, action: () => setLang('ko') },
      ]],
      [t('Compile'), [
        { label: t('Compile Current File'), kbd: 'F7', action: () => this.compileCurrent() },
        { label: t('Compile All'), kbd: 'Shift+F7', action: () => this.compileFiles(this.project.hdlFiles()) },
        { label: t('Compile Selected'), action: () => this.project.sel && this.compileFiles([this.project.sel]) },
        '-',
        { label: t('Clear Library "work"'), action: () => void this.cmd('vdel -lib work -all') },
      ]],
      [t('Simulate'), [
        { label: t('Start Simulation…'), action: () => void this.startSimDialog() },
        { label: t('Run'), kbd: 'F9', action: () => void this.cmd(`run ${this.runField.value}`) },
        { label: t('Run -All'), kbd: 'F5', action: () => void this.cmd('run -all') },
        { label: t('Continue'), action: () => void this.cmd('run -continue') },
        { label: t('Break'), kbd: 'Esc', action: () => this.session.breakRun() },
        { label: t('Step'), kbd: 'F11', action: () => void this.cmd('step') },
        { label: t('Step Over'), kbd: 'F10', action: () => void this.cmd('step -over') },
        { label: t('Toggle Breakpoint at Cursor'), kbd: 'F8', action: () => this.toggleBpAtCursor() },
        { label: t('Delete All Breakpoints'), action: () => void this.cmd('bd all') },
        { label: t('Restart'), action: () => void this.cmd('restart -f') },
        '-',
        { label: t('End Simulation'), action: () => void this.cmd('quit -sim') },
      ]],
      [t('Wave'), [
        { label: t('Zoom Full'), kbd: 'F', action: () => this.wave.zoomFull() },
        { label: t('Zoom In'), kbd: 'I', action: () => this.wave.zoom(0.5) },
        { label: t('Zoom Out'), kbd: 'O', action: () => this.wave.zoom(2) },
        { label: t('Center on Cursor'), kbd: 'C', action: () => this.wave.centerCursor() },
        '-',
        { label: t('Add All Signals (recursive)'), action: () => void this.cmd('add wave -r /*') },
        { label: t('Save Format…'), action: () => void this.saveWaveFormat() },
        { label: t('Load Format…'), action: () => void this.loadWaveFormat() },
        '-',
        { label: t('Export VCD (wave signals)…'), action: () => void this.exportVcd(false) },
        { label: t('Export VCD (all signals)…'), action: () => void this.exportVcd(true) },
        { label: t('Delete Selected'), kbd: 'Del', action: () => this.wave.deleteSelected() },
        { label: t('Delete All'), action: () => void this.cmd('delete wave *') },
      ]],
      [t('Help'), [
        { label: t('Command Reference'), action: () => void this.cmd('help') },
        { label: t('Keyboard Shortcuts'), action: () => this.shortcuts() },
        { label: t('About WebSim'), action: () => this.about() },
      ]],
    ];
    const close = () => { if (this.openMenu) { this.openMenu.classList.remove('open'); this.openMenu.querySelector('.menu-drop')?.remove(); this.openMenu = null; } };
    const mkDrop = (items: MI[]): HTMLElement => h('div', { class: 'menu-drop', role: 'menu' },
      items.map(it => it === '-' ? h('div', { class: 'menu-sep' }) :
        it.sub ? h('div', { class: 'menu-item menu-sub' }, h('span', { class: 'menu-check' }), it.label, h('span', { class: 'kbd' }, '▸'), mkDrop(it.sub)) :
          h('div', { class: 'menu-item', role: 'menuitem', onclick: (e: MouseEvent) => { e.stopPropagation(); close(); it.action?.(); } }, h('span', { class: 'menu-check' }), it.label, it.kbd ? h('span', { class: 'kbd' }, it.kbd) : null)));
    const tops = menus.map(([name, items]) => {
      const top: HTMLElement = h('div', { class: 'menu-top', role: 'menubar' }, name);
      const open = () => { close(); top.classList.add('open'); top.appendChild(mkDrop(items)); this.openMenu = top; };
      top.addEventListener('mousedown', (e) => { if ((e.target as HTMLElement).closest('.menu-drop')) return; if (this.openMenu === top) close(); else open(); });
      top.addEventListener('mouseenter', () => { if (this.openMenu && this.openMenu !== top) open(); });
      return top;
    });
    document.addEventListener('mousedown', (e) => { if (this.openMenu && !this.openMenu.contains(e.target as Node)) close(); });
    const logo = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><rect x="1" y="3" width="18" height="14" rx="2" fill="#0b1a2e"/><path d="M3 13h3V7h4v6h3V7h4" fill="none" stroke="#3ddc84" stroke-width="1.6"/></svg>';
    return h('div', { class: 'menubar' }, h('span', { class: 'brand', html: logo + '<span>WebSim</span>' }), ...tops);
  }

  private buildToolbar(): HTMLElement {
    const b = (ic: string, title: string, f: () => void) => h('button', { class: 'tb-btn', title, 'aria-label': title, onclick: f }, icon(ic)) as HTMLButtonElement;
    this.runField = h('input', { class: 'tb-field', value: this.state.runLength, title: t('Run length'), 'aria-label': t('Run length'), onchange: () => { this.state.runLength = this.runField.value; this.persist(); } });
    const run = b('run', t('Run (F9): advance by the run length'), () => void this.cmd(`run ${this.runField.value}`));
    const cont = b('cont', t('Continue run'), () => void this.cmd('run -continue'));
    const runall = b('runall', t('Run -All (F5)'), () => void this.cmd('run -all'));
    this.brkBtn = b('brk', t('Break (Esc)'), () => this.session.breakRun());
    const restart = b('restart', t('Restart'), () => void this.cmd('restart -f'));
    const stepIn = b('stepinto', t('Step (F11): run to the next statement'), () => void this.cmd('step'));
    const stepOver = b('stepover', t('Step Over (F10): next statement in this process, skipping task calls'), () => void this.cmd('step -over'));
    this.runBtns = [run, cont, runall, stepIn, stepOver];
    this.simBtns = [restart];
    return h('div', { class: 'toolbar', role: 'toolbar' },
      b('newfile', t('New file'), () => this.newFile()),
      b('open', t('Import files'), () => this.importFiles()),
      b('save', t('Save (Ctrl+S)'), () => { const n = this.editors.activeName; if (n) this.editors.save(n); }),
      h('span', { class: 'tb-sep' }),
      b('compile', t('Compile current file (F7)'), () => this.compileCurrent()),
      b('compileall', t('Compile all (Shift+F7)'), () => this.compileFiles(this.project.hdlFiles())),
      h('span', { class: 'tb-sep' }),
      b('simulate', t('Start simulation…'), () => void this.startSimDialog()),
      restart,
      h('span', { class: 'tb-sep' }),
      this.runField, run, cont, runall, this.brkBtn, stepIn, stepOver,
      h('span', { class: 'tb-sep' }),
      b('zoomin', t('Zoom in'), () => this.wave.zoom(0.5)),
      b('zoomout', t('Zoom out'), () => this.wave.zoom(2)),
      b('zoomfull', t('Zoom full'), () => this.wave.zoomFull()),
    );
  }

  // ------------------------------------------------------------ wiring
  private wire() {
    const s = this.session;
    this.transcript.onOpenLocation = (f, l) => { if (this.fs.has(f)) this.editors.open(f, l); };
    this.editors.onCompile = (f) => this.compileFiles([f]);
    this.editors.onChange = () => { this.state.openFiles = this.editors.openNames(); this.persist(); };
    this.project.onOpen = (f) => this.editors.open(f);
    this.project.onCompile = (fs) => this.compileFiles(fs);
    this.project.onNew = () => this.newFile();
    this.project.onImport = () => this.importFiles();
    this.project.onExport = (f) => download(f, this.fs.read(f) ?? '');
    this.project.onRunDo = (f) => void this.cmd(`do ${f}`);
    this.project.onRename = async (f) => {
      const n = await promptText(t('Rename file'), t('New name'), f);
      if (!n || n === f) return;
      if (!this.fs.rename(f, n)) { await alertBox(t('Rename file'), t('A file named "{0}" already exists.', n)); return; }
      this.editors.rename(f, n);
      this.project.sel = n;
    };
    this.project.onDelete = async (f) => {
      if (!(await confirmBox(t('Remove file'), t('Remove "{0}" from the project? This deletes it from browser storage.', f)))) return;
      await this.editors.close(f, true);
      this.fs.remove(f);
      s.fileStatus.delete(f);
      this.project.render();
    };
    this.editors.onToggleBp = (f, l) => { s.toggleBreakpoint(f, l); this.saveBreakpoints(); };
    s.on('debug', () => this.syncDebug());
    s.on('running', () => { if (s.running) this.editors.showExec(null); });
    s.on('sim', () => this.syncDebug());
    this.library.onSimulate = (lib, u) => void this.cmd(`vsim ${lib}.${u}`);
    this.library.onOpenFile = (f) => this.editors.open(f);
    this.objects.onForce = (p) => void this.forceDialog(p);
    this.memory.onEdit = async (path, addr, cur) => {
      const v = await promptText(t('Change memory word'), `${path}[${addr}]`, cur);
      if (v) { await this.session.memDeposit(path, addr, /^[0-9a-f]+$/i.test(v) && !/^[01]+$/.test(v) ? `16#${v}` : v); void this.memory.refresh(); }
    };

    s.on('sim', () => { if (s.design) { this.left.activate('sim'); this.right.activate('wave'); } this.updateStatus(); });
    let waveCount = 0;
    s.on('wave', () => { if (s.design && s.waves.length > waveCount) this.right.activate('wave'); waveCount = s.waves.length; });
    let listCount = 0;
    s.on('list', () => { if (s.design && s.lists.length > listCount) this.right.activate('list'); listCount = s.lists.length; });
    s.on('time', () => this.updateStatus());
    s.on('scope', () => this.updateStatus());
    s.on('running', () => this.updateStatus());
    s.on('library', () => { this.state.compiled = s.compiledSources; this.state.libs = [...s.libs.libs.keys()]; this.persist(); });
    s.on('compiled', () => this.markErrors());
    this.updateStatus();

    document.addEventListener('keydown', (e) => {
      const inEditor = (e.target as HTMLElement).closest?.('.cm-editor');
      if (e.key === 'F9') { e.preventDefault(); void this.cmd(`run ${this.runField.value}`); }
      else if (e.key === 'F5') { e.preventDefault(); void this.cmd('run -all'); }
      else if (e.key === 'F10') { e.preventDefault(); void this.cmd('step -over'); }
      else if (e.key === 'F11') { e.preventDefault(); void this.cmd('step'); }
      else if (e.key === 'F8') { e.preventDefault(); this.toggleBpAtCursor(); }
      else if (e.key === 'F7' && !inEditor) { e.preventDefault(); if (e.shiftKey) this.compileFiles(this.project.hdlFiles()); else this.compileCurrent(); }
      else if (e.key === 'F7' && e.shiftKey) { e.preventDefault(); this.compileFiles(this.project.hdlFiles()); }
      else if (e.key === 'Escape' && s.running) { e.preventDefault(); s.breakRun(); }
      else if (e.key.toLowerCase() === 'n' && e.ctrlKey && e.altKey) { e.preventDefault(); this.newFile(); }
    });
    window.addEventListener('beforeunload', (e) => {
      if ([...this.editors.docs.values()].some(d => d.dirty)) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  private syncDebug() {
    if (this.session.paused && this.mid.active !== 'locals' && this.mid.active !== 'memory') this.mid.activate('locals');
    const byFile = new Map<string, number[]>();
    for (const b of this.session.breakpoints) (byFile.get(b.file) ?? byFile.set(b.file, []).get(b.file)!).push(b.line);
    this.editors.setBreakpoints(byFile);
    const p = this.session.paused;
    this.editors.showExec(p ? { file: p.file, line: p.line } : null);
    this.updateStatus();
  }

  private toggleBpAtCursor() {
    const n = this.editors.activeName;
    const line = n ? this.editors.cursorLine(n) : null;
    if (!n || !line) { this.transcript.print('** Error: ' + t('Open a source file and place the cursor on a statement.'), 'err'); return; }
    this.session.toggleBreakpoint(n, line);
    this.saveBreakpoints();
  }

  private saveBreakpoints() {
    this.state.breakpoints = this.session.breakpoints.map(b => ({ file: b.file, line: b.line, cond: b.cond }));
    this.persist();
  }

  private updateStatus() {
    const s = this.session;
    const d = s.design;
    const st = this.status;
    st.ind.classList.toggle('on', s.running);
    st.state.textContent = s.running ? t('Running') : d ? (d.kernel.finished ? t('Finished') : s.paused ? t('Paused at {0}', `${s.paused.file}:${s.paused.line}`) : t('Ready')) : t('No design');
    st.now.textContent = fmtTime(s.now, s.resolution);
    st.delta.textContent = String(d?.kernel.deltaCount ?? 0);
    const hb = d?.kernel.histBytes;
    st.mem.textContent = hb === undefined ? '—' : hb > 1048576 ? `${(hb / 1048576).toFixed(1)} MB` : `${Math.ceil(hb / 1024)} KB`;
    st.scope.textContent = s.scope ? `sim:${s.scope.path}` : '—';
    for (const b of this.runBtns) b.disabled = !d || s.running;
    for (const b of this.simBtns) b.disabled = !s.lastVsim || s.running;
    this.brkBtn.disabled = !s.running;
  }

  /** Highlight the first error line in open editors after compile. */
  private markErrors() {
    // nothing beyond transcript links for now; project panel shows status icons
    this.project.render();
  }

  // ------------------------------------------------------------ actions
  async cmd(c: string) {
    await this.transcript.run(c);
  }

  compileCurrent() {
    const n = this.editors.activeName ?? this.project.sel;
    if (!n) { this.transcript.print('** Error: ' + t('No file selected to compile.'), 'err'); return; }
    this.compileFiles([n]);
  }

  compileFiles(files: string[]) {
    this.editors.saveAll();
    const hdl = files.filter(f => langOf(f) === 'verilog' || langOf(f) === 'vhdl');
    if (!hdl.length) { this.transcript.print('** Error: ' + t('No Verilog/VHDL files to compile.'), 'err'); return; }
    // group consecutive files by language to keep compile order
    const groups: { lang: string; files: string[] }[] = [];
    for (const f of hdl) {
      const l = langOf(f);
      const g = groups[groups.length - 1];
      if (g && g.lang === l) g.files.push(f); else groups.push({ lang: l, files: [f] });
    }
    void (async () => {
      for (const g of groups) await this.cmd(`${g.lang === 'verilog' ? 'vlog' : 'vcom'} ${g.files.join(' ')}`);
    })();
  }

  async newFile() {
    const n = await promptText(t('New file'), t('File name'), 'design.v');
    if (!n) return;
    if (this.fs.has(n)) { this.editors.open(n); return; }
    const l = langOf(n);
    const base = n.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]/g, '_') || 'top';
    const tpl = l === 'verilog'
      ? `\`timescale 1ns/1ps\nmodule ${base} (\n  input  wire clk,\n  input  wire rst,\n  output reg  q\n);\n  always @(posedge clk)\n    if (rst) q <= 1'b0;\n    else     q <= ~q;\nendmodule\n`
      : l === 'vhdl'
        ? `library ieee;\nuse ieee.std_logic_1164.all;\nuse ieee.numeric_std.all;\n\nentity ${base} is\n  port (\n    clk : in  std_logic;\n    rst : in  std_logic;\n    q   : out std_logic\n  );\nend entity;\n\narchitecture rtl of ${base} is\n  signal r : std_logic := '0';\nbegin\n  process (clk)\n  begin\n    if rising_edge(clk) then\n      if rst = '1' then r <= '0'; else r <= not r; end if;\n    end if;\n  end process;\n  q <= r;\nend architecture;\n`
        : l === 'do' ? `vlib work\nvlog *.v\n# vsim work.top\n# add wave -r /*\n# run -all\n` : '';
    this.fs.write(n, tpl);
    this.project.sel = n;
    this.editors.open(n);
  }

  importFiles() {
    const inp = h('input', { type: 'file', multiple: true, accept: '.v,.sv,.vh,.svh,.vhd,.vhdl,.do,.tcl,.hex,.mem,.txt,.json,.vcd' });
    inp.addEventListener('change', async () => {
      for (const f of Array.from(inp.files ?? [])) {
        const text = await f.text();
        if (f.name.endsWith('.json')) {
          try { const data = JSON.parse(text); if (data?.websim && data.files) { for (const [n, t] of Object.entries(data.files as Record<string, string>)) this.fs.write(n, t); continue; } } catch { /* plain file */ }
        }
        this.fs.write(f.name, text);
        this.editors.reload(f.name);
      }
      this.transcript.print(t('Imported {0} file(s).', inp.files?.length ?? 0));
    });
    inp.click();
  }

  /** Pick a .vcd from disk, add it to the project and open it as a read-only waveform dataset. */
  openVcd() {
    const inp = h('input', { type: 'file', accept: '.vcd' });
    inp.addEventListener('change', async () => {
      const f = inp.files?.[0];
      if (!f) return;
      this.fs.write(f.name, await f.text());
      await this.cmd(`vcd load ${f.name}`);
    });
    inp.click();
  }

  async saveWaveFormat() {
    if (!this.session.design) { this.transcript.print('** Error: ' + t('No design is loaded.'), 'err'); return; }
    const n = await promptText(t('Save Wave Format'), t('File name'), 'wave.do');
    if (n) await this.cmd(`write format wave ${n}`);
  }

  async loadWaveFormat() {
    const dos = this.fs.list().filter(f => langOf(f) === 'do');
    if (!dos.length) { this.transcript.print('** Error: ' + t('No .do files in the project.'), 'err'); return; }
    const sel = h('select', { class: 'field' }, dos.map(d => h('option', { value: d, selected: d === 'wave.do' }, d)));
    if ((await modal(t('Load Wave Format'), h('label', { class: 'form-row' }, h('span', {}, t('Format file')), sel))) !== 'ok') return;
    await this.cmd('delete wave *');
    await this.cmd(`do ${sel.value}`);
  }

  async exportVcd(all: boolean) {
    try {
      if (!this.session.design) throw new Error(t('No design is loaded.'));
      if (!all && !this.session.waves.length) throw new Error(t('The wave window is empty.'));
      const name = `${this.session.design.top}.vcd`;
      download(name, await this.session.vcdText(all));
      this.transcript.print(all ? t('Exported all signals to {0}.', name) : t('Exported wave signals to {0}.', name));
    } catch (e) {
      this.transcript.print(`** Error: ${(e as Error).message}`, 'err');
    }
  }

  exportProject() {
    const files = Object.fromEntries(this.fs.list().map(n => [n, this.fs.read(n)!]));
    download('websim-project.json', JSON.stringify({ websim: 1, files }, null, 2));
  }

  async loadExample(id: string, run: boolean) {
    const ex = EXAMPLES.find(e => e.id === id);
    if (!ex) return;
    for (const [n, t] of Object.entries(ex.files)) { this.fs.write(n, t); this.editors.reload(n); }
    this.transcript.print(t('Loaded example "{0}". Running {1} …', ex.title, ex.doFile), 'note');
    const first = Object.keys(ex.files).find(f => langOf(f) !== 'do');
    if (first) this.editors.open(first);
    this.right.activate('wave');
    if (run) await this.cmd(`do ${ex.doFile}`);
    this.right.activate('wave');
  }

  async resetWorkspace() {
    if (!(await confirmBox(t('Reset workspace'), t('Delete all files and libraries stored in this browser and reload the examples?')))) return;
    await this.session.exec('quit -sim', false);
    for (const n of this.editors.openNames()) await this.editors.close(n, true);
    this.fs.clear();
    this.session.resetLibraries();
    this.transcript.clear();
    await this.loadExample('counter', true);
  }

  togglePane(which: 'left' | 'mid') {
    if (which === 'left') this.state.hideLeft = !this.state.hideLeft; else this.state.hideMid = !this.state.hideMid;
    this.main.classList.toggle('hide-left', this.state.hideLeft);
    this.main.classList.toggle('hide-mid', this.state.hideMid);
    this.persist();
    this.wave.render();
  }
  showLeft() { if (this.state.hideLeft) this.togglePane('left'); }
  showMid() { if (this.state.hideMid) this.togglePane('mid'); }

  setTheme(t: AppState['theme']) { this.state.theme = t; this.applyTheme(); this.persist(); this.wave.render(); }
  applyTheme() {
    if (this.state.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', this.state.theme);
  }

  persist() { saveState(this.state); }

  // ------------------------------------------------------------ dialogs
  async startSimDialog() {
    const units: { lib: string; name: string; kind: string; file: string }[] = [];
    for (const [ln, lib] of this.session.libs.libs) for (const u of lib.list()) if (u.kind === 'module' || u.kind === 'entity') units.push({ lib: ln, name: u.name, kind: u.kind, file: u.file });
    if (!units.length) { await modal(t('Start Simulation'), h('p', {}, t('The library is empty. Compile your design first (Compile ▸ Compile All).')), [{ label: t('OK'), value: 'ok', primary: true }]); return; }
    const tops = new Set(this.session.libs.topLevels());
    let chosen = units.find(u => tops.has(u.name) && u.name === this.session.lastVsim?.top) ?? units.find(u => tops.has(u.name) && /tb|test/i.test(u.name)) ?? units.find(u => tops.has(u.name)) ?? units[0];
    const list = h('div', { class: 'unit-list' });
    const renderList = () => {
      clear(list);
      list.appendChild(h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, h('th', {}, t('Design unit')), h('th', {}, t('Type')), h('th', {}, t('Library')), h('th', {}, t('File')))),
        h('tbody', {}, units.map(u => h('tr', {
          class: u === chosen ? 'sel' : '',
          onclick: () => { chosen = u; renderList(); },
          ondblclick: () => { chosen = u; (overlayOk() as HTMLElement | null)?.click(); },
        }, h('td', {}, u.name, tops.has(u.name) ? h('span', { class: 'kind' }, '  (top)') : ''), h('td', { class: 'kind' }, u.kind === 'module' ? t('Module') : t('Entity')), h('td', { class: 'kind' }, u.lib), h('td', { class: 'kind' }, u.file))))));
    };
    const overlayOk = () => document.querySelector('.modal .btn.primary');
    renderList();
    const res = h('select', { class: 'field' }, ['default', '1fs', '1ps', '10ps', '100ps', '1ns'].map(r => h('option', { value: r }, r)));
    const gen = h('input', { class: 'field', placeholder: t('e.g. WIDTH=8 DEPTH=16'), spellcheck: 'false' });
    const body = h('div', {}, list,
      h('label', { class: 'form-row' }, h('span', {}, t('Resolution')), res),
      h('label', { class: 'form-row' }, h('span', {}, t('Generics')), gen));
    const r = await modal(t('Start Simulation'), body, [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }]);
    if (r !== 'ok' || !chosen) return;
    const parts = ['vsim'];
    if (res.value !== 'default') parts.push('-t', res.value);
    for (const g of gen.value.split(/\s+/).filter(Boolean)) parts.push(`-g${g}`);
    parts.push(`${chosen.lib}.${chosen.name}`);
    await this.cmd(parts.join(' '));
  }

  async forceDialog(path: string) {
    const f = this.session.findSignal(path);
    const val = h('input', { class: 'field', value: f ? f.obj.sig.value.toString() : '', spellcheck: 'false' });
    const kind = h('select', { class: 'field' }, h('option', { value: 'freeze' }, t('Freeze (force)')), h('option', { value: 'deposit' }, t('Deposit')));
    const delay = h('input', { class: 'field', placeholder: t('optional, e.g. 10 ns'), spellcheck: 'false' });
    const body = h('div', {},
      h('p', {}, t('Signal: '), h('code', {}, path)),
      h('label', { class: 'form-row' }, h('span', {}, t('Value')), val),
      h('label', { class: 'form-row' }, h('span', {}, t('Kind')), kind),
      h('label', { class: 'form-row' }, h('span', {}, t('Delay')), delay),
      h('p', { class: 'kind' }, 'Values: 1, 0, X, Z, 1010, 16#FF, 8\'hA5, decimal.'));
    if ((await modal(t('Force Signal'), body)) !== 'ok' || !val.value.trim()) return;
    await this.cmd(`force ${kind.value === 'deposit' ? '-deposit ' : ''}${path} ${val.value.trim()}${delay.value.trim() ? ' ' + delay.value.trim().replace(/\s+/g, '') : ''}`);
  }

  about() {
    void modal(t('About WebSim'), h('div', { class: 'about' },
      h('h2', {}, 'WebSim'),
      h('p', {}, t('A browser-based Verilog / SystemVerilog / VHDL event-driven simulator with a classic desktop-simulator workflow: libraries, vlog/vcom compilation, vsim elaboration, a transcript console and a waveform viewer.')),
      h('p', {}, t('This is an independent clean-room implementation written from a functional specification and the IEEE 1364 / 1076 standards. It contains no code from, and is not affiliated with, any commercial simulator vendor.')),
      h('p', { class: 'kind' }, t('Everything runs locally in your browser; files are kept in browser storage.'))),
      [{ label: t('Close'), value: 'ok', primary: true }]);
  }

  shortcuts() {
    const rows: [string, string][] = [
      ['F7 / Shift+F7', t('Compile current file / all files')], ['F9', t('Run for the run length')], ['F5', t('Run -all')], ['Esc', t('Break a running simulation')],
      ['F8', t('Toggle breakpoint at the editor cursor (or click the gutter)')], ['F11 / F10', t('Step / Step over')],
      ['Ctrl+S', t('Save file')], ['Ctrl+Alt+N', t('New file')],
      [t('Wave: F / I / O / C'), t('Zoom full / in / out / center cursor')], [t('Wave: Tab / Shift+Tab'), t('Next / previous transition')], [t('Wave: Del'), t('Delete selected signals')],
      [t('Wave: Ctrl+wheel'), t('Zoom around mouse')], [t('Wave: drag'), t('Zoom to area')], [t('Transcript: ↑ / ↓ / Tab'), t('History / completion')],
    ];
    void modal(t('Keyboard Shortcuts'), h('table', { class: 'grid' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', { class: 'mono' }, k), h('td', {}, v))))), [{ label: t('Close'), value: 'ok', primary: true }]);
  }

  // ------------------------------------------------------------ startup
  private async start() {
    const tr = this.transcript;
    tr.print(t('WebSim — browser HDL simulator (clean-room implementation).'));
    tr.print(t('Type "help" for commands. Use File ▸ Load Example to try the bundled designs.'));
    for (const l of this.state.libs) this.session.libs.ensure(l);
    this.session.loadBreakpoints(this.state.breakpoints ?? []);
    if (this.fs.empty || !this.state.seen) {
      this.state.seen = true;
      this.persist();
      if (this.fs.empty) { await this.loadExample('counter', true); return; }
    }
    if (this.state.compiled.length) {
      this.session.rebuild(this.state.compiled);
      tr.print(t('Restored library "work" ({0} source file(s) recompiled).', this.state.compiled.length));
    }
    for (const f of this.state.openFiles) if (this.fs.has(f)) this.editors.open(f);
    this.right.activate('wave');
    this.transcript.focus();
  }
}
