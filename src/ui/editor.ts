// Source editor tabs backed by CodeMirror.
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, keymap, gutter, GutterMarker } from '@codemirror/view';
import { RangeSet } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { verilog } from '@codemirror/legacy-modes/mode/verilog';
import { vhdl } from '@codemirror/legacy-modes/mode/vhdl';
import { tcl } from '@codemirror/legacy-modes/mode/tcl';
import { h } from './dom';
import { langOf, type BrowserFS } from './vfs';
import type { Pane } from './pane';
import { t } from './i18n';

const verilogLang = StreamLanguage.define(verilog);
const vhdlLang = StreamLanguage.define(vhdl);
const tclLang = StreamLanguage.define(tcl);

const setErrorLine = StateEffect.define<number | null>();
const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrorLine)) {
        if (e.value === null) deco = Decoration.none;
        else {
          const line = tr.state.doc.line(Math.min(Math.max(1, e.value), tr.state.doc.lines));
          deco = Decoration.set([Decoration.line({ class: 'cm-error-line' }).range(line.from)]);
        }
      }
    }
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});

// ---- breakpoints gutter and current execution line
const setBpLines = StateEffect.define<number[]>();
class BpMarker extends GutterMarker {
  toDOM() { const d = document.createElement('div'); d.className = 'cm-bp-dot'; d.title = t('Breakpoint (click to remove)'); return d; }
}
const bpMarker = new BpMarker();
const bpField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setBpLines)) {
        const doc = tr.state.doc;
        const ranges = [...new Set(e.value)].filter(l => l >= 1 && l <= doc.lines).sort((a, b) => a - b).map(l => bpMarker.range(doc.line(l).from));
        set = RangeSet.of(ranges);
      }
    }
    return set;
  },
});
const setExecLine = StateEffect.define<number | null>();
const execField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setExecLine)) {
      if (e.value === null) deco = Decoration.none;
      else { const line = tr.state.doc.line(Math.min(Math.max(1, e.value), tr.state.doc.lines)); deco = Decoration.set([Decoration.line({ class: 'cm-exec-line' }).range(line.from)]); }
    }
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});

interface Doc { name: string; view: EditorView; dirty: boolean; page: HTMLElement }

export class Editors {
  docs = new Map<string, Doc>();
  onSaved?: (name: string) => void;
  onCompile?: (name: string) => void;
  onChange?: () => void;
  onToggleBp?: (name: string, line: number) => void;
  private bpLines = new Map<string, number[]>();
  private exec: { file: string; line: number } | null = null;

  constructor(private pane: Pane, private fs: BrowserFS) {}

  langExt(name: string): Extension {
    const l = langOf(name);
    return l === 'verilog' ? verilogLang : l === 'vhdl' ? vhdlLang : l === 'do' ? tclLang : [];
  }

  open(name: string, line?: number) {
    let d = this.docs.get(name);
    if (!d) {
      const text = this.fs.read(name);
      if (text === undefined) return;
      const host = h('div', { class: 'editor-host' });
      const page = h('div', {}, host);
      const view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: text,
          extensions: [
            basicSetup,
            this.langExt(name),
            errorLineField,
            bpField,
            execField,
            gutter({
              class: 'cm-bp-gutter',
              markers: v => v.state.field(bpField),
              initialSpacer: () => bpMarker,
              domEventHandlers: {
                mousedown: (view, block) => { this.onToggleBp?.(name, view.state.doc.lineAt(block.from).number); return true; },
              },
            }),
            EditorState.tabSize.of(2),
            keymap.of([
              { key: 'Mod-s', preventDefault: true, run: () => { this.save(name); return true; } },
              { key: 'F7', preventDefault: true, run: () => { this.save(name); this.onCompile?.(name); return true; } },
            ]),
            EditorView.updateListener.of(u => {
              if (u.docChanged) {
                const doc = this.docs.get(name);
                if (doc && !doc.dirty) { doc.dirty = true; this.refreshTitle(name); this.onChange?.(); }
                if (doc) doc.view.dispatch({ effects: setErrorLine.of(null) });
              }
            }),
          ],
        }),
      });
      d = { name, view, dirty: false, page };
      this.docs.set(name, d);
      view.dispatch({ effects: [setBpLines.of(this.bpLines.get(name) ?? []), setExecLine.of(this.exec?.file === name ? this.exec.line : null)] });
      this.pane.add('file:' + name, name, page, { closable: true, onClose: () => this.closing(name), tooltip: name });
      this.onChange?.();
    }
    this.pane.activate('file:' + name);
    if (line) this.gotoLine(name, line, true);
    setTimeout(() => d!.view.focus(), 0);
  }

  private closing(name: string): boolean {
    const d = this.docs.get(name);
    if (d?.dirty && !confirm(t('Save changes to {0} before closing?\n\nOK = save, Cancel = discard', name))) { /* discard */ }
    else if (d?.dirty) this.save(name);
    d?.view.destroy();
    this.docs.delete(name);
    this.onChange?.();
    return true;
  }

  /** Show breakpoint markers: map of file -> lines. */
  setBreakpoints(byFile: Map<string, number[]>) {
    this.bpLines = byFile;
    for (const [n, d] of this.docs) d.view.dispatch({ effects: setBpLines.of(byFile.get(n) ?? []) });
  }

  /** Highlight the statement where simulation is paused (null clears). */
  showExec(loc: { file: string; line: number } | null) {
    this.exec = loc;
    for (const [n, d] of this.docs) d.view.dispatch({ effects: setExecLine.of(loc && loc.file === n ? loc.line : null) });
    if (loc && this.fs.has(loc.file)) { this.open(loc.file); this.gotoLine(loc.file, loc.line); }
  }

  gotoLine(name: string, line: number, mark = false) {
    const d = this.docs.get(name);
    if (!d) return;
    const doc = d.view.state.doc;
    const l = doc.line(Math.min(Math.max(1, line), doc.lines));
    d.view.dispatch({ selection: { anchor: l.from }, effects: [EditorView.scrollIntoView(l.from, { y: 'center' }), ...(mark ? [setErrorLine.of(line)] : [])] });
  }

  refreshTitle(name: string) {
    const d = this.docs.get(name);
    if (!d) return;
    this.pane.setTitle('file:' + name, d.dirty ? h('span', {}, name, h('span', { class: 'dirty' }, ' ●')) : name);
  }

  save(name: string) {
    const d = this.docs.get(name);
    if (!d) return;
    this.fs.write(name, d.view.state.doc.toString());
    d.dirty = false;
    this.refreshTitle(name);
    this.onSaved?.(name);
    this.onChange?.();
  }

  saveAll() { for (const n of this.docs.keys()) if (this.docs.get(n)!.dirty) this.save(n); }

  cursorLine(name: string): number | null {
    const d = this.docs.get(name);
    return d ? d.view.state.doc.lineAt(d.view.state.selection.main.head).number : null;
  }

  get activeName(): string | null {
    const a = this.pane.active;
    return a?.startsWith('file:') ? a.slice(5) : null;
  }

  /** Reload a file's content from the store (after external change). */
  reload(name: string) {
    const d = this.docs.get(name);
    const t = this.fs.read(name);
    if (!d || t === undefined) return;
    d.view.dispatch({ changes: { from: 0, to: d.view.state.doc.length, insert: t } });
    d.dirty = false;
    this.refreshTitle(name);
  }

  close(name: string) { this.pane.close('file:' + name); }

  rename(from: string, to: string) {
    if (!this.docs.has(from)) return;
    this.close(from);
    this.open(to);
  }

  openNames() { return [...this.docs.keys()]; }
}
