// Verilog (IEEE 1364 subset + common SystemVerilog) recursive-descent parser.
import { CompileError, type Expr, type Item, type Loc, type ParamDecl, type PortDecl, type SensItem, type Stmt, type TypeSpec, type Unit, type FuncDecl, type DeclName } from '../ast';
import { lexVerilog, parseTimescale, preprocess, type Macro, type Token } from './lexer';
import { fromBits } from '../logic';

export interface VerilogParseOptions {
  defines?: Map<string, Macro>;
  include?: (name: string) => string | undefined;
  defaultTimescale?: { unit: number; prec: number };
}

export function parseVerilog(src: string, file: string, opts: VerilogParseOptions = {}): Unit[] {
  const text = preprocess(src, file, { defines: opts.defines, include: opts.include });
  const toks = lexVerilog(text, file);
  return new VParser(toks, file, src, opts.defaultTimescale).parseSource();
}

const NET_TYPES = new Set(['wire', 'tri', 'tri0', 'tri1', 'wand', 'wor', 'supply0', 'supply1']);
const VAR_TYPES = new Set(['event', 'reg', 'logic', 'bit', 'integer', 'int', 'byte', 'shortint', 'longint', 'time', 'real', 'realtime', 'genvar', 'string']);
const GATES = new Set(['and', 'or', 'nand', 'nor', 'xor', 'xnor', 'not', 'buf']);

const BIN_PREC: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '^~': 4, '~^': 4, '&': 5,
  '==': 6, '!=': 6, '===': 6, '!==': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7,
  '<<': 8, '>>': 8, '<<<': 8, '>>>': 8,
  '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 11,
};

class VParser {
  pos = 0;
  timescale?: { unit: number; prec: number };
  typedefs = new Map<string, TypeSpec>();

  constructor(private toks: Token[], private file: string, private src: string, defTs?: { unit: number; prec: number }) {
    this.timescale = defTs;
  }

  // ---------- token helpers ----------
  get tok() { return this.toks[this.pos]; }
  peek(o = 1) { return this.toks[Math.min(this.pos + o, this.toks.length - 1)]; }
  loc(): Loc { return this.tok.loc; }
  is(v: string) { const t = this.tok; return (t.t === 'op' || t.t === 'id') && t.v === v; }
  isOp(v: string) { return this.tok.t === 'op' && this.tok.v === v; }
  accept(v: string) { if (this.is(v)) { this.pos++; return true; } return false; }
  expect(v: string): Token {
    if (!this.is(v)) this.err(`near "${this.tok.v}": syntax error, expecting '${v}'`);
    return this.toks[this.pos++];
  }
  err(msg: string, loc = this.loc()): never { throw new CompileError(msg, loc); }
  ident(): string {
    const t = this.tok;
    if (t.t !== 'id') this.err(`near "${t.v}": syntax error, expecting identifier`);
    this.pos++;
    return t.v;
  }

  // ---------- source ----------
  parseSource(): Unit[] {
    const units: Unit[] = [];
    while (this.tok.t !== 'eof') {
      if (this.tok.t === 'dir') {
        this.timescale = parseTimescale(this.tok.v.slice('timescale '.length), this.loc());
        this.pos++; continue;
      }
      if (this.is('module') || this.is('macromodule')) { units.push(this.parseModule()); continue; }
      if (this.is('typedef')) { this.globalItems.push(this.parseTypedef()); continue; }
      if (this.accept(';')) continue;
      this.err(`near "${this.tok.v}": syntax error, unexpected ${this.tok.v}`);
    }
    return units;
  }

  parseModule(): Unit {
    const startTok = this.tok;
    this.pos++;
    const name = this.ident();
    const unit: Unit = { kind: 'module', lang: 'verilog', name, file: this.file, line: startTok.loc.line, params: [], ports: [], items: [...this.globalItems], timescale: this.timescale };
    const savedTypedefs = new Map(this.typedefs);
    // parameter port list
    if (this.accept('#')) {
      this.expect('(');
      if (!this.isOp(')')) {
        do {
          this.accept('parameter'); this.accept('localparam');
          const type = this.maybeType();
          const pname = this.ident();
          this.expect('=');
          unit.params.push({ name: pname, value: this.expr(), local: false, type: type ?? undefined, loc: this.loc() });
        } while (this.accept(',') && !this.isOp(')'));
      }
      this.expect(')');
    }
    // port list
    const headerNames: string[] = [];
    if (this.accept('(')) {
      if (!this.isOp(')')) {
        let lastDir: PortDecl['dir'] | null = null;
        let lastType: TypeSpec | null = null;
        let lastVar = false;
        do {
          if (this.is('input') || this.is('output') || this.is('inout')) {
            lastDir = this.tok.v as PortDecl['dir']; this.pos++;
            let isVar = false;
            if (this.tok.t === 'id' && (NET_TYPES.has(this.tok.v) || VAR_TYPES.has(this.tok.v))) {
              isVar = !NET_TYPES.has(this.tok.v);
            }
            const t = this.parseDataType();
            lastType = t; lastVar = isVar;
            const pname = this.ident();
            const init = this.accept('=') ? this.expr() : undefined;
            unit.ports.push({ name: pname, dir: lastDir, type: t, isVar, init, loc: this.loc() });
          } else if (lastDir && this.tok.t === 'id' && this.peekNotTypeStart()) {
            const pname = this.ident();
            unit.ports.push({ name: pname, dir: lastDir, type: lastType!, isVar: lastVar, loc: this.loc() });
          } else {
            headerNames.push(this.ident());
          }
        } while (this.accept(','));
      }
      this.expect(')');
    }
    this.expect(';');
    const nonAnsi = new Map<string, PortDecl>();
    for (const h of headerNames) nonAnsi.set(h, { name: h, dir: 'input', type: { base: 'logic' }, loc: this.loc() });
    while (!this.is('endmodule')) {
      if (this.tok.t === 'eof') this.err('Unexpected end of file, expecting endmodule');
      this.parseModuleItem(unit.items, unit, nonAnsi);
    }
    this.pos++;
    if (this.accept(':')) this.ident();
    if (headerNames.length) unit.ports = headerNames.map(h => nonAnsi.get(h)!);
    unit.source = this.src;
    this.typedefs = savedTypedefs;
    return unit;
  }

  peekNotTypeStart(): boolean {
    const t = this.tok;
    return !(NET_TYPES.has(t.v) || VAR_TYPES.has(t.v) || t.v === 'signed' || this.typedefs.has(t.v));
  }

  /** Parses optional net/var keyword, signedness and packed range. */
  parseDataType(): TypeSpec {
    const t: TypeSpec = { base: 'logic' };
    if (this.tok.t === 'id') {
      const v = this.tok.v;
      if (NET_TYPES.has(v) || v === 'reg' || v === 'logic' || v === 'bit' || v === 'event') { this.pos++; if (this.accept('signed')) t.signed = true; }
      else if (v === 'integer' || v === 'int') { this.pos++; t.base = 'integer'; t.width = 32; t.signed = true; }
      else if (v === 'byte') { this.pos++; t.base = 'integer'; t.width = 8; t.signed = true; }
      else if (v === 'shortint') { this.pos++; t.base = 'integer'; t.width = 16; t.signed = true; }
      else if (v === 'longint' || v === 'time') { this.pos++; t.base = 'integer'; t.width = 64; t.signed = v !== 'time'; }
      else if (v === 'real' || v === 'realtime') { this.pos++; t.base = 'real'; t.width = 64; }
      else if (v === 'string') { this.pos++; t.base = 'string'; }
      else if (this.typedefs.has(v)) { this.pos++; return { ...this.typedefs.get(v)! }; }
    }
    if (this.accept('signed')) t.signed = true;
    if (this.accept('unsigned')) t.signed = false;
    if (this.isOp('[')) { this.pos++; const msb = this.expr(); this.expect(':'); const lsb = this.expr(); this.expect(']'); t.range = [msb, lsb]; }
    return t;
  }

  maybeType(): TypeSpec | null {
    const v = this.tok.v;
    if (this.tok.t === 'id' && (VAR_TYPES.has(v) || NET_TYPES.has(v) || v === 'signed' || this.typedefs.has(v))) return this.parseDataType();
    if (this.isOp('[')) return this.parseDataType();
    return null;
  }

  globalItems: Item[] = [];

  parseTypedef(): Item {
    const loc = this.loc();
    this.expect('typedef');
    let t: TypeSpec;
    if (this.accept('enum')) {
      let base: TypeSpec = { base: 'logic' };
      if (!this.isOp('{')) base = this.parseDataType();
      this.expect('{');
      const names: string[] = [];
      do { names.push(this.ident()); if (this.accept('=')) this.expr(); } while (this.accept(','));
      this.expect('}');
      t = { ...base, base: 'enum', enumNames: names };
    } else {
      t = this.parseDataType();
    }
    const name = this.ident();
    this.expect(';');
    this.typedefs.set(name, t);
    return { k: 'typedef', name, type: t, loc };
  }

  parseModuleItem(items: Item[], unit: Unit | null, nonAnsi: Map<string, PortDecl>) {
    const loc = this.loc();
    const t = this.tok;
    if (t.t === 'dir') { this.pos++; return; }
    if (this.accept(';')) return;
    const v = t.v;
    if (t.t !== 'id') this.err(`near "${t.v}": syntax error, unexpected ${t.v}`);
    switch (v) {
      case 'input': case 'output': case 'inout': {
        this.pos++;
        const isVar = this.tok.t === 'id' && VAR_TYPES.has(this.tok.v);
        const type = this.parseDataType();
        do {
          const name = this.ident();
          const p = nonAnsi.get(name);
          if (!p) this.err(`Port '${name}' is not in the port list`);
          p.dir = v as PortDecl['dir']; p.type = type; p.isVar = p.isVar || isVar; p.loc = loc;
          if (this.accept('=')) p.init = this.expr();
        } while (this.accept(','));
        this.expect(';');
        return;
      }
      case 'parameter': case 'localparam': {
        this.pos++;
        const type = this.maybeType();
        do {
          const name = this.ident();
          this.expect('=');
          const p: ParamDecl = { name, value: this.expr(), local: v === 'localparam', type: type ?? undefined, loc };
          items.push({ k: 'param', ...p });
        } while (this.accept(','));
        this.expect(';');
        return;
      }
      case 'assign': {
        this.pos++;
        const delay = this.accept('#') ? this.delayValue() : undefined;
        do {
          const lhs = this.lvalue();
          this.expect('=');
          items.push({ k: 'cassign', lhs, rhs: this.expr(), delay, loc });
        } while (this.accept(','));
        this.expect(';');
        return;
      }
      case 'always': case 'always_ff': case 'always_comb': case 'always_latch': case 'initial': {
        this.pos++;
        const body = this.stmt();
        items.push({ k: 'process', kind: v as any, body, loc });
        return;
      }
      case 'function': case 'task': items.push(this.parseFunc(v === 'task')); return;
      case 'generate': this.pos++; while (!this.accept('endgenerate')) this.parseModuleItem(items, unit, nonAnsi); return;
      case 'genvar': this.pos++; do this.ident(); while (this.accept(',')); this.expect(';'); return;
      case 'for': items.push(this.parseGenFor()); return;
      case 'if': items.push(this.parseGenIf()); return;
      case 'begin': {
        this.pos++;
        if (this.accept(':')) this.ident();
        while (!this.accept('end')) this.parseModuleItem(items, unit, nonAnsi);
        if (this.accept(':')) this.ident();
        return;
      }
      case 'typedef': items.push(this.parseTypedef()); return;
      case 'specify': while (!this.accept('endspecify')) this.pos++; return;
      case 'defparam': this.err('defparam is not supported; use #() parameter overrides');
    }
    if (NET_TYPES.has(v) || VAR_TYPES.has(v) || this.typedefs.has(v)) {
      const isNet = NET_TYPES.has(v);
      this.pos++;
      if (isNet && this.is('reg')) this.pos++;
      this.pos--;
      const type = v === 'genvar' ? (this.pos++, { base: 'integer', width: 32, signed: true } as TypeSpec) : this.parseDataType();
      let delay: Expr | undefined;
      if (this.accept('#')) delay = this.delayValue();
      const names: DeclName[] = [];
      do {
        const nloc = this.loc();
        const name = this.ident();
        const dn: DeclName = { name };
        while (this.isOp('[')) {
          this.pos++;
          const a = this.expr();
          // [N] is shorthand for [0:N-1]
          const dim: [Expr, Expr] = this.accept(':') ? [a, this.expr()] : [num(0), { k: 'bin', op: '-', l: a, r: num(1) }];
          this.expect(']');
          (dn.unpacked ??= []).push(dim);
        }
        if (this.accept('=')) {
          const init = this.expr();
          if (isNet) items.push({ k: 'cassign', lhs: { k: 'id', name, loc: nloc }, rhs: init, delay, loc: nloc });
          else dn.init = init;
        }
        // named events are modelled as a 1-bit variable toggled by "->"; start known so a toggle is a change
        if (v === 'event') dn.init = num(0);
        names.push(dn);
      } while (this.accept(','));
      this.expect(';');
      items.push({ k: 'decl', kind: isNet ? 'net' : 'var', type, names, loc });
      if (v === 'supply0' || v === 'supply1') for (const dn of names) items.push({ k: 'cassign', lhs: { k: 'id', name: dn.name }, rhs: { k: 'num', v: fromBits(v === 'supply1' ? '1' : '0') }, loc });
      return;
    }
    if (GATES.has(v)) { this.parseGate(items); return; }
    // module instantiation
    if (this.peek().t === 'id' || (this.peek().t === 'op' && this.peek().v === '#')) { this.parseInstances(items); return; }
    this.err(`near "${v}": syntax error, unexpected ${v}`);
  }

  parseGate(items: Item[]) {
    const g = this.ident();
    if (this.accept('#')) this.delayValue();
    do {
      if (this.tok.t === 'id') this.ident();
      const loc = this.loc();
      this.expect('(');
      const args: Expr[] = [];
      do args.push(this.expr()); while (this.accept(','));
      this.expect(')');
      if (args.length < 2) this.err(`gate '${g}' needs at least 2 terminals`);
      const out = args[0];
      let rhs: Expr;
      if (g === 'not' || g === 'buf') rhs = g === 'not' ? { k: 'un', op: '~', e: args[1] } : args[1];
      else {
        const op = { and: '&', or: '|', xor: '^', nand: '&', nor: '|', xnor: '^' }[g]!;
        rhs = args.slice(1).reduce((l, r) => ({ k: 'bin', op, l, r }));
        if (g === 'nand' || g === 'nor' || g === 'xnor') rhs = { k: 'un', op: '~', e: rhs };
      }
      items.push({ k: 'cassign', lhs: out, rhs, loc });
    } while (this.accept(','));
    this.expect(';');
  }

  parseInstances(items: Item[]) {
    const loc = this.loc();
    const module = this.ident();
    const params: { name?: string; value: Expr }[] = [];
    if (this.accept('#')) {
      if (this.accept('(')) {
        if (!this.isOp(')')) {
          do {
            if (this.accept('.')) { const n = this.ident(); this.expect('('); const val = this.expr(); this.expect(')'); params.push({ name: n, value: val }); }
            else params.push({ value: this.expr() });
          } while (this.accept(','));
        }
        this.expect(')');
      } else params.push({ value: this.primary() });
    }
    do {
      const iloc = this.loc();
      const name = this.ident();
      if (this.isOp('[')) this.err('Arrays of instances are not supported');
      this.expect('(');
      const conns: { name?: string; expr: Expr | null }[] = [];
      if (!this.isOp(')')) {
        do {
          if (this.accept('.*')) { conns.push({ name: '*', expr: null }); continue; }
          if (this.accept('.')) {
            const n = this.ident();
            if (this.accept('(')) {
              const e = this.isOp(')') ? null : this.expr();
              this.expect(')');
              conns.push({ name: n, expr: e });
            } else conns.push({ name: n, expr: { k: 'id', name: n } });
          } else if (this.isOp(',') || this.isOp(')')) conns.push({ expr: null });
          else conns.push({ expr: this.expr() });
        } while (this.accept(','));
      }
      this.expect(')');
      items.push({ k: 'inst', module, name, params, conns, loc: iloc ?? loc });
    } while (this.accept(','));
    this.expect(';');
  }

  parseGenFor(): Item {
    const loc = this.loc();
    this.expect('for'); this.expect('(');
    this.accept('genvar');
    const v = this.ident(); this.expect('=');
    const init = this.expr(); this.expect(';');
    const cond = this.expr(); this.expect(';');
    const sv = this.ident();
    if (sv !== v) this.err('generate for step must assign the genvar');
    let stepExpr: Expr;
    if (this.accept('++')) stepExpr = { k: 'bin', op: '+', l: { k: 'id', name: v }, r: num(1) };
    else if (this.accept('--')) stepExpr = { k: 'bin', op: '-', l: { k: 'id', name: v }, r: num(1) };
    else if (this.isOp('+=') || this.isOp('-=')) { const op = this.tok.v[0]; this.pos++; stepExpr = { k: 'bin', op, l: { k: 'id', name: v }, r: this.expr() }; }
    else { this.expect('='); stepExpr = this.expr(); }
    this.expect(')');
    const items: Item[] = [];
    let name: string | undefined;
    if (this.accept('begin')) {
      if (this.accept(':')) name = this.ident();
      while (!this.accept('end')) this.parseModuleItem(items, null, new Map());
      if (this.accept(':')) this.ident();
    } else this.parseModuleItem(items, null, new Map());
    return { k: 'genfor', v, init, cond, stepExpr, name, items, loc };
  }

  parseGenIf(): Item {
    const loc = this.loc();
    this.expect('if'); this.expect('(');
    const c = this.expr(); this.expect(')');
    const block = (): { items: Item[]; name?: string } => {
      const items: Item[] = []; let name: string | undefined;
      if (this.accept('begin')) {
        if (this.accept(':')) name = this.ident();
        while (!this.accept('end')) this.parseModuleItem(items, null, new Map());
        if (this.accept(':')) this.ident();
      } else this.parseModuleItem(items, null, new Map());
      return { items, name };
    };
    const t = block();
    let e: Item[] | undefined;
    if (this.accept('else')) {
      if (this.is('if')) e = [this.parseGenIf()];
      else e = block().items;
    }
    return { k: 'genif', c, then: t.items, else: e, name: t.name, loc };
  }

  parseFunc(isTask: boolean): FuncDecl {
    const loc = this.loc();
    this.pos++;
    this.accept('automatic'); this.accept('static');
    let ret: TypeSpec | undefined;
    if (!isTask) {
      if (this.is('void')) { this.pos++; ret = undefined; }
      else {
        const nameNext = this.tok.t === 'id' && (this.peek().v === ';' || this.peek().v === '(') && !VAR_TYPES.has(this.tok.v) && !this.typedefs.has(this.tok.v);
        ret = nameNext ? { base: 'logic' } : this.parseDataType();
      }
    }
    const name = this.ident();
    const args: FuncDecl['args'] = [];
    const decls: Item[] = [];
    if (this.accept('(')) {
      let dir: 'input' | 'output' | 'inout' = 'input';
      let type: TypeSpec = { base: 'logic' };
      if (!this.isOp(')')) {
        do {
          if (this.is('input') || this.is('output') || this.is('inout')) { dir = this.tok.v as any; this.pos++; type = this.parseDataType(); }
          else if (!this.peekNotTypeStart() || this.isOp('[')) type = this.parseDataType();
          args.push({ name: this.ident(), dir, type });
        } while (this.accept(','));
      }
      this.expect(')');
    }
    this.expect(';');
    const stmts: Stmt[] = [];
    const end = isTask ? 'endtask' : 'endfunction';
    while (!this.is(end)) {
      const v = this.tok.v;
      if (v === 'input' || v === 'output' || v === 'inout') {
        this.pos++;
        const type = this.parseDataType();
        do args.push({ name: this.ident(), dir: v as any, type }); while (this.accept(','));
        this.expect(';');
      } else if (VAR_TYPES.has(v) || this.typedefs.has(v) || v === 'parameter' || v === 'localparam') {
        this.parseModuleItem(decls, null, new Map());
      } else stmts.push(this.stmt());
    }
    this.pos++;
    if (this.accept(':')) this.ident();
    const body: Stmt = stmts.length === 1 ? stmts[0] : { k: 'block', stmts };
    return { k: 'func', name, isTask, ret, args, decls, body, loc };
  }

  // ---------- statements ----------
  stmt(): Stmt {
    const loc = this.loc();
    const t = this.tok;
    if (this.accept(';')) return { k: 'null', loc };
    if (t.t === 'sys') {
      this.pos++;
      const args: (Expr | null)[] = [];
      if (this.accept('(')) {
        if (!this.isOp(')')) {
          do {
            if (this.isOp(',') || this.isOp(')')) args.push(null);
            else args.push(this.expr());
          } while (this.accept(','));
        }
        this.expect(')');
      }
      this.expect(';');
      return { k: 'sys', name: t.v, args, loc };
    }
    if (t.t === 'op') {
      if (t.v === '#') {
        this.pos++;
        const d = this.delayValue();
        if (this.accept(';')) return { k: 'delay', d, loc };
        return { k: 'delay', d, body: this.stmt(), loc };
      }
      if (t.v === '@') {
        this.pos++;
        const items = this.eventControl();
        if (this.accept(';')) return { k: 'event', items, loc };
        return { k: 'event', items, body: this.stmt(), loc };
      }
      if (t.v === '{') return this.assignStmt(loc, true);
      if (t.v === '->') {
        this.pos++;
        const ev: Expr = { k: 'id', name: this.hierName(), loc };
        this.expect(';');
        return { k: 'assign', lhs: ev, rhs: { k: 'un', op: '~', e: ev }, nb: false, loc };
      }
      this.err(`near "${t.v}": syntax error, unexpected ${t.v}`);
    }
    switch (t.v) {
      case 'begin': case 'fork': {
        this.pos++;
        let name: string | undefined;
        if (this.accept(':')) name = this.ident();
        const stmts: Stmt[] = [];
        const decls: Item[] = [];
        const endKw = t.v === 'begin' ? ['end'] : ['join', 'join_any', 'join_none'];
        while (!endKw.some(k => this.is(k))) {
          if (this.tok.t === 'eof') this.err(`Unexpected end of file, expecting '${endKw[0]}'`);
          const v = this.tok.v;
          if (this.tok.t === 'id' && (VAR_TYPES.has(v) || this.typedefs.has(v) || v === 'parameter' || v === 'localparam') && this.peek().v !== '=' ) {
            this.parseModuleItem(decls, null, new Map());
          } else stmts.push(this.stmt());
        }
        const endTok = this.tok.v;
        this.pos++;
        if (this.accept(':')) this.ident();
        if (t.v === 'fork') {
          const join = endTok === 'join_any' ? 'any' : endTok === 'join_none' ? 'none' : 'all';
          return { k: 'fork', branches: stmts, join, name, decls: decls.length ? decls : undefined, loc };
        }
        return { k: 'block', stmts, name, decls: decls.length ? decls : undefined, loc };
      }
      case 'if': {
        this.pos++; this.expect('(');
        const c = this.expr(); this.expect(')');
        const th = this.stmt();
        const el = this.accept('else') ? this.stmt() : undefined;
        return { k: 'if', c, t: th, f: el, loc };
      }
      case 'unique': case 'priority': this.pos++; return this.stmt();
      case 'case': case 'casez': case 'casex': {
        this.pos++; this.expect('(');
        const e = this.expr(); this.expect(')');
        const items: { labels: Expr[] | null; body: Stmt }[] = [];
        while (!this.accept('endcase')) {
          if (this.accept('default')) { this.accept(':'); items.push({ labels: null, body: this.stmt() }); continue; }
          const labels: Expr[] = [];
          do labels.push(this.expr()); while (this.accept(','));
          this.expect(':');
          items.push({ labels, body: this.stmt() });
        }
        return { k: 'case', kind: t.v as any, expr: e, items, loc };
      }
      case 'for': {
        this.pos++; this.expect('(');
        let init: Stmt | undefined;
        if (!this.isOp(';')) {
          if (this.tok.t === 'id' && (VAR_TYPES.has(this.tok.v))) this.parseDataType();
          init = this.simpleAssign();
        }
        this.expect(';');
        const cond = this.isOp(';') ? undefined : this.expr();
        this.expect(';');
        const step = this.isOp(')') ? undefined : this.simpleAssign();
        this.expect(')');
        return { k: 'for', init, cond, step, body: this.stmt(), loc };
      }
      case 'while': { this.pos++; this.expect('('); const c = this.expr(); this.expect(')'); return { k: 'while', c, body: this.stmt(), loc }; }
      case 'repeat': { this.pos++; this.expect('('); const n = this.expr(); this.expect(')'); return { k: 'repeat', n, body: this.stmt(), loc }; }
      case 'forever': this.pos++; return { k: 'forever', body: this.stmt(), loc };
      case 'wait': {
        this.pos++; this.expect('('); const c = this.expr(); this.expect(')');
        if (this.accept(';')) return { k: 'wait', c, loc };
        return { k: 'wait', c, body: this.stmt(), loc };
      }
      case 'disable': {
        this.pos++;
        if (this.accept('fork')) { this.expect(';'); return { k: 'disable_fork', loc }; }
        const n = this.ident(); this.expect(';'); return { k: 'disable', name: n, loc };
      }
      case 'return': { this.pos++; const e = this.isOp(';') ? undefined : this.expr(); this.expect(';'); return { k: 'return', e, loc }; }
      case 'force': case 'assign': {
        this.pos++; const lhs = this.lvalue(); this.expect('='); const rhs = this.expr(); this.expect(';');
        return t.v === 'force' ? { k: 'force', lhs, rhs, release: false, loc } : { k: 'assign', lhs, rhs, nb: false, loc };
      }
      case 'release': case 'deassign': { this.pos++; const lhs = this.lvalue(); this.expect(';'); return { k: 'force', lhs, release: true, loc }; }
    }
    if (t.t === 'id') {
      // task call or assignment
      const nx = this.peek();
      if (nx.t === 'op' && (nx.v === ';')) { this.pos += 2; return { k: 'call', name: t.v, args: [], loc }; }
      if (nx.t === 'op' && nx.v === '(') {
        this.pos += 2;
        const args: Expr[] = [];
        if (!this.isOp(')')) { do args.push(this.expr()); while (this.accept(',')); }
        this.expect(')'); this.expect(';');
        return { k: 'call', name: t.v, args, loc };
      }
      return this.assignStmt(loc, true);
    }
    this.err(`near "${t.v}": syntax error, unexpected ${t.v}`);
  }

  simpleAssign(): Stmt {
    const loc = this.loc();
    const lhs = this.lvalue();
    return this.finishAssign(lhs, loc, false);
  }

  assignStmt(loc: Loc, semi: boolean): Stmt {
    const lhs = this.lvalue();
    const s = this.finishAssign(lhs, loc, true);
    if (semi) this.expect(';');
    return s;
  }

  finishAssign(lhs: Expr, loc: Loc, allowNb: boolean): Stmt {
    if (this.accept('++')) return { k: 'assign', lhs, rhs: { k: 'bin', op: '+', l: lhs, r: num(1) }, nb: false, loc };
    if (this.accept('--')) return { k: 'assign', lhs, rhs: { k: 'bin', op: '-', l: lhs, r: num(1) }, nb: false, loc };
    const t = this.tok;
    if (t.t === 'op' && /^(\+|-|\*|\/|%|&|\||\^|<<<|>>>|<<|>>)=$/.test(t.v)) {
      this.pos++;
      const op = t.v.slice(0, -1);
      return { k: 'assign', lhs, rhs: { k: 'bin', op, l: lhs, r: this.expr() }, nb: false, loc };
    }
    let nb = false;
    if (allowNb && this.isOp('<=')) { nb = true; this.pos++; }
    else this.expect('=');
    let delay: Expr | undefined; let evctl: SensItem[] | undefined;
    if (this.accept('#')) delay = this.delayValue();
    else if (this.accept('@')) { const ev = this.eventControl(); if (ev !== '*') evctl = ev; }
    return { k: 'assign', lhs, rhs: this.expr(), nb, delay, evctl, loc };
  }

  delayValue(): Expr {
    if (this.accept('(')) {
      const e = this.expr();
      // min:typ:max -> typ
      if (this.accept(':')) { const typ = this.expr(); this.expect(':'); this.expr(); this.expect(')'); return typ; }
      if (this.accept(',')) { this.expr(); if (this.accept(',')) this.expr(); }
      this.expect(')');
      return e;
    }
    const t = this.tok;
    if (t.t === 'num' || t.t === 'real' || t.t === 'id') {
      const e = this.primary();
      // SV time literal: 10ns
      if (this.tok.t === 'id' && /^(s|ms|us|ns|ps|fs)$/.test(this.tok.v) && this.tok.loc.line === t.loc.line) {
        const scale = { s: 1e12, ms: 1e9, us: 1e6, ns: 1e3, ps: 1, fs: 1e-3 }[this.tok.v]!;
        this.pos++;
        const v = e.k === 'num' ? Number(e.v.a) : e.k === 'real' ? e.v : 0;
        return { k: 'time', ps: v * scale };
      }
      return e;
    }
    this.err(`near "${t.v}": syntax error, expecting delay value`);
  }

  eventControl(): SensItem[] | '*' {
    if (this.accept('*')) return '*';
    if (this.accept('(')) {
      if (this.accept('*')) { this.expect(')'); return '*'; }
      if (this.isOp('.*')) { this.err('syntax error'); }
      const items: SensItem[] = [];
      do {
        let edge: SensItem['edge'] = 'any';
        if (this.accept('posedge')) edge = 'pos';
        else if (this.accept('negedge')) edge = 'neg';
        items.push({ edge, expr: this.expr() });
      } while (this.accept('or') || this.accept(','));
      this.expect(')');
      return items;
    }
    const loc = this.loc();
    return [{ edge: 'any', expr: { k: 'id', name: this.hierName(), loc } }];
  }

  hierName(): string {
    let n = this.ident();
    while (this.isOp('.') && this.peek().t === 'id') { this.pos++; n += '.' + this.ident(); }
    return n;
  }

  lvalue(): Expr {
    const loc = this.loc();
    if (this.accept('{')) {
      const parts: Expr[] = [];
      do parts.push(this.lvalue()); while (this.accept(','));
      this.expect('}');
      return { k: 'concat', parts, loc };
    }
    let e: Expr = { k: 'id', name: this.hierName(), loc };
    e = this.selects(e);
    return e;
  }

  selects(e: Expr): Expr {
    while (this.isOp('[')) {
      const loc = this.loc();
      this.pos++;
      const a = this.expr();
      if (this.accept(':')) { const b = this.expr(); this.expect(']'); e = { k: 'range', base: e, msb: a, lsb: b, loc }; }
      else if (this.isOp('+:') || this.isOp('-:')) { const dir = this.tok.v[0] as '+' | '-'; this.pos++; const w = this.expr(); this.expect(']'); e = { k: 'irange', base: e, start: a, width: w, dir, loc }; }
      else { this.expect(']'); e = { k: 'index', base: e, index: a, loc }; }
    }
    return e;
  }

  // ---------- expressions ----------
  expr(): Expr {
    const c = this.binary(1);
    if (this.isOp('?')) {
      const loc = this.loc();
      this.pos++;
      const t = this.expr();
      this.expect(':');
      const f = this.expr();
      return { k: 'tern', c, t, f, loc };
    }
    return c;
  }

  binary(minPrec: number): Expr {
    let l = this.unary();
    for (;;) {
      const t = this.tok;
      if (t.t !== 'op') break;
      const p = BIN_PREC[t.v];
      if (p === undefined || p < minPrec) break;
      this.pos++;
      // ** is right-assoc
      const r = t.v === '**' ? this.binary(p) : this.binary(p + 1);
      l = { k: 'bin', op: t.v === '^~' ? '~^' : t.v, l, r, loc: t.loc };
    }
    return l;
  }

  unary(): Expr {
    const t = this.tok;
    if (t.t === 'op' && ['+', '-', '!', '~', '&', '~&', '|', '~|', '^', '~^', '^~'].includes(t.v)) {
      this.pos++;
      const e = this.unary();
      return { k: 'un', op: t.v === '^~' ? '~^' : t.v, e, loc: t.loc };
    }
    return this.primary();
  }

  primary(): Expr {
    const t = this.tok;
    const loc = t.loc;
    if (t.t === 'num') {
      this.pos++;
      if (!t.num) return { k: 'fill', bit: t.v[1] as any, loc };
      return { k: 'num', v: t.num.v, unsized: t.num.unsized, loc };
    }
    if (t.t === 'real') { this.pos++; return { k: 'real', v: t.real!, loc }; }
    if (t.t === 'str') { this.pos++; return { k: 'str', s: t.v, loc }; }
    if (t.t === 'sys') {
      this.pos++;
      const args: Expr[] = [];
      if (this.accept('(')) {
        if (!this.isOp(')')) { do args.push(this.expr()); while (this.accept(',')); }
        this.expect(')');
      }
      return { k: 'call', name: t.v, args, loc };
    }
    if (t.t === 'op') {
      if (t.v === '(') {
        this.pos++;
        const e = this.expr();
        // min:typ:max
        if (this.accept(':')) { const typ = this.expr(); this.expect(':'); this.expr(); this.expect(')'); return typ; }
        this.expect(')');
        return e;
      }
      if (t.v === '{') {
        this.pos++;
        const first = this.expr();
        if (this.isOp('{')) {
          this.pos++;
          const parts: Expr[] = [];
          do parts.push(this.expr()); while (this.accept(','));
          this.expect('}');
          this.expect('}');
          return { k: 'repl', count: first, parts, loc };
        }
        const parts = [first];
        while (this.accept(',')) parts.push(this.expr());
        this.expect('}');
        return { k: 'concat', parts, loc };
      }
    }
    if (t.t === 'id') {
      const name = this.hierName();
      if (this.isOp('(') ) {
        this.pos++;
        const args: Expr[] = [];
        if (!this.isOp(')')) { do args.push(this.expr()); while (this.accept(',')); }
        this.expect(')');
        return { k: 'call', name, args, loc };
      }
      if (this.isOp('::')) { this.pos++; return this.selects({ k: 'id', name: this.ident(), loc }); }
      return this.selects({ k: 'id', name, loc });
    }
    this.err(`near "${t.v}": syntax error, unexpected ${t.t === 'eof' ? 'end of file' : t.v}`);
  }
}

function num(n: number): Expr {
  return { k: 'num', v: fromBits(n.toString(2).padStart(32, '0'), true), unsized: true };
}
