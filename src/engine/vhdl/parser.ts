// VHDL (1076-1993/2008 subset) recursive-descent parser producing the shared AST.
import { CompileError, type Expr, type Item, type Loc, type ParamDecl, type PortDecl, type Stmt, type TypeSpec, type Unit, type FuncDecl, type DeclName } from '../ast';
import { lexVhdl, type VToken } from './lexer';
import { Vec, fromBits, fromInt, mask } from '../logic';

const TIME_UNITS: Record<string, number> = { fs: 1e-3, ps: 1, ns: 1e3, us: 1e6, ms: 1e9, sec: 1e12, min: 60e12, hr: 3600e12 };
import { RESERVED } from './lexer';

export function parseVhdl(src: string, file: string): Unit[] {
  return new VhParser(lexVhdl(src, file), file).parseDesignFile();
}

class VhParser {
  pos = 0;
  constructor(private toks: VToken[], private file: string) {}

  get tok() { return this.toks[this.pos]; }
  peek(o = 1) { return this.toks[Math.min(this.pos + o, this.toks.length - 1)]; }
  loc(): Loc { return this.tok.loc; }
  is(v: string) { const t = this.tok; return (t.t === 'id' || t.t === 'op') && t.v === v; }
  isAt(o: number, v: string) { const t = this.peek(o); return (t.t === 'id' || t.t === 'op') && t.v === v; }
  accept(v: string) { if (this.is(v)) { this.pos++; return true; } return false; }
  expect(v: string): VToken {
    if (!this.is(v)) this.err(`near "${this.tok.v}": (vcom-1576) expecting ${v.toUpperCase()}.`);
    return this.toks[this.pos++];
  }
  err(msg: string, loc = this.loc()): never { throw new CompileError(msg, loc); }
  ident(): string {
    const t = this.tok;
    if (t.t !== 'id' || (RESERVED.has(t.v) && !['range', 'stop', 'finish'].includes(t.v))) this.err(`near "${t.v}": syntax error, expecting identifier`);
    this.pos++;
    return t.v;
  }
  /** Consume `end [kw...] [name] ;` */
  endOf(...kws: string[]) {
    this.expect('end');
    for (const k of kws) this.accept(k);
    if (this.tok.t === 'id' && !this.is(';')) this.pos++;
    this.expect(';');
  }

  // ---------------------------------------------------------- design units

  parseDesignFile(): Unit[] {
    const units: Unit[] = [];
    let ctx: Item[] = [];
    while (this.tok.t !== 'eof') {
      if (this.accept('library')) { do this.ident(); while (this.accept(',')); this.expect(';'); continue; }
      if (this.is('use')) { ctx.push(...this.useClause()); continue; }
      if (this.is('context')) { while (!this.accept(';')) this.pos++; continue; }
      const loc = this.loc();
      let u: Unit;
      if (this.accept('entity')) u = this.entity(loc);
      else if (this.accept('architecture')) u = this.architecture(loc);
      else if (this.accept('package')) u = this.pkg(loc);
      else if (this.accept('configuration')) { this.skipConfiguration(); continue; }
      else this.err(`near "${this.tok.v}": syntax error, expecting design unit`);
      u.items.unshift(...ctx);
      units.push(u);
      ctx = [];
    }
    return units;
  }

  useClause(): Item[] {
    const loc = this.loc();
    this.expect('use');
    const out: Item[] = [];
    do {
      const parts = [this.ident()];
      while (this.accept('.')) parts.push(this.tok.v), this.pos++;
      if (parts[parts.length - 1] === 'all' || parts.length > 2) parts.pop();
      out.push({ k: 'use', pkg: parts.join('.'), loc });
    } while (this.accept(','));
    this.expect(';');
    return out;
  }

  skipConfiguration() {
    let depth = 0;
    while (this.tok.t !== 'eof') {
      if (this.is('for')) depth++;
      if (this.is('end')) {
        if (this.isAt(1, 'for')) { depth--; this.pos += 3; continue; }
        if (depth <= 0) { this.endOf('configuration'); return; }
      }
      this.pos++;
    }
  }

  entity(loc: Loc): Unit {
    const name = this.ident();
    this.expect('is');
    const u: Unit = { kind: 'entity', lang: 'vhdl', name, file: this.file, line: loc.line, params: [], ports: [], items: [] };
    if (this.accept('generic')) { u.params = this.genericList(); this.expect(';'); }
    if (this.accept('port')) { u.ports = this.portList(); this.expect(';'); }
    while (!this.is('end') && !this.is('begin')) this.declaration(u.items);
    if (this.accept('begin')) { while (!this.is('end')) this.concurrent(u.items); }
    this.endOf('entity');
    return u;
  }

  genericList(): ParamDecl[] {
    const out: ParamDecl[] = [];
    this.expect('(');
    do {
      if (this.is(')')) break;
      const loc = this.loc();
      this.accept('constant');
      const names = [this.ident()];
      while (this.accept(',')) names.push(this.ident());
      this.expect(':');
      this.accept('in');
      const type = this.subtype();
      const value = this.accept(':=') ? this.expr() : undefined;
      for (const n of names) out.push({ name: n, value, local: false, type, loc });
    } while (this.accept(';'));
    this.expect(')');
    return out;
  }

  portList(): PortDecl[] {
    const out: PortDecl[] = [];
    this.expect('(');
    do {
      if (this.is(')')) break;
      const loc = this.loc();
      this.accept('signal');
      const names = [this.ident()];
      while (this.accept(',')) names.push(this.ident());
      this.expect(':');
      let dir: PortDecl['dir'] = 'input';
      if (this.accept('in')) dir = 'input';
      else if (this.accept('out') || this.accept('buffer')) dir = 'output';
      else if (this.accept('inout') || this.accept('linkage')) dir = 'inout';
      const type = this.subtype();
      const init = this.accept(':=') ? this.expr() : undefined;
      for (const n of names) out.push({ name: n, dir, type, init, loc });
    } while (this.accept(';'));
    this.expect(')');
    return out;
  }

  architecture(loc: Loc): Unit {
    const name = this.ident();
    this.expect('of');
    const of = this.ident();
    this.expect('is');
    const u: Unit = { kind: 'architecture', lang: 'vhdl', name, of, file: this.file, line: loc.line, params: [], ports: [], items: [] };
    while (!this.is('begin')) this.declaration(u.items);
    this.expect('begin');
    while (!this.is('end')) this.concurrent(u.items);
    this.endOf('architecture');
    return u;
  }

  pkg(loc: Loc): Unit {
    const body = this.accept('body');
    const name = this.ident();
    this.expect('is');
    const u: Unit = { kind: body ? 'package_body' : 'package', lang: 'vhdl', name, file: this.file, line: loc.line, params: [], ports: [], items: [] };
    while (!this.is('end')) this.declaration(u.items);
    this.expect('end'); this.accept('package'); this.accept('body');
    if (this.tok.t === 'id') this.pos++;
    this.expect(';');
    return u;
  }

  // ---------------------------------------------------------- types

  subtype(): TypeSpec {
    // optional resolution function name (e.g. "resolved std_ulogic") — skip a leading 'resolved'
    if (this.is('resolved') && this.peek().t === 'id') this.pos++;
    let name = this.ident();
    while (this.accept('.')) name = this.ident(); // ieee.std_logic_1164.std_logic
    const t: TypeSpec = { base: 'named', name };
    if (this.is('(')) {
      this.pos++;
      const l = this.expr();
      if (this.accept('downto') || this.accept('to')) { const r = this.expr(); t.range = [l, r]; }
      else if (l.k === 'attr' && l.attr === 'range') t.range = [{ k: 'attr', base: l.base, attr: 'left' }, { k: 'attr', base: l.base, attr: 'right' }];
      else this.err('Expected range constraint');
      this.expect(')');
    } else if (this.accept('range')) {
      const l = this.expr();
      if (!this.accept('to')) this.expect('downto');
      const r = this.expr();
      t.range = [l, r];
    }
    return t;
  }

  // ---------------------------------------------------------- declarations

  declaration(items: Item[]) {
    const loc = this.loc();
    const v = this.tok.v;
    switch (v) {
      case 'signal': case 'variable': case 'constant': case 'shared': {
        this.pos++;
        if (v === 'shared') this.expect('variable');
        const names = [this.ident()];
        while (this.accept(',')) names.push(this.ident());
        this.expect(':');
        const type = this.subtype();
        if (this.accept('register') || this.accept('bus')) { /* ignore */ }
        const init = this.accept(':=') ? this.expr() : undefined;
        this.expect(';');
        const kind = v === 'signal' ? 'signal' : v === 'constant' ? 'const' : 'variable';
        if (kind === 'const' && !init) { // deferred constant in package: value comes with the body
          return;
        }
        items.push({ k: 'decl', kind, type, names: names.map(n => ({ name: n, init }) as DeclName), loc });
        return;
      }
      case 'type': {
        this.pos++;
        const name = this.ident();
        if (this.accept(';')) return; // incomplete type
        this.expect('is');
        if (this.accept('(')) {
          const names: string[] = [];
          do {
            const t = this.tok;
            if (t.t === 'char') { names.push(`'${t.v}'`); this.pos++; } else names.push(this.ident());
          } while (this.accept(','));
          this.expect(')');
          this.expect(';');
          items.push({ k: 'typedef', name, type: { base: 'enum', enumNames: names }, loc });
          return;
        }
        if (this.accept('array')) {
          this.expect('(');
          const l = this.expr();
          let range: [Expr, Expr] | undefined;
          if (this.is('range') && this.isAt(1, '<>')) this.pos += 2;   // unconstrained: index_type range <>
          else { if (!this.accept('to')) this.expect('downto'); range = [l, this.expr()]; }
          if (this.is(',')) this.err('Multi-dimensional array types are not supported');
          this.expect(')');
          this.expect('of');
          const elem = this.subtype();
          this.expect(';');
          items.push({ k: 'typedef', name, array: { range, elem }, loc });
          return;
        }
        if (this.accept('range')) {
          const l = this.expr();
          if (!this.accept('to')) this.expect('downto');
          const r = this.expr();
          if (this.accept('units')) { while (!this.is('end')) this.pos++; this.endOf('units'); return; }
          this.expect(';');
          items.push({ k: 'typedef', name, type: { base: 'integer', width: 32, signed: true, range: [l, r] }, loc });
          return;
        }
        if (this.accept('record')) {
          const fields: { name: string; type: TypeSpec }[] = [];
          while (!this.is('end')) {
            const names = [this.ident()];
            while (this.accept(',')) names.push(this.ident());
            this.expect(':');
            const type = this.subtype();
            this.expect(';');
            for (const n of names) fields.push({ name: n, type });
          }
          this.expect('end'); this.expect('record');
          if (this.tok.t === 'id') this.pos++;
          this.expect(';');
          if (!fields.length) this.err(`Record type '${name}' has no fields`);
          items.push({ k: 'typedef', name, record: fields, loc });
          return;
        }
        this.err(`Unsupported type definition for '${name}'`);
      }
      case 'subtype': {
        this.pos++;
        const name = this.ident();
        this.expect('is');
        const type = this.subtype();
        this.expect(';');
        items.push({ k: 'typedef', name, type, loc });
        return;
      }
      case 'component': {
        this.pos++;
        this.ident();
        this.accept('is');
        if (this.accept('generic')) { this.genericList(); this.expect(';'); }
        if (this.accept('port')) { this.portList(); this.expect(';'); }
        this.endOf('component');
        return;
      }
      case 'function': case 'procedure': case 'pure': case 'impure': {
        const f = this.subprogram();
        if (f) items.push(f);
        return;
      }
      case 'file': {
        // file f : text [open read_mode|write_mode|append_mode] [is "name"];   (also VHDL-87: is in/out "name")
        this.pos++;
        const names = [this.ident()];
        while (this.accept(',')) names.push(this.ident());
        this.expect(':');
        const type = this.subtype();
        let mode: 'read' | 'write' | 'append' = 'read';
        if (this.accept('open')) {
          const m = this.ident();
          mode = m.startsWith('write') ? 'write' : m.startsWith('append') ? 'append' : 'read';
        }
        let init: Expr | undefined;
        if (this.accept('is')) {
          if (this.accept('in')) mode = 'read';
          else if (this.accept('out')) mode = 'write';
          init = this.expr();
        }
        this.expect(';');
        items.push({ k: 'decl', kind: 'variable', type, names: names.map(n => ({ name: n, init })), fileMode: mode, loc });
        return;
      }
      case 'alias': {
        this.pos++;
        const name = this.ident();
        const type = this.accept(':') ? this.subtype() : undefined;
        this.expect('is');
        const target = this.name();
        if (this.is('[')) while (!this.accept(']')) this.pos++; // subprogram signature
        this.expect(';');
        items.push({ k: 'alias', name, type, target, loc });
        return;
      }
      case 'attribute': case 'disconnect': case 'group':
        while (!this.accept(';')) this.pos++;
        return;
      case 'use': items.push(...this.useClause()); return;
    }
    this.err(`near "${this.tok.v}": syntax error, unexpected ${this.tok.v}`);
  }

  subprogram(): FuncDecl | null {
    const loc = this.loc();
    this.accept('pure'); this.accept('impure');
    const isProc = this.accept('procedure');
    if (!isProc) this.expect('function');
    const t = this.tok;
    let name: string;
    if (t.t === 'str') { name = `"${t.v.toLowerCase()}"`; this.pos++; }
    else name = this.ident();
    const args: FuncDecl['args'] = [];
    if (this.accept('(')) {
      do {
        let cls = '';
        if (this.is('signal') || this.is('variable') || this.is('constant') || this.is('file')) { cls = this.tok.v; this.pos++; }
        const names = [this.ident()];
        while (this.accept(',')) names.push(this.ident());
        this.expect(':');
        let dir: 'input' | 'output' | 'inout' = 'input';
        if (this.accept('in')) dir = 'input';
        else if (this.accept('out')) dir = 'output';
        else if (this.accept('inout')) dir = 'inout';
        const type = this.subtype();
        const def = this.accept(':=') ? this.expr() : undefined;
        for (const n of names) args.push({ name: n, dir, type, vsig: cls === 'signal', def });
      } while (this.accept(';'));
      this.expect(')');
    }
    let ret: TypeSpec | undefined;
    if (!isProc) { this.expect('return'); ret = this.subtype(); }
    if (this.accept(';')) return { k: 'func', name, isTask: isProc, ret, args, decls: [], body: { k: 'null' }, loc };
    this.expect('is');
    const decls: Item[] = [];
    while (!this.is('begin')) this.declaration(decls);
    this.expect('begin');
    const stmts = this.seqList(['end']);
    this.expect('end'); this.accept('function'); this.accept('procedure');
    if (this.tok.t === 'id' || this.tok.t === 'str') this.pos++;
    this.expect(';');
    return { k: 'func', name, isTask: isProc, ret, args, decls, body: { k: 'block', stmts, loc }, loc };
  }

  // ---------------------------------------------------------- concurrent statements

  concurrent(items: Item[]) {
    const loc = this.loc();
    let label: string | undefined;
    if (this.tok.t === 'id' && this.isAt(1, ':') && !this.isAt(1, ':=')) { label = this.ident(); this.expect(':'); }
    this.accept('postponed');
    if (this.accept('process')) { items.push(this.process(label, loc)); return; }
    if (this.is('for') && label) { items.push(this.forGenerate(label, loc)); return; }
    if (this.is('if') && label) { items.push(this.ifGenerate(label, loc)); return; }
    if (this.accept('block')) this.err('Block statements are not supported');
    if (this.accept('assert')) {
      const cond = this.expr();
      const s = this.reportTail({ k: 'report', cond, loc });
      items.push({ k: 'process', kind: 'vproc', sens: 'all', name: label, body: { k: 'block', stmts: [s] }, loc });
      return;
    }
    if (this.accept('with')) { items.push(this.selectedAssign(label, loc)); return; }
    if (label && (this.is('entity') || this.is('component') || this.is('configuration'))) { items.push(this.instance(label, loc)); return; }
    if (label && this.tok.t === 'id' && (this.isAt(1, 'port') || this.isAt(1, 'generic') || this.isAt(1, ';') || (this.isAt(1, '.') && !this.isAt(3, '<=')))) {
      items.push(this.instance(label, loc)); return;
    }
    // concurrent signal assignment (or procedure call)
    const target = this.name();
    if (this.accept('<=')) {
      this.accept('guarded');
      const body = this.condWaveforms(target, loc);
      this.expect(';');
      items.push({ k: 'process', kind: 'vproc', sens: 'all', name: label, body, loc });
      return;
    }
    if (this.accept(';')) {
      const call = this.toCall(target, loc);
      items.push({ k: 'process', kind: 'vproc', sens: 'all', name: label, body: call, loc });
      return;
    }
    this.err(`near "${this.tok.v}": syntax error, unexpected ${this.tok.v}`);
  }

  /** waveform [when cond else waveform]* — returns a statement */
  condWaveforms(target: Expr, loc: Loc): Stmt {
    this.accept('transport');
    if (this.accept('reject')) { this.expr(); this.expect('inertial'); }
    this.accept('inertial');
    const first = this.waveform();
    if (!this.is('when')) return { k: 'vsigassign', lhs: target, waves: first, loc };
    const branches: { c?: Expr; w: { value: Expr; after?: Expr }[] }[] = [];
    let cur = first;
    while (this.accept('when')) {
      const c = this.expr();
      branches.push({ c, w: cur });
      if (!this.accept('else')) { cur = []; break; }
      cur = this.waveform();
    }
    if (cur.length) branches.push({ w: cur });
    let s: Stmt | undefined;
    for (let i = branches.length - 1; i >= 0; i--) {
      const b = branches[i];
      const a: Stmt = { k: 'vsigassign', lhs: target, waves: b.w, loc };
      s = b.c ? { k: 'if', c: b.c, t: a, f: s, loc } : a;
    }
    return s!;
  }

  waveform(): { value: Expr; after?: Expr }[] {
    const out: { value: Expr; after?: Expr }[] = [];
    if (this.accept('unaffected')) return out;
    do {
      const value = this.expr();
      const after = this.accept('after') ? this.expr() : undefined;
      out.push({ value, after });
    } while (this.accept(','));
    return out;
  }

  selectedAssign(label: string | undefined, loc: Loc): Item {
    const sel = this.expr();
    this.expect('select');
    const target = this.name();
    this.expect('<=');
    this.accept('transport');
    const items: { labels: Expr[] | null; body: Stmt }[] = [];
    do {
      const w = this.waveform();
      this.expect('when');
      const labels = this.choices();
      items.push({ labels, body: { k: 'vsigassign', lhs: target, waves: w, loc } });
    } while (this.accept(','));
    this.expect(';');
    return { k: 'process', kind: 'vproc', sens: 'all', name: label, body: { k: 'case', kind: 'case', expr: sel, items, loc }, loc };
  }

  choices(): Expr[] | null {
    const out: Expr[] = [];
    let others = false;
    do {
      if (this.accept('others')) { others = true; continue; }
      const a = this.expr();
      if (this.accept('to')) out.push({ k: 'call', name: '__to', args: [a, this.expr()] });
      else if (this.accept('downto')) out.push({ k: 'call', name: '__downto', args: [a, this.expr()] });
      else out.push(a);
    } while (this.accept('|'));
    return others ? null : out;
  }

  process(label: string | undefined, loc: Loc): Item {
    let sens: Expr[] | 'all' | undefined;
    if (this.accept('(')) {
      if (this.accept('all')) sens = 'all';
      else { sens = []; do sens.push(this.name()); while (this.accept(',')); }
      this.expect(')');
    }
    this.accept('is');
    const decls: Item[] = [];
    while (!this.is('begin')) this.declaration(decls);
    this.expect('begin');
    const stmts = this.seqList(['end']);
    this.expect('end'); this.accept('postponed'); this.expect('process');
    if (this.tok.t === 'id') this.pos++;
    this.expect(';');
    return { k: 'process', kind: 'vproc', sens, name: label, body: { k: 'block', stmts, decls: decls.length ? decls : undefined, loc }, loc };
  }

  instance(label: string, loc: Loc): Item {
    let module: string, lib: string | undefined, arch: string | undefined;
    let isEntity = false;
    if (this.accept('entity')) {
      isEntity = true;
      module = this.ident();
      if (this.accept('.')) { lib = module; module = this.ident(); }
      if (this.accept('(')) { arch = this.ident(); this.expect(')'); }
    } else if (this.accept('configuration')) {
      this.err('Configuration instantiation is not supported');
    } else {
      this.accept('component');
      module = this.ident();
      if (this.accept('.')) { lib = module; module = this.ident(); }
    }
    const params: { name?: string; value: Expr }[] = [];
    const conns: { name?: string; expr: Expr | null }[] = [];
    if (this.accept('generic')) {
      this.expect('map');
      for (const a of this.assocList()) params.push({ name: a.name, value: a.expr ?? this.err('open generic not allowed') });
    }
    if (this.accept('port')) {
      this.expect('map');
      conns.push(...this.assocList());
    }
    this.expect(';');
    return { k: 'inst', module: module!, lib, arch, name: label, params, conns, isEntity, loc };
  }

  assocList(): { name?: string; expr: Expr | null; sel?: Expr }[] {
    const out: { name?: string; expr: Expr | null; sel?: Expr }[] = [];
    this.expect('(');
    do {
      let name: string | undefined;
      let sel: Expr | undefined;
      if (this.tok.t === 'id' && this.isAt(1, '=>')) { name = this.ident(); this.expect('=>'); }
      else if (this.tok.t === 'id' && this.isAt(1, '(')) {
        // partial formal "q(0) => x" / "q(7 downto 4) => y": scan for => after the matching ')'
        let j = this.pos + 1, depth = 0;
        for (; j < this.toks.length; j++) {
          const t = this.toks[j];
          if (t.v === '(') depth++;
          else if (t.v === ')') { depth--; if (depth === 0) break; }
        }
        if (this.toks[j + 1]?.v === '=>') {
          const f = this.name();
          if (f.k !== 'call' || f.args.length !== 1) this.err('Unsupported formal in association');
          name = f.name; sel = f.args[0];
          this.expect('=>');
        }
      }
      if (this.accept('open')) out.push({ name, expr: null, sel });
      else out.push({ name, expr: this.expr(), sel });
    } while (this.accept(','));
    this.expect(')');
    return out;
  }

  forGenerate(label: string, loc: Loc): Item {
    this.expect('for');
    const v = this.ident();
    this.expect('in');
    const from = this.expr();
    let down = false, to: Expr;
    if (this.accept('downto')) { down = true; to = this.expr(); }
    else if (this.accept('to')) to = this.expr();
    else this.err('Expected range in for generate');
    this.expect('generate');
    const items = this.generateBody();
    this.endGenerate();
    return { k: 'genfor', v, init: from, cond: from, stepExpr: from, name: label, items, vhdl: { from, to, down }, loc };
  }

  ifGenerate(label: string, loc: Loc): Item {
    this.expect('if');
    const c = this.expr();
    this.expect('generate');
    const then = this.generateBody(['elsif', 'else', 'end']);
    let els: Item[] | undefined;
    if (this.is('elsif')) {
      this.tok.v = 'if';
      els = [this.ifGenerateInner(label)];
      return { k: 'genif', c, then, else: els, name: label, loc };
    }
    if (this.accept('else')) { this.accept('generate'); els = this.generateBody(); }
    this.endGenerate();
    return { k: 'genif', c, then, else: els, name: label, loc };
  }

  ifGenerateInner(label: string): Item {
    const loc = this.loc();
    this.expect('if');
    const c = this.expr();
    this.expect('generate');
    const then = this.generateBody(['elsif', 'else', 'end']);
    let els: Item[] | undefined;
    if (this.is('elsif')) { this.tok.v = 'if'; els = [this.ifGenerateInner(label)]; return { k: 'genif', c, then, else: els, name: label, loc }; }
    if (this.accept('else')) { this.accept('generate'); els = this.generateBody(); }
    this.endGenerate();
    return { k: 'genif', c, then, else: els, name: label, loc };
  }

  generateBody(stops = ['end']): Item[] {
    const items: Item[] = [];
    // optional declarative part followed by begin
    const save = this.pos;
    const isDecl = () => ['signal', 'constant', 'variable', 'type', 'subtype', 'component', 'function', 'procedure', 'attribute', 'shared'].includes(this.tok.v);
    if (isDecl()) {
      while (!this.is('begin')) this.declaration(items);
      this.expect('begin');
    } else if (this.accept('begin')) { /* empty decls */ } else this.pos = save;
    while (!stops.some(s => this.is(s))) this.concurrent(items);
    return items;
  }

  endGenerate() {
    this.expect('end');
    this.expect('generate');
    if (this.tok.t === 'id') this.pos++;
    this.expect(';');
  }

  // ---------------------------------------------------------- sequential statements

  seqList(stops: string[]): Stmt[] {
    const out: Stmt[] = [];
    while (!stops.some(s => this.is(s))) {
      if (this.tok.t === 'eof') this.err('Unexpected end of file');
      out.push(this.seq());
    }
    return out;
  }

  seq(): Stmt {
    const loc = this.loc();
    let label: string | undefined;
    if (this.tok.t === 'id' && this.isAt(1, ':') && !RESERVED.has(this.tok.v)) { label = this.ident(); this.expect(':'); }
    const v = this.tok.t === 'id' ? this.tok.v : '';
    switch (v) {
      case 'if': {
        this.pos++;
        const c = this.expr();
        this.expect('then');
        const t = this.seqList(['elsif', 'else', 'end']);
        const root: Stmt = { k: 'if', c, t: { k: 'block', stmts: t }, loc };
        let cur = root as Extract<Stmt, { k: 'if' }>;
        while (this.is('elsif')) {
          const l2 = this.loc();
          this.pos++;
          const c2 = this.expr();
          this.expect('then');
          const t2 = this.seqList(['elsif', 'else', 'end']);
          const n: Extract<Stmt, { k: 'if' }> = { k: 'if', c: c2, t: { k: 'block', stmts: t2 }, loc: l2 };
          cur.f = n; cur = n;
        }
        if (this.accept('else')) cur.f = { k: 'block', stmts: this.seqList(['end']) };
        this.expect('end'); this.expect('if');
        if (this.tok.t === 'id') this.pos++;
        this.expect(';');
        return root;
      }
      case 'case': {
        this.pos++;
        this.accept('?');
        const e = this.expr();
        this.expect('is');
        const items: { labels: Expr[] | null; body: Stmt }[] = [];
        while (this.accept('when')) {
          const labels = this.choices();
          this.expect('=>');
          items.push({ labels, body: { k: 'block', stmts: this.seqList(['when', 'end']) } });
        }
        this.expect('end'); this.expect('case');
        if (this.tok.t === 'id') this.pos++;
        this.expect(';');
        return { k: 'case', kind: 'case', expr: e, items, loc };
      }
      case 'for': {
        this.pos++;
        const iv = this.ident();
        this.expect('in');
        const from = this.expr();
        let down = false, to: Expr = from;
        if (this.accept('downto')) { down = true; to = this.expr(); }
        else if (this.accept('to')) to = this.expr();
        else if (!(from.k === 'attr' && (from.attr === 'range' || from.attr === 'reverse_range'))) this.err('Expected range in for loop');
        const body = this.loopBody();
        return { k: 'vfor', v: iv, from, to, down, body, label, loc };
      }
      case 'while': {
        this.pos++;
        const c = this.expr();
        return { k: 'while', c, body: this.loopBody(), label, loc };
      }
      case 'loop': return { k: 'loop', body: this.loopBody(), label, loc };
      case 'exit': case 'next': {
        this.pos++;
        let lab: string | undefined;
        if (this.tok.t === 'id' && !this.is('when')) lab = this.ident();
        const cond = this.accept('when') ? this.expr() : undefined;
        this.expect(';');
        return { k: 'exit', label: lab, cond, next: v === 'next', loc };
      }
      case 'wait': {
        this.pos++;
        const s: Extract<Stmt, { k: 'vwait' }> = { k: 'vwait', loc };
        if (this.accept('on')) { s.on = []; do s.on.push(this.name()); while (this.accept(',')); }
        if (this.accept('until')) s.until = this.expr();
        if (this.accept('for')) s.for = this.expr();
        this.expect(';');
        return s;
      }
      case 'assert': {
        this.pos++;
        const cond = this.expr();
        return this.reportTail({ k: 'report', cond, loc });
      }
      case 'report': return this.reportTail({ k: 'report', loc });
      case 'return': {
        this.pos++;
        const e = this.is(';') ? undefined : this.expr();
        this.expect(';');
        return { k: 'return', e, loc };
      }
      case 'null': this.pos++; this.expect(';'); return { k: 'null', loc };
    }
    // assignment or procedure call
    const target = this.name();
    if (this.accept(':=')) {
      const rhs = this.expr();
      if (this.is('when')) {
        // VHDL-2008 conditional variable assignment
        let s: Stmt | undefined;
        const parts: { c?: Expr; v: Expr }[] = [];
        let cur = rhs;
        while (this.accept('when')) { const c = this.expr(); parts.push({ c, v: cur }); if (!this.accept('else')) break; cur = this.expr(); if (!this.is('when')) { parts.push({ v: cur }); break; } }
        for (let i = parts.length - 1; i >= 0; i--) { const a: Stmt = { k: 'assign', lhs: target, rhs: parts[i].v, nb: false, loc }; s = parts[i].c ? { k: 'if', c: parts[i].c!, t: a, f: s } : a; }
        this.expect(';');
        return s!;
      }
      this.expect(';');
      return { k: 'assign', lhs: target, rhs, nb: false, loc };
    }
    if (this.accept('<=')) {
      const s = this.condWaveforms(target, loc);
      this.expect(';');
      return s;
    }
    this.expect(';');
    return this.toCall(target, loc);
  }

  toCall(target: Expr, loc: Loc): Stmt {
    if (target.k === 'id') return { k: 'call', name: target.name, args: [], loc };
    if (target.k === 'call') return { k: 'call', name: target.name, args: target.args, named: target.named, loc };
    this.err('Expected procedure call or assignment', loc);
  }

  loopBody(): Stmt {
    this.expect('loop');
    const stmts = this.seqList(['end']);
    this.expect('end'); this.expect('loop');
    if (this.tok.t === 'id') this.pos++;
    this.expect(';');
    return { k: 'block', stmts };
  }

  reportTail(s: Extract<Stmt, { k: 'report' }>): Stmt {
    if (this.accept('report')) s.msg = this.expr();
    if (this.accept('severity')) s.severity = this.expr();
    this.expect(';');
    return s;
  }

  // ---------------------------------------------------------- expressions

  expr(): Expr {
    let l = this.relation();
    const t = this.tok;
    if (t.t === 'id' && ['and', 'or', 'xor', 'xnor', 'nand', 'nor'].includes(t.v)) {
      const op = t.v;
      while (this.accept(op)) {
        const r = this.relation();
        l = logical(op, l, r, t.loc);
      }
      if (this.tok.t === 'id' && ['and', 'or', 'xor', 'xnor', 'nand', 'nor'].includes(this.tok.v)) this.err('Mixed logical operators require parentheses');
    }
    return l;
  }

  relation(): Expr {
    const l = this.shiftExpr();
    const t = this.tok;
    if (t.t === 'op' && ['=', '/=', '<', '<=', '>', '>=', '?=', '?/='].includes(t.v)) {
      this.pos++;
      const r = this.shiftExpr();
      const op = t.v === '=' || t.v === '?=' ? '===' : t.v === '/=' || t.v === '?/=' ? '!==' : t.v;
      return { k: 'bin', op, l, r, loc: t.loc };
    }
    return l;
  }

  shiftExpr(): Expr {
    const l = this.simpleExpr();
    const t = this.tok;
    const map: Record<string, string> = { sll: '<<', srl: '>>', sla: '<<<', sra: '>>>', rol: 'rol', ror: 'ror' };
    if (t.t === 'id' && map[t.v]) { this.pos++; return { k: 'bin', op: map[t.v], l, r: this.simpleExpr(), loc: t.loc }; }
    return l;
  }

  simpleExpr(): Expr {
    let l: Expr;
    const t0 = this.tok;
    if (t0.t === 'op' && (t0.v === '+' || t0.v === '-')) { this.pos++; const e = this.term(); l = t0.v === '-' ? { k: 'un', op: '-', e, loc: t0.loc } : e; }
    else l = this.term();
    for (;;) {
      const t = this.tok;
      if (t.t !== 'op' || !['+', '-', '&'].includes(t.v)) break;
      this.pos++;
      const r = this.term();
      if (t.v === '&') {
        const parts = l.k === 'concat' && (l as any).vh ? [...l.parts, r] : [l, r];
        l = { k: 'concat', parts, loc: t.loc };
        (l as any).vh = true;
      } else l = { k: 'bin', op: t.v, l, r, loc: t.loc };
    }
    return l;
  }

  term(): Expr {
    let l = this.factor();
    for (;;) {
      const t = this.tok;
      let op: string | null = null;
      if (t.t === 'op' && (t.v === '*' || t.v === '/')) op = t.v;
      else if (t.t === 'id' && t.v === 'mod') op = 'mod';
      else if (t.t === 'id' && t.v === 'rem') op = '%';
      if (!op) break;
      this.pos++;
      l = { k: 'bin', op, l, r: this.factor(), loc: t.loc };
    }
    return l;
  }

  factor(): Expr {
    const t = this.tok;
    if (t.t === 'id') {
      if (t.v === 'not') { this.pos++; return { k: 'un', op: '~', e: this.factor(), loc: t.loc }; }
      if (t.v === 'abs') { this.pos++; return { k: 'un', op: 'abs', e: this.factor(), loc: t.loc }; }
      if (['and', 'or', 'xor', 'nand', 'nor', 'xnor'].includes(t.v)) {
        // VHDL-2008 unary reduction
        this.pos++;
        const op = { and: '&', or: '|', xor: '^', nand: '~&', nor: '~|', xnor: '~^' }[t.v]!;
        return { k: 'un', op, e: this.factor(), loc: t.loc };
      }
    }
    if (t.t === 'op' && t.v === '??') { this.pos++; return this.primary(); }
    const p = this.primary();
    if (this.is('**')) { const l2 = this.loc(); this.pos++; return { k: 'bin', op: '**', l: p, r: this.primary(), loc: l2 }; }
    return p;
  }

  primary(): Expr {
    const t = this.tok;
    const loc = t.loc;
    switch (t.t) {
      case 'int': case 'real': {
        this.pos++;
        const nx = this.tok;
        if (nx.t === 'id' && TIME_UNITS[nx.v] !== undefined) {
          this.pos++;
          const val = t.t === 'int' ? Number(t.based!) : t.n!;
          return { k: 'time', ps: val * TIME_UNITS[nx.v], loc };
        }
        if (t.t === 'real') return { k: 'real', v: t.n!, loc };
        return { k: 'num', v: fromInt(t.based!, 32, true), unsized: true, loc };
      }
      case 'char': {
        this.pos++;
        if (/^[01uxzwlhUXZWLH-]$/.test(t.v)) return { k: 'num', v: fromBits(t.v), loc };
        return { k: 'num', v: fromInt(t.v.charCodeAt(0), 8), loc };
      }
      case 'str': {
        this.pos++;
        // string used as a qualified-expression base? (rare) -> plain string
        return { k: 'str', s: t.v, loc };
      }
      case 'bits': {
        this.pos++;
        return { k: 'num', v: bitString(t.v, loc), loc };
      }
      case 'op':
        if (t.v === '(') return this.aggregateOrParen();
        break;
      case 'id':
        if (t.v === 'null') { this.pos++; return { k: 'num', v: fromInt(0, 1), loc }; }
        if (t.v === 'others' || (RESERVED.has(t.v) && t.v !== 'range')) break;
        return this.name();
    }
    this.err(`near "${t.v}": syntax error, unexpected ${t.t === 'eof' ? 'end of file' : t.v}`);
  }

  aggregateOrParen(): Expr {
    const loc = this.loc();
    this.expect('(');
    const elems: { choice: Expr | null; value: Expr }[] = [];
    let others: Expr | undefined;
    let isAgg = false;
    do {
      if (this.accept('others')) { this.expect('=>'); others = this.expr(); isAgg = true; continue; }
      const e = this.expr();
      if (this.accept('=>')) { elems.push({ choice: e, value: this.expr() }); isAgg = true; continue; }
      if (this.accept('|')) this.err('Choice lists in aggregates are not supported');
      elems.push({ choice: null, value: e });
      if (this.is(',')) isAgg = true;
    } while (this.accept(','));
    this.expect(')');
    if (!isAgg && elems.length === 1) return elems[0].value;
    return { k: 'agg', others, elems, loc };
  }

  /** name: id { .id | (args) | 'attr } */
  name(): Expr {
    const loc = this.loc();
    let n = this.ident();
    // selected names: lib.pkg.obj / std.env.stop
    while (this.is('.') && this.peek().t === 'id') { this.pos++; n += '.' + this.tok.v; this.pos++; }
    let e: Expr = { k: 'id', name: n, loc };
    for (;;) {
      if (this.is('(')) {
        this.pos++;
        const args: Expr[] = [];
        const named: (string | null)[] = [];
        do {
          let nm: string | null = null;
          if (this.tok.t === 'id' && this.isAt(1, '=>')) { nm = this.ident(); this.pos++; }
          const a = this.expr();
          if (this.accept('downto')) args.push({ k: 'call', name: '__downto', args: [a, this.expr()] });
          else if (this.accept('to')) args.push({ k: 'call', name: '__to', args: [a, this.expr()] });
          else args.push(a);
          named.push(nm);
        } while (this.accept(','));
        this.expect(')');
        if (e.k === 'id') e = { k: 'call', name: e.name, args, named: named.some(x => x) ? named : undefined, loc };
        else if (e.k === 'call') {
          // name(a)(b): nested index
          const inner = e;
          const a0 = args[0];
          e = a0.k === 'call' && (a0.name === '__downto' || a0.name === '__to')
            ? { k: 'range', base: inner, msb: a0.args[0], lsb: a0.args[1], loc }
            : { k: 'index', base: inner, index: a0, loc };
        } else {
          e = { k: 'index', base: e, index: args[0], loc };
        }
        continue;
      }
      if (this.is('.') && this.peek().t === 'id' && e.k !== 'id') {
        // record field of an indexed/called name: mem(i).field
        this.pos++;
        e = { k: 'field', base: e, field: this.ident(), loc };
        continue;
      }
      if (this.is("'")) {
        this.pos++;
        if (this.is('(')) {
          // qualified expression type'(expr)
          const inner = this.aggregateOrParen();
          const tname = e.k === 'id' ? e.name : '';
          e = { k: 'call', name: tname, args: [inner], loc };
          continue;
        }
        const attr = this.tok.v;
        this.pos++;
        let arg: Expr | undefined;
        if (this.is('(') && ['image', 'value', 'pos', 'val', 'succ', 'pred', 'leftof', 'rightof', 'delayed', 'stable', 'quiet', 'transaction'].includes(attr)) {
          this.pos++; arg = this.expr(); this.expect(')');
        }
        e = { k: 'attr', base: e, attr, arg, loc };
        continue;
      }
      break;
    }
    return e;
  }
}

function logical(op: string, l: Expr, r: Expr, loc: Loc): Expr {
  switch (op) {
    case 'and': return { k: 'bin', op: '&', l, r, loc };
    case 'or': return { k: 'bin', op: '|', l, r, loc };
    case 'xor': return { k: 'bin', op: '^', l, r, loc };
    case 'xnor': return { k: 'bin', op: '~^', l, r, loc };
    case 'nand': return { k: 'un', op: '~', e: { k: 'bin', op: '&', l, r, loc }, loc };
    case 'nor': return { k: 'un', op: '~', e: { k: 'bin', op: '|', l, r, loc }, loc };
  }
  throw new CompileError(`bad op ${op}`, loc);
}

function bitString(tv: string, loc: Loc): Vec {
  const [base, body, size] = tv.split(':');
  const digits = body.replace(/_/g, '');
  let bits = '';
  if (base === 'd') {
    const v = BigInt(digits);
    const w = size ? Number(size) : Math.max(1, v.toString(2).length);
    return new Vec(w, v & mask(w), 0n);
  }
  const per = base === 'b' ? 1 : base === 'o' ? 3 : 4;
  for (const ch of digits) {
    if (/[xXzZuU-]/.test(ch)) { bits += ch.repeat(per); continue; }
    const d = parseInt(ch, 16);
    if (isNaN(d) || d >= 1 << per) throw new CompileError(`Illegal digit '${ch}' in bit string literal`, loc);
    bits += d.toString(2).padStart(per, '0');
  }
  let v = fromBits(bits || '0');
  if (size) {
    const w = Number(size);
    v = w <= v.w ? new Vec(w, v.a & mask(w), v.b & mask(w)) : new Vec(w, v.a, v.b);
  }
  return v;
}
