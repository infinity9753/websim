// Tabbed pane container.
import { h, icon } from './dom';

interface Tab { id: string; tab: HTMLElement; label: HTMLElement; page: HTMLElement; onClose?: () => boolean | void }

export class Pane {
  el: HTMLElement;
  private tabsEl: HTMLElement;
  private body: HTMLElement;
  tabs = new Map<string, Tab>();
  active: string | null = null;
  onActivate?: (id: string) => void;

  constructor(cls: string) {
    this.tabsEl = h('div', { class: 'pane-tabs', role: 'tablist' });
    this.body = h('div', { class: 'pane-body' });
    this.el = h('section', { class: `pane ${cls}` }, this.tabsEl, this.body);
  }

  add(id: string, title: string, page: HTMLElement, opts: { closable?: boolean; onClose?: () => boolean | void; activate?: boolean; tooltip?: string } = {}) {
    if (this.tabs.has(id)) { if (opts.activate !== false) this.activate(id); return; }
    const label = h('span', {}, title);
    const tab = h('div', { class: 'pane-tab', role: 'tab', title: opts.tooltip ?? title, onclick: () => this.activate(id), onauxclick: (e: MouseEvent) => { if (e.button === 1 && opts.closable) this.close(id); } }, label);
    if (opts.closable) tab.appendChild(h('span', { class: 'tab-x', title: 'Close', onclick: (e: MouseEvent) => { e.stopPropagation(); this.close(id); } }, icon('close')));
    page.classList.add('pane-page');
    this.tabsEl.appendChild(tab);
    this.body.appendChild(page);
    this.tabs.set(id, { id, tab, label, page, onClose: opts.onClose });
    if (opts.activate !== false || !this.active) this.activate(id);
  }

  setTitle(id: string, title: string | Node) {
    const t = this.tabs.get(id);
    if (!t) return;
    t.label.replaceChildren(title);
  }

  activate(id: string) {
    if (!this.tabs.has(id)) return;
    for (const [k, t] of this.tabs) {
      t.tab.classList.toggle('active', k === id);
      t.page.classList.toggle('active', k === id);
    }
    this.active = id;
    this.onActivate?.(id);
  }

  close(id: string) {
    const t = this.tabs.get(id);
    if (!t) return;
    if (t.onClose && t.onClose() === false) return;
    t.tab.remove(); t.page.remove();
    this.tabs.delete(id);
    if (this.active === id) {
      const next = [...this.tabs.keys()].pop();
      this.active = null;
      if (next) this.activate(next);
    }
  }

  has(id: string) { return this.tabs.has(id); }
}
