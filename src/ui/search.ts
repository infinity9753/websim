// Find in project files.
import { h } from './dom';
import { t } from './i18n';
import type { BrowserFS } from './vfs';

export interface SearchHit { file: string; line: number; text: string; col: number; len: number }

/** Search every project file; returns at most `limit` hits. Throws on an invalid regular expression. */
export function searchFiles(fs: BrowserFS, query: string, opts: { caseSensitive?: boolean; regex?: boolean; word?: boolean }, limit = 2000): SearchHit[] {
  if (!query) return [];
  let src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.word) src = `\\b(?:${src})\\b`;
  const re = new RegExp(src, opts.caseSensitive ? 'g' : 'gi');
  const hits: SearchHit[] = [];
  for (const file of fs.list()) {
    const lines = (fs.read(file) ?? '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (!m) continue;
      hits.push({ file, line: i + 1, text: lines[i], col: m.index, len: Math.max(1, m[0].length) });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

export class SearchPanel {
  el: HTMLElement;
  private input: HTMLInputElement;
  private results: HTMLElement;
  private info: HTMLElement;
  private opts = { caseSensitive: false, regex: false, word: false };
  onOpen?: (file: string, line: number) => void;

  constructor(private fs: BrowserFS) {
    this.input = h('input', { type: 'search', class: 'tb-field', placeholder: t('Search in project files'), 'aria-label': t('Search in project files'), style: { flex: '1', minWidth: '60px' }, oninput: () => this.schedule(), onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') this.run(); } });
    const opt = (key: keyof SearchPanel['opts'], label: string, title: string) => {
      const b = h('button', { class: 'tb-btn search-opt', title, 'aria-label': title, 'aria-pressed': 'false', onclick: () => { this.opts[key] = !this.opts[key]; b.classList.toggle('on', this.opts[key]); b.setAttribute('aria-pressed', String(this.opts[key])); this.run(); } }, label);
      return b;
    };
    this.info = h('div', { class: 'search-info kind' });
    this.results = h('div', { class: 'scroll search-results' });
    this.el = h('div', { class: 'search-panel' },
      h('div', { class: 'subbar' }, this.input, opt('caseSensitive', 'Aa', t('Match case')), opt('word', 'ab', t('Whole word')), opt('regex', '.*', t('Regular expression'))),
      this.info, this.results);
    fs.onChange(() => { if (this.input.value) this.schedule(); });
  }

  focus() { this.input.focus(); this.input.select(); }

  private timer = 0;
  private schedule() { clearTimeout(this.timer); this.timer = window.setTimeout(() => this.run(), 200); }

  run() {
    const q = this.input.value;
    let hits: SearchHit[];
    try { hits = searchFiles(this.fs, q, this.opts); } catch (e) { this.info.textContent = (e as Error).message; this.results.replaceChildren(); return; }
    const files = new Set(hits.map(x => x.file));
    this.info.textContent = q ? (hits.length ? t('{0} matches in {1} files', hits.length, files.size) : t('No matches')) : '';
    const rows: HTMLElement[] = [];
    let cur = '';
    for (const x of hits) {
      if (x.file !== cur) { cur = x.file; rows.push(h('div', { class: 'search-file' }, x.file)); }
      const pre = x.text.slice(Math.max(0, x.col - 40), x.col).trimStart();
      rows.push(h('div', { class: 'search-hit', title: `${x.file}:${x.line}`, onclick: () => this.onOpen?.(x.file, x.line) },
        h('span', { class: 'search-ln' }, String(x.line)),
        h('span', { class: 'mono' }, pre, h('mark', {}, x.text.slice(x.col, x.col + x.len)), x.text.slice(x.col + x.len, x.col + x.len + 80))));
    }
    this.results.replaceChildren(...rows);
  }
}
