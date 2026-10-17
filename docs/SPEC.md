# WebSim — Clean-Room Functional Specification

This document is the "specification" half of a clean-room process. It describes
the *externally observable behaviour* of a classic desktop HDL simulator
workflow (as found in widely used commercial tools such as ModelSim/Questa) using
only public, general knowledge: user manuals, tutorials, and the IEEE language
standards. **No vendor source code, binaries, disassembly, or proprietary file
formats were consulted.** The implementation team works only from this document
and the IEEE standards (IEEE 1364 Verilog, IEEE 1076 VHDL).

WebSim is an independent product. It is not affiliated with, and does not use
the trademarks or assets of, any simulator vendor.

---

## 1. Workflow model

The user-facing flow of a typical HDL simulator is:

1. **Create a library** (`vlib work`). A library is a named container for
   compiled design units. `work` is the default target.
2. **Compile sources** into the library:
   - `vlog <files>` compiles Verilog (and a small SystemVerilog subset).
   - `vcom <files>` compiles VHDL.
   Compilation reports per-unit progress (`-- Compiling module counter`) and
   errors with file and line (`** Error: file.v(12): ...`).
3. **Load a simulation** (`vsim <lib>.<top>`): elaborates the design hierarchy
   rooted at a top-level unit, resolves parameters/generics, and connects ports.
4. **Inspect and run**: add signals to the wave window (`add wave`), run the
   simulator for a time span (`run 100 ns`) or until no more events / `$finish`
   (`run -all`), and inspect values (`examine`).
5. **Restart / quit**: `restart` re-elaborates and returns to time 0 keeping the
   wave setup; `quit -sim` unloads the design.

A *project* groups source files, their compile order, and the default library.

## 2. User interface (main window)

| Region | Behaviour |
|---|---|
| Menu bar | File / Edit / View / Compile / Simulate / Wave / Help. |
| Toolbar | New file, save, compile, compile all, simulate, run (default length), run-length field, run -all, break, restart, zoom in/out/full. |
| **Library** panel | Tree of libraries → compiled design units (module/entity/architecture/package) with type. Double-click a unit to simulate it. |
| **Project** panel | Project source files with compile status (✓ / ✗ / ?), compile order, add/remove/new file. Double-click opens the editor. |
| **Sim** (structure) panel | Instance hierarchy of the loaded design. Selecting an instance populates Objects. |
| **Objects** panel | Signals of the selected scope: name, current value, kind (in/out/inout/internal). Add selected/all to wave. |
| **Wave** window | Signal list with value at cursor, waveform area with time ruler, logic and bus rendering (X red, Z blue/mid-level), cursor placement by click, zoom, radix per signal (binary/hex/unsigned/signed/octal/ascii). |
| **Source** editor | Syntax-highlighted editor with line numbers; tabs per file; save; compile current file. |
| **Transcript** | Console at the bottom. Echoes commands and messages prefixed with `# `. Prompt `VSIM n>` when a design is loaded, otherwise `ModelSim>`-style generic prompt (WebSim uses `WebSim>`). Command history with Up/Down. |

## 3. Transcript command language (subset)

| Command | Semantics |
|---|---|
| `vlib <name>` | Create library. |
| `vmap <logical> <physical>` | Accepted; libraries are virtual. |
| `vdel [-lib L] [-all] [unit]` | Delete unit(s) or library contents. |
| `vlog [-work L] <files...>` | Compile Verilog files. |
| `vcom [-work L] [-2008] <files...>` | Compile VHDL files. |
| `vsim [-t <res>] [-g<name>=<v>] [lib.]top` | Elaborate and load. |
| `run [<n> [<unit>]] \| -all \| -continue` | Advance simulation. Default run length 100 ns. |
| `restart [-f]` | Back to time 0, keep waves. |
| `quit -sim` | Unload simulation. |
| `add wave [-radix r] <paths...>` | Paths are absolute (`/tb/dut/q`) or relative to current scope; `*` wildcard; `-r` recursive. |
| `delete wave *` | Clear wave window. |
| `force [-deposit] <sig> <val> [<time>]` | Override a signal value. |
| `noforce <sig>` | Release force. |
| `examine <sig...>` | Print current values. |
| `env [scope]` | Show / change current scope. |
| `ls`, `pwd`, `echo`, `help`, `clear`, `history` | Utilities. |
| `do <file>` | Execute a script of commands (one per line, `#` comments). |
| `radix <r>` | Default radix. |
| `wave zoom full` | Zoom wave to whole simulation. |
| `when`/`bp` | Not implemented in v1. |

Messages:
- Simulator notes: `# ** Note: $finish    : tb.v(30)` then `#    Time: 120 ns  Iteration: 0  Instance: /tb`.
- `$stop` pauses (`# Break in Module tb at tb.v line 31`).
- VHDL `assert ... severity` maps to `** Note/Warning/Error/Failure`; `failure` stops.

## 4. Language support (v1 targets)

### 4.1 Verilog (IEEE 1364-2005 subset + common SystemVerilog)
- Modules, ANSI and non-ANSI ports, `parameter`/`localparam`, `#(...)` overrides (ordered and named).
- `wire`, `reg`, `integer`, `logic`, `bit`, signed vectors, memories (`reg [7:0] m [0:255]`).
- `assign` (with optional delay), `always`, `always_ff`, `always_comb`, `always_latch`, `initial`.
- Statements: `begin/end` (named), `if/else`, `case/casez/casex`, `for`, `while`, `repeat`, `forever`, `#delay`, `@(event)` incl. `posedge/negedge/or/,/*`, `wait(expr)`, blocking/non-blocking with intra-assignment delay, `disable`.
- Functions and tasks; `generate for/if` with `genvar`.
- Expressions: full operator set incl. reduction, `===`, `<<<`/`>>>`, `**`, ternary, concatenation, replication, bit/part/indexed (`+:`/`-:`) selects.
- 4-state logic (0, 1, X, Z), Verilog sizing and sign rules.
- System tasks: `$display $write $strobe $monitor $finish $stop $time $stime $realtime $random $urandom $signed $unsigned $clog2 $readmemh $readmemb $dumpfile $dumpvars(no-op)`.
- Compiler directives: `` `timescale `define `undef `ifdef `ifndef `else `elsif `endif `include ``.

### 4.2 VHDL (IEEE 1076-1993/2008 subset)
- `library`/`use` (ieee.std_logic_1164, numeric_std, std_logic_unsigned built in).
- Entities with generics and ports; architectures; packages (constants, types, functions).
- Types: `std_logic(_vector)`, `std_ulogic`, `bit(_vector)`, `boolean`, `integer`/`natural`/`positive` (with range), `unsigned`/`signed`, enumerations, constrained arrays (memories), `time`.
- Concurrent: processes (sensitivity list or `wait`), signal assignment, conditional `when/else`, selected `with/select`, component and direct entity instantiation, `for/if generate`.
- Sequential: variable/signal assignment (with `after`), `if/elsif/else`, `case`, `for/while/loop`, `exit/next`, `wait [on][until][for]`, `assert/report`, `null`, procedure/function calls.
- Functions: `rising_edge falling_edge to_integer to_unsigned to_signed unsigned signed std_logic_vector resize conv_integer conv_std_logic_vector`, attributes `'event 'length 'range 'high 'low 'left 'right 'image`, `now`, `std.env.stop/finish`.
- std_logic values are mapped onto the 4-state domain (U,X,W,- → X; L → 0; H → 1).

## 5. Simulation semantics
- Discrete-event kernel with time steps, delta cycles, active / inactive /
  non-blocking-update / postponed (monitor, strobe) regions.
- Nets with multiple drivers are resolved per bit (Z yields; conflict → X).
- Iteration limit per time step (default 10000 deltas) reports
  `** Error: Iteration limit reached` and stops.
- Time is kept as integer picoseconds; display uses the simulator resolution
  (finest precision found in the design, or `-t`).
- All signal transitions are recorded, so signals added to the wave after the
  fact show full history (a WebSim convenience).

## 6. Persistence
Project files and library contents (as source snapshots) persist in browser
storage. Files can be imported from / exported to the local disk.
