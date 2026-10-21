// Messages exchanged between the UI thread and the simulation worker.
import type { MsgKind, Breakpoint } from './commands';
import type { UnitInfo } from './library';
import type { Radix } from './logic';

/** Structured-clone friendly 4-state value. */
export interface PVec { w: number; a: bigint; b: bigint; s: boolean; u?: bigint; k?: bigint }

export interface PSignal { id: number; path: string; name: string; w: number; msb: number; lsb: number; signed: boolean; enumNames?: string[]; driven: boolean; isReal?: boolean }
export interface PObject { name: string; sigId: number; dir: 'in' | 'out' | 'inout' | 'internal' }
export interface PProc { idx: number; name: string; scope: string; file?: string; line?: number }
export interface PScope {
  name: string; path: string; kind: string;
  unit: string; arch?: string; lang: 'verilog' | 'vhdl';
  objects: PObject[];
  memories: { name: string; lo: number; hi: number; w: number }[];
  procs: PProc[];
  children: PScope[];
}
export interface PDFNode { kind: 'process' | 'assign' | 'port' | 'udp'; name: string; scope: string; file?: string; line?: number; reads: number[]; writes: number[] }
export interface PDesign { top: string; loaded: string[]; resolution: number; root: PScope; signals: PSignal[]; df?: PDFNode[] }

/** History update for one signal: drop entries from `from` onward, then append. */
export interface PHist { id: number; from: number; t: number[]; v: PVec[]; forced: boolean; value: PVec }

export interface PList { path: string; name: string; sigId: number; radix: Radix }
export interface PWave {
  id: number; path: string; name: string; sigId: number; radix: Radix; dividerLabel?: string;
  color?: string; format?: 'literal' | 'analog-step' | 'analog-interp'; height?: number; min?: number; max?: number;
  groupLabel?: string; collapsed?: boolean; parent?: number;
}

export interface PState {
  events: string[];
  libs?: { name: string; units: UnitInfo[]; tops: string[] }[];
  fileStatus?: [string, 'ok' | 'error'][];
  compiled?: { file: string; lang: 'verilog' | 'vhdl'; lib: string }[];
  design?: PDesign | null;
  scope?: string | null;
  waves?: PWave[];
  lists?: PList[];
  asic?: { run: number; top: string; base: string; ok: boolean; summary: string[] } | null;
  pnr?: { run: number; top: string; device: string; family: 'ice40' | 'ecp5' | 'gowin'; bitstream: string; base: string; ok: boolean; util: [string, number, number][]; fmax: [string, number, number | null][] } | null;
  synth?: { top: string; target: string; base: string; ok: boolean; cells: [string, number][]; warnings: number } | null;
  time?: { now: number; delta: number; finished: boolean; procStates: string; histBytes?: number; histEntries?: number };
  hist?: PHist[];
  running?: boolean;
  paused?: { file: string; line: number; proc: string } | null;
  locals?: { name: string; value: PVec; enumNames?: string[]; where: string }[];
  stack?: string[];
  breakpoints?: Breakpoint[];
  prompt?: string;
  history?: string[];
  defaultRadix?: Radix;
  lastVsim?: { top: string; lib?: string; cocotb?: string } | null;
}

export type ToWorker =
  | { type: 'files'; files: [string, string][] }
  | { type: 'exec'; id: number; cmd: string; echo: boolean }
  | { type: 'break' }
  | { type: 'call'; id: number; method: string; args: unknown[] };

export type FromWorker =
  | { type: 'print'; msg: string; kind?: MsgKind }
  | { type: 'clear' }
  | { type: 'state'; state: PState }
  | { type: 'done'; id: number; value: unknown; error?: string }
  | { type: 'fileWrite'; name: string; text: string };
