# WebSim

A browser-based Verilog / VHDL simulator with a classic desktop-simulator
workflow: libraries, `vlog`/`vcom` compilation, `vsim` elaboration, a
transcript console, structure/objects panels, and a waveform viewer.

WebSim is a **clean-room** implementation: it was written from a functional
specification ([docs/SPEC.md](docs/SPEC.md)) derived from public knowledge and
the IEEE language standards. It contains no code or assets from any commercial
simulator and is not affiliated with any vendor.

## Quick start

```bash
npm install
npm run dev      # open the printed URL
npm test         # engine test-suite
npm run build    # static build in dist/
```

In the transcript:

```
vlib work
vlog counter.v tb_counter.v
vsim work.tb_counter
add wave -r /*
run -all
```

## Layout

| Path | Purpose |
|---|---|
| `src/engine/logic.ts` | 4-state bit-vector arithmetic |
| `src/engine/verilog/` | Verilog preprocessor, lexer, parser |
| `src/engine/vhdl/` | VHDL lexer, parser |
| `src/engine/ast.ts` | Language-neutral design AST |
| `src/engine/elab.ts` | Elaboration + closure compiler |
| `src/engine/kernel.ts` | Event-driven simulation kernel |
| `src/engine/library.ts` | Compiled-unit libraries |
| `src/engine/commands.ts` | Transcript command interpreter |
| `src/ui/` | Browser UI (panels, wave viewer, editor) |
| `tests/` | Vitest suite |

## License

MIT
