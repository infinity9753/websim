// Transcript console: command output plus prompt with history.
import { h, clear } from './dom';
import type { MsgKind } from '../engine/commands';
import type { RemoteSession as Session } from './remote';

const MAX_LINES = 6000;

export class Transcript {
  el: HTMLElement;
  private out: HTMLElement;
  private input: HTMLInputElement;
  private promptEl: HTMLElement;
  private histIdx = -1;
  private draft = '';
  onOpenLocation?: (file: string, line: number) => void;
  private pendingScroll = false;

  constructor(private session: Session) {
    this.out = h('div', { class: 'tr-out', role: 'log', 'aria-live': 'polite' });
    this.promptEl = h('span', { class: 'prompt' });
    this.input = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Command input' });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.el = h('div', { class: 'transcript', onclick: (e: MouseEvent) => { if ((e.target as HTMLElement).closest('.tr-out') && !window.getSelection()?.toString()) this.input.focus(); } },
      this.out, h('div', { class: 'tr-in' }, this.promptEl, this.input));
    this.updatePrompt();
    session.on('sim', () => this.updatePrompt());
    session.on('running', () => { this.input.disabled = session.running; this.updatePrompt(); if (!session.running) this.input.focus({ preventScroll: true }); });
    session.emitClear = () => this.clear();
  }

  updatePrompt() { this.promptEl.textContent = this.session.running ? '(running)' : this.session.prompt; }

  print(msg: string, kind: MsgKind = 'out') {
    const line = h('div', { class: `tr-line ${kind}` });
    const text = kind === 'cmd' ? msg : `# ${msg}`;
    // make "file(line)" references clickable
    const re = /([\w./-]+\.(?:v|sv|vh|vhd|vhdl|do))\((\d+)\)/g;
    let last = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      line.appendChild(document.createTextNode(text.slice(last, m.index)));
      const file = m[1], ln = Number(m[2]);
      line.appendChild(h('span', { class: 'link', title: `Open ${file} at line ${ln}`, onclick: () => this.onOpenLocation?.(file, ln) }, m[0]));
      last = m.index + m[0].length;
    }
    line.appendChild(document.createTextNode(text.slice(last)));
    this.out.appendChild(line);
    while (this.out.childElementCount > MAX_LINES) this.out.firstElementChild!.remove();
    if (!this.pendingScroll) {
      this.pendingScroll = true;
      requestAnimationFrame(() => { this.pendingScroll = false; this.out.scrollTop = this.out.scrollHeight; });
    }
    if (kind === 'cmd') this.updatePrompt();
  }

  clear() { clear(this.out); }
  focus() { this.input.focus(); }
  text(): string { return [...this.out.children].map(c => c.textContent).join('\n'); }

  async run(cmd: string) {
    await this.session.exec(cmd);
    this.updatePrompt();
  }

  private async onKey(e: KeyboardEvent) {
    const hist = this.session.history;
    if (e.key === 'Enter') {
      const v = this.input.value;
      this.input.value = '';
      this.histIdx = -1;
      await this.run(v);
    } else if (e.key === 'ArrowUp') {
      if (!hist.length) return;
      e.preventDefault();
      if (this.histIdx === -1) { this.draft = this.input.value; this.histIdx = hist.length; }
      this.histIdx = Math.max(0, this.histIdx - 1);
      this.input.value = hist[this.histIdx];
    } else if (e.key === 'ArrowDown') {
      if (this.histIdx === -1) return;
      e.preventDefault();
      this.histIdx++;
      if (this.histIdx >= hist.length) { this.histIdx = -1; this.input.value = this.draft; }
      else this.input.value = hist[this.histIdx];
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.complete();
    } else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); this.clear(); }
  }

  private complete() {
    const v = this.input.value;
    const words = v.split(/\s+/);
    const last = words[words.length - 1];
    let cands: string[];
    if (words.length === 1) cands = ['vlib', 'vmap', 'vlog', 'vcom', 'vsim', 'run', 'restart', 'quit', 'add', 'delete', 'force', 'noforce', 'examine', 'env', 'find', 'show', 'do', 'radix', 'ls', 'pwd', 'echo', 'help', 'history', 'clear', 'wave'];
    else if (/^(vlog|vcom|do)$/.test(words[0])) cands = this.session.fs.list();
    else if (this.session.design) {
      const dir = last.includes('/') ? last.slice(0, last.lastIndexOf('/') + 1) : '';
      const sc = dir ? this.session.findScope(dir.replace(/\/$/, '') || '/') : this.session.scope;
      cands = sc ? [...sc.children.map(c => dir + c.name + '/'), ...sc.objects.map(o => dir + o.name)] : [];
      if (!dir && this.session.design) cands.push('/' + this.session.design.root.name + '/');
    } else cands = [];
    const matches = cands.filter(c => c.startsWith(last));
    if (!matches.length) return;
    let common = matches[0];
    for (const m of matches) while (!m.startsWith(common)) common = common.slice(0, -1);
    if (common.length > last.length) { words[words.length - 1] = common; this.input.value = words.join(' ') + (matches.length === 1 && !common.endsWith('/') ? ' ' : ''); }
    else if (matches.length > 1) this.print(matches.join('  '));
  }
}
