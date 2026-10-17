// Elaboration: builds the instance hierarchy and compiles processes into closures.
import { CompileError, type Expr, type Item, type Loc, type Stmt, type TypeSpec, type Unit, type FuncDecl, type SensItem } from './ast';
import * as L from './logic';
import { Vec, resize, fromInt, allX, allZ, slice, insert } from './logic';
import { Kernel, Signal, Memory, Driver, Process, FinishEx, StopProcEx, type Wait, type KernelHost, type ProcInfo } from './kernel';
import { expandFormat, fmtTime, type FmtArg } from './format';

// ---------------------------------------------------------------- types

export interface RType {
  kind: 'vec' | 'enum' | 'array' | 'real' | 'string';
  w: number;              // 0 = unconstrained (VHDL)
  msb: number;
  lsb: number;
  signed: boolean;
  scalar?: boolean;       // std_logic / bit (no index range)
  isInt?: boolean;
  isTime?: boolean;
  isBool?: boolean;
  isBit?: boolean;        // VHDL bit / SV bit: 2-state, default 0
  enumNames?: string[];
  elem?: RType;
  lo?: number;
  hi?: number;
  left?: number;          // VHDL integer range left bound
  right?: number;
}

export type Sym =
  | { k: 'sig'; sig: Signal; t: RType }
  | { k: 'mem'; mem: Memory; t: RType }
  | { k: 'const'; v: Vec; t?: RType; str?: string }
  | { k: 'func'; f: FuncDecl; scope: Scope; cache: Map<string, CFunc> }
  | { k: 'type'; t: RType }
  | { k: 'scope'; s: Scope };

export interface ModInfo { lang: 'verilog' | 'vhdl'; unit: Unit; arch?: string; tsUnit: number; tsPrec: number; file: string; libName: string }
export interface ObjEntry { name: string; sig: Signal; dir: 'in' | 'out' | 'inout' | 'internal'; t: RType }

export class Scope {
  syms = new Map<string, Sym>();
  children: Scope[] = [];
  objects: ObjEntry[] = [];
  memories: { name: string; mem: Memory }[] = [];
  imports: Scope[] = [];
  procs: Process[] = [];
  overrides?: { named: Map<string, Expr>; positional: Expr[]; from: Scope };
  constructor(public name: string, public path: string, public lex: Scope | null, public up: Scope | null, public mod: ModInfo, public kind: 'instance' | 'generate' | 'block' | 'package' | 'func') {}

  lookup(n: string): Sym | undefined {
    for (let s: Scope | null = this; s; s = s.lex) {
      const v = s.syms.get(n);
      if (v) return v;
      for (const imp of s.imports) { const x = imp.syms.get(n); if (x) return x; }
    }
    return undefined;
  }

  /** Dotted name used by Verilog %m. */
  get dotted(): string { return this.path.replace(/^\//, '').replace(/\//g, '.'); }
}

export interface DesignResolver {
  findDesign(name: string, lib?: string, arch?: string): { unit: Unit; arch?: Unit; libName: string } | undefined;
  findPackage(name: string, lib?: string): { pkg: Unit; body?: Unit; libName: string } | undefined;
}

export interface Design {
  root: Scope;
  kernel: Kernel;
  top: string;
  loaded: string[];
  warnings: string[];
  allScopes: Scope[];
}

type Ev = () => Vec;
interface Node {
  w: number;
  s: boolean;
  mk: (W: number, sx: boolean) => Ev;
  str?: string;
  isTime?: boolean;
  real?: number;
  cv?: Vec;              // compile-time constant value
  enumNames?: string[];
  sig?: Signal;          // plain signal reference
  isMonTime?: boolean;   // $time-like: excluded from $monitor change detection
}

interface CFunc { args: Signal[]; argT: RType[]; ret: Signal | null; locals: Signal[]; body: () => void; reads: Set<Signal | Memory> }

interface Ctx {
  scope: Scope;
  lang: 'verilog' | 'vhdl';
  reads?: Set<Signal | Memory>;
  owner: string;
  drivers: Map<Signal, Driver>;
  driverMode: boolean;
  deferred: boolean;
  constOnly?: boolean;
  strMode?: boolean;
  proc?: ProcInfo;
  func?: CFunc;
  depth: number;
}

type Tgt = { k: 'sig'; sig: Signal; off: number; w: number; drv?: Driver } | { k: 'mem'; mem: Memory; idx: number; off: number; w: number };
interface LNode { w: number; tg: () => Tgt[] }

type Gen = Generator<Wait, void, void>;
interface SC { sync?: () => void; gen?: () => Gen }

class ReturnEx { }
class DisableEx { constructor(public name: string) {} }
class LoopEx { constructor(public label: string | undefined, public next: boolean) {} }
const RET = new ReturnEx();

const ONE32 = fromInt(1, 32, true);
const LOOP_GUARD = 50_000_000;

function err(msg: string, loc?: Loc): never { throw new CompileError(msg, loc); }

function constNode(v: Vec, extra: Partial<Node> = {}): Node {
  return {
    w: v.w, s: v.signed, cv: v,
    mk: (W, sx) => { const c = resize(v.withSign(sx), W, v.signed && sx).withSign(sx); return () => c; },
    ...extra,
  };
}

function leaf(get: Ev, w: number, s: boolean, extra: Partial<Node> = {}): Node {
  return {
    w, s,
    mk: (W, sx) => (W === w && sx === s ? get : W === w ? () => get().withSign(sx) : () => resize(get(), W, sx && s).withSign(sx)),
    ...extra,
  };
}

/** Evaluate a node at exactly width W (truncate or extend). */
function final(n: Node, W: number): Ev {
  const inner = n.mk(Math.max(W, n.w), n.s);
  if (n.w <= W) return inner;
  return () => resize(inner(), W);
}

function selfEv(n: Node): Ev { return n.mk(n.w, n.s); }

function clog2(n: bigint): number { let r = 0; let v = n - 1n; while (v > 0n) { r++; v >>= 1n; } return r; }

const VHDL_STD_TYPES: Record<string, RType> = {
  std_logic: { kind: 'vec', w: 1, msb: 0, lsb: 0, signed: false, scalar: true },
  std_ulogic: { kind: 'vec', w: 1, msb: 0, lsb: 0, signed: false, scalar: true },
  bit: { kind: 'vec', w: 1, msb: 0, lsb: 0, signed: false, scalar: true, isBit: true },
  boolean: { kind: 'vec', w: 1, msb: 0, lsb: 0, signed: false, scalar: true, isBool: true, enumNames: ['false', 'true'] },
  character: { kind: 'vec', w: 8, msb: 7, lsb: 0, signed: false, scalar: true },
  integer: { kind: 'vec', w: 32, msb: 31, lsb: 0, signed: true, isInt: true, left: -2147483648, right: 2147483647 },
  natural: { kind: 'vec', w: 32, msb: 31, lsb: 0, signed: true, isInt: true, left: 0, right: 2147483647 },
  positive: { kind: 'vec', w: 32, msb: 31, lsb: 0, signed: true, isInt: true, left: 1, right: 2147483647 },
  real: { kind: 'real', w: 64, msb: 63, lsb: 0, signed: true },
  time: { kind: 'vec', w: 64, msb: 63, lsb: 0, signed: true, isInt: true, isTime: true, left: 0 },
  delay_length: { kind: 'vec', w: 64, msb: 63, lsb: 0, signed: true, isInt: true, isTime: true, left: 0 },
  string: { kind: 'string', w: 0, msb: 0, lsb: 0, signed: false },
  std_logic_vector: { kind: 'vec', w: 0, msb: 0, lsb: 0, signed: false },
  std_ulogic_vector: { kind: 'vec', w: 0, msb: 0, lsb: 0, signed: false },
  bit_vector: { kind: 'vec', w: 0, msb: 0, lsb: 0, signed: false, isBit: true },
  unsigned: { kind: 'vec', w: 0, msb: 0, lsb: 0, signed: false },
  signed: { kind: 'vec', w: 0, msb: 0, lsb: 0, signed: true },
  severity_level: { kind: 'enum', w: 2, msb: 1, lsb: 0, signed: false, enumNames: ['note', 'warning', 'error', 'failure'] },
};

// ---------------------------------------------------------------- elaborator

export interface ElabOptions {
  generics?: Map<string, string>;
  resolutionPs?: number;
}

export class Elaborator {
  k: Kernel;
  pending: (() => void)[] = [];
  loaded: string[] = [];
  warnings: string[] = [];
  scopes: Scope[] = [];
  root!: Scope;
  procSeq = 0;
  ownerSeq = 0;
  stdScope: Scope;
  pkgScopes = new Map<string, Scope>();
  minPrec = Infinity;
  instDepth = 0;

  constructor(public lib: DesignResolver, host: KernelHost, public opts: ElabOptions = {}) {
    this.k = new Kernel(host);
    const dummyUnit: Unit = { kind: 'package', lang: 'vhdl', name: 'standard', file: '', line: 0, params: [], ports: [], items: [] };
    this.stdScope = new Scope('std', '/std', null, null, { lang: 'vhdl', unit: dummyUnit, tsUnit: 1, tsPrec: 1, file: '', libName: 'std' }, 'package');
    for (const [n, t] of Object.entries(VHDL_STD_TYPES)) this.stdScope.syms.set(n, { k: 'type', t });
    this.stdScope.syms.set('true', { k: 'const', v: L.ONE, t: VHDL_STD_TYPES.boolean });
    this.stdScope.syms.set('false', { k: 'const', v: L.ZERO, t: VHDL_STD_TYPES.boolean });
    ['note', 'warning', 'error', 'failure'].forEach((n, i) => this.stdScope.syms.set(n, { k: 'const', v: fromInt(i, 2), t: VHDL_STD_TYPES.severity_level }));
  }

  elaborate(top: string, lib?: string): Design {
    let arch: string | undefined;
    const m = /^(\w+)\((\w+)\)$/.exec(top);
    if (m) { top = m[1]; arch = m[2]; }
    const found = this.lib.findDesign(top, lib, arch);
    if (!found) err(`(vsim-3170) Could not find '${lib ? lib + '.' : ''}${top}'.`);
    const ovr: { name?: string; value: Expr }[] = [];
    for (const [n, v] of this.opts.generics ?? []) ovr.push({ name: n, value: this.parseGenericValue(v) });
    this.root = this.instantiate(found, found.unit.name, null, ovr, [], undefined);
    for (const p of this.pending) p();
    this.pending = [];
    // initial resolution of nets with drivers + time-0 history
    const sigs = new Set<Signal>();
    for (const s of this.scopes) for (const o of s.objects) sigs.add(o.sig);
    for (const sig of sigs) {
      if (sig.drivers && sig.drivers.length) sig.value = sig.drivers.length === 1 ? sig.drivers[0].value : L.resolve(sig.w, sig.drivers.map(d => d.value));
      sig.prev = sig.value;
      sig.times = [0]; sig.vals = [sig.value];
    }
    this.k.signals = [...sigs];
    const prec = this.minPrec === Infinity ? 1000 : this.minPrec;
    this.k.resolution = this.opts.resolutionPs ?? Math.max(1, Math.min(1000, prec));
    return { root: this.root, kernel: this.k, top: found.unit.name, loaded: this.loaded, warnings: this.warnings, allScopes: this.scopes };
  }

  parseGenericValue(v: string): Expr {
    if (/^-?\d+$/.test(v)) return { k: 'num', v: fromInt(BigInt(v), 32, true), unsized: true };
    const m = /^(\d+)'([bhdo])([0-9a-fA-FxXzZ_]+)$/.exec(v);
    if (m) {
      const bits = { b: 2, h: 16, d: 10, o: 8 }[m[2]]!;
      return { k: 'num', v: fromInt(BigInt(parseInt(m[3].replace(/_/g, ''), bits)), Number(m[1])) };
    }
    if (/^"[01]+"$/.test(v)) return { k: 'num', v: L.fromBits(v.slice(1, -1)) };
    return { k: 'str', s: v.replace(/^"|"$/g, '') };
  }

  // ---------------------------------------------------------- hierarchy

  instantiate(found: { unit: Unit; arch?: Unit; libName: string }, instName: string, parent: Scope | null, params: { name?: string; value: Expr }[], conns: { name?: string; expr: Expr | null }[], loc: Loc | undefined): Scope {
    if (++this.instDepth > 64) err('Design hierarchy too deep (recursive instantiation?)', loc);
    const unit = found.unit;
    const arch = found.arch;
    const lang = unit.lang;
    const ts = lang === 'verilog' ? unit.timescale ?? { unit: 1000, prec: 1000 } : { unit: 1, prec: 1 };
    if (lang === 'verilog') this.minPrec = Math.min(this.minPrec, ts.prec);
    const mod: ModInfo = { lang, unit, arch: arch?.name, tsUnit: ts.unit, tsPrec: ts.prec, file: (arch ?? unit).file, libName: found.libName };
    const path = parent ? `${parent.path}/${instName}` : `/${instName}`;
    const scope = new Scope(instName, path, null, parent, mod, 'instance');
    this.scopes.push(scope);
    if (parent) { parent.children.push(scope); parent.syms.set(instName, { k: 'scope', s: scope }); }
    const unitLabel = `${found.libName}.${unit.name}${arch ? `(${arch.name})` : ''}`;
    if (!this.loaded.includes(unitLabel)) this.loaded.push(unitLabel);
    if (lang === 'vhdl') {
      scope.imports.push(this.stdScope);
      for (const it of [...unit.items, ...(arch?.items ?? [])]) if (it.k === 'use') this.importPackage(scope, it.pkg, it.loc);
    }
    const eqName = (a: string, b: string) => a === b || a.toLowerCase() === b.toLowerCase();

    // parameters / generics
    const positional = params.filter(p => !p.name).map(p => p.value);
    const named = new Map<string, Expr>();
    for (const p of params) if (p.name) named.set(p.name.toLowerCase(), p.value);
    let posIdx = 0;
    for (const p of unit.params) {
      let ovExpr = named.get(p.name.toLowerCase());
      if (ovExpr) named.delete(p.name.toLowerCase());
      else if (posIdx < positional.length) ovExpr = positional[posIdx++];
      let v: Vec; let str: string | undefined;
      const t = p.type ? this.resolveType(p.type, scope, p.loc) : undefined;
      if (ovExpr) { const r = this.constEvalFull(ovExpr, parent ?? scope, t); v = r.v; str = r.str; }
      else if (p.value) { const r = this.constEvalFull(p.value, scope, t); v = r.v; str = r.str; }
      else err(`(vsim-3171) Generic '${p.name}' of '${unit.name}' has no default value and is not mapped.`, p.loc ?? loc);
      if (t && t.w > 0 && t.kind !== 'string') v = resize(v, t.w).withSign(t.signed);
      scope.syms.set(p.name, { k: 'const', v, t, str });
    }
    scope.overrides = { named, positional: positional.slice(posIdx), from: parent ?? scope };

    // ports
    const byName = conns.some(c => c.name && c.name !== '*');
    const wildcard = conns.some(c => c.name === '*');
    unit.ports.forEach((port, pi) => {
      const t = this.resolveType(port.type, scope, port.loc);
      let conn: { name?: string; expr: Expr | null } | undefined;
      if (byName || wildcard) {
        conn = conns.find(c => c.name && c.name !== '*' && eqName(c.name, port.name));
        if (!conn && wildcard) conn = { name: port.name, expr: { k: 'id', name: port.name } };
      } else conn = conns[pi];
      const dir = port.dir === 'input' ? 'in' : port.dir === 'output' ? 'out' : 'inout';
      if (conn?.expr && parent) {
        const alias = this.aliasTarget(conn.expr, parent, t);
        if (alias) {
          // a variable port (output reg / VHDL port) collapsed onto an undriven net starts unknown, not Z
          if ((port.isVar || lang === 'vhdl') && !alias.drivers && alias.value.b === L.mask(alias.w) && alias.value.a === 0n) {
            alias.value = port.init ? this.constEval(port.init, scope, alias.w) : this.defaultValue(t);
            alias.prev = alias.value;
          }
          scope.syms.set(port.name, { k: 'sig', sig: alias, t });
          scope.objects.push({ name: port.name, sig: alias, dir, t });
          return;
        }
      }
      let init: Vec | undefined;
      if (port.init) init = this.constEval(port.init, scope, t.w);
      const sig = this.newSignal(scope, port.name, t, init, false, dir);
      if (conn?.expr && parent) {
        const pexpr = conn.expr;
        const self = { k: 'id', name: port.name } as Expr;
        if (dir === 'in') this.pending.push(() => this.compileCassign(self, pexpr, undefined, scope, parent, `port ${port.name}`));
        else this.pending.push(() => this.compileCassign(pexpr, self, undefined, parent, scope, `port ${port.name}`));
      } else if (dir === 'in' && lang === 'verilog' && !init) {
        sig.value = allZ(sig.w); sig.prev = sig.value;
      }
    });
    for (const c of conns) {
      if (c.name && c.name !== '*' && !unit.ports.some(p => eqName(p.name, c.name!))) err(`(vsim-3043) Unresolved reference to port '${c.name}' in instance '${instName}' of '${unit.name}'.`, loc);
    }
    if (!byName && !wildcard && conns.length > unit.ports.length) err(`(vsim-3015) Too many port connections for instance '${instName}' of '${unit.name}'.`, loc);

    this.elabItems(unit.items, scope);
    if (arch) this.elabItems(arch.items, scope);
    for (const [n] of named) err(`(vsim-3150) Parameter/generic '${n}' not found in '${unit.name}'.`, loc);
    this.instDepth--;
    return scope;
  }

  importPackage(scope: Scope, pkgPath: string, loc?: Loc) {
    // pkgPath like "work.my_pkg" or "ieee.std_logic_1164"
    const parts = pkgPath.toLowerCase().split('.');
    const lib = parts.length > 1 ? parts[0] : undefined;
    const name = parts.length > 1 ? parts[1] : parts[0];
    if (lib === 'ieee' || lib === 'std' || name === 'env') return;
    const key = `${lib ?? 'work'}.${name}`;
    let ps = this.pkgScopes.get(key);
    if (!ps) {
      const found = this.lib.findPackage(name, lib);
      if (!found) err(`(vcom-1598) Library unit "${name}" not found in library "${lib ?? 'work'}".`, loc);
      const mod: ModInfo = { lang: 'vhdl', unit: found.pkg, tsUnit: 1, tsPrec: 1, file: found.pkg.file, libName: found.libName };
      ps = new Scope(name, `/${name}`, null, null, mod, 'package');
      ps.imports.push(this.stdScope);
      this.pkgScopes.set(key, ps);
      for (const it of found.pkg.items) if (it.k === 'use') this.importPackage(ps, it.pkg, it.loc);
      this.elabItems(found.pkg.items, ps);
      if (found.body) this.elabItems(found.body.items, ps);
      // package bodies replace function prototypes
    }
    if (!scope.imports.includes(ps)) scope.imports.push(ps);
  }

  /** If `e` is a whole-signal reference of matching width in `parent`, return that signal for port collapsing. */
  aliasTarget(e: Expr, parent: Scope, t: RType): Signal | null {
    if (e.k !== 'id') return null;
    let sym = this.lookupName(parent, e.name);
    if (!sym && parent.mod.lang === 'verilog' && !e.name.includes('.')) {
      // implicit net
      this.warnings.push(`(vlog-2623) Implicit net '${e.name}' created in ${parent.path}.`);
      this.newSignal(parent, e.name, { kind: 'vec', w: t.w || 1, msb: (t.w || 1) - 1, lsb: 0, signed: false }, undefined, false, 'internal', true);
      sym = this.lookupName(parent, e.name);
    }
    if (sym?.k === 'sig' && (sym.sig.w === t.w || t.w === 0) && !sym.sig.isVar) return sym.sig;
    return null;
  }

  newSignal(scope: Scope, name: string, t: RType, init: Vec | undefined, isVar: boolean, dir: ObjEntry['dir'] = 'internal', isNet = false): Signal {
    const w = t.w || 1;
    let v = init ?? this.defaultValue(t, isNet);
    v = resize(v, w).withSign(t.signed);
    const sig = new Signal(`${scope.path}/${name}`, name, w, t.msb, t.lsb, t.signed, v, isVar);
    sig.kind = dir;
    if (t.enumNames) sig.enumNames = t.enumNames;
    if (t.kind === 'real') sig.isReal = true;
    scope.syms.set(name, { k: 'sig', sig, t });
    if (!isVar) scope.objects.push({ name, sig, dir, t });
    return sig;
  }

  defaultValue(t: RType, isNet = false): Vec {
    const w = t.w || 1;
    if (isNet) return allZ(w);
    if (t.kind === 'enum' || t.isBool || t.isBit || t.kind === 'real') return L.zeros(w);
    if (t.isInt) {
      if (t.left !== undefined) return fromInt(t.left, w, true);
      return allX(w);
    }
    return allX(w);
  }

  resolveType(ts: TypeSpec, scope: Scope, loc?: Loc): RType {
    const range = (r: [Expr, Expr] | undefined): [number, number] | null => r ? [this.constInt(r[0], scope), this.constInt(r[1], scope)] : null;
    switch (ts.base) {
      case 'logic': case 'bool': {
        const r = range(ts.range);
        if (!r) return { kind: 'vec', w: 1, msb: 0, lsb: 0, signed: !!ts.signed, scalar: true };
        return { kind: 'vec', w: Math.abs(r[0] - r[1]) + 1, msb: r[0], lsb: r[1], signed: !!ts.signed };
      }
      case 'integer': {
        const w = ts.width ?? 32;
        const r = range(ts.range);
        return { kind: 'vec', w, msb: w - 1, lsb: 0, signed: ts.signed ?? true, isInt: true, left: r ? r[0] : undefined };
      }
      case 'real': return { kind: 'real', w: 64, msb: 63, lsb: 0, signed: true };
      case 'time': return { ...VHDL_STD_TYPES.time };
      case 'string': return { kind: 'string', w: 0, msb: 0, lsb: 0, signed: false };
      case 'enum': {
        const n = ts.enumNames!.length;
        const r = range(ts.range);
        const w = r ? Math.abs(r[0] - r[1]) + 1 : Math.max(1, clog2(BigInt(n)));
        return { kind: 'enum', w, msb: w - 1, lsb: 0, signed: false, enumNames: ts.enumNames };
      }
      case 'named': {
        const name = ts.name!;
        const sym = scope.lookup(name) ?? this.stdScope.syms.get(name);
        if (!sym || sym.k !== 'type') err(`(vcom-1136) Unknown identifier "${name}".`, loc);
        const base = sym.t;
        const r = range(ts.range);
        if (base.kind === 'array') return base;
        if (r) {
          if (base.isInt) return { ...base, left: r[0], right: r[1] };
          return { ...base, w: Math.abs(r[0] - r[1]) + 1, msb: r[0], lsb: r[1], scalar: false };
        }
        return base;
      }
    }
  }

  // ---------------------------------------------------------- items

  elabItems(items: Item[], scope: Scope) {
    // pass 1: declarations
    for (const it of items) {
      switch (it.k) {
        case 'param': {
          let ov: Expr | undefined;
          if (!it.local && scope.overrides) {
            ov = scope.overrides.named.get(it.name.toLowerCase());
            if (ov) scope.overrides.named.delete(it.name.toLowerCase());
            else if (scope.overrides.positional.length) ov = scope.overrides.positional.shift();
          }
          const t = it.type && (it.type.range || it.type.base !== 'logic') ? this.resolveType(it.type, scope, it.loc) : undefined;
          let v = ov ? this.constEval(ov, scope.overrides!.from) : this.constEval(it.value!, scope);
          if (t && t.w) v = resize(v, t.w).withSign(t.signed);
          scope.syms.set(it.name, { k: 'const', v, t });
          break;
        }
        case 'typedef': {
          if (it.array) {
            const elem = this.resolveType(it.array.elem, scope, it.loc);
            const lo = this.constInt(it.array.range[0], scope), hi = this.constInt(it.array.range[1], scope);
            // unconstrained element vectors can't be stored
            scope.syms.set(it.name, { k: 'type', t: { kind: 'array', w: elem.w, msb: elem.msb, lsb: elem.lsb, signed: elem.signed, elem, lo: Math.min(lo, hi), hi: Math.max(lo, hi), enumNames: elem.enumNames } });
          } else {
            const t = this.resolveType(it.type!, scope, it.loc);
            scope.syms.set(it.name, { k: 'type', t });
            if (t.enumNames && t.kind === 'enum') t.enumNames.forEach((n, i) => scope.syms.set(n, { k: 'const', v: fromInt(i, t.w), t }));
          }
          break;
        }
        case 'decl': this.elabDecl(it, scope); break;
        case 'func': {
          const existing = scope.syms.get(it.name);
          // VHDL package body / later declaration with a body overrides a prototype
          if (existing?.k === 'func' && it.body.k === 'null' && !it.decls.length) break;
          scope.syms.set(it.name, { k: 'func', f: it, scope, cache: new Map() });
          break;
        }
        case 'use': if (scope.mod.lang === 'vhdl') this.importPackage(scope, it.pkg, it.loc); break;
      }
    }
    // pass 2: structure and behaviour
    for (const it of items) {
      switch (it.k) {
        case 'inst': this.elabInst(it, scope); break;
        case 'genfor': this.elabGenFor(it, scope); break;
        case 'genif': {
          const c = this.constEval(it.c, scope);
          const branch = L.isTrue(c) ? it.then : it.else;
          if (branch) {
            if (it.name && L.isTrue(c)) {
              const sub = this.subScope(scope, it.name);
              this.elabItems(branch, sub);
            } else this.elabItems(branch, scope);
          }
          break;
        }
        case 'process': this.pending.push(() => this.compileProcess(it, scope)); break;
        case 'cassign': this.pending.push(() => this.compileCassign(it.lhs, it.rhs, it.delay, scope, scope, `assign@${it.loc?.line ?? 0}`)); break;
      }
    }
  }

  subScope(scope: Scope, name: string): Scope {
    const sub = new Scope(name, `${scope.path}/${name}`, scope, scope, scope.mod, 'generate');
    scope.children.push(sub);
    scope.syms.set(name.replace(/[([].*$/, ''), { k: 'scope', s: sub });
    scope.syms.set(name, { k: 'scope', s: sub });
    this.scopes.push(sub);
    return sub;
  }

  elabGenFor(it: Extract<Item, { k: 'genfor' }>, scope: Scope) {
    const name = it.name ?? 'genblk';
    let n = 0;
    const vhdl = it.vhdl;
    if (vhdl) {
      const from = this.constInt(vhdl.from, scope), to = this.constInt(vhdl.to, scope);
      const step = vhdl.down ? -1 : 1;
      for (let i = from; vhdl.down ? i >= to : i <= to; i += step) {
        const sub = this.subScope(scope, `${name}(${i})`);
        sub.syms.set(it.v, { k: 'const', v: fromInt(i, 32, true), t: VHDL_STD_TYPES.integer });
        this.elabItems(it.items, sub);
        if (++n > 100000) err('generate loop too long', it.loc);
      }
      return;
    }
    let v = this.constEval(it.init, scope);
    for (;;) {
      const tmp = new Scope('tmp', scope.path, scope, null, scope.mod, 'block');
      tmp.syms.set(it.v, { k: 'const', v });
      if (!L.isTrue(this.constEval(it.cond, tmp))) break;
      const i = Number(v.toBigInt());
      const sub = this.subScope(scope, `${name}[${i}]`);
      sub.syms.set(it.v, { k: 'const', v });
      this.elabItems(it.items, sub);
      v = this.constEval(it.stepExpr, tmp);
      if (++n > 100000) err('generate loop too long', it.loc);
    }
  }

  elabInst(it: Extract<Item, { k: 'inst' }>, scope: Scope) {
    const lib = it.lib && it.lib !== 'work' ? it.lib : undefined;
    let found = this.lib.findDesign(it.module, lib, it.arch);
    if (!found && scope.mod.lang === 'vhdl') found = this.lib.findDesign(it.module.toLowerCase(), lib, it.arch);
    if (!found) err(`(vsim-3033) Instantiation of '${it.module}' failed. The design unit was not found.`, it.loc);
    this.instantiate(found, it.name, scope, it.params, it.conns, it.loc);
  }

  elabDecl(it: Extract<Item, { k: 'decl' }>, scope: Scope) {
    const t = this.resolveType(it.type, scope, it.loc);
    for (const dn of it.names) {
      const existing = scope.syms.get(dn.name);
      if (existing?.k === 'sig' && scope.objects.some(o => o.name === dn.name && o.dir !== 'internal')) {
        // Verilog non-ANSI "output q; reg q;" — port already declared
        if (dn.init) existing.sig.value = this.constEval(dn.init, scope, existing.sig.w);
        continue;
      }
      if (existing && scope.kind !== 'func') {
        if (existing.k === 'sig' || existing.k === 'mem') err(`(vlog-2388) '${dn.name}' already declared in this scope (${scope.path}).`, it.loc);
      }
      if (dn.unpacked || t.kind === 'array') {
        // memory
        let lo: number, hi: number, et: RType;
        if (dn.unpacked) {
          const a = this.constInt(dn.unpacked[0][0], scope), b = this.constInt(dn.unpacked[0][1], scope);
          lo = Math.min(a, b); hi = Math.max(a, b); et = t;
          if (dn.unpacked.length > 1) err('Multi-dimensional unpacked arrays are not supported', it.loc);
        } else { lo = t.lo!; hi = t.hi!; et = t.elem!; }
        const n = hi - lo + 1;
        if (n > 1 << 22) err(`Memory '${dn.name}' too large (${n} words)`, it.loc);
        const w = et.w || 1;
        const init = this.defaultValue(et);
        const words: Vec[] = new Array(n).fill(resize(init, w).withSign(et.signed));
        const mem = new Memory(`${scope.path}/${dn.name}`, dn.name, w, lo, hi, et.signed, words, et.msb, et.lsb, et.enumNames);
        if (dn.init) this.initMemory(mem, dn.init, scope);
        const mt: RType = { kind: 'array', w, msb: et.msb, lsb: et.lsb, signed: et.signed, elem: et, lo, hi, enumNames: et.enumNames };
        scope.syms.set(dn.name, { k: 'mem', mem, t: mt });
        scope.memories.push({ name: dn.name, mem });
        continue;
      }
      if (it.kind === 'const') {
        const r = this.constEvalFull(dn.init!, scope, t);
        let v = r.v;
        if (t.w) v = resize(v, t.w).withSign(t.signed);
        scope.syms.set(dn.name, { k: 'const', v, t, str: r.str });
        continue;
      }
      if (t.kind === 'string') {
        // string variables: store up to 256 chars
        const st: RType = { kind: 'vec', w: 8 * 256, msb: 8 * 256 - 1, lsb: 0, signed: false };
        this.newSignal(scope, dn.name, st, dn.init ? this.constEval(dn.init, scope, st.w) : L.zeros(st.w), it.kind === 'variable' || scope.kind === 'func');
        continue;
      }
      let init: Vec | undefined;
      if (dn.init) {
        const c = this.ctx(scope, 'init');
        c.constOnly = false;
        const n = this.ex(dn.init, c);
        if (n.cv) init = resize(final(n, t.w || n.w)(), t.w || n.w);
        else {
          // non-constant initializer (Verilog "reg x = y;"): evaluate at time 0
          const ev = final(n, t.w || 1);
          this.pending.push(() => { /* compiled lazily */ });
          this.k.activate(() => { const s = scope.syms.get(dn.name); if (s?.k === 'sig') this.k.set(s.sig, ev()); });
        }
      }
      const isVar = it.kind === 'variable' || scope.kind === 'func' || scope.kind === 'block';
      const isNet = it.kind === 'net';
      if (t.w === 0) err(`(vcom-1013) Unconstrained type for '${dn.name}'.`, it.loc);
      this.newSignal(scope, dn.name, t, init, isVar, 'internal', isNet && !init);
    }
  }

  initMemory(mem: Memory, e: Expr, scope: Scope) {
    const c = this.ctx(scope, 'init');
    const put = (i: number, x: Expr) => { if (i >= 0 && i < mem.words.length) mem.words[i] = resize(final(this.ex(x, c), mem.w)(), mem.w).withSign(mem.signed); };
    if (e.k === 'agg') {
      if (e.others) for (let i = 0; i < mem.words.length; i++) put(i, e.others);
      e.elems.forEach((el, i) => {
        if (el.choice) put(this.constInt(el.choice, scope) - mem.lo, el.value);
        else put(i, el.value);
      });
      return;
    }
    if (e.k === 'concat') { e.parts.forEach((p, i) => put(i, p)); return; }
    err('Unsupported memory initializer', e.loc);
  }

  // ---------------------------------------------------------- constants

  ctx(scope: Scope, owner: string): Ctx {
    return { scope, lang: scope.mod.lang, owner, drivers: new Map(), driverMode: false, deferred: false, depth: 0 };
  }

  constEval(e: Expr, scope: Scope, w?: number): Vec {
    const c = this.ctx(scope, 'const');
    c.constOnly = true;
    const n = this.ex(e, c);
    return w ? resize(final(n, w)(), w) : selfEv(n)();
  }

  constEvalFull(e: Expr, scope: Scope, t?: RType): { v: Vec; str?: string } {
    const c = this.ctx(scope, 'const');
    c.constOnly = true;
    c.strMode = t?.kind === 'string';
    const n = this.ex(e, c);
    const v = t && t.w ? resize(final(n, t.w)(), t.w) : selfEv(n)();
    return { v, str: n.str ?? (t?.kind === 'string' ? L.toAscii(v) : undefined) };
  }

  constInt(e: Expr, scope: Scope): number {
    const v = this.constEval(e, scope);
    if (!v.known) err('Constant expression evaluates to X/Z', e.loc);
    return Number(v.toBigInt());
  }

  // ---------------------------------------------------------- lookup

  lookupName(scope: Scope, name: string): Sym | undefined {
    const lang = scope.mod.lang;
    if (lang === 'vhdl') name = name.toLowerCase();
    const s = scope.lookup(name);
    if (s) return s;
    if (name.includes('.')) return this.lookupHier(scope, name);
    return undefined;
  }

  lookupHier(scope: Scope, name: string): Sym | undefined {
    const parts = name.split('.');
    let cur: Scope | undefined;
    const first = scope.lookup(parts[0]);
    if (first?.k === 'scope') cur = first.s;
    else if (this.root && parts[0] === this.root.name) cur = this.root;
    else {
      // VHDL: lib.pkg.name or pkg.name
      for (const [key, ps] of this.pkgScopes) {
        const [lib, pk] = key.split('.');
        if (parts.length === 3 && parts[0] === lib && parts[1] === pk) return ps.syms.get(parts[2]);
        if (parts.length === 2 && parts[0] === pk) return ps.syms.get(parts[1]);
      }
      // upward search through instance parents
      for (let s: Scope | null = scope.up; s; s = s.up) {
        if (s.name === parts[0]) { cur = s; break; }
        const c = s.syms.get(parts[0]);
        if (c?.k === 'scope') { cur = c.s; break; }
      }
      if (!cur) return undefined;
    }
    for (let i = 1; i < parts.length - 1; i++) {
      const nx: Sym | undefined = cur!.syms.get(parts[i]);
      if (nx?.k !== 'scope') return undefined;
      cur = nx.s;
    }
    return cur!.syms.get(parts[parts.length - 1]);
  }

  // ---------------------------------------------------------- expressions

  ex(e: Expr, c: Ctx): Node {
    switch (e.k) {
      case 'num': {
        if (e.unsized && !e.v.known) {
          const v = e.v;
          return { w: v.w, s: v.signed, cv: v, mk: (W, sx) => { const r = L.resizeLiteral(v, W).withSign(sx); return () => r; } };
        }
        return constNode(e.v);
      }
      case 'real': return constNode(fromInt(Math.round(e.v), 64, true), { real: e.v });
      case 'time': return constNode(fromInt(Math.round(e.ps), 64, true), { isTime: true });
      case 'str': {
        if (c.lang === 'vhdl' && !c.strMode && e.s.length > 0 && /^[01uxzwlh-]+$/i.test(e.s)) return constNode(L.fromBits(e.s));
        return constNode(e.s.length ? L.fromString(e.s) : L.zeros(8), { str: e.s });
      }
      case 'fill': return { w: 1, s: false, mk: (W) => { const v = e.bit === '0' ? L.zeros(W) : e.bit === '1' ? new Vec(W, L.mask(W), 0n) : e.bit === 'x' ? allX(W) : allZ(W); return () => v; } };
      case 'id': return this.idNode(e.name, c, e.loc);
      case 'index': case 'range': case 'irange': return this.selectNode(e, c);
      case 'un': return this.unaryNode(e, c);
      case 'bin': return this.binNode(e, c);
      case 'tern': {
        const C = this.ex(e.c, c), T = this.ex(e.t, c), F = this.ex(e.f, c);
        const cf = selfEv(C);
        return {
          w: Math.max(T.w, F.w), s: T.s && F.s, isTime: T.isTime || F.isTime, str: T.str !== undefined && F.str !== undefined ? '' : undefined,
          mk: (W, sx) => {
            const tf = T.mk(W, sx), ff = F.mk(W, sx);
            return () => {
              const t = L.truth(cf());
              if (t === 1) return tf();
              if (t === 0) return ff();
              const a = tf(), b = ff();
              const diff = (a.a ^ b.a) | a.b | b.b;
              return new Vec(W, a.a | diff, diff, sx);
            };
          },
        };
      }
      case 'concat': {
        const parts = e.parts.map(p => this.ex(p, c));
        const evs = parts.map(p => selfEv(p));
        const w = parts.reduce((s, p) => s + p.w, 0);
        const allStr = parts.every(p => p.str !== undefined);
        // strings built at run time ('image, to_string) may be longer than their nominal width
        const strish = parts.some(p => p.str !== undefined);
        return {
          w, s: false, str: allStr ? parts.map(p => p.str).join('') : undefined,
          cv: parts.every(p => p.cv) ? L.concat(evs.map(f => f())) : undefined,
          mk: (W) => strish
            ? () => { const v = L.concat(evs.map(f => f())); return v.w >= W ? v : resize(v, W); }
            : () => resize(L.concat(evs.map(f => f())), W),
        };
      }
      case 'repl': {
        const n = this.constInt(e.count, c.scope);
        const parts = e.parts.map(p => this.ex(p, c));
        const evs = parts.map(p => selfEv(p));
        const w = n * parts.reduce((s, p) => s + p.w, 0);
        return { w, s: false, mk: (W) => () => resize(L.replicate(n, L.concat(evs.map(f => f()))), W) };
      }
      case 'call': return this.callNode(e, c);
      case 'attr': return this.attrNode(e, c);
      case 'agg': return this.aggNode(e, c);
    }
  }

  idNode(name: string, c: Ctx, loc?: Loc): Node {
    const sym = this.lookupName(c.scope, name);
    if (!sym) {
      if (c.lang === 'vhdl' && (name === 'now')) return this.vhdlBuiltin('now', [], c, loc)!;
      err(c.lang === 'vhdl' ? `(vcom-1136) Unknown identifier "${name}".` : `(vlog-2110) Undefined variable: '${name}'.`, loc);
    }
    switch (sym.k) {
      case 'const': return constNode(sym.v, { isTime: sym.t?.isTime, enumNames: sym.t?.enumNames, str: sym.str });
      case 'sig': {
        if (c.constOnly) err(`'${name}' is not a constant.`, loc);
        const sig = sym.sig;
        c.reads?.add(sig);
        return leaf(() => sig.value, sig.w, sig.signed, { isTime: sym.t.isTime, enumNames: sig.enumNames, sig });
      }
      case 'mem': err(`Memory '${name}' must be indexed.`, loc);
      case 'func': return this.funcCall(sym, [], c, loc);
      case 'type': err(`Type '${name}' used as a value.`, loc);
      case 'scope': err(`Scope '${name}' used as a value.`, loc);
    }
  }

  /** Resolve the base of a select into a signal, memory or generic node. */
  selBase(base: Expr, c: Ctx): { k: 'sig'; sig: Signal; t: RType } | { k: 'mem'; mem: Memory; t: RType } | { k: 'node'; node: Node; msb: number; lsb: number } {
    if (base.k === 'id') {
      const sym = this.lookupName(c.scope, base.name);
      if (sym?.k === 'sig') { if (c.constOnly) err(`'${base.name}' is not a constant.`, base.loc); return sym; }
      if (sym?.k === 'mem') { if (c.constOnly) err(`'${base.name}' is not a constant.`, base.loc); return sym; }
      if (sym?.k === 'const') {
        const t = sym.t;
        return { k: 'node', node: constNode(sym.v), msb: t && !t.isInt && t.w ? t.msb : sym.v.w - 1, lsb: t && !t.isInt && t.w ? t.lsb : 0 };
      }
    }
    if (base.k === 'index') {
      const b = this.selBase(base.base, c);
      if (b.k === 'mem') return { k: 'node', node: this.selectNode(base, c), msb: b.mem.elemMsb, lsb: b.mem.elemLsb };
    }
    const n = this.ex(base, c);
    return { k: 'node', node: n, msb: n.w - 1, lsb: 0 };
  }

  selectNode(e: Extract<Expr, { k: 'index' | 'range' | 'irange' }>, c: Ctx): Node {
    const b = this.selBase(e.base, c);
    const offOf = (msb: number, lsb: number) => (i: number) => {
      if (msb >= lsb) return i >= lsb && i <= msb ? i - lsb : -1;
      return i <= lsb && i >= msb ? lsb - i : -1;
    };
    if (e.k === 'index') {
      const I = this.ex(e.index, c);
      const iv = selfEv(I);
      if (b.k === 'mem') {
        const mem = b.mem;
        c.reads?.add(mem);
        const X = allX(mem.w).withSign(mem.signed);
        return leaf(() => {
          const i = iv();
          if (!i.known) return X;
          const k = mem.index(Number(i.toBigInt()));
          return k < 0 ? X : mem.words[k];
        }, mem.w, mem.signed, { enumNames: mem.enumNames });
      }
      let get: () => Vec, off: (i: number) => number;
      if (b.k === 'sig') { const sig = b.sig; get = () => sig.value; off = (i) => sig.offsetOf(i); c.reads?.add(sig); }
      else { get = selfEv(b.node); off = offOf(b.msb, b.lsb); }
      if (I.cv) {
        const o = off(Number(I.cv.toBigInt()));
        if (o < 0) return constNode(L.X1);
        const r = leaf(() => slice(get(), o, 1), 1, false);
        if (b.k === 'node' && b.node.cv) r.cv = slice(b.node.cv, o, 1);
        return r;
      }
      return leaf(() => {
        const i = iv();
        if (!i.known) return L.X1;
        const o = off(Number(i.toBigInt()));
        return o < 0 ? L.X1 : slice(get(), o, 1);
      }, 1, false);
    }
    // part selects
    let get: () => Vec, off: (i: number) => number, signedBase = false;
    if (b.k === 'mem') err('Part-select of memory requires a word index', e.loc);
    if (b.k === 'sig') { const sig = b.sig; get = () => sig.value; off = (i) => sig.offsetOf(i); c.reads?.add(sig); signedBase = false; }
    else { get = selfEv(b.node); off = offOf(b.msb, b.lsb); }
    void signedBase;
    if (e.k === 'range') {
      const mi = this.tryConst(e.msb, c), li = this.tryConst(e.lsb, c);
      if (mi === null || li === null) {
        // dynamic slice with (hopefully) constant width: VHDL a(i+3 downto i)
        const M = selfEv(this.ex(e.msb, c)), Lx = selfEv(this.ex(e.lsb, c));
        const w0 = this.sliceWidthGuess(e, c);
        return leaf(() => {
          const m = M(), l = Lx();
          if (!m.known || !l.known) return allX(w0);
          const o1 = off(Number(m.toBigInt())), o2 = off(Number(l.toBigInt()));
          if (o1 < 0 || o2 < 0) return allX(w0);
          return resize(slice(get(), Math.min(o1, o2), Math.abs(o1 - o2) + 1), w0);
        }, w0, false);
      }
      const o1 = off(mi), o2 = off(li);
      const w = Math.abs(mi - li) + 1;
      const lo = o1 < 0 || o2 < 0 ? (o1 < 0 ? o2 - (w - 1) : Math.min(o1, o2)) : Math.min(o1, o2);
      const r = leaf(() => slice(get(), lo, w), w, false);
      if (b.k === 'node' && b.node.cv) r.cv = slice(b.node.cv, lo, w);
      return r;
    }
    // indexed part select
    const w = this.constInt(e.width, c.scope);
    const S = selfEv(this.ex(e.start, c));
    const dir = e.dir;
    return leaf(() => {
      const s = S();
      if (!s.known) return allX(w);
      const st = Number(s.toBigInt());
      const a = off(st), bb = off(dir === '+' ? st + w - 1 : st - w + 1);
      let lo: number;
      if (a >= 0 && bb >= 0) lo = Math.min(a, bb);
      else if (a >= 0) lo = dir === '+' ? (bb < 0 ? a : a) : a - (w - 1);
      else return allX(w);
      return slice(get(), lo, w);
    }, w, false);
  }

  sliceWidthGuess(e: Extract<Expr, { k: 'range' }>, c: Ctx): number {
    // width = msb - lsb + 1 when difference is constant: evaluate with a probe value for each signal
    const diff: Expr = { k: 'bin', op: '-', l: e.msb, r: e.lsb };
    try { return Math.abs(this.constInt(diff, c.scope)) + 1; } catch { /* fallthrough */ }
    // try simple symbolic forms: (x + K) downto x
    const sym = (x: Expr): [string, number] | null => {
      if (x.k === 'id') return [x.name, 0];
      if (x.k === 'bin' && (x.op === '+' || x.op === '-')) {
        const l = sym(x.l); const r = this.tryConst(x.r, c);
        if (l && r !== null) return [l[0], l[1] + (x.op === '+' ? r : -r)];
      }
      return null;
    };
    const a = sym(e.msb), b = sym(e.lsb);
    if (a && b && a[0] === b[0]) return Math.abs(a[1] - b[1]) + 1;
    err('Part-select width must be constant', e.loc);
  }

  tryConst(e: Expr, c: Ctx): number | null {
    try {
      const v = this.constEval(e, c.scope);
      return v.known ? Number(v.toBigInt()) : null;
    } catch { return null; }
  }

  unaryNode(e: Extract<Expr, { k: 'un' }>, c: Ctx): Node {
    const A = this.ex(e.e, c);
    const op = e.op;
    const red = (f: (v: Vec) => Vec, neg = false): Node => {
      const av = selfEv(A);
      return leaf(neg ? () => L.not(f(av())) : () => f(av()), 1, false, { cv: A.cv ? (neg ? L.not(f(A.cv)) : f(A.cv)) : undefined });
    };
    switch (op) {
      case '+': return A;
      case '-': return { w: A.w, s: A.s, isTime: A.isTime, cv: A.cv ? L.neg(A.cv) : undefined, mk: (W, sx) => { const f = A.mk(W, sx); return () => L.neg(f()); } };
      case '~': return { w: A.w, s: A.s, enumNames: A.w === 1 && A.enumNames ? A.enumNames : undefined, cv: A.cv ? L.not(A.cv) : undefined, mk: (W, sx) => { const f = A.mk(W, sx); return () => L.not(f()); } };
      case '!': return red(L.lnot);
      case '&': return red(L.redAnd);
      case '|': return red(L.redOr);
      case '^': return red(L.redXor);
      case '~&': return red(L.redAnd, true);
      case '~|': return red(L.redOr, true);
      case '~^': return red(L.redXor, true);
      case 'abs': return { w: A.w, s: A.s, mk: (W, sx) => { const f = A.mk(W, sx); return () => { const v = f(); return v.known && v.signed && v.toBigInt() < 0n ? L.neg(v) : v; }; } };
    }
    err(`Unknown unary operator ${op}`, e.loc);
  }

  binNode(e: Extract<Expr, { k: 'bin' }>, c: Ctx): Node {
    const A = this.ex(e.l, c), B = this.ex(e.r, c);
    const op = e.op;
    const ctxOp = (f: (a: Vec, b: Vec) => Vec): Node => {
      const w = Math.max(A.w, B.w), s = A.s && B.s;
      const n: Node = {
        w, s, isTime: A.isTime || B.isTime,
        mk: (W, sx) => { const af = A.mk(W, sx), bf = B.mk(W, sx); return () => f(af(), bf()); },
      };
      if (A.cv && B.cv) n.cv = n.mk(w, s)();
      if (A.real !== undefined || B.real !== undefined) {
        const ar = A.real ?? (A.cv ? Number(A.cv.toBigInt()) : undefined), br = B.real ?? (B.cv ? Number(B.cv.toBigInt()) : undefined);
        if (ar !== undefined && br !== undefined) {
          const r = op === '+' ? ar + br : op === '-' ? ar - br : op === '*' ? ar * br : op === '/' ? ar / br : undefined;
          if (r !== undefined) return constNode(fromInt(Math.round(r), 64, true), { real: r, isTime: n.isTime });
        }
      }
      return n;
    };
    const cmpOp = (f: (a: Vec, b: Vec) => Vec): Node => {
      const w = Math.max(A.w, B.w), s = A.s && B.s;
      const af = A.mk(w, s), bf = B.mk(w, s);
      const n = leaf(() => f(af(), bf()), 1, false);
      if (A.cv && B.cv) n.cv = f(af(), bf());
      return n;
    };
    const shiftOp = (f: (a: Vec, b: Vec) => Vec): Node => {
      const bf = selfEv(B);
      const n: Node = { w: A.w, s: A.s, mk: (W, sx) => { const af = A.mk(W, sx); return () => f(af(), bf().withSign(false)); } };
      if (A.cv && B.cv) n.cv = n.mk(A.w, A.s)();
      return n;
    };
    const logOp = (f: (a: Vec, b: Vec) => Vec): Node => {
      const af = selfEv(A), bf = selfEv(B);
      const n = leaf(() => f(af(), bf()), 1, false);
      if (A.cv && B.cv) n.cv = f(af(), bf());
      return n;
    };
    switch (op) {
      case '+': return ctxOp(L.add);
      case '-': return ctxOp(L.sub);
      case '*': return ctxOp(L.mul);
      case '/': return ctxOp(L.div);
      case '%': return ctxOp(L.mod);
      case 'mod': return ctxOp(L.vmod);
      case '&': return ctxOp(L.and);
      case '|': return ctxOp(L.or);
      case '^': return ctxOp(L.xor);
      case '~^': return ctxOp(L.xnor);
      case '**': return shiftOp(L.pow);
      case '<<': case '<<<': return shiftOp(L.shl);
      case '>>': return shiftOp(L.shr);
      case '>>>': return shiftOp(L.ashr);
      case '==': return cmpOp(L.eq);
      case '!=': return cmpOp(L.neq);
      case '===': return cmpOp(L.caseEq);
      case '!==': return cmpOp(L.caseNeq);
      case '<': return cmpOp(L.lt);
      case '<=': return cmpOp(L.le);
      case '>': return cmpOp(L.gt);
      case '>=': return cmpOp(L.ge);
      case '&&': return logOp(L.land);
      case '||': return logOp(L.lor);
      case 'rol': case 'ror': {
        const bf = selfEv(B);
        return { w: A.w, s: A.s, mk: (W, sx) => { const af = A.mk(W, sx); return () => rotate(af(), bf(), op === 'rol'); } };
      }
    }
    err(`Unknown operator ${op}`, e.loc);
  }

  aggNode(e: Extract<Expr, { k: 'agg' }>, c: Ctx): Node {
    if (!e.others && e.elems.every(el => !el.choice)) {
      // positional aggregate == concatenation
      return this.ex({ k: 'concat', parts: e.elems.map(el => el.value), loc: e.loc }, c);
    }
    const others = e.others ? selfEv(this.ex(e.others, c)) : null;
    const elems = e.elems.map(el => ({ idx: el.choice ? this.constInt(el.choice, c.scope) : -1, ev: selfEv(this.ex(el.value, c)) }));
    const minW = Math.max(1, ...elems.map(x => x.idx + 1));
    return {
      w: minW, s: false,
      mk: (W) => () => {
        let v = others ? L.replicate(W, resize(others(), 1)) : allX(W);
        for (const el of elems) if (el.idx >= 0 && el.idx < W) v = insert(v, el.idx, resize(el.ev(), 1));
        return v;
      },
    };
  }

  attrNode(e: Extract<Expr, { k: 'attr' }>, c: Ctx): Node {
    const a = e.attr.toLowerCase();
    if (a === 'event' || a === 'last_value' || a === 'stable' || a === 'active') {
      const b = this.selBase(e.base, c);
      if (b.k !== 'sig') err(`'${a} requires a signal`, e.loc);
      const sig = b.sig;
      c.reads?.add(sig);
      const k = this.k;
      if (a === 'event' || a === 'active') return leaf(() => L.bool(sig.lastStamp === k.stamp), 1, false);
      if (a === 'stable') return leaf(() => L.bool(sig.lastStamp !== k.stamp), 1, false);
      return leaf(() => sig.prev, sig.w, sig.signed);
    }
    if (a === 'image' || a === 'value') {
      const arg = e.arg ? this.ex(e.arg, { ...c, strMode: false }) : null;
      if (!arg) err(`'${a} requires an argument`, e.loc);
      const tname = e.base.k === 'id' ? e.base.name.toLowerCase() : '';
      const t = tname ? (this.lookupName(c.scope, tname) as any)?.t as RType | undefined : undefined;
      const af = selfEv(arg);
      const isTime = tname === 'time' || arg.isTime;
      const names = t?.enumNames ?? arg.enumNames;
      const res = this.k.resolution;
      return {
        w: 8, s: false, str: '',
        mk: (W) => () => {
          const v = af();
          let s: string;
          if (names && v.known) s = names[Number(v.a)] ?? String(v.a);
          else if (isTime) s = v.known ? fmtTime(Number(v.toBigInt()), res) : 'X';
          else if (t?.scalar || arg.w === 1) s = `'${v.bit(0) === 'x' ? 'X' : v.bit(0) === 'z' ? 'Z' : v.bit(0)}'`;
          else s = L.toDec(v, true);
          return resize(L.fromString(s), Math.max(W, s.length * 8));
        },
      };
    }
    // array/type attributes
    let t: RType | undefined;
    let mem: Memory | undefined;
    if (e.base.k === 'id') {
      const sym = this.lookupName(c.scope, e.base.name);
      if (sym?.k === 'sig' || sym?.k === 'type' || sym?.k === 'const') t = sym.t;
      if (sym?.k === 'sig') t = { ...sym.t, w: sym.sig.w, msb: sym.sig.msb, lsb: sym.sig.lsb };
      if (sym?.k === 'mem') { mem = sym.mem; t = sym.t; }
      if (sym?.k === 'const' && !t) t = { kind: 'vec', w: sym.v.w, msb: sym.v.w - 1, lsb: 0, signed: false };
    }
    if (!t) { const n = this.ex(e.base, c); t = { kind: 'vec', w: n.w, msb: n.w - 1, lsb: 0, signed: false }; }
    let left: number, right: number;
    if (mem) { left = mem.lo; right = mem.hi; }
    else if (t.isInt) { left = t.left ?? -2147483648; right = t.right ?? 2147483647; }
    else if (t.enumNames && t.kind === 'enum') { left = 0; right = t.enumNames.length - 1; }
    else { left = t.msb; right = t.lsb; }
    const hi = Math.max(left, right), lo = Math.min(left, right);
    const v = (n: number) => constNode(fromInt(n, 32, true));
    switch (a) {
      case 'length': return v(hi - lo + 1);
      case 'high': return v(hi);
      case 'low': return v(lo);
      case 'left': return v(left);
      case 'right': return v(right);
      case 'ascending': return constNode(L.bool(left < right));
    }
    err(`Unsupported attribute '${e.attr}`, e.loc);
  }

  // ---------------------------------------------------------- calls

  callNode(e: Extract<Expr, { k: 'call' }>, c: Ctx): Node {
    const name = c.lang === 'vhdl' ? e.name.toLowerCase() : e.name;
    if (name.startsWith('$')) return this.sysFunc(name, e.args, c, e.loc);
    let sym = this.lookupName(c.scope, name);
    if (sym && sym.k !== 'func' && c.lang === 'verilog') {
      // Verilog name(...) is always a call; skip the function's own return variable
      for (let s: Scope | null = c.scope; s; s = s.lex) { const f = s.syms.get(name); if (f?.k === 'func') { sym = f; break; } }
    }
    if (sym) {
      if (sym.k === 'sig' || sym.k === 'mem' || (sym.k === 'const' && c.lang === 'vhdl' && e.args.length)) {
        return this.ex(this.vhdlIndexExpr(e, sym.k === 'mem'), c);
      }
      if (sym.k === 'func') return this.funcCall(sym, e.args, c, e.loc, e.named);
      if (sym.k === 'type') {
        // type conversion / qualification
        if (e.args.length !== 1) err(`Type conversion to '${name}' takes one argument`, e.loc);
        const A = this.ex(e.args[0], c);
        const t = sym.t;
        const w = t.w || A.w;
        const af = final(A, w);
        if (t.isInt && !A.isTime) {
          const src = A.mk(A.w, A.s);
          return leaf(() => resize(src(), 32, A.s).withSign(true), 32, true);
        }
        return leaf(() => af().withSign(t.signed), w, t.signed, { cv: A.cv ? resize(A.cv, w).withSign(t.signed) : undefined });
      }
    }
    if (c.lang === 'vhdl') {
      const b = this.vhdlBuiltin(name, e.args, c, e.loc);
      if (b) return b;
    }
    err(c.lang === 'vhdl' ? `(vcom-1136) Unknown identifier "${e.name}".` : `(vlog-2164) Function '${e.name}' not found.`, e.loc);
  }

  /** VHDL name(args) where name is an array: convert to index/range expression. */
  vhdlIndexExpr(e: Extract<Expr, { k: 'call' }>, isMem: boolean): Expr {
    let base: Expr = { k: 'id', name: e.name, loc: e.loc };
    for (const a of e.args) {
      if (a.k === 'call' && (a.name === '__downto' || a.name === '__to')) base = { k: 'range', base, msb: a.args[0], lsb: a.args[1], loc: e.loc };
      else base = { k: 'index', base, index: a, loc: e.loc };
    }
    void isMem;
    return base;
  }

  getCFunc(sym: Extract<Sym, { k: 'func' }>, argNodes: Node[], loc?: Loc): CFunc {
    const f = sym.f;
    const key = argNodes.map(n => n.w).join(',');
    let cf = sym.cache.get(key);
    if (cf) return cf;
    const fs = new Scope(f.name, sym.scope.path, sym.scope, null, sym.scope.mod, 'func');
    const args: Signal[] = [];
    const argT: RType[] = [];
    f.args.forEach((a, i) => {
      let t = this.resolveType(a.type, fs, loc);
      if (t.w === 0) {
        const w = argNodes[i]?.w ?? 1;
        t = { ...t, w, msb: w - 1, lsb: 0 };
      }
      argT.push(t);
      args.push(this.newSignal(fs, a.name, t, undefined, true));
    });
    let ret: Signal | null = null;
    if (f.ret) {
      let t = this.resolveType(f.ret, fs, loc);
      if (t.w === 0) {
        const w = Math.max(1, ...argT.filter(x => !x.isInt && !x.scalar).map(x => x.w));
        t = { ...t, w, msb: w - 1, lsb: 0 };
      }
      ret = this.newSignal(fs, sym.scope.mod.lang === 'vhdl' ? '__ret' : f.name, t, undefined, true);
      (ret as any).rtype = t;
    }
    const reads = new Set<Signal | Memory>();
    cf = { args, argT, ret, locals: [], body: () => {}, reads };
    sym.cache.set(key, cf);
    for (const d of f.decls) {
      if (d.k === 'decl') this.elabDecl({ ...d, kind: 'variable' }, fs);
      else if (d.k === 'param' || d.k === 'typedef' || d.k === 'func') this.elabItems([d], fs);
    }
    for (const [, s] of fs.syms) if (s.k === 'sig' && !args.includes(s.sig) && s.sig !== ret) cf.locals.push(s.sig);
    const c = this.ctx(fs, `func ${f.name}`);
    c.reads = reads;
    c.func = cf;
    const body = this.st(f.body, c);
    if (!body.sync) err(`(vlog-2244) Function '${f.name}' contains timing controls.`, f.loc);
    cf.body = body.sync;
    // a function's reads of its own locals/args are not external sensitivity
    for (const a of [...args, ...cf.locals]) reads.delete(a);
    if (ret) reads.delete(ret);
    return cf;
  }

  funcCall(sym: Extract<Sym, { k: 'func' }>, argExprs: Expr[], c: Ctx, loc?: Loc, named?: (string | null)[]): Node {
    const f = sym.f;
    if (f.isTask) err(`Task '${f.name}' called as a function.`, loc);
    argExprs = this.orderArgs(f, argExprs, named, loc);
    if (argExprs.length !== f.args.length) err(`(vlog-2165) Wrong number of arguments in call to '${f.name}': expected ${f.args.length}, got ${argExprs.length}.`, loc);
    const argNodes = argExprs.map(a => this.ex(a, { ...c, strMode: false }));
    const cf = this.getCFunc(sym, argNodes, loc);
    if (c.reads) for (const r of cf.reads) c.reads.add(r);
    const argEvs = argNodes.map((n, i) => final(n, cf.args[i].w));
    const ret = cf.ret;
    if (!ret) err(`Void function '${f.name}' used in expression.`, loc);
    const frame = [...cf.args, ...cf.locals, ret];
    let depth = 0;
    const callFn = () => {
      const vals = argEvs.map(f => f());
      const saved = depth > 0 ? frame.map(s => s.value) : null;
      depth++;
      if (depth > 1000) { depth = 0; throw new CompileError(`Recursion too deep in function '${f.name}'`, loc); }
      for (let i = 0; i < vals.length; i++) cf.args[i].value = vals[i].withSign(cf.args[i].signed);
      try { cf.body(); } catch (x) { if (x !== RET) { depth--; throw x; } }
      const r = ret.value;
      depth--;
      if (saved) frame.forEach((s, i) => { s.value = saved[i]; });
      return r;
    };
    const rt: RType | undefined = (ret as any).rtype;
    return leaf(callFn, ret.w, ret.signed, { enumNames: ret.enumNames, isTime: rt?.isTime });
  }

  orderArgs(f: FuncDecl, args: Expr[], named: (string | null)[] | undefined, loc?: Loc): Expr[] {
    if (!named || named.every(n => !n)) {
      // VHDL default values not supported -> exact count
      return args;
    }
    const out: Expr[] = [];
    let pos = 0;
    for (let i = 0; i < args.length; i++) if (!named[i]) out[pos++] = args[i];
    for (let i = 0; i < args.length; i++) {
      const n = named[i];
      if (!n) continue;
      const idx = f.args.findIndex(a => a.name.toLowerCase() === n.toLowerCase());
      if (idx < 0) err(`No parameter named '${n}' in '${f.name}'.`, loc);
      out[idx] = args[i];
    }
    return out;
  }

  sysFunc(name: string, args: Expr[], c: Ctx, loc?: Loc): Node {
    const k = this.k;
    const tsUnit = c.scope.mod.tsUnit;
    const A = (i: number) => { if (!args[i]) err(`${name}: missing argument`, loc); return this.ex(args[i], c); };
    switch (name) {
      case '$time': return leaf(() => fromInt(Math.round(k.now / tsUnit), 64), 64, false, { isMonTime: true });
      case '$stime': return leaf(() => fromInt(Math.round(k.now / tsUnit), 32), 32, false, { isMonTime: true });
      case '$realtime': return leaf(() => fromInt(Math.round(k.now / tsUnit), 64), 64, false, { isMonTime: true });
      case '$random': return leaf(() => fromInt(k.random(), 32, true), 32, true);
      case '$urandom': return leaf(() => fromInt(k.random() >>> 0, 32), 32, false);
      case '$urandom_range': {
        const hi = selfEv(A(0)), lo = args[1] ? selfEv(A(1)) : () => L.zeros(32);
        return leaf(() => {
          let h = Number(hi().a), l = Number(lo().a);
          if (h < l) [h, l] = [l, h];
          return fromInt(l + ((k.random() >>> 0) % (h - l + 1)), 32);
        }, 32, false);
      }
      case '$signed': case '$unsigned': {
        const X = A(0);
        const xf = X.mk(X.w, X.s);
        const s = name === '$signed';
        return leaf(() => xf().withSign(s), X.w, s, { cv: X.cv ? X.cv.withSign(s) : undefined });
      }
      case '$clog2': {
        const X = A(0);
        const xf = selfEv(X);
        const f = () => { const v = xf(); return v.known ? fromInt(clog2(v.a), 32, true) : allX(32); };
        return leaf(f, 32, true, { cv: X.cv ? f() : undefined });
      }
      case '$bits': { const X = A(0); return constNode(fromInt(X.w, 32, true)); }
      case '$countones': { const xf = selfEv(A(0)); return leaf(() => { const v = xf(); let n = 0, a = v.a & ~v.b; while (a) { n += Number(a & 1n); a >>= 1n; } return fromInt(n, 32); }, 32, false); }
      case '$onehot': case '$onehot0': {
        const xf = selfEv(A(0));
        return leaf(() => { const v = xf(); if (v.b) return L.X1; const a = v.a; const one = a !== 0n && (a & (a - 1n)) === 0n; return L.bool(name === '$onehot' ? one : one || a === 0n); }, 1, false);
      }
      case '$isunknown': { const xf = selfEv(A(0)); return leaf(() => L.bool(xf().b !== 0n), 1, false); }
      case '$fopen': return constNode(fromInt(0x80000001, 32));
      case '$feof': return constNode(L.ONE);
      case '$test$plusargs': case '$value$plusargs': return constNode(L.ZERO);
      case '$rtoi': case '$itor': case '$realtobits': case '$bitstoreal': return A(0);
    }
    err(`(vlog-2163) Unknown system function '${name}'.`, loc);
  }

  vhdlBuiltin(name: string, args: Expr[], c: Ctx, loc?: Loc): Node | null {
    const k = this.k;
    const A = (i: number) => { if (!args[i]) err(`${name}: missing argument`, loc); return this.ex(args[i], { ...c, strMode: false }); };
    const sigArg = (): Signal => {
      const a = args[0];
      const n = a.k === 'id' ? a.name : a.k === 'call' ? a.name : null;
      const sym = n ? this.lookupName(c.scope, n) : undefined;
      if (sym?.k !== 'sig') err(`${name}() requires a signal argument`, loc);
      c.reads?.add(sym.sig);
      return sym.sig;
    };
    const toStr = (s: string, W: number) => resize(L.fromString(s), Math.max(W, s.length * 8));
    switch (name) {
      case 'rising_edge': case 'falling_edge': {
        const sig = sigArg();
        const want = name === 'rising_edge' ? '1' : '0', from = name === 'rising_edge' ? '0' : '1';
        return leaf(() => L.bool(sig.lastStamp === k.stamp && sig.value.bit(0) === want && sig.prev.bit(0) === from), 1, false);
      }
      case 'now': return leaf(() => fromInt(k.now, 64, true), 64, true, { isTime: true });
      case 'to_integer': case 'conv_integer': {
        const X = A(0); const xf = selfEv(X);
        const signed = X.s;
        const f = () => { const v = xf(); if (!v.known) return L.zeros(32).withSign(true); return resize(v, 32, signed).withSign(true); };
        return leaf(f, 32, true, { cv: X.cv ? f() : undefined });
      }
      case 'to_unsigned': case 'to_signed': case 'conv_std_logic_vector': case 'conv_unsigned': case 'conv_signed': case 'to_slv': {
        const X = A(0);
        const n = this.constInt(args[1], c.scope);
        const s = name === 'to_signed' || name === 'conv_signed';
        const xf = X.mk(Math.max(X.w, n), X.s);
        const f = () => resize(xf(), n).withSign(s);
        return leaf(f, n, s, { cv: X.cv ? f() : undefined });
      }
      case 'resize': {
        const X = A(0);
        const n = this.constInt(args[1], c.scope);
        const xf = selfEv(X);
        return leaf(() => resize(xf(), n, X.s).withSign(X.s), n, X.s);
      }
      case 'ext': case 'sxt': {
        const X = A(0); const n = this.constInt(args[1], c.scope); const xf = selfEv(X);
        return leaf(() => resize(xf(), n, name === 'sxt'), n, false);
      }
      case 'shift_left': case 'shift_right': case 'rotate_left': case 'rotate_right': {
        const X = A(0), N = A(1);
        const xf = selfEv(X), nf = selfEv(N);
        const f = name === 'shift_left' ? (v: Vec, n: Vec) => L.shl(v, n)
          : name === 'shift_right' ? (v: Vec, n: Vec) => (X.s ? L.ashr(v, n) : L.shr(v, n))
            : (v: Vec, n: Vec) => rotate(v, n, name === 'rotate_left');
        return leaf(() => f(xf(), nf().withSign(false)), X.w, X.s);
      }
      case 'std_logic_vector': case 'std_ulogic_vector': case 'unsigned': case 'signed': case 'to_stdlogicvector': case 'to_bitvector': case 'to_std_logic_vector': case 'std_logic': case 'to_x01': case 'to_01': {
        const X = A(0); const xf = selfEv(X);
        const s = name === 'signed';
        if (name === 'to_01') return leaf(() => { const v = xf(); return v.known ? v : L.zeros(v.w); }, X.w, X.s);
        return leaf(() => xf().withSign(s), X.w, s, { cv: X.cv?.withSign(s) });
      }
      case 'is_x': { const xf = selfEv(A(0)); return leaf(() => L.bool(xf().b !== 0n), 1, false); }
      case 'and_reduce': { const xf = selfEv(A(0)); return leaf(() => L.redAnd(xf()), 1, false); }
      case 'or_reduce': { const xf = selfEv(A(0)); return leaf(() => L.redOr(xf()), 1, false); }
      case 'xor_reduce': { const xf = selfEv(A(0)); return leaf(() => L.redXor(xf()), 1, false); }
      case 'minimum': case 'maximum': {
        const X = A(0), Y = A(1);
        const w = Math.max(X.w, Y.w), s = X.s && Y.s;
        const xf = X.mk(w, s), yf = Y.mk(w, s);
        return leaf(() => { const a = xf(), b = yf(); return L.isTrue(L.lt(a, b)) === (name === 'minimum') ? a : b; }, w, s);
      }
      case 'to_string': case 'to_hstring': case 'to_ostring': case 'to_bstring': {
        const X = A(0); const xf = selfEv(X);
        const res = k.resolution;
        return {
          w: 8, s: false, str: '',
          mk: (W) => () => {
            const v = xf();
            let s: string;
            if (name === 'to_hstring') s = L.toHex(v).toUpperCase();
            else if (name === 'to_ostring') s = L.toOct(v);
            else if (X.isTime) s = fmtTime(Number(v.toBigInt()), res);
            else if (X.enumNames && v.known) s = X.enumNames[Number(v.a)] ?? String(v.a);
            else if (X.s && X.w === 32) s = L.toDec(v, true);
            else if (X.str !== undefined) s = L.toAscii(v);
            else s = L.toBin(v).toUpperCase();
            return toStr(s, W);
          },
        };
      }
      case 'std.env.stop': case 'std.env.finish': case 'stop': case 'finish': return null;
    }
    return null;
  }

  // ---------------------------------------------------------- lvalues

  getDriver(c: Ctx, sig: Signal, off: number, w: number): Driver | undefined {
    if (!c.driverMode || sig.isVar) return undefined;
    let d = c.drivers.get(sig);
    if (!d) {
      d = new Driver(sig, allZ(sig.w), c.owner);
      (sig.drivers ??= []).push(d);
      c.drivers.set(sig, d);
    }
    if (c.lang === 'vhdl' && c.deferred) d.value = insert(d.value, off, slice(sig.value, off, w));
    return d;
  }

  lv(e: Expr, c: Ctx): LNode {
    if (e.k === 'call' && c.lang === 'vhdl') {
      const sym = this.lookupName(c.scope, e.name);
      if (sym?.k === 'sig' || sym?.k === 'mem') return this.lv(this.vhdlIndexExpr(e, sym.k === 'mem'), c);
      err(`Illegal target for assignment: '${e.name}'.`, e.loc);
    }
    if (e.k === 'concat' || e.k === 'agg') {
      const parts = (e.k === 'concat' ? e.parts : e.elems.map(x => x.value)).map(p => this.lv(p, c));
      const w = parts.reduce((s, p) => s + p.w, 0);
      return { w, tg: () => parts.flatMap(p => p.tg()) };
    }
    if (e.k === 'id') {
      let sym = this.lookupName(c.scope, e.name);
      if (!sym && c.lang === 'verilog' && c.owner.startsWith('assign')) {
        this.warnings.push(`(vlog-2623) Implicit net '${e.name}' created in ${c.scope.path}.`);
        this.newSignal(c.scope, e.name, { kind: 'vec', w: 1, msb: 0, lsb: 0, signed: false }, undefined, false, 'internal', true);
        sym = this.lookupName(c.scope, e.name);
      }
      if (!sym) err(c.lang === 'vhdl' ? `(vcom-1136) Unknown identifier "${e.name}".` : `(vlog-2110) Undefined variable: '${e.name}'.`, e.loc);
      if (sym.k === 'mem') {
        err(`Array '${e.name}' must be indexed here (whole-array assignment is only supported as a plain statement).`, e.loc);
      }
      if (sym.k !== 'sig') err(`Illegal target for assignment: '${e.name}' is not a variable or signal.`, e.loc);
      const sig = sym.sig;
      const t: Tgt[] = [{ k: 'sig', sig, off: 0, w: sig.w, drv: this.getDriver(c, sig, 0, sig.w) }];
      return { w: sig.w, tg: () => t };
    }
    if (e.k === 'index' || e.k === 'range' || e.k === 'irange') {
      // memory word (possibly with bit/part select on it)
      const memBase = (x: Expr): { mem: Memory; idx: () => number } | null => {
        if (x.k === 'index' && x.base.k === 'id') {
          const s = this.lookupName(c.scope, x.base.name);
          if (s?.k === 'mem') {
            const I = selfEv(this.ex(x.index, c));
            const mem = s.mem;
            return { mem, idx: () => { const v = I(); return v.known ? mem.index(Number(v.toBigInt())) : -1; } };
          }
        }
        return null;
      };
      const mb = memBase(e);
      if (mb) {
        const { mem, idx } = mb;
        return { w: mem.w, tg: () => { const i = idx(); return i < 0 ? [] : [{ k: 'mem', mem, idx: i, off: 0, w: mem.w }]; } };
      }
      const inner = memBase(e.base);
      let sig: Signal | null = null;
      let off: (i: number) => number;
      if (inner) {
        const em = inner.mem.elemMsb, el = inner.mem.elemLsb;
        off = (i) => (em >= el ? (i >= el && i <= em ? i - el : -1) : (i <= el && i >= em ? el - i : -1));
      } else {
        const bsym = e.base.k === 'id' ? this.lookupName(c.scope, e.base.name) : undefined;
        if (bsym?.k !== 'sig') err('Unsupported assignment target', e.loc);
        sig = bsym.sig;
        const s = sig;
        off = (i) => s.offsetOf(i);
      }
      const mk = (o: number, w: number): Tgt[] => {
        if (o < 0) return [];
        if (inner) { const i = inner.idx(); return i < 0 ? [] : [{ k: 'mem', mem: inner.mem, idx: i, off: o, w }]; }
        return [{ k: 'sig', sig: sig!, off: o, w, drv: this.getDriver(c, sig!, o, w) }];
      };
      if (e.k === 'index') {
        const I = this.ex(e.index, c);
        if (I.cv && !inner) { const t = mk(off(Number(I.cv.toBigInt())), 1); return { w: 1, tg: () => t }; }
        if (!inner && sig && c.driverMode) this.getDriver(c, sig, 0, sig.w);
        const iv = selfEv(I);
        return { w: 1, tg: () => { const v = iv(); return v.known ? mk(off(Number(v.toBigInt())), 1) : []; } };
      }
      if (e.k === 'range') {
        const mi = this.tryConst(e.msb, c), li = this.tryConst(e.lsb, c);
        if (mi === null || li === null) {
          const w = this.sliceWidthGuess(e, c);
          const M = selfEv(this.ex(e.msb, c)), Lx = selfEv(this.ex(e.lsb, c));
          if (!inner && sig && c.driverMode) this.getDriver(c, sig, 0, sig.w);
          return { w, tg: () => { const a = M(), b = Lx(); if (!a.known || !b.known) return []; const o1 = off(Number(a.toBigInt())), o2 = off(Number(b.toBigInt())); return o1 < 0 || o2 < 0 ? [] : mk(Math.min(o1, o2), w); } };
        }
        const w = Math.abs(mi - li) + 1;
        const o1 = off(mi), o2 = off(li);
        const t = o1 < 0 || o2 < 0 ? [] : mk(Math.min(o1, o2), w);
        return { w, tg: () => t };
      }
      const w = this.constInt(e.width, c.scope);
      const S = selfEv(this.ex(e.start, c));
      const dir = e.dir;
      if (!inner && sig && c.driverMode) this.getDriver(c, sig, 0, sig.w);
      return { w, tg: () => { const s = S(); if (!s.known) return []; const st = Number(s.toBigInt()); const a = off(st), b = off(dir === '+' ? st + w - 1 : st - w + 1); if (a < 0 || b < 0) return []; return mk(Math.min(a, b), w); } };
    }
    err('Illegal assignment target', (e as any).loc);
  }

  write(tgts: Tgt[], v: Vec) {
    const k = this.k;
    if (tgts.length === 1) { this.write1(tgts[0], v.w === tgts[0].w ? v : resize(v, tgts[0].w)); return; }
    let off = tgts.reduce((s, t) => s + t.w, 0);
    for (const t of tgts) { off -= t.w; this.write1(t, slice(v, off, t.w)); }
    void k;
  }

  write1(t: Tgt, part: Vec) {
    const k = this.k;
    if (t.k === 'sig') {
      if (t.drv) k.updateDriver(t.drv, t.off === 0 && t.w === t.sig.w ? part : insert(t.drv.value, t.off, part));
      else k.set(t.sig, t.off === 0 && t.w === t.sig.w ? part : insert(t.sig.value, t.off, part));
    } else {
      const old = t.mem.words[t.idx];
      k.memWrite(t.mem, t.idx, (t.off === 0 && t.w === t.mem.w ? part : insert(old, t.off, part)).withSign(t.mem.signed));
    }
  }

  // ---------------------------------------------------------- delays

  delayFn(e: Expr, c: Ctx): () => number {
    const n = this.ex(e, c);
    const unit = c.scope.mod.tsUnit, prec = c.scope.mod.tsPrec;
    if (c.lang === 'vhdl' || n.isTime) {
      const f = final(n, 64);
      return () => { const v = f(); return v.known ? Number(v.withSign(true).toBigInt()) : 0; };
    }
    const scale = (x: number) => Math.round(Math.round((x * unit) / prec) * prec);
    if (n.real !== undefined) { const d = scale(n.real); return () => d; }
    const f = selfEv(n);
    return () => { const v = f(); return v.known ? scale(Number(v.toBigInt())) : 0; };
  }

  // ---------------------------------------------------------- processes

  compileCassign(lhs: Expr, rhs: Expr, delay: Expr | undefined, lscope: Scope, rscope: Scope, name: string) {
    const owner = `assign#${++this.ownerSeq}`;
    const lc = this.ctx(lscope, owner);
    lc.driverMode = true;
    const L_ = this.lv(lhs, lc);
    const rc = this.ctx(rscope, owner);
    rc.reads = new Set();
    const R = final(this.ex(rhs, rc), L_.w);
    const k = this.k;
    const d = delay ? this.delayFn(delay, rc) : null;
    let pending = false;
    const fire = () => {
      pending = false;
      const v = R();
      if (d) { const t = d(); k.schedule(k.now + t, () => this.write(L_.tg(), v)); }
      else this.write(L_.tg(), v);
    };
    const wake = () => { if (!pending) { pending = true; k.activate(fire); } };
    for (const s of rc.reads) k.listen(s, wake);
    pending = true;
    k.activate(fire);
    void name;
  }

  compileProcess(it: Extract<Item, { k: 'process' }>, scope: Scope) {
    const lang = scope.mod.lang;
    const line = it.loc?.line ?? 0;
    const pname = it.name ?? (lang === 'vhdl' ? `line__${line}` : `#${it.kind.toUpperCase()}#${line}`);
    const owner = `${scope.path}/${pname}#${++this.procSeq}`;
    const c = this.ctx(scope, owner);
    c.proc = { name: pname, scope: scope.path, file: it.loc?.file, line };
    if (lang === 'vhdl') { c.driverMode = true; c.deferred = true; }
    const k = this.k;
    let start: () => Gen;
    const needReads = it.kind === 'always_comb' || it.kind === 'always_latch' || (it.kind === 'vproc' && it.sens === 'all');
    if (needReads) c.reads = new Set();
    const body = this.st(it.body, c);
    const bodyGen = asGen(body);
    switch (it.kind) {
      case 'initial':
        start = bodyGen;
        break;
      case 'always': case 'always_ff':
        if (body.sync) err(`(vlog-2643) always block has no timing control; this would cause an infinite zero-delay loop.`, it.loc);
        start = function* () { for (;;) yield* bodyGen(); };
        break;
      case 'always_comb': case 'always_latch': case 'vproc': {
        let sens: (Signal | Memory)[] = [];
        if (it.kind !== 'vproc' || it.sens === 'all') sens = [...c.reads!];
        else if (it.sens) {
          const sc = this.ctx(scope, owner);
          sc.reads = new Set();
          for (const e of it.sens) this.ex(e, sc);
          sens = [...sc.reads];
        } else {
          if (body.sync) err(`(vcom-1090) Process without sensitivity list must contain a wait statement.`, it.loc);
          start = function* () { for (;;) yield* bodyGen(); };
          break;
        }
        const w: Wait = { t: 'sens', sigs: sens };
        start = function* () {
          for (;;) {
            yield* bodyGen();
            if (!sens.length) { yield { t: 'done' }; return; }
            yield w;
          }
        };
        break;
      }
    }
    const p = new Process(k, c.proc, start!);
    scope.procs.push(p);
    k.addProcess(p);
  }

  // ---------------------------------------------------------- statements

  st(s: Stmt, c: Ctx): SC {
    switch (s.k) {
      case 'null': return { sync: () => {} };
      case 'block': return this.blockStmt(s, c);
      case 'assign': return this.assignStmt(s, c);
      case 'vsigassign': return this.vsigStmt(s, c);
      case 'if': {
        const C = selfEv(this.ex(s.c, c));
        const T = this.st(s.t, c), F = s.f ? this.st(s.f, c) : null;
        if (T.sync && (!F || F.sync)) {
          const t = T.sync, f = F?.sync;
          return { sync: f ? () => { if (L.truth(C()) === 1) t(); else f(); } : () => { if (L.truth(C()) === 1) t(); } };
        }
        const tg = asGen(T), fg = F ? asGen(F) : null;
        return { gen: function* () { if (L.truth(C()) === 1) yield* tg(); else if (fg) yield* fg(); } };
      }
      case 'case': return this.caseStmt(s, c);
      case 'for': {
        let fc = c;
        if (s.init && s.init.k === 'assign' && s.init.lhs.k === 'id' && !this.lookupName(c.scope, s.init.lhs.name)) {
          // SV "for (int i = 0; ...)": implicit loop variable
          const sub = new Scope('for', c.scope.path, c.scope, null, c.scope.mod, 'block');
          this.newSignal(sub, s.init.lhs.name, VHDL_STD_TYPES.integer, undefined, true);
          fc = { ...c, scope: sub };
        }
        const I = s.init ? this.st(s.init, fc) : null;
        const C = s.cond ? selfEv(this.ex(s.cond, fc)) : () => L.ONE;
        const S = s.step ? this.st(s.step, fc) : null;
        const B = this.st(s.body, fc);
        if (B.sync && (!I || I.sync) && (!S || S.sync)) {
          const i = I?.sync, st = S?.sync, b = B.sync;
          return { sync: () => { let n = 0; if (i) i(); while (L.truth(C()) === 1) { if (++n > LOOP_GUARD) loopGuard(s.loc); try { b(); } catch (x) { if (x instanceof LoopEx && !x.label) { if (!x.next) break; } else throw x; } if (st) st(); } } };
        }
        const ig = I ? asGen(I) : null, sg = S ? asGen(S) : null, bg = asGen(B);
        return { gen: function* () { if (ig) yield* ig(); while (L.truth(C()) === 1) { yield* bg(); if (sg) yield* sg(); } } };
      }
      case 'vfor': return this.vforStmt(s, c);
      case 'while': case 'loop': {
        const C = s.k === 'while' ? selfEv(this.ex(s.c, c)) : () => L.ONE;
        const B = this.st(s.body, c);
        const label = s.label;
        const catchLoop = (x: unknown): 'break' | 'next' => {
          if (x instanceof LoopEx && (!x.label || x.label === label)) return x.next ? 'next' : 'break';
          throw x;
        };
        if (B.sync) {
          const b = B.sync;
          return { sync: () => { let n = 0; while (L.truth(C()) === 1) { if (++n > LOOP_GUARD) loopGuard(s.loc); try { b(); } catch (x) { if (catchLoop(x) === 'break') break; } } } };
        }
        if (s.k === 'loop' && B.gen) {
          // VHDL loop with waits
        }
        const bg = asGen(B);
        return {
          gen: function* () {
            while (L.truth(C()) === 1) {
              try { yield* bg(); } catch (x) { if (catchLoop(x) === 'break') break; }
            }
          },
        };
      }
      case 'repeat': {
        const N = selfEv(this.ex(s.n, c));
        const B = this.st(s.body, c);
        if (B.sync) { const b = B.sync; return { sync: () => { const v = N(); const n = v.known ? Number(v.toBigInt()) : 0; for (let i = 0; i < n; i++) b(); } }; }
        const bg = asGen(B);
        return { gen: function* () { const v = N(); const n = v.known ? Number(v.toBigInt()) : 0; for (let i = 0; i < n; i++) yield* bg(); } };
      }
      case 'forever': {
        const B = this.st(s.body, c);
        if (B.sync) err('(vlog-2643) forever loop without timing control.', s.loc);
        const bg = asGen(B);
        return { gen: function* () { for (;;) yield* bg(); } };
      }
      case 'delay': {
        const D = this.delayFn(s.d, c);
        const B = s.body ? asGen(this.st(s.body, c)) : null;
        return { gen: function* () { yield { t: 'delay', d: D() }; if (B) yield* B(); } };
      }
      case 'event': {
        const B = s.body ? this.st(s.body, c) : null;
        let waitFn: () => Wait;
        if (s.items === '*') {
          const rc: Ctx = { ...c, reads: new Set() };
          if (s.body) this.st(s.body, rc);
          const sigs = [...rc.reads!];
          if (c.reads) for (const r of sigs) c.reads.add(r);
          const w: Wait = sigs.length ? { t: 'sens', sigs } : { t: 'done' };
          waitFn = () => w;
        } else waitFn = this.eventWait(s.items, c);
        const bg = B ? asGen(B) : null;
        return { gen: function* () { yield waitFn(); if (bg) yield* bg(); } };
      }
      case 'wait': {
        const rc: Ctx = { ...c, reads: new Set() };
        const C = selfEv(this.ex(s.c, rc));
        const sigs = [...rc.reads!];
        const B = s.body ? asGen(this.st(s.body, c)) : null;
        const test = () => L.truth(C()) === 1;
        return { gen: function* () { if (!test()) yield { t: 'sens', sigs, test }; if (B) yield* B(); } };
      }
      case 'vwait': return this.vwaitStmt(s, c);
      case 'sys': return this.sysTask(s, c);
      case 'call': return this.callStmt(s, c);
      case 'report': return this.reportStmt(s, c);
      case 'return': {
        if (!c.func) { return { sync: () => { throw new DisableEx('__task__'); } }; }
        const ret = c.func.ret;
        if (s.e && ret) { const R = final(this.ex(s.e, c), ret.w); return { sync: () => { ret.value = R().withSign(ret.signed); throw RET; } }; }
        return { sync: () => { throw RET; } };
      }
      case 'disable': { const n = s.name; return { sync: () => { throw new DisableEx(n); } }; }
      case 'exit': {
        const C = s.cond ? selfEv(this.ex(s.cond, c)) : null;
        const ex = new LoopEx(s.label, s.next);
        return { sync: C ? () => { if (L.truth(C()) === 1) throw ex; } : () => { throw ex; } };
      }
      case 'force': {
        const Lv = this.lv(s.lhs, { ...c, driverMode: false });
        const R = s.rhs ? final(this.ex(s.rhs, c), Lv.w) : null;
        const k = this.k;
        return {
          sync: () => {
            for (const t of Lv.tg()) {
              if (t.k !== 'sig') continue;
              if (s.release) k.release(t.sig);
              else k.force(t.sig, t.off === 0 && t.w === t.sig.w ? R!() : insert(t.sig.value, t.off, R!()));
            }
          },
        };
      }
    }
    err(`Unsupported statement`, (s as any).loc);
  }

  blockStmt(s: Extract<Stmt, { k: 'block' }>, c: Ctx): SC {
    let bc = c;
    if (s.decls?.length) {
      const sub = new Scope(s.name ?? 'block', c.scope.path, c.scope, null, c.scope.mod, 'block');
      for (const d of s.decls) {
        if (d.k === 'decl') this.elabDecl({ ...d, kind: 'variable' }, sub);
        else this.elabItems([d], sub);
      }
      bc = { ...c, scope: sub };
    }
    const parts = s.stmts.map(x => this.st(x, bc));
    const name = s.name;
    if (parts.every(p => p.sync)) {
      const fs = parts.map(p => p.sync!);
      const run = fs.length === 1 ? fs[0] : () => { for (const f of fs) f(); };
      if (!name) return { sync: run };
      return { sync: () => { try { run(); } catch (x) { if (!(x instanceof DisableEx && x.name === name)) throw x; } } };
    }
    const gens = parts.map(p => p.sync ?? null);
    const asyncs = parts.map(p => (p.sync ? null : p.gen!));
    const runAll = function* (): Gen {
      for (let i = 0; i < gens.length; i++) {
        const sf = gens[i];
        if (sf) sf(); else yield* asyncs[i]!();
      }
    };
    if (!name) return { gen: runAll };
    return { gen: function* () { try { yield* runAll(); } catch (x) { if (!(x instanceof DisableEx && x.name === name)) throw x; } } };
  }

  assignStmt(s: Extract<Stmt, { k: 'assign' }>, c: Ctx): SC {
    const k = this.k;
    const nb = s.nb;
    const mem = this.memTarget(s.lhs, c);
    if (mem && !s.delay && !s.evctl) return this.memAssign(mem, s.rhs, c, nb ? 'nba' : 'now');
    const lc: Ctx = nb && c.lang === 'verilog' ? { ...c, driverMode: false } : { ...c, driverMode: false };
    const Lv = this.lv(s.lhs, lc);
    const R = final(this.ex(s.rhs, c), Lv.w);
    const self = this;
    if (s.evctl) {
      const wf = this.eventWait(s.evctl, c);
      if (nb) {
        // q <= @(ev) d: sample d now, update q in the NBA region after the event, without blocking the process
        return {
          sync: () => {
            const v = R(); const t = Lv.tg(); const w = wf();
            if (w.t === 'sens') k.onceEvent(w, () => self.write(t, v), true);
          },
        };
      }
      return { gen: function* () { const v = R(); yield wf(); self.write(Lv.tg(), v); } };
    }
    if (s.delay) {
      const D = this.delayFn(s.delay, c);
      if (nb) return { sync: () => { const v = R(); const t = Lv.tg(); k.schedule(k.now + D(), () => self.write(t, v), true); } };
      return { gen: function* () { const v = R(); yield { t: 'delay', d: D() }; self.write(Lv.tg(), v); } };
    }
    if (nb) return { sync: () => { const v = R(); const t = Lv.tg(); k.nba.push(() => self.write(t, v)); } };
    return { sync: () => self.write(Lv.tg(), R()) };
  }

  /** Whole-array target (VHDL `mem <= (others => ...)`): returns the memory if `lhs` names one. */
  memTarget(lhs: Expr, c: Ctx): Memory | null {
    if (lhs.k !== 'id') return null;
    const sym = this.lookupName(c.scope, lhs.name);
    return sym?.k === 'mem' ? sym.mem : null;
  }

  /** Compile a value for every word of `mem`: an aggregate or another array of the same shape. */
  memValues(mem: Memory, rhs: Expr, c: Ctx): () => Vec[] {
    const n = mem.words.length;
    const fix = (f: Ev) => () => resize(f(), mem.w).withSign(mem.signed);
    if (rhs.k === 'agg') {
      const others = rhs.others ? fix(final(this.ex(rhs.others, c), mem.w)) : null;
      const per: (Ev | null)[] = new Array(n).fill(others);
      rhs.elems.forEach((el, i) => {
        const idx = el.choice ? this.constInt(el.choice, c.scope) - mem.lo : i;
        if (idx < 0 || idx >= n) err(`Aggregate index out of range for '${mem.name}'.`, rhs.loc);
        per[idx] = fix(final(this.ex(el.value, c), mem.w));
      });
      if (per.some(p => !p)) err(`Aggregate does not cover every element of '${mem.name}' (add "others =>").`, rhs.loc);
      return () => per.map(p => p!());
    }
    const src = rhs.k === 'id' ? this.memTarget(rhs, c) : null;
    if (src) {
      if (src.words.length !== n || src.w !== mem.w) err(`Array size mismatch assigning '${src.name}' to '${mem.name}'.`, rhs.loc);
      c.reads?.add(src);
      return () => src.words.slice();
    }
    err(`Unsupported value for whole-array assignment to '${mem.name}'.`, rhs.loc);
  }

  memAssign(mem: Memory, rhs: Expr, c: Ctx, when: 'now' | 'nba', delay?: () => number): SC {
    const k = this.k;
    const V = this.memValues(mem, rhs, c);
    const apply = (vals: Vec[]) => vals.forEach((v, i) => k.memWrite(mem, i, v));
    return {
      sync: () => {
        const vals = V();
        const d = delay ? delay() : 0;
        if (d > 0) k.schedule(k.now + d, () => apply(vals), true);
        else if (when === 'nba') k.nba.push(() => apply(vals));
        else apply(vals);
      },
    };
  }

  vsigStmt(s: Extract<Stmt, { k: 'vsigassign' }>, c: Ctx): SC {
    const mem = this.memTarget(s.lhs, c);
    if (mem) {
      if (s.waves.length !== 1) err('Multiple waveform elements are not supported for array assignment.', s.loc);
      const w = s.waves[0];
      return this.memAssign(mem, w.value, c, c.deferred ? 'nba' : 'now', w.after ? this.delayFn(w.after, c) : undefined);
    }
    const k = this.k;
    const Lv = this.lv(s.lhs, c);
    const waves = s.waves.map(w => ({ R: final(this.ex(w.value, c), Lv.w), D: w.after ? this.delayFn(w.after, c) : null }));
    const self = this;
    const deferred = c.deferred;
    return {
      sync: () => {
        const t = Lv.tg();
        for (const w of waves) {
          const v = w.R();
          const d = w.D ? w.D() : 0;
          if (d > 0) k.schedule(k.now + d, () => self.write(t, v), true);
          else if (deferred) k.nba.push(() => self.write(t, v));
          else self.write(t, v);
        }
      },
    };
  }

  caseStmt(s: Extract<Stmt, { k: 'case' }>, c: Ctx): SC {
    const E = this.ex(s.expr, c);
    const items = s.items.map(it => ({ labels: it.labels?.map(l => this.caseLabel(l, c)) ?? null, body: this.st(it.body, c) }));
    let w = E.w;
    for (const it of items) for (const l of it.labels ?? []) if (l.kind === 'v') w = Math.max(w, l.n.w);
    const sgn = E.s && items.every(it => (it.labels ?? []).every(l => l.kind !== 'v' || l.n.s));
    const ef = E.mk(w, sgn);
    const kind = s.kind;
    type Lab = { kind: 'v'; f: Ev } | { kind: 'r'; lo: Ev; hi: Ev };
    const labs: (Lab[] | null)[] = items.map(it => it.labels?.map(l => (l.kind === 'v' ? { kind: 'v', f: l.n.mk(w, sgn) } : { kind: 'r', lo: l.lo.mk(w, sgn), hi: l.hi.mk(w, sgn) })) ?? null);
    const match = (v: Vec, l: Lab): boolean => {
      if (l.kind === 'r') return L.isTrue(L.ge(v, l.lo())) && L.isTrue(L.le(v, l.hi()));
      const x = l.f();
      if (kind === 'case') return v.a === x.a && v.b === x.b;
      return L.wildEq(v, x, kind);
    };
    const select = (): number => {
      const v = ef();
      let def = -1;
      for (let i = 0; i < labs.length; i++) {
        const ls = labs[i];
        if (!ls) { def = i; continue; }
        for (const l of ls) if (match(v, l)) return i;
      }
      return def;
    };
    if (items.every(it => it.body.sync)) {
      const bs = items.map(it => it.body.sync!);
      return { sync: () => { const i = select(); if (i >= 0) bs[i](); } };
    }
    const gs = items.map(it => asGen(it.body));
    return { gen: function* () { const i = select(); if (i >= 0) yield* gs[i](); } };
  }

  caseLabel(l: Expr, c: Ctx): { kind: 'v'; n: Node } | { kind: 'r'; lo: Node; hi: Node } {
    if (l.k === 'call' && (l.name === '__to' || l.name === '__downto')) {
      const a = this.ex(l.args[0], c), b = this.ex(l.args[1], c);
      return l.name === '__to' ? { kind: 'r', lo: a, hi: b } : { kind: 'r', lo: b, hi: a };
    }
    return { kind: 'v', n: this.ex(l, c) };
  }

  vforStmt(s: Extract<Stmt, { k: 'vfor' }>, c: Ctx): SC {
    const sub = new Scope('loop', c.scope.path, c.scope, null, c.scope.mod, 'block');
    const iv = this.newSignal(sub, s.v.toLowerCase(), VHDL_STD_TYPES.integer, fromInt(0, 32, true), true);
    let from: Ev, to: Ev, down = s.down;
    if (s.from.k === 'attr' && (s.from.attr === 'range' || s.from.attr === 'reverse_range')) {
      const hiN = this.attrNode({ ...s.from, attr: 'left' }, c), loN = this.attrNode({ ...s.from, attr: 'right' }, c);
      from = selfEv(hiN); to = selfEv(loN);
      const l = Number(hiN.cv!.toBigInt()), r = Number(loN.cv!.toBigInt());
      down = l > r;
      if (s.from.attr === 'reverse_range') { [from, to] = [to, from]; down = !down; }
    } else { from = selfEv(this.ex(s.from, c)); to = selfEv(this.ex(s.to, c)); }
    const bc: Ctx = { ...c, scope: sub };
    const B = this.st(s.body, bc);
    const label = s.label;
    const num = (v: Vec) => (v.known ? Number(v.toBigInt()) : 0);
    const handle = (x: unknown): 'break' | 'next' => {
      if (x instanceof LoopEx && (!x.label || x.label === label)) return x.next ? 'next' : 'break';
      throw x;
    };
    if (B.sync) {
      const b = B.sync;
      return {
        sync: () => {
          const f = num(from()), t = num(to());
          for (let i = f; down ? i >= t : i <= t; i += down ? -1 : 1) {
            iv.value = fromInt(i, 32, true);
            try { b(); } catch (x) { if (handle(x) === 'break') break; }
          }
        },
      };
    }
    const bg = asGen(B);
    return {
      gen: function* () {
        const f = num(from()), t = num(to());
        for (let i = f; down ? i >= t : i <= t; i += down ? -1 : 1) {
          iv.value = fromInt(i, 32, true);
          try { yield* bg(); } catch (x) { if (handle(x) === 'break') break; }
        }
      },
    };
  }

  eventWait(items: SensItem[], c: Ctx): () => Wait {
    const parts = items.map(it => {
      const rc: Ctx = { ...c, reads: new Set() };
      const n = this.ex(it.expr, rc);
      return { edge: it.edge, f: selfEv(n), sigs: [...rc.reads!], sig: n.sig };
    });
    const sigs = [...new Set(parts.flatMap(p => p.sigs))];
    // fast path: single plain signal with edge
    if (parts.length === 1 && parts[0].sig) {
      const { edge, sig } = parts[0];
      const s = sig!;
      if (edge === 'any') { const w: Wait = { t: 'sens', sigs: [s] }; return () => w; }
      const test = edge === 'pos' ? () => isPos(s.prev.bit(0), s.value.bit(0)) : () => isNeg(s.prev.bit(0), s.value.bit(0));
      const w: Wait = { t: 'sens', sigs: [s], test };
      return () => w;
    }
    return () => {
      const olds = parts.map(p => p.f());
      const test = () => {
        let hit = false;
        parts.forEach((p, i) => {
          const nv = p.f();
          const ov = olds[i];
          if (!(nv.a === ov.a && nv.b === ov.b)) {
            if (p.edge === 'any') hit = true;
            else if (p.edge === 'pos' ? isPos(ov.bit(0), nv.bit(0)) : isNeg(ov.bit(0), nv.bit(0))) hit = true;
            olds[i] = nv;
          }
        });
        return hit;
      };
      return { t: 'sens', sigs, test };
    };
  }

  vwaitStmt(s: Extract<Stmt, { k: 'vwait' }>, c: Ctx): SC {
    let sigs: (Signal | Memory)[] = [];
    if (s.on) {
      const rc: Ctx = { ...c, reads: new Set() };
      for (const e of s.on) this.ex(e, rc);
      sigs = [...rc.reads!];
    }
    let test: (() => boolean) | undefined;
    if (s.until) {
      const rc: Ctx = { ...c, reads: new Set() };
      const C = selfEv(this.ex(s.until, rc));
      if (!s.on) sigs = [...rc.reads!];
      test = () => L.truth(C()) === 1;
    }
    const D = s.for ? this.delayFn(s.for, c) : null;
    if (!sigs.length && !D) return { gen: function* () { yield { t: 'done' }; } };
    if (!sigs.length && D) return { gen: function* () { yield { t: 'delay', d: D() }; } };
    return { gen: function* () { yield { t: 'sens', sigs, test, timeout: D ? D() : undefined }; } };
  }

  // ---------------------------------------------------------- system tasks

  displayFn(args: (Expr | null)[], c: Ctx, defRadix = 'd'): { fn: () => string; nodes: Node[] } {
    const nodes: (Node | null)[] = args.map(a => (a ? this.ex(a, c) : null));
    const evs = nodes.map(n => (n ? selfEv(n) : null));
    const scopeName = c.scope.dotted;
    const k = this.k;
    const tsUnit = c.scope.mod.tsUnit;
    const timeFmt = (v: Vec) => (v.known ? String(Math.round((Number(v.a) * tsUnit) / k.resolution)) : 'x');
    const fctx = { scopeName, timeFmt };
    const fn = () => {
      let out = '';
      let i = 0;
      while (i < nodes.length) {
        const n = nodes[i];
        if (!n) { out += ' '; i++; continue; }
        if (n.str !== undefined && args[i]!.k === 'str') {
          const rest: FmtArg[] = [];
          for (let j = i + 1; j < nodes.length; j++) {
            const nj = nodes[j];
            rest.push(nj ? { v: evs[j]!(), isStr: nj.str !== undefined, real: nj.real } : { v: L.zeros(1) });
          }
          const [s, used] = expandFormat(n.str, rest, fctx);
          out += s;
          i += 1 + used;
          continue;
        }
        const v = evs[i]!();
        if (n.str !== undefined) out += L.toAscii(v);
        else if (n.enumNames && v.known && c.lang === 'vhdl') out += n.enumNames[Number(v.a)];
        else out += expandFormat(`%${defRadix}`, [{ v, real: n.real }], fctx)[0];
        i++;
      }
      return out;
    };
    return { fn, nodes: nodes.filter((x): x is Node => !!x) };
  }

  locStr(loc?: Loc) { return loc ? `${loc.file}(${loc.line})` : ''; }

  sysTask(s: Extract<Stmt, { k: 'sys' }>, c: Ctx): SC {
    const k = this.k;
    const host = k.host;
    const name = s.name;
    const scopePath = c.scope.path;
    const where = this.locStr(s.loc);
    const timeLine = () => `   Time: ${fmtTime(k.now, k.resolution)}  Iteration: ${k.deltaCount}  Instance: ${scopePath}`;
    switch (name) {
      case '$display': case '$displayb': case '$displayh': case '$displayo': case '$write': case '$writeb': case '$writeh': case '$writeo': {
        const radix = { b: 'b', h: 'h', o: 'o' }[name.slice(-1)] ?? 'd';
        const { fn } = this.displayFn(s.args, c, radix);
        const nl = name.startsWith('$display');
        if (nl) return { sync: () => host.print(fn()) };
        return { sync: () => (host as any).write ? (host as any).write(fn()) : host.print(fn()) };
      }
      case '$fdisplay': case '$fwrite': {
        const { fn } = this.displayFn(s.args.slice(1), c);
        return { sync: () => host.print(fn()) };
      }
      case '$strobe': {
        const { fn } = this.displayFn(s.args, c);
        return { sync: () => k.postponed.push(() => host.print(fn())) };
      }
      case '$monitor': {
        const { fn, nodes } = this.displayFn(s.args, c);
        const watch = nodes.filter(n => !n.isMonTime && n.str === undefined).map(n => selfEv(n));
        return {
          sync: () => {
            let last: Vec[] | null = null;
            k.monitors = [() => {
              const cur = watch.map(f => f());
              if (last && cur.every((v, i) => v.equals(last![i]))) return;
              last = cur;
              host.print(fn());
            }];
          },
        };
      }
      case '$monitoron': return { sync: () => { k.monitorOn = true; } };
      case '$monitoroff': return { sync: () => { k.monitorOn = false; } };
      case '$finish': return { sync: () => { host.print(`** Note: $finish    : ${where}`); host.print(timeLine()); throw new FinishEx(); } };
      case '$stop': {
        const lineNo = s.loc?.line;
        return { gen: function* () { host.print(`** Note: $stop    : ${where}`); host.print(timeLine()); k.lastStopInfo = `Break in Module ${c.scope.mod.unit.name} at ${s.loc?.file} line ${lineNo}`; yield { t: 'stop' }; } };
      }
      case '$error': case '$warning': case '$info': case '$fatal': {
        const args = name === '$fatal' && s.args.length && s.args[0]?.k === 'num' ? s.args.slice(1) : s.args;
        const { fn } = this.displayFn(args, c);
        const sev = { $error: 'Error', $warning: 'Warning', $info: 'Info', $fatal: 'Fatal' }[name];
        return {
          sync: () => {
            host.print(`** ${sev}: ${fn()}`);
            host.print(`   Time: ${fmtTime(k.now, k.resolution)}  Scope: ${c.scope.dotted} File: ${s.loc?.file} Line: ${s.loc?.line}`);
            if (name === '$fatal') throw new FinishEx(1);
          },
        };
      }
      case '$readmemh': case '$readmemb': {
        const fileArg = s.args[0];
        const memArg = s.args[1];
        if (!fileArg || !memArg || memArg.k !== 'id') err(`${name}: expected (file, memory)`, s.loc);
        const sym = this.lookupName(c.scope, memArg.name);
        if (sym?.k !== 'mem') err(`${name}: '${memArg.name}' is not a memory`, s.loc);
        const mem = sym.mem;
        const fileN = this.ex(fileArg, c);
        const ff = selfEv(fileN);
        const startE = s.args[2] ? selfEv(this.ex(s.args[2], c)) : null;
        const radix = name === '$readmemh' ? 16 : 2;
        return {
          sync: () => {
            const fname = fileN.str ?? L.toAscii(ff());
            const text = host.readFile?.(fname);
            if (text === undefined) { host.print(`** Warning: (vsim-PLI-3406) ${name} : Unable to open file '${fname}' for reading. ${where}`); return; }
            let addr = startE ? Number(startE().a) : mem.lo;
            const clean = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
            for (const tok of clean.split(/\s+/).filter(Boolean)) {
              if (tok.startsWith('@')) { addr = parseInt(tok.slice(1), 16); continue; }
              const i = mem.index(addr++);
              if (i < 0) continue;
              const bitsPer = radix === 16 ? 4 : 1;
              const digits = tok.replace(/_/g, '').toLowerCase();
              let a = 0n, b = 0n;
              for (const ch of digits) {
                a <<= BigInt(bitsPer); b <<= BigInt(bitsPer);
                const m = BigInt((1 << bitsPer) - 1);
                if (ch === 'x') { a |= m; b |= m; } else if (ch === 'z') { b |= m; } else a |= BigInt(parseInt(ch, radix) || 0);
              }
              k.memWrite(mem, i, resize(new Vec(digits.length * bitsPer, a, b), mem.w).withSign(mem.signed));
            }
          },
        };
      }
      case '$dumpfile': {
        const a = s.args[0];
        if (!a) return { sync: () => {} };
        const n = this.ex(a, c);
        const f = selfEv(n);
        return { sync: () => { k.dumpFile = n.str ?? L.toAscii(f()); } };
      }
      case '$dumpvars': {
        // $dumpvars; | $dumpvars(levels, scope_or_signal, ...)
        const levels = s.args[0] ? this.constInt(s.args[0], c.scope) : 0;
        const paths: string[] = [];
        for (const a of s.args.slice(1)) {
          if (!a || a.k !== 'id') err('$dumpvars: expected a module instance or signal name', s.loc);
          const sym = this.lookupName(c.scope, a.name) ?? (this.root && a.name === this.root.name ? { k: 'scope', s: this.root } as Sym : undefined);
          if (sym?.k === 'scope') paths.push(sym.s.path);
          else if (sym?.k === 'sig') paths.push(sym.sig.path);
          else err(`$dumpvars: cannot find '${a.name}'`, s.loc);
        }
        return { sync: () => { const items = paths.length ? paths.map(p => ({ path: p, levels })) : [{ path: '', levels: 0 }]; k.dumpItems = [...(k.dumpItems ?? []), ...items]; } };
      }
      case '$dumpon': case '$dumpoff': case '$dumpall': case '$dumpflush': case '$fclose': case '$timeformat': case '$printtimescale': case '$fflush':
        return { sync: () => {} };
      case '$random': case '$urandom': return { sync: () => { k.random(); } };
    }
    err(`(vlog-2163) Unknown system task '${name}'.`, s.loc);
  }

  reportStmt(s: Extract<Stmt, { k: 'report' }>, c: Ctx): SC {
    const k = this.k;
    const host = k.host;
    const C = s.cond ? selfEv(this.ex(s.cond, c)) : null;
    const msgN = s.msg ? this.ex(s.msg, { ...c, strMode: true }) : null;
    const M = msgN ? selfEv(msgN) : null;
    let sevIdx = s.cond ? 2 : 0;
    let sevF: Ev | null = null;
    if (s.severity) {
      if (s.severity.k === 'id') {
        const i = ['note', 'warning', 'error', 'failure'].indexOf(s.severity.name.toLowerCase());
        if (i >= 0) sevIdx = i;
      } else sevF = selfEv(this.ex(s.severity, c));
    }
    const names = ['Note', 'Warning', 'Error', 'Failure'];
    const scopePath = c.scope.path;
    const pname = c.proc?.name ?? '';
    const where = s.loc;
    return {
      sync: () => {
        if (C && L.truth(C()) === 1) return;
        const sev = sevF ? Number(sevF().a) & 3 : sevIdx;
        const msg = M ? (msgN!.str !== undefined && msgN!.cv ? msgN!.str : L.toAscii(M())) : 'Assertion violation.';
        host.print(`** ${names[sev]}: ${msg}`);
        host.print(`   Time: ${fmtTime(k.now, k.resolution)}  Iteration: ${k.deltaCount}  Process: ${scopePath}/${pname} File: ${where?.file}`);
        if (sev === 3) {
          k.lastStopInfo = `Break in Process ${pname} at ${where?.file} line ${where?.line}`;
          k.stopRequested = true;
          throw new StopProcEx();
        }
      },
    };
  }

  callStmt(s: Extract<Stmt, { k: 'call' }>, c: Ctx): SC {
    const name = c.lang === 'vhdl' ? s.name.toLowerCase() : s.name;
    const k = this.k;
    const host = k.host;
    if (c.lang === 'vhdl' && /(^|\.)(stop|finish)$/.test(name) && !this.lookupName(c.scope, name)) {
      const isStop = name.endsWith('stop');
      const where = s.loc;
      const pname = c.proc?.name ?? '';
      return {
        gen: function* () {
          host.print(`** Note: ${isStop ? 'stop' : 'finish'}`);
          host.print(`   Time: ${fmtTime(k.now, k.resolution)}  Iteration: ${k.deltaCount}  Instance: ${c.scope.path}`);
          if (!isStop) throw new FinishEx();
          k.lastStopInfo = `Break in Process ${pname} at ${where?.file} line ${where?.line}`;
          yield { t: 'stop' };
        },
      };
    }
    if (name.startsWith('$')) return this.sysTask({ k: 'sys', name, args: s.args, loc: s.loc }, c);
    const sym = this.lookupName(c.scope, name);
    if (!sym || sym.k !== 'func') err(c.lang === 'vhdl' ? `(vcom-1136) Unknown identifier "${s.name}".` : `(vlog-2164) Task '${s.name}' not found.`, s.loc);
    const f = sym.f;
    if (!f.isTask) {
      // function called as statement (void function / discarded result)
      const n = this.funcCallVoid(sym, s.args, c, s.loc, s.named);
      return { sync: n };
    }
    if (c.depth > 16) err(`Task '${f.name}' recursion too deep (tasks are inlined per call site).`, s.loc);
    const args = this.orderArgs(f, s.args, s.named, s.loc);
    if (args.length !== f.args.length) err(`Wrong number of arguments in call to task '${f.name}'.`, s.loc);
    const ts = new Scope(f.name, sym.scope.path, sym.scope, null, sym.scope.mod, 'func');
    const ins: { sig: Signal; ev: Ev }[] = [];
    const outs: { sig: Signal; lv: LNode }[] = [];
    f.args.forEach((a, i) => {
      const actual = args[i];
      if (a.vsig) {
        // VHDL signal-class parameter: alias the actual signal
        const base = actual.k === 'id' ? this.lookupName(c.scope, actual.name) : undefined;
        if (base?.k !== 'sig') err(`Actual for signal parameter '${a.name}' must be a signal.`, s.loc);
        ts.syms.set(a.name, base);
        return;
      }
      let t = this.resolveType(a.type, ts, s.loc);
      const an = this.ex(actual, c);
      if (t.w === 0) t = { ...t, w: an.w, msb: an.w - 1, lsb: 0 };
      const v = this.newSignal(ts, a.name, t, undefined, true);
      if (a.dir !== 'output') ins.push({ sig: v, ev: final(an, v.w) });
      if (a.dir !== 'input') outs.push({ sig: v, lv: this.lv(actual, { ...c, driverMode: c.lang === 'vhdl' ? false : false }) });
    });
    for (const d of f.decls) {
      if (d.k === 'decl') this.elabDecl({ ...d, kind: 'variable' }, ts);
      else this.elabItems([d], ts);
    }
    const tc: Ctx = { ...c, scope: ts, depth: c.depth + 1, func: undefined };
    const body = this.st(f.body, tc);
    const self = this;
    const pre = () => { for (const a of ins) a.sig.value = a.ev().withSign(a.sig.signed); };
    const post = () => { for (const o of outs) self.write(o.lv.tg(), o.sig.value); };
    const isTaskEnd = (x: unknown) => x instanceof DisableEx && (x.name === '__task__' || x.name === f.name);
    if (body.sync) {
      const b = body.sync;
      return { sync: () => { pre(); try { b(); } catch (x) { if (!isTaskEnd(x)) throw x; } post(); } };
    }
    const bg = body.gen!;
    return { gen: function* () { pre(); try { yield* bg(); } catch (x) { if (!isTaskEnd(x)) throw x; } post(); } };
  }

  funcCallVoid(sym: Extract<Sym, { k: 'func' }>, args: Expr[], c: Ctx, loc?: Loc, named?: (string | null)[]): () => void {
    const f = sym.f;
    args = this.orderArgs(f, args, named, loc);
    const argNodes = args.map(a => this.ex(a, c));
    const cf = this.getCFunc(sym, argNodes, loc);
    const argEvs = argNodes.map((n, i) => final(n, cf.args[i].w));
    // output args of VHDL procedures / SV functions
    const outs: { sig: Signal; lv: LNode }[] = [];
    f.args.forEach((a, i) => { if (a.dir !== 'input' && args[i]) outs.push({ sig: cf.args[i], lv: this.lv(args[i], c) }); });
    return () => {
      const vals = argEvs.map(f => f());
      vals.forEach((v, i) => { cf.args[i].value = v; });
      try { cf.body(); } catch (x) { if (x !== RET) throw x; }
      for (const o of outs) this.write(o.lv.tg(), o.sig.value);
    };
  }
}

// ---------------------------------------------------------------- helpers

function asGen(s: SC): () => Gen {
  if (s.gen) return s.gen;
  const f = s.sync!;
  return function* () { f(); };
}

function isPos(o: string, n: string) { return (o === '0' && n !== '0') || ((o === 'x' || o === 'z') && n === '1'); }
function isNeg(o: string, n: string) { return (o === '1' && n !== '1') || ((o === 'x' || o === 'z') && n === '0'); }

function rotate(v: Vec, n: Vec, left: boolean): Vec {
  if (!n.known || v.w === 0) return allX(v.w);
  let k = Number(n.a) % v.w;
  if (!left) k = (v.w - k) % v.w;
  if (k === 0) return v;
  return L.concat([slice(v, 0, v.w - k), slice(v, v.w - k, k)]).withSign(v.signed);
}

function loopGuard(loc?: Loc): never {
  throw new CompileError('Loop iteration limit exceeded (possible infinite loop).', loc);
}

export { ONE32 };
