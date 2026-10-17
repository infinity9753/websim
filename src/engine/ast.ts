// Language-neutral design AST shared by the Verilog and VHDL front-ends.
import type { Vec } from './logic';

export interface Loc { file: string; line: number }

export type Expr =
  | { k: 'num'; v: Vec; unsized?: boolean; loc?: Loc }
  | { k: 'real'; v: number; loc?: Loc }
  | { k: 'time'; ps: number; loc?: Loc }                 // VHDL physical time literal
  | { k: 'str'; s: string; loc?: Loc }
  | { k: 'id'; name: string; loc?: Loc }                  // may be dotted (hierarchical)
  | { k: 'index'; base: Expr; index: Expr; loc?: Loc }
  | { k: 'range'; base: Expr; msb: Expr; lsb: Expr; loc?: Loc }
  | { k: 'irange'; base: Expr; start: Expr; width: Expr; dir: '+' | '-'; loc?: Loc }
  | { k: 'un'; op: string; e: Expr; loc?: Loc }
  | { k: 'bin'; op: string; l: Expr; r: Expr; loc?: Loc }
  | { k: 'tern'; c: Expr; t: Expr; f: Expr; loc?: Loc }
  | { k: 'concat'; parts: Expr[]; loc?: Loc }
  | { k: 'repl'; count: Expr; parts: Expr[]; loc?: Loc }
  | { k: 'call'; name: string; args: Expr[]; named?: (string | null)[]; loc?: Loc } // function, system function, or (VHDL) ambiguous index
  | { k: 'attr'; base: Expr; attr: string; arg?: Expr; loc?: Loc }   // VHDL x'event
  | { k: 'agg'; others?: Expr; elems: { choice: Expr | null; value: Expr }[]; loc?: Loc } // VHDL aggregate
  | { k: 'fill'; bit: '0' | '1' | 'x' | 'z'; loc?: Loc }
  | { k: 'field'; base: Expr; field: string; loc?: Loc }           // VHDL record field of a non-simple name: mem(i).f
  | { k: 'sized'; e: Expr; w: number; loc?: Loc };                 // internal: evaluate e at exactly w bits          // SV '0 '1 'x 'z

export interface TypeSpec {
  base: 'logic' | 'integer' | 'real' | 'time' | 'bool' | 'enum' | 'named' | 'string' | 'struct';
  fields?: { name: string; type: TypeSpec }[];   // SV struct packed (first field = MSBs)
  range?: [Expr, Expr];             // packed range, msb..lsb as written ([7:0] / 7 downto 0 / 0 to 7)
  signed?: boolean;
  enumNames?: string[];
  name?: string;                    // named type reference (resolved during elaboration)
  width?: number;                   // fixed width for builtin int types
}

export interface SensItem { edge: 'pos' | 'neg' | 'any'; expr: Expr }

export type Stmt =
  | { k: 'block'; stmts: Stmt[]; name?: string; decls?: Item[]; loc?: Loc }
  | { k: 'assign'; lhs: Expr; rhs: Expr; nb: boolean; delay?: Expr; evctl?: SensItem[]; vsig?: boolean; loc?: Loc }
  | { k: 'vsigassign'; lhs: Expr; waves: { value: Expr; after?: Expr }[]; loc?: Loc }  // VHDL signal assignment
  | { k: 'if'; c: Expr; t: Stmt; f?: Stmt; loc?: Loc }
  | { k: 'case'; kind: 'case' | 'casez' | 'casex'; expr: Expr; items: { labels: Expr[] | null; body: Stmt }[]; loc?: Loc }
  | { k: 'for'; init?: Stmt; cond?: Expr; step?: Stmt; body: Stmt; loc?: Loc }
  | { k: 'vfor'; v: string; from: Expr; to: Expr; down: boolean; body: Stmt; label?: string; loc?: Loc }
  | { k: 'while'; c: Expr; body: Stmt; label?: string; loc?: Loc }
  | { k: 'loop'; body: Stmt; label?: string; loc?: Loc }           // VHDL plain loop
  | { k: 'repeat'; n: Expr; body: Stmt; loc?: Loc }
  | { k: 'forever'; body: Stmt; loc?: Loc }
  | { k: 'delay'; d: Expr; body?: Stmt; loc?: Loc }
  | { k: 'event'; items: SensItem[] | '*'; body?: Stmt; loc?: Loc }
  | { k: 'wait'; c: Expr; body?: Stmt; loc?: Loc }
  | { k: 'vwait'; on?: Expr[]; until?: Expr; for?: Expr; loc?: Loc }
  | { k: 'sys'; name: string; args: (Expr | null)[]; loc?: Loc }
  | { k: 'call'; name: string; args: Expr[]; named?: (string | null)[]; loc?: Loc }
  | { k: 'report'; msg?: Expr; severity?: Expr; cond?: Expr; loc?: Loc }
  | { k: 'return'; e?: Expr; loc?: Loc }
  | { k: 'disable'; name: string; loc?: Loc }
  | { k: 'exit'; label?: string; cond?: Expr; next: boolean; loc?: Loc }
  | { k: 'force'; lhs: Expr; rhs?: Expr; release: boolean; loc?: Loc }
  | { k: 'fork'; branches: Stmt[]; join: 'all' | 'any' | 'none'; name?: string; decls?: Item[]; loc?: Loc }
  | { k: 'disable_fork'; loc?: Loc }
  | { k: 'foreach'; arr: string; vars: string[]; body: Stmt; loc?: Loc }
  | { k: 'null'; loc?: Loc };

export interface DeclName { name: string; init?: Expr; unpacked?: [Expr, Expr][] }

export interface PortDecl {
  name: string;
  dir: 'input' | 'output' | 'inout';
  type: TypeSpec;
  isVar?: boolean;     // Verilog 'output reg'
  init?: Expr;
  loc?: Loc;
}

export interface ParamDecl { name: string; value?: Expr; local: boolean; type?: TypeSpec; loc?: Loc }

export interface FuncDecl {
  k: 'func';
  name: string;
  isTask: boolean;
  ret?: TypeSpec;
  args: { name: string; dir: 'input' | 'output' | 'inout'; type: TypeSpec; vsig?: boolean; def?: Expr }[];
  decls: Item[];
  body: Stmt;
  loc?: Loc;
}

export type Item =
  | { k: 'decl'; kind: 'net' | 'var' | 'signal' | 'const' | 'variable'; type: TypeSpec; names: DeclName[]; fileMode?: 'read' | 'write' | 'append'; loc?: Loc }
  | ({ k: 'param' } & ParamDecl)
  | { k: 'cassign'; lhs: Expr; rhs: Expr; delay?: Expr; loc?: Loc }
  | { k: 'process'; kind: 'always' | 'initial' | 'always_comb' | 'always_ff' | 'always_latch' | 'vproc'; body: Stmt; sens?: Expr[] | 'all'; name?: string; loc?: Loc }
  | { k: 'inst'; module: string; lib?: string; arch?: string; name: string; params: { name?: string; value: Expr }[]; conns: { name?: string; expr: Expr | null; sel?: Expr }[]; isEntity?: boolean; range?: [Expr, Expr]; loc?: Loc }
  | { k: 'defparam'; path: string; value: Expr; loc?: Loc }
  | { k: 'alias'; name: string; type?: TypeSpec; target: Expr; loc?: Loc }
  | FuncDecl
  | { k: 'genfor'; v: string; init: Expr; cond: Expr; stepExpr: Expr; name?: string; items: Item[]; vhdl?: { from: Expr; to: Expr; down: boolean }; loc?: Loc }
  | { k: 'genif'; c: Expr; then: Item[]; else?: Item[]; name?: string; loc?: Loc }
  | { k: 'typedef'; name: string; type?: TypeSpec; array?: { range?: [Expr, Expr]; elem: TypeSpec }; record?: { name: string; type: TypeSpec }[]; loc?: Loc }
  | { k: 'use'; pkg: string; loc?: Loc };

export interface Unit {
  kind: 'module' | 'entity' | 'architecture' | 'package' | 'package_body';
  lang: 'verilog' | 'vhdl';
  name: string;          // module / entity / package name (lowercase for VHDL)
  of?: string;           // architecture: entity name
  file: string;
  line: number;
  params: ParamDecl[];
  ports: PortDecl[];
  items: Item[];
  timescale?: { unit: number; prec: number }; // in ps (may be fractional for fs)
  typedefs?: Record<string, TypeSpec>;          // Verilog package: exported type names
  source?: string;
}

export class CompileError extends Error {
  constructor(msg: string, public loc?: Loc) { super(msg); }
}
