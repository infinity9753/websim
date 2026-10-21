# Vendored files

| File | Source | License | sha256 |
|---|---|---|---|
| `msgspec-0.22.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl` | https://pypi.org/project/msgspec/0.22.0/ (built for Pyodide 314) | BSD-3-Clause | `a66b1766311e42371e509c996c3933b161c7ae0eabdf361af5316dec197e1022` |

`gowin_pack` (Apicula) needs msgspec. YoWASP installs it with micropip from the Pyodide CDN; WebSim loads this
copy instead (`src/engine/synth.ts`), so place and route for Gowin works without third-party network access.
When `pyodide` is upgraded to a new ABI, replace the wheel with the matching `pyemscripten_*` build.
