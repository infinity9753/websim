# WebSim — notes for contributors and coding agents

Browser-based Verilog / SystemVerilog / VHDL event-driven simulator with a classic desktop-simulator
workflow (vlib → vlog/vcom → vsim → add wave → run). TypeScript, Vite, CodeMirror 6, no backend.

## Clean-room rule

WebSim is a clean-room implementation written from `docs/SPEC.md`, public knowledge of how HDL
simulators behave, and the IEEE 1364 / 1800 / 1076 standards. Never copy code, documentation,
messages or assets from a commercial simulator. Message formats such as `** Error: file(line): ...`
or `(vsim-3170)` follow publicly visible tool output for compatibility with existing scripts.

## Commands

```bash
npm run dev        # dev server (http://localhost:5173/)
npm test           # Vitest unit/integration tests (tests/**/*.test.ts)
npm run typecheck  # tsc (also part of npm run build)
npm run build      # production build in dist/
npm run test:e2e   # Playwright UI tests (e2e/) against "vite preview"; needs Chromium:
                   #   npx playwright install chromium   or   PW_CHROMIUM=/path/to/chromium
npm run bench      # simulation kernel benchmark (bench/lfsr.ts)
```

CI (`.github/workflows/deploy.yml`) runs unit tests, build and E2E on every push and PR, and deploys
`main` to GitHub Pages.

## Layout

| Path | What |
|---|---|
| `src/engine/logic.ts` | 4-state `Vec` (BigInt planes a/b, plus u/k for std_logic U and weak W/L/H), operators, resolution |
| `src/engine/kernel.ts` | Event kernel: signals with full value history, drivers, processes (generators or loop callbacks), active/inactive/NBA/postponed regions, deltas, breakpoints. **Time is in femtoseconds.** |
| `src/engine/ast.ts` | Language-neutral AST shared by both front-ends |
| `src/engine/verilog/`, `src/engine/vhdl/` | Lexers, preprocessor, recursive-descent parsers |
| `src/engine/elab.ts` | Elaborator: instance hierarchy, types, and compilation of expressions/statements into closures; classes, assertions, UDPs, coverage, dataflow relations |
| `src/engine/commands.ts` | `Session`: the transcript command interpreter (vlib, vlog, vsim, run, add wave, force, ...) |
| `src/engine/worker.ts`, `protocol.ts` | The simulation runs in a Web Worker; state is streamed to the UI (`PState`, incremental history deltas) |
| `src/engine/{format,vcd,list,coverage,textio,library}.ts` | Value/time formatting, VCD writer/reader, List window rows, coverage report, VHDL textio, design libraries |
| `src/ui/remote.ts` | `RemoteSession`: UI-side mirror of the worker session (same API shape as `Session`) |
| `src/ui/app.ts` | Main window: menus, toolbar, panes, dialogs, wiring |
| `src/ui/{wave,list,dataflow,panels,editor,transcript,search}.ts` | Windows and panels |
| `src/ui/vfs.ts` | Projects and the browser file store (localStorage, per project) |
| `src/ui/i18n.ts`, `i18n-ko.ts` | UI translations; keys are the English strings |
| `tests/` | Vitest; `tests/helpers.ts` has `simulate(files, top)` returning transcript lines |
| `e2e/` | Playwright UI tests |
| `docs/SPEC.md`, `docs/GUIDE.md` | Functional specification (English) and user guide (Korean) |

## Conventions

- Every behaviour change comes with a test: engine features in `tests/*.test.ts` (use `simulate()` or a
  `Session` with an in-memory file map), UI flows in `e2e/`. Verify expected values by reasoning about
  the HDL semantics; when a test and the simulator disagree, find out which one is wrong.
- UI strings go through `t('English text')`; add the Korean entry to `src/ui/i18n-ko.ts`
  (`tests/i18n.test.ts` fails on a missing key). Simulator/transcript messages stay in English.
- Keep the UI responsive for large designs: lists use `VRows` (virtualized rows), the wave window
  renders only visible rows, and history is shipped to the UI incrementally.
- Times are integers in fs; display through `fmtTime(t, resolution)`. Verilog delays are scaled by the
  module's `timescale`.
- Match the surrounding code style (dense, small helpers, comments only where the why is not obvious).
- Commits: one step per commit, imperative subject, body explaining what and why, `Fixes #N` /
  `Refs #N` for issues.
