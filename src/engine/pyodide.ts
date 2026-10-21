// Pyodide (CPython in WebAssembly) for the simulation worker: cocotb tests (#46) and gowin_pack (#50).
// The runtime files are served next to the app (vite.config.ts copies them to pyodide/); Node (tests) uses the package.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Py = any;

const isNode = !!(globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;

/** A variable specifier keeps bundlers from resolving Node-only modules. */
const nodeImport = (m: string) => import(/* @vite-ignore */ m);

async function indexURL(): Promise<string> {
  if (!isNode) return new URL(import.meta.env.DEV ? '/pyodide/' : '../pyodide/', self.location.href).href;
  const { createRequire } = await nodeImport('node:module');
  return createRequire(import.meta.url).resolve('pyodide').replace(/[^/\\]+$/, '');
}

/** A fresh Pyodide instance; `opts` are passed to loadPyodide. */
export async function newPyodide(opts: Record<string, unknown> = {}): Promise<Py> {
  const { loadPyodide } = await import('pyodide');
  return loadPyodide({ ...opts, indexURL: await indexURL() });
}

/** A file shipped with the app (an asset URL made with new URL(..., import.meta.url)): a path in Node, a URL in the browser. */
export async function assetLocation(url: URL): Promise<string> {
  if (!isNode) return url.href;
  const { fileURLToPath } = await nodeImport('node:url');
  return fileURLToPath(url);
}
