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
| **Project** panel | Project source files in a folder tree (`rtl/alu.v`), with compile status (✓ / ✗ / ?), compile order, add/remove/new file and folder, drag a file onto a folder to move it. Double-click opens the editor. |
| Projects | File ▸ New Project / Open Project / Rename / Delete: each project keeps its own files, compiled libraries, open editors and breakpoints in browser storage (appearance settings are shared). |
| **Dataflow** window | The selected signal (from Objects or Wave, or right-click ▸ Show in Dataflow) with the processes / continuous assignments / port connections / UDPs that drive it and their inputs on the left, and those that read it with their outputs on the right; values at the wave cursor. Click a signal to follow it (Back/Forward history), double-click to add it to the wave, click a process to open its source line. Relations are collected statically during elaboration. |
| **Search** panel | Find in all project files (Ctrl+Shift+F) with match-case, whole-word and regex options; click a hit to open the file at that line. |
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
| `vsim [-t <res>] [-g<name>=<v>] [-sdfmin\|-sdftyp\|-sdfmax [<region>=]<file>] [+notimingchecks] [+nospecify] [lib.]top` | Elaborate and load. `-sdf*` back-annotates an SDF file (IEEE 1497) onto the instance `<region>` (absolute path, or relative to the top; default the top) after elaboration, picking the min, typ or max of `a:b:c` triples: `IOPATH` (also under `COND`) replaces the module path delay to that output of the instance (rise, fall, turn-off; several IOPATHs to one output keep the largest), `TIMINGCHECK` `SETUP HOLD SETUPHOLD RECOVERY REMOVAL RECREM WIDTH PERIOD` replace the limits of the matching specify checks. `INTERCONNECT`, `PORT`, `INCREMENT` and wildcard instances are reported as unsupported. `+notimingchecks` drops the timing checks, `+nospecify` the whole specify blocks. |
| `vsim top -cocotb <module> [-testcase a,b]` | cocotb-compatible Python testbench: Pyodide (loaded on first use) imports `<module>.py` from the project and runs its `@cocotb.test()` coroutines from time 0, in order. Writes made by a coroutine are applied when it yields; triggers map to kernel regions (`Timer` → timed queue, edges → signal listeners, `ReadWrite` → a region after active/NBA settle, `ReadOnly` → postponed). The regression ends the simulation and prints a result table; `run` fails if a test failed. The cocotb API layer is WebSim's own implementation of the public cocotb API, not the cocotb package. |
| `run [<n> [<unit>]] \| -all \| -continue` | Advance simulation. Default run length 100 ns. |
| `restart [-f]` | Back to time 0, keep waves. |
| `quit -sim` | Unload simulation. |
| `synth [-top m] [-target generic\|asic\|ice40\|ecp5\|gowin\|xilinx] [-flatten] [files]` | Logic synthesis with Yosys (YoWASP WebAssembly build, loaded on first use). Without files, the sources of the top module and everything it instantiates are taken from the library. Writes `synth/<top>[_<target>].{v,json,stat,log}`, prints the cell usage and Yosys warnings/errors; the Synthesis window shows the cell table and a schematic and can compile the generic netlist for gate-level simulation. Target `asic` maps onto WebSim's invented educational standard-cell library (`src/engine/asic/cells.ts`: Liberty for `dfflibmap`/`abc`, 0.4 µm track grid, 8-track rows), turns asynchronous-reset/negative-edge/enable flops into DFF/DFFR plus logic, uses TIEHI/TIELO for constants and BUF for net-to-net assignments, reports the chip area and writes the cell models `synth/websim_edu.v` (with specify delays) and `synth/websim_edu.lib`. For `ice40`, `ecp5`, `gowin` and `xilinx` it also writes `synth/<target>_cells.v`: the primitive simulation models that ship with Yosys (`cells_sim.v`, read from the installed package at build time, delays in ps), plus WebSim behavioural models of the DSP multipliers Yosys has only as blackboxes (combinational mode; registered modes raise an elaboration error). The netlist's top module re-declares the RTL parameters with the synthesized values, so testbench overrides bind. |
| `pnr [-top m] [-device <iCE40: lp384\|lp1k\|hx1k\|lp8k\|hx8k\|u4k\|up5k; ECP5: lfe5u-12f\|25f\|45f\|85f; Gowin: gw1nz-1\|gw1ns-4\|gw1n-9c\|gw2a-18c>] [-package p] [-pcf\|-lpf\|-cst\|-constraints f] [-freq MHz] [-seed n]` | FPGA place and route: runs `synth -target <family> -flatten`, then nextpnr (ice40, ecp5 or himbaechel-gowin) and the family's packer (icepack → `.bin`, ecppack → `.bit`, gowin_pack → `.fs`), YoWASP WebAssembly loaded on first use. gowin_pack (Python) runs on Pyodide with msgspec from `vendor/` (no CDN). Pin constraints come from the option or `<top>.<pcf\|lpf\|cst>` / `constraints/<top>.<ext>`; Gowin requires every port to be constrained. Writes `pnr/<top>.{placed.json,log}` plus the text configuration (`.asc`, `.config`), prints resource utilization and the maximum frequency per clock (PASS/FAIL against `-freq`) and returns an error on a timing failure. The Place & Route window shows the utilization, a floorplan of the placed tiles and nets, makes constraint templates and downloads the bitstream. |
| `asic [-top m] [-util 0.6] [-layers 2..4] [-sdc file] [-auto] [files]` | With `-auto`, an unclean layout (or a core too small for the cells) is retried after one synthesis: first with 4 routing layers, then with the utilization lowered in steps of 0.1 down to 0.3; each attempt is reported. Educational in-browser ASIC flow (no PDK; invented `websim_edu` cells and layer stack): `synth -target asic`, then floorplan (square core from the target utilization, rows alternating N/FS, 4-track margin), IO pins around the die, quadratic global placement with spreading anchors, Abacus legalization, HPWL detailed placement, fillers; routing on a track grid (M2/M4 horizontal, M3/M5 vertical, via1 to M1 pins) with A* trees and PathFinder negotiated congestion; power rails on M1 with M3 straps; an independent short/open check; static timing (below) — without `-sdc` an estimate with one ideal clock on every flip-flop, with `-sdc` the constrained analysis, summarized in the transcript and reported in the `.rpt`. Extracts parasitics from the routed geometry (an RC network per net with a node on every track crossing: invented sheet resistance 0.4 Ω/□ on M2/M3 and 0.15 Ω/□ on M4/M5 at half-pitch width, area + fringe capacitance to ground, via resistance; no coupling capacitance) and computes Elmore delays from each driver to its sinks; the STA uses the extracted wire capacitance as load, adds the wire delay at every input pin and degrades the transition there (√(s² + (ln 9 · d)²)). Writes `asic/<top>.spef` (IEEE 1481: name map, ports, `*D_NET` with `*CONN`/`*CAP`/`*RES`, units ns/fF/Ω), `asic/<top>.def`, `asic/<top>.sdf` (IOPATH delays per arc from the STA delay calculation plus the largest wire delay of the driven net, since WebSim's SDF reader has no INTERCONNECT, flip-flop SETUPHOLD/RECREM; the instance names `_N_` match `synth/<top>_asic.v`, so `vsim -sdftyp /tb/dut=asic/<top>.sdf` gives a post-layout gate-level simulation with timing checks), `asic/<top>.rpt` and `asic/websim_edu.lef`; the GDSII stream is kept in memory for download. Returns an error when the layout is not clean. |
| `sta [-sdc file] [-paths n] [-setup\|-hold] [-file f]` | Static timing analysis of the last `asic` layout (constraints of `asic -sdc` unless `-sdc` is given). Delay calculation: NLDM tables of the library (5×5, input transition × output load; rise table for max, fall table for min), loads from pin capacitance, extracted wire capacitance and output-port loads, Elmore wire delays to each input pin; transitions propagate (largest for setup, smallest for hold). Clocks are ideal (no clock-tree delay) and found through buffers/inverters back to the `create_clock` port; rising-edge flip-flops. Checks: setup/hold at D, recovery/removal at RN, output delays at outputs; cross-clock relations use the closest launch/capture edge pair. SDC (Tcl subset: braces, quotes, `[...]`, `set`/`$var`, `\` continuations): `create_clock -name -period -waveform`, `set_input_delay` / `set_output_delay [-clock] [-max\|-min]`, `set_load`, `set_input_transition`, `set_clock_uncertainty [-setup\|-hold]`, `set_false_path`, `set_max_delay`, `set_min_delay` with `-from`/`-to` (ports, cells, pins, clocks; `-through` is ignored with a warning), `get_ports` (bus names match their bits, globs), `get_cells`, `get_pins`, `get_clocks`, `all_inputs`, `all_outputs`, `all_clocks`, `all_registers`; other commands warn. Prints WNS/TNS, WHS/THS, achievable frequency per clock, unclocked flip-flops and unconstrained ports, and the worst `n` path reports (startpoint, endpoint, per-pin delay/time/slew/load, required time, slack MET/VIOLATED); writes `asic/<top>_sta.rpt` with the slack of every endpoint. Fails when a check is violated. |
| `openlane [-top m] [-period ns] [-sdc file] [-util pct]` | Export the design (top inferred like `synth`) as an OpenLane 2 / LibreLane project for the sky130 PDK: `openlane/<top>/config.json` (`meta.version` 2, `DESIGN_NAME`, `VERILOG_FILES` as `dir::src/...`, `CLOCK_PORT`, `CLOCK_PERIOD`, `PNR_SDC_FILE`, `SIGNOFF_SDC_FILE`, `FP_CORE_UTIL`, default 40%), the RTL sources of the hierarchy in `src/`, `<top>.sdc` (the given file, or generated: clock, 0.25 ns uncertainty, 20% of the period as input/output delay, sky130 HD load and transition) and a README with run instructions; also a stored zip (`<top>_openlane.zip`, downloaded by **Compile ▸ Export to OpenLane (sky130)**). The clock port comes from the SDC's `create_clock`, else the input used most often in `posedge`/`negedge` (names like `clk` win ties); without one, `CLOCK_PORT` is null and the SDC uses a virtual clock. The period defaults to the SDC's, else 10 ns. WebSim does not run that flow. |
| `signoff [-top m] [-tb t] [-sdc f] [-util u] [-layers n] [-mtm min\|typ\|max] [-time t]` | One-command signoff: simulate the testbench (default: the work top level that instantiates the design top) on the RTL, run `asic`, compile the netlist with the cell models and simulate it with `vsim -sdf<mtm> /<tb>/<inst>=asic/<top>.sdf`, then compare the testbench's output lines. PASS when the layout is clean, timing is met (WNS and WHS ≥ 0 with an SDC; without one only the estimate is reported), the post-layout run has no timing-check violation and the outputs are identical; prints and writes `asic/<top>_signoff.rpt` with the first differing lines. The RTL is compiled into the library again afterwards. |
| `vsim -coverage ...` / `coverage report [-details] [-file f]` / `coverage clear` | Code coverage: statement execution counts (by source line), branch arms of `if` (incl. the implicit else) and `case` (incl. the implicit default), and toggle coverage (every bit seen rising and falling, from the recorded history). Counts appear in the editor gutter (green count, red ✗ never executed, yellow branch partly taken). |
| `vcd load <file.vcd>` / `vsim -view <file.vcd>` | Open a VCD (from any simulator) as a read-only dataset: its scopes and variables appear in Structure/Objects and can be added to the Wave and List windows; `run`/`force`/`step`/`restart` are refused until `quit -sim`. Also File > Open VCD Waveform… and double-click on a `.vcd` in the Project pane. |
| `add list [-radix r] [-r] <paths...>` / `delete list <paths>\|*` / `write list <file>` | List window: one row per time step at which any listed signal changes (deltas collapsed), time in simulator-resolution units. |
| `add wave [-group name] [-color c] [-format Literal\|Analog-Step\|Analog-Interpolated] [-height px] [-min v] [-max v] ...` | Groups collapse/expand from their header; analog rows plot the numeric value (reals, or signed/unsigned by radix) with an automatic or fixed range; colours are names (green, yellow, orange, red, magenta, cyan, blue, white) or CSS colours. All of it is saved by `write format wave`. |
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
| `bp [<file> <line> [{cond}]]` / `bd <id>\|<file> <line>\|all` | Set or list source breakpoints (optional condition) / delete them. |
| `step [-over]` | Execute one statement (into or over calls). |
| `when [-label n] {cond} {cmds}` / `nowhen <label>` | Run commands (e.g. `stop`) when the condition becomes true / remove the watch. |
| `find signals <pattern>` / `show [<scope>]` / `describe <name>` | Find objects / list a scope's contents / print an object's type and declaration. |
| `now` | Print the current simulation time. |
| `log [-r] <paths>\|-all` / `nolog ...` / `log -cap <n>` | Choose which signals record value history (waves, List) / cap the changes kept per signal. |
| `simstats` | History size and memory estimate. |
| `mem list` / `mem display [-startaddress a] [-endaddress b] <mem>` / `mem save -outfile f [-format hex\|bin] <mem>` / `mem load -infile f <mem>` | Memories of the loaded design: list, print, save, load. |
| `transcript`, `onbreak`, `onerror`, `onfinish`, `set`, `configure`, `update`, `quietly`, `view`, `TreeUpdate`, `WaveRestoreCursors`, `WaveRestoreZoom` | Accepted and ignored, so scripts written for other simulators run. |

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
- Gate level: primitives `and or nand nor xor xnor buf not bufif0/1 notif0/1 nmos pmos rnmos rpmos cmos rcmos pullup pulldown`; user-defined primitives (combinational and sequential tables with `r f p n * (vw) ? b -`, `initial`); drive strengths on gates, `assign` and net declarations (`supply/strong` vs `pull/weak` vs `highz`, resolved like std_logic so weak drivers lose to strong ones), `tri0`/`tri1`; `%v` prints `St0 St1 StX Pu0 Pu1 PuX HiZ`; rise/fall/turn-off delays `#(r, f, z)`; `specify` blocks with `specparam` and module path delays `(a => y) = (r, f)` applied at the module output (largest delay of all paths; SDF IOPATH values replace it per output); timing checks `$setup $hold $setuphold $recovery $removal $recrem $width $period` with edge events, `&&&` conditions, min:typ:max limits (typ) and a notifier register (toggled x→0→1→0 on a violation), reported as `** Warning: file(line): $setuphold( posedge CLK:t1, D:t2, limit );` with the time and instance; `$sdf_annotate("file" [, instance, , , "MINIMUM"|"TYPICAL"|"MAXIMUM"])` annotates at run time; `vsim +notimingchecks` / `+nospecify` disable them.
- SystemVerilog interfaces: `interface ... endinterface`, interface ports (`bus_if m`, `bus_if.mp m`), `modport` (parsed, directions not enforced), tasks/functions called as `m.task()`.
- SystemVerilog classes: properties (incl. struct and handle types, initializers), `static` members (`C::x`), constructors with default arguments, `extends`, `super.new`/`super.m()`, `virtual`/`pure virtual` methods with dynamic dispatch, `this`, `null`, time-consuming tasks. Objects are stored per property, indexed by a 32-bit object id; calling a method through a null handle is a fatal error.
- Assertions: immediate `assert/assume/cover` with action blocks; concurrent `assert/assume/cover property` with clocking event, `disable iff`, `|->`, `|=>`, `##N`, `##[m:n]`, `##[m:$]`, `[*n]`, `[*m:n]`, `not`, named `sequence`/`property`, `default clocking`, `$past $rose $fell $stable $changed`. Failures print `** Error: Assertion error.` with time, attempt start time, scope and line.

### 4.2 VHDL (IEEE 1076-1993/2008 subset)
- Configurations: `configuration c of e is for arch for u1 : comp use entity lib.e(a); end for; for others : comp use configuration lib.c2; end for; end for; end;` (also `all`, `use open`, nested block configurations); `vsim c` and `u : configuration work.c` instantiate them.
- Block statements (`b : block [(guard)] ... begin ... end block;`) with the implicit `GUARD` signal and `<= guarded` assignments.
- Physical types (`type d is range ... units nm; um = 1000 nm; end units;`), literals `5 um`, `'image` / `'value` in the base unit.
- Attributes `'pos 'val 'succ 'pred 'leftof 'rightof` (with range checks) and `'value` for enumeration, integer, physical, time and real types.
- VHDL-2008: matching `case?` (`'-'` don't-care), `?=`, `?/=`, `?<`..., external names `<< signal .tb.dut.s : t >>`, conditional variable assignment, `process(all)`, unary reduction operators.
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
