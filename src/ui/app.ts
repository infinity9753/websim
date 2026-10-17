// Application shell: menus, toolbar, panes, dialogs, persistence.
import { h, icon, modal, promptText, confirmBox, download, clear } from './dom';
import { Pane } from './pane';
import { RemoteSession } from './remote';
import { BrowserFS, langOf, loadState, saveState } from './vfs';
import { Transcript } from './transcript';
import { Editors } from './editor';
import { WaveView } from './wave';
import { ProjectPanel, LibraryPanel, StructurePanel, ObjectsPanel, ProcessesPanel, MemoryPanel, LocalsPanel } from './panels';
import { EXAMPLES } from './samples';
import { fmtTime } from '../engine/format';

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
    this.left.add('project', 'Project', this.project.el, { activate: true });
    this.left.add('library', 'Library', this.library.el, { activate: false });
    this.left.add('sim', 'sim', this.structure.el, { activate: false });
    this.mid.add('objects', 'Objects', this.objects.el);
    this.mid.add('processes', 'Processes', this.processes.el, { activate: false });
    this.mid.add('memory', 'Memory', this.memory.el, { activate: false });
    this.mid.add('locals', 'Locals', this.locals.el, { activate: false });
    this.mid.onActivate = (id) => { if (id === 'memory') this.memory.show(); };
    this.right.add('wave', 'Wave', this.wave.el);
    this.bottom.add('transcript', 'Transcript', this.transcript.el);

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
      state: h('b', {}, 'No design'),
      now: h('b', {}, '0 ns'),
      delta: h('b', {}, '0'),
      scope: h('b', {}, '—'),
      mem: h('b', {}, '—'),
      lib: h('b', {}, 'work'),
    };
    const st = this.status;
    const statusbar = h('div', { class: 'statusbar' },
      h('span', {}, st.ind, st.state),
      h('span', {}, 'Now: ', st.now),
      h('span', {}, 'Delta: ', st.delta),
      h('span', {}, 'Region: ', st.scope),
      h('span', { title: 'Recorded waveform history (estimate). Use "log -cap" / "nolog" to limit.' }, 'History: ', st.mem),
      h('span', { class: 'grow' }),
      h('span', {}, 'Library: ', st.lib),
      h('span', {}, 'WebSim — clean-room HDL simulator'));

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
      ['File', [
        { label: 'New File…', kbd: 'Ctrl+Alt+N', action: () => this.newFile() },
        { label: 'Import Files…', action: () => this.importFiles() },
        { label: 'Save', kbd: 'Ctrl+S', action: () => { const n = this.editors.activeName; if (n) this.editors.save(n); } },
        { label: 'Save All', action: () => this.editors.saveAll() },
        '-',
        { label: 'Load Example', sub: EXAMPLES.map(ex => ({ label: ex.title, action: () => void this.loadExample(ex.id, true) })) },
        { label: 'Download Project (.json)', action: () => this.exportProject() },
        { label: 'Export Transcript', action: () => download('transcript.txt', this.transcript.text()) },
        '-',
        { label: 'Reset Workspace…', action: () => void this.resetWorkspace() },
      ]],
      ['View', [
        { label: 'Toggle Project/Library pane', action: () => this.togglePane('left') },
        { label: 'Toggle Objects/Processes pane', action: () => this.togglePane('mid') },
        '-',
        { label: 'Project', action: () => { this.showLeft(); this.left.activate('project'); } },
        { label: 'Library', action: () => { this.showLeft(); this.left.activate('library'); } },
        { label: 'Structure (sim)', action: () => { this.showLeft(); this.left.activate('sim'); } },
        { label: 'Objects', action: () => { this.showMid(); this.mid.activate('objects'); } },
        { label: 'Processes', action: () => { this.showMid(); this.mid.activate('processes'); } },
        { label: 'Memory', action: () => { this.showMid(); this.mid.activate('memory'); } },
        { label: 'Wave', action: () => this.right.activate('wave') },
        '-',
        { label: 'Theme: Auto', action: () => this.setTheme('auto') },
        { label: 'Theme: Light', action: () => this.setTheme('light') },
        { label: 'Theme: Dark', action: () => this.setTheme('dark') },
      ]],
      ['Compile', [
        { label: 'Compile Current File', kbd: 'F7', action: () => this.compileCurrent() },
        { label: 'Compile All', kbd: 'Shift+F7', action: () => this.compileFiles(this.project.hdlFiles()) },
        { label: 'Compile Selected', action: () => this.project.sel && this.compileFiles([this.project.sel]) },
        '-',
        { label: 'Clear Library "work"', action: () => void this.cmd('vdel -lib work -all') },
      ]],
      ['Simulate', [
        { label: 'Start Simulation…', action: () => void this.startSimDialog() },
        { label: 'Run', kbd: 'F9', action: () => void this.cmd(`run ${this.runField.value}`) },
        { label: 'Run -All', kbd: 'F5', action: () => void this.cmd('run -all') },
        { label: 'Continue', action: () => void this.cmd('run -continue') },
        { label: 'Break', kbd: 'Esc', action: () => this.session.breakRun() },
        { label: 'Step', kbd: 'F11', action: () => void this.cmd('step') },
        { label: 'Step Over', kbd: 'F10', action: () => void this.cmd('step -over') },
        { label: 'Toggle Breakpoint at Cursor', kbd: 'F8', action: () => this.toggleBpAtCursor() },
        { label: 'Delete All Breakpoints', action: () => void this.cmd('bd all') },
        { label: 'Restart', action: () => void this.cmd('restart -f') },
        '-',
        { label: 'End Simulation', action: () => void this.cmd('quit -sim') },
      ]],
      ['Wave', [
        { label: 'Zoom Full', kbd: 'F', action: () => this.wave.zoomFull() },
        { label: 'Zoom In', kbd: 'I', action: () => this.wave.zoom(0.5) },
        { label: 'Zoom Out', kbd: 'O', action: () => this.wave.zoom(2) },
        { label: 'Center on Cursor', kbd: 'C', action: () => this.wave.centerCursor() },
        '-',
        { label: 'Add All Signals (recursive)', action: () => void this.cmd('add wave -r /*') },
        { label: 'Save Format…', action: () => void this.saveWaveFormat() },
        { label: 'Load Format…', action: () => void this.loadWaveFormat() },
        '-',
        { label: 'Export VCD (wave signals)…', action: () => void this.exportVcd(false) },
        { label: 'Export VCD (all signals)…', action: () => void this.exportVcd(true) },
        { label: 'Delete Selected', kbd: 'Del', action: () => this.wave.deleteSelected() },
        { label: 'Delete All', action: () => void this.cmd('delete wave *') },
      ]],
      ['Help', [
        { label: 'Command Reference', action: () => void this.cmd('help') },
        { label: 'Keyboard Shortcuts', action: () => this.shortcuts() },
        { label: 'About WebSim', action: () => this.about() },
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
    this.runField = h('input', { class: 'tb-field', value: this.state.runLength, title: 'Run length', 'aria-label': 'Run length', onchange: () => { this.state.runLength = this.runField.value; this.persist(); } });
    const run = b('run', 'Run (F9): advance by the run length', () => void this.cmd(`run ${this.runField.value}`));
    const cont = b('cont', 'Continue run', () => void this.cmd('run -continue'));
    const runall = b('runall', 'Run -All (F5)', () => void this.cmd('run -all'));
    this.brkBtn = b('brk', 'Break (Esc)', () => this.session.breakRun());
    const restart = b('restart', 'Restart', () => void this.cmd('restart -f'));
    const stepIn = b('stepinto', 'Step (F11): run to the next statement', () => void this.cmd('step'));
    const stepOver = b('stepover', 'Step Over (F10): next statement in this process, skipping task calls', () => void this.cmd('step -over'));
    this.runBtns = [run, cont, runall, stepIn, stepOver];
    this.simBtns = [restart];
    return h('div', { class: 'toolbar', role: 'toolbar' },
      b('newfile', 'New file', () => this.newFile()),
      b('open', 'Import files', () => this.importFiles()),
      b('save', 'Save (Ctrl+S)', () => { const n = this.editors.activeName; if (n) this.editors.save(n); }),
      h('span', { class: 'tb-sep' }),
      b('compile', 'Compile current file (F7)', () => this.compileCurrent()),
      b('compileall', 'Compile all (Shift+F7)', () => this.compileFiles(this.project.hdlFiles())),
      h('span', { class: 'tb-sep' }),
      b('simulate', 'Start simulation…', () => void this.startSimDialog()),
      restart,
      h('span', { class: 'tb-sep' }),
      this.runField, run, cont, runall, this.brkBtn, stepIn, stepOver,
      h('span', { class: 'tb-sep' }),
      b('zoomin', 'Zoom in', () => this.wave.zoom(0.5)),
      b('zoomout', 'Zoom out', () => this.wave.zoom(2)),
      b('zoomfull', 'Zoom full', () => this.wave.zoomFull()),
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
      const n = await promptText('Rename file', 'New name', f);
      if (!n || n === f) return;
      if (!this.fs.rename(f, n)) { alert(`A file named "${n}" already exists.`); return; }
      this.editors.rename(f, n);
      this.project.sel = n;
    };
    this.project.onDelete = async (f) => {
      if (!(await confirmBox('Remove file', `Remove "${f}" from the project? This deletes it from browser storage.`))) return;
      this.editors.close(f);
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
      const v = await promptText('Change memory word', `${path}[${addr}]`, cur);
      if (v) { await this.session.memDeposit(path, addr, /^[0-9a-f]+$/i.test(v) && !/^[01]+$/.test(v) ? `16#${v}` : v); void this.memory.refresh(); }
    };

    s.on('sim', () => { if (s.design) { this.left.activate('sim'); this.right.activate('wave'); } this.updateStatus(); });
    let waveCount = 0;
    s.on('wave', () => { if (s.design && s.waves.length > waveCount) this.right.activate('wave'); waveCount = s.waves.length; });
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
    if (!n || !line) { this.transcript.print('** Error: Open a source file and place the cursor on a statement.', 'err'); return; }
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
    st.state.textContent = s.running ? 'Running' : d ? (d.kernel.finished ? 'Finished' : s.paused ? `Paused at ${s.paused.file}:${s.paused.line}` : 'Ready') : 'No design';
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
    if (!n) { this.transcript.print('** Error: No file selected to compile.', 'err'); return; }
    this.compileFiles([n]);
  }

  compileFiles(files: string[]) {
    this.editors.saveAll();
    const hdl = files.filter(f => langOf(f) === 'verilog' || langOf(f) === 'vhdl');
    if (!hdl.length) { this.transcript.print('** Error: No Verilog/VHDL files to compile.', 'err'); return; }
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
    const n = await promptText('New file', 'File name', 'design.v');
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
    const inp = h('input', { type: 'file', multiple: true, accept: '.v,.sv,.vh,.svh,.vhd,.vhdl,.do,.tcl,.hex,.mem,.txt,.json' });
    inp.addEventListener('change', async () => {
      for (const f of Array.from(inp.files ?? [])) {
        const text = await f.text();
        if (f.name.endsWith('.json')) {
          try { const data = JSON.parse(text); if (data?.websim && data.files) { for (const [n, t] of Object.entries(data.files as Record<string, string>)) this.fs.write(n, t); continue; } } catch { /* plain file */ }
        }
        this.fs.write(f.name, text);
        this.editors.reload(f.name);
      }
      this.transcript.print(`Imported ${inp.files?.length ?? 0} file(s).`);
    });
    inp.click();
  }

  async saveWaveFormat() {
    if (!this.session.design) { this.transcript.print('** Error: No design is loaded.', 'err'); return; }
    const n = await promptText('Save Wave Format', 'File name', 'wave.do');
    if (n) await this.cmd(`write format wave ${n}`);
  }

  async loadWaveFormat() {
    const dos = this.fs.list().filter(f => langOf(f) === 'do');
    if (!dos.length) { this.transcript.print('** Error: No .do files in the project.', 'err'); return; }
    const sel = h('select', { class: 'field' }, dos.map(d => h('option', { value: d, selected: d === 'wave.do' }, d)));
    if ((await modal('Load Wave Format', h('label', { class: 'form-row' }, h('span', {}, 'Format file'), sel))) !== 'ok') return;
    await this.cmd('delete wave *');
    await this.cmd(`do ${sel.value}`);
  }

  async exportVcd(all: boolean) {
    try {
      if (!this.session.design) throw new Error('No design is loaded.');
      if (!all && !this.session.waves.length) throw new Error('The wave window is empty.');
      const name = `${this.session.design.top}.vcd`;
      download(name, await this.session.vcdText(all));
      this.transcript.print(`Exported ${all ? 'all signals' : 'wave signals'} to ${name}.`);
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
    this.transcript.print(`Loaded example "${ex.title}". Running ${ex.doFile} …`, 'note');
    const first = Object.keys(ex.files).find(f => langOf(f) !== 'do');
    if (first) this.editors.open(first);
    this.right.activate('wave');
    if (run) await this.cmd(`do ${ex.doFile}`);
    this.right.activate('wave');
  }

  async resetWorkspace() {
    if (!(await confirmBox('Reset workspace', 'Delete all files and libraries stored in this browser and reload the examples?'))) return;
    await this.session.exec('quit -sim', false);
    for (const n of this.editors.openNames()) this.editors.close(n);
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
    if (!units.length) { await modal('Start Simulation', h('p', {}, 'The library is empty. Compile your design first (Compile ▸ Compile All).'), [{ label: 'OK', value: 'ok', primary: true }]); return; }
    const tops = new Set(this.session.libs.topLevels());
    let chosen = units.find(u => tops.has(u.name) && u.name === this.session.lastVsim?.top) ?? units.find(u => tops.has(u.name) && /tb|test/i.test(u.name)) ?? units.find(u => tops.has(u.name)) ?? units[0];
    const list = h('div', { class: 'unit-list' });
    const renderList = () => {
      clear(list);
      list.appendChild(h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Design unit'), h('th', {}, 'Type'), h('th', {}, 'Library'), h('th', {}, 'File'))),
        h('tbody', {}, units.map(u => h('tr', {
          class: u === chosen ? 'sel' : '',
          onclick: () => { chosen = u; renderList(); },
          ondblclick: () => { chosen = u; (overlayOk() as HTMLElement | null)?.click(); },
        }, h('td', {}, u.name, tops.has(u.name) ? h('span', { class: 'kind' }, '  (top)') : ''), h('td', { class: 'kind' }, u.kind === 'module' ? 'Module' : 'Entity'), h('td', { class: 'kind' }, u.lib), h('td', { class: 'kind' }, u.file))))));
    };
    const overlayOk = () => document.querySelector('.modal .btn.primary');
    renderList();
    const res = h('select', { class: 'field' }, ['default', '1fs', '1ps', '10ps', '100ps', '1ns'].map(r => h('option', { value: r }, r)));
    const gen = h('input', { class: 'field', placeholder: 'e.g. WIDTH=8 DEPTH=16', spellcheck: 'false' });
    const body = h('div', {}, list,
      h('label', { class: 'form-row' }, h('span', {}, 'Resolution'), res),
      h('label', { class: 'form-row' }, h('span', {}, 'Generics'), gen));
    const r = await modal('Start Simulation', body, [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }]);
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
    const kind = h('select', { class: 'field' }, h('option', { value: 'freeze' }, 'Freeze (force)'), h('option', { value: 'deposit' }, 'Deposit'));
    const delay = h('input', { class: 'field', placeholder: 'optional, e.g. 10 ns', spellcheck: 'false' });
    const body = h('div', {},
      h('p', {}, 'Signal: ', h('code', {}, path)),
      h('label', { class: 'form-row' }, h('span', {}, 'Value'), val),
      h('label', { class: 'form-row' }, h('span', {}, 'Kind'), kind),
      h('label', { class: 'form-row' }, h('span', {}, 'Delay'), delay),
      h('p', { class: 'kind' }, 'Values: 1, 0, X, Z, 1010, 16#FF, 8\'hA5, decimal.'));
    if ((await modal('Force Signal', body)) !== 'ok' || !val.value.trim()) return;
    await this.cmd(`force ${kind.value === 'deposit' ? '-deposit ' : ''}${path} ${val.value.trim()}${delay.value.trim() ? ' ' + delay.value.trim().replace(/\s+/g, '') : ''}`);
  }

  about() {
    void modal('About WebSim', h('div', { class: 'about' },
      h('h2', {}, 'WebSim'),
      h('p', {}, 'A browser-based Verilog / SystemVerilog / VHDL event-driven simulator with a classic desktop-simulator workflow: libraries, ', h('code', {}, 'vlog'), '/', h('code', {}, 'vcom'), ' compilation, ', h('code', {}, 'vsim'), ' elaboration, a transcript console and a waveform viewer.'),
      h('p', {}, 'This is an independent clean-room implementation written from a functional specification and the IEEE 1364 / 1076 standards. It contains no code from, and is not affiliated with, any commercial simulator vendor.'),
      h('p', { class: 'kind' }, 'Everything runs locally in your browser; files are kept in browser storage.')),
      [{ label: 'Close', value: 'ok', primary: true }]);
  }

  shortcuts() {
    const rows: [string, string][] = [
      ['F7 / Shift+F7', 'Compile current file / all files'], ['F9', 'Run for the run length'], ['F5', 'Run -all'], ['Esc', 'Break a running simulation'],
      ['F8', 'Toggle breakpoint at the editor cursor (or click the gutter)'], ['F11 / F10', 'Step / Step over'],
      ['Ctrl+S', 'Save file'], ['Ctrl+Alt+N', 'New file'],
      ['Wave: F / I / O / C', 'Zoom full / in / out / center cursor'], ['Wave: Tab / Shift+Tab', 'Next / previous transition'], ['Wave: Del', 'Delete selected signals'],
      ['Wave: Ctrl+wheel', 'Zoom around mouse'], ['Wave: drag', 'Zoom to area'], ['Transcript: ↑ / ↓ / Tab', 'History / completion'],
    ];
    void modal('Keyboard Shortcuts', h('table', { class: 'grid' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', { class: 'mono' }, k), h('td', {}, v))))), [{ label: 'Close', value: 'ok', primary: true }]);
  }

  // ------------------------------------------------------------ startup
  private async start() {
    const t = this.transcript;
    t.print('WebSim — browser HDL simulator (clean-room implementation).');
    t.print('Type "help" for commands. Use File ▸ Load Example to try the bundled designs.');
    for (const l of this.state.libs) this.session.libs.ensure(l);
    this.session.loadBreakpoints(this.state.breakpoints ?? []);
    if (this.fs.empty || !this.state.seen) {
      this.state.seen = true;
      this.persist();
      if (this.fs.empty) { await this.loadExample('counter', true); return; }
    }
    if (this.state.compiled.length) {
      this.session.rebuild(this.state.compiled);
      t.print(`Restored library "work" (${this.state.compiled.length} source file(s) recompiled).`);
    }
    for (const f of this.state.openFiles) if (this.fs.has(f)) this.editors.open(f);
    this.right.activate('wave');
    this.transcript.focus();
  }
}
