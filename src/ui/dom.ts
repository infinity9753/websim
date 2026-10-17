// Tiny DOM helpers and inline icons.
import { t } from './i18n';

type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: HTMLElement) { while (el.firstChild) el.removeChild(el.firstChild); }

const S = (body: string) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${body}</svg>`;

export const ICONS: Record<string, string> = {
  newfolder: S('<path d="M1.5 4h4.5l1.5 1.5h7v8h-13z" fill="#e8c46a" stroke="#a5852f"/><path d="M8.5 9.5h4M10.5 7.5v4" stroke="#2a7a2a" stroke-width="1.5"/>'),
  search: S('<circle cx="6.5" cy="6.5" r="4" fill="none" stroke="var(--ic-line)" stroke-width="1.5"/><path d="M9.5 9.5l4.5 4.5" stroke="var(--ic-line)" stroke-width="1.8"/>'),
  newfile: S('<path d="M4 1.5h5l3 3V14.5H4z" fill="var(--ic-paper)" stroke="var(--ic-line)"/><path d="M9 1.5v3h3" fill="none" stroke="var(--ic-line)"/>'),
  open: S('<path d="M1.5 4.5h4l1 1h7v8h-12z" fill="var(--ic-folder)" stroke="var(--ic-line)"/>'),
  save: S('<rect x="2" y="2" width="12" height="12" rx="1" fill="var(--ic-blue)" stroke="var(--ic-line)"/><rect x="4.5" y="2.5" width="7" height="4" fill="var(--ic-paper)"/><rect x="4" y="9" width="8" height="4.5" fill="var(--ic-paper)"/>'),
  compile: S('<path d="M3 2.5h7l3 3v8H3z" fill="var(--ic-paper)" stroke="var(--ic-line)"/><path d="M5 9l2 2 4-5" fill="none" stroke="var(--ic-green)" stroke-width="2"/>'),
  compileall: S('<path d="M2 1.5h6l2 2v6H2z" fill="var(--ic-paper)" stroke="var(--ic-line)"/><path d="M6 6.5h6l2 2v6H6z" fill="var(--ic-paper)" stroke="var(--ic-line)"/><path d="M7.5 11l1.5 1.5 3-3.5" fill="none" stroke="var(--ic-green)" stroke-width="1.8"/>'),
  simulate: S('<rect x="1.5" y="3" width="13" height="10" rx="1" fill="#101418" stroke="var(--ic-line)"/><path d="M3 10h2V6h3v4h2V6h3" fill="none" stroke="#3ddc84" stroke-width="1.4"/>'),
  run: S('<path d="M4 2.5v11l9-5.5z" fill="var(--ic-green)" stroke="var(--ic-line)"/>'),
  cont: S('<path d="M2 2.5v11l6-5.5z" fill="var(--ic-green)" stroke="var(--ic-line)"/><path d="M8 2.5v11l6-5.5z" fill="var(--ic-green)" stroke="var(--ic-line)"/>'),
  runall: S('<path d="M2 2.5v11l6-5.5z" fill="var(--ic-green)" stroke="var(--ic-line)"/><path d="M8 2.5v11l6-5.5z" fill="var(--ic-green)" stroke="var(--ic-line)"/><rect x="13.2" y="2.5" width="1.8" height="11" fill="var(--ic-line)"/>'),
  brk: S('<rect x="3" y="3" width="10" height="10" rx="1.5" fill="var(--ic-red)" stroke="var(--ic-line)"/>'),
  restart: S('<path d="M12.5 8a4.5 4.5 0 1 1-1.4-3.3" fill="none" stroke="var(--ic-blue)" stroke-width="2"/><path d="M12.8 1.8v3.6H9.2z" fill="var(--ic-blue)"/>'),
  zoomin: S('<circle cx="6.5" cy="6.5" r="4.5" fill="var(--ic-paper)" stroke="var(--ic-line)" stroke-width="1.4"/><path d="M10 10l4.5 4.5" stroke="var(--ic-line)" stroke-width="2"/><path d="M4 6.5h5M6.5 4v5" stroke="var(--ic-blue)" stroke-width="1.6"/>'),
  zoomout: S('<circle cx="6.5" cy="6.5" r="4.5" fill="var(--ic-paper)" stroke="var(--ic-line)" stroke-width="1.4"/><path d="M10 10l4.5 4.5" stroke="var(--ic-line)" stroke-width="2"/><path d="M4 6.5h5" stroke="var(--ic-blue)" stroke-width="1.6"/>'),
  zoomfull: S('<rect x="1.5" y="3.5" width="13" height="9" fill="var(--ic-paper)" stroke="var(--ic-line)"/><path d="M3 8h10M3 8l2-2M3 8l2 2M13 8l-2-2M13 8l-2 2" fill="none" stroke="var(--ic-blue)" stroke-width="1.3"/>'),
  zoomcursor: S('<rect x="1.5" y="3.5" width="13" height="9" fill="var(--ic-paper)" stroke="var(--ic-line)"/><path d="M8 3.5v9" stroke="#d4a017" stroke-width="2"/>'),
  prevedge: S('<path d="M10 3v10M10 8H3M6 5L3 8l3 3" fill="none" stroke="var(--ic-blue)" stroke-width="1.6"/>'),
  nextedge: S('<path d="M6 3v10M6 8h7M10 5l3 3-3 3" fill="none" stroke="var(--ic-blue)" stroke-width="1.6"/>'),
  stepinto: S('<path d="M8 2v8M5 7l3 3 3-3" fill="none" stroke="var(--ic-blue)" stroke-width="1.8"/><circle cx="8" cy="13" r="1.8" fill="var(--ic-green)"/>'),
  stepover: S('<path d="M3 9a5 5 0 0 1 10 0" fill="none" stroke="var(--ic-blue)" stroke-width="1.8"/><path d="M13.5 5.5V9.5H9.5" fill="none" stroke="var(--ic-blue)" stroke-width="1.8"/><circle cx="8" cy="13" r="1.8" fill="var(--ic-green)"/>'),
  trash: S('<path d="M3.5 4.5h9l-1 9.5h-7z" fill="var(--ic-paper)" stroke="var(--ic-line)"/><path d="M2.5 4h11M6 2.5h4" stroke="var(--ic-line)" stroke-width="1.4"/>'),
  up: S('<path d="M8 3l5 6H3z" fill="var(--ic-line)"/>'),
  down: S('<path d="M8 13l5-6H3z" fill="var(--ic-line)"/>'),
  addwave: S('<rect x="1.5" y="3" width="10" height="10" rx="1" fill="#101418" stroke="var(--ic-line)"/><path d="M2.5 10h2V6h3v4h2" fill="none" stroke="#3ddc84" stroke-width="1.2"/><path d="M12.5 5v6M9.5 8h6" stroke="var(--ic-green)" stroke-width="2"/>'),
  download: S('<path d="M8 2v8M4.5 7L8 10.5 11.5 7" fill="none" stroke="var(--ic-blue)" stroke-width="1.8"/><path d="M2.5 12.5h11" stroke="var(--ic-line)" stroke-width="1.6"/>'),
  upload: S('<path d="M8 11V3M4.5 6L8 2.5 11.5 6" fill="none" stroke="var(--ic-blue)" stroke-width="1.8"/><path d="M2.5 13.5h11" stroke="var(--ic-line)" stroke-width="1.6"/>'),
  rename: S('<path d="M2.5 11.5L10 4l2 2-7.5 7.5H2.5z" fill="var(--ic-paper)" stroke="var(--ic-line)"/>'),
  close: S('<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6"/>'),
  chip: S('<rect x="3.5" y="3.5" width="9" height="9" fill="var(--ic-blue)" stroke="var(--ic-line)"/><path d="M5 1.5v2M8 1.5v2M11 1.5v2M5 12.5v2M8 12.5v2M11 12.5v2M1.5 5h2M1.5 8h2M1.5 11h2M12.5 5h2M12.5 8h2M12.5 11h2" stroke="var(--ic-line)"/>'),
  lib: S('<rect x="2" y="2.5" width="3" height="11" fill="var(--ic-blue)" stroke="var(--ic-line)"/><rect x="6" y="2.5" width="3" height="11" fill="var(--ic-green)" stroke="var(--ic-line)"/><path d="M10.5 3.5l2.6-.9 2.9 10.4-2.7.8z" fill="var(--ic-folder)" stroke="var(--ic-line)"/>'),
};

export function icon(name: string, cls = 'ic') {
  return h('span', { class: cls, html: ICONS[name] ?? '' });
}

/** Simple modal dialog. Resolves with the form values or null. */
export function modal(title: string, body: HTMLElement, buttons: { label: string; value: string; primary?: boolean }[] = [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }]): Promise<string> {
  return new Promise(resolve => {
    const close = (v: string) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close('cancel');
      if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) { const p = buttons.find(b => b.primary); if (p) { e.preventDefault(); close(p.value); } }
    };
    const overlay = h('div', { class: 'modal-overlay', onmousedown: (e: MouseEvent) => { if (e.target === overlay) close('cancel'); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
        h('div', { class: 'modal-title' }, title, h('button', { class: 'modal-x', title: t('Close'), onclick: () => close('cancel') }, icon('close'))),
        h('div', { class: 'modal-body' }, body),
        h('div', { class: 'modal-buttons' }, buttons.map(b => h('button', { class: b.primary ? 'btn primary' : 'btn', onclick: () => close(b.value) }, b.label)))));
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    const first = body.querySelector('input, select, textarea') as HTMLElement | null;
    setTimeout(() => (first ?? overlay.querySelector('.btn.primary') as HTMLElement)?.focus(), 0);
  });
}

export async function promptText(title: string, label: string, value = ''): Promise<string | null> {
  const inp = h('input', { type: 'text', value, class: 'field', spellcheck: 'false' });
  const r = await modal(title, h('label', { class: 'form-row' }, h('span', {}, label), inp));
  return r === 'ok' ? inp.value.trim() : null;
}

export async function alertBox(title: string, msg: string): Promise<void> {
  await modal(title, h('p', {}, msg), [{ label: t('OK'), value: 'ok', primary: true }]);
}

export async function confirmBox(title: string, msg: string): Promise<boolean> {
  return (await modal(title, h('p', {}, msg), [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }])) === 'ok';
}

let ctxMenu: HTMLElement | null = null;
export type CtxItem = { label: string; action?: () => void; disabled?: boolean; checked?: boolean; sub?: CtxItem[]; swatch?: string } | '-';

export function contextMenu(x: number, y: number, items: CtxItem[]) {
  ctxMenu?.remove();
  const menu = h('div', { class: 'ctx-menu', role: 'menu' },
    items.map(it => it === '-' ? h('div', { class: 'menu-sep' }) :
      h('div', {
        class: 'menu-item' + (it.disabled ? ' disabled' : '') + (it.sub ? ' has-sub' : ''), role: 'menuitem',
        onclick: (e: MouseEvent) => {
          if (it.disabled) return;
          if (it.sub) {
            // open the submenu next to this item (replaces the current menu)
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            e.stopPropagation();
            contextMenu(r.right, r.top, it.sub);
            return;
          }
          menu.remove(); ctxMenu = null; it.action?.();
        },
      },
        h('span', { class: 'menu-check' }, it.checked ? '✓' : ''),
        it.swatch ? h('span', { class: 'menu-swatch', style: { background: it.swatch } }) : '',
        it.label, it.sub ? h('span', { class: 'menu-arrow' }, '▸') : '')));
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
  ctxMenu = menu;
  const off = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) { menu.remove(); ctxMenu = null; document.removeEventListener('mousedown', off, true); } };
  setTimeout(() => document.addEventListener('mousedown', off, true), 0);
}

export function download(name: string, text: string) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
