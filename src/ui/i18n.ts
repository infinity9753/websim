// UI translations. Keys are the English strings; simulator messages (transcript) are not translated.
import { KO } from './i18n-ko';

export type Lang = 'en' | 'ko';
const KEY = 'websim.lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'ko') return saved;
  } catch { /* storage unavailable */ }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

let lang: Lang = detect();
if (typeof document !== 'undefined') document.documentElement.lang = lang;

export function getLang(): Lang { return lang; }

/** Switch language; the UI is rebuilt by reloading (the project is kept in local storage). */
export function setLang(l: Lang) {
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  lang = l;
  location.reload();
}

/** Translate an English UI string; {0}, {1}... are replaced by args. */
export function t(s: string, ...args: (string | number)[]): string {
  const tr = lang === 'ko' ? KO[s] ?? s : s;
  return args.length ? tr.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')) : tr;
}
