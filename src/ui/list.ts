// List window: a table of values of the listed signals at every time any of them changes.
import { h, icon } from './dom';
import { VRows } from './panels';
import { fmtSig, type RemoteSession as Session } from './remote';
import { listRows, listUnit } from '../engine/list';

export class ListView {
  el: HTMLElement;
  private head: HTMLElement;
  private tbody: HTMLElement;
  private info: HTMLElement;
  private vr: VRows;
  private cols = 1;
  private raf = 0;
  private stale = false;

  constructor(private session: Session) {
    this.head = h('tr');
    this.tbody = h('tbody');
    this.info = h('span', { class: 'kind' });
    const scroll = h('div', { class: 'scroll' }, h('table', { class: 'grid vt list-grid' }, h('thead', {}, this.head), this.tbody));
    const btn = (ic: string, title: string, f: () => void) => h('button', { class: 'tb-btn', title, 'aria-label': title, onclick: f }, icon(ic));
    this.el = h('div', { class: 'list-view' },
      h('div', { class: 'subbar' },
        btn('save', 'Write the list to list.lst', () => { void this.session.exec('write list list.lst'); }),
        btn('trash', 'Remove all signals from the list', () => { void this.session.exec('delete list *'); }),
        h('span', { class: 'grow' }),
        this.info),
      scroll);
    this.vr = new VRows(scroll, this.tbody, 1);
    session.on('list', () => this.render());
    session.on('sim', () => this.render());
    session.on('time', () => this.schedule());
    // refresh when the tab becomes visible again after changes while hidden
    new IntersectionObserver(es => { if (es.some(e => e.isIntersecting) && this.stale) this.render(); }).observe(this.el);
    this.render();
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; if (this.el.offsetParent !== null) this.render(); else this.stale = true; });
  }

  render() {
    this.stale = false;
    const s = this.session;
    const lists = s.lists;
    const [f, unit] = listUnit(s.resolution);
    this.head.replaceChildren(h('th', { class: 'num' }, unit), ...lists.map(l => h('th', { title: l.path }, l.name)));
    if (this.cols !== lists.length + 1) { this.cols = lists.length + 1; this.vr = new VRows(this.tbody.closest('.scroll') as HTMLElement, this.tbody, this.cols); }
    if (!s.design || !lists.length) {
      this.info.textContent = '';
      this.vr.set(1, () => h('tr', {}, h('td', { colspan: String(this.cols), class: 'empty' }, s.design ? 'Use "add list <signals>" or the Objects context menu to list signals.' : 'No design loaded.')));
      return;
    }
    const rows = listRows(lists.map(l => ({ times: l.sig.times, at: (i: number) => l.sig.vals[i] })), s.now);
    this.info.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'}`;
    this.vr.set(rows.length, i => {
      const r = rows[i];
      return h('tr', {}, h('td', { class: 'num' }, String(r.t / f)),
        ...r.vals.map((v, j) => { const l = lists[j]; return h('td', { class: 'mono' }, fmtSig(l.sig, v, l.radix, l.radix === 'symbolic' ? l.sig.enumNames : undefined)); }));
    });
  }
}
