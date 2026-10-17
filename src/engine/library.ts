// Design libraries: hold compiled design units (as parsed ASTs + source snapshots).
import { CompileError, type Unit } from './ast';
import type { DesignResolver } from './elab';
import { parseVerilog } from './verilog/parser';
import type { Macro } from './verilog/lexer';

export type VhdlParser = (src: string, file: string) => Unit[];
let vhdlParser: VhdlParser | null = null;
export function registerVhdlParser(p: VhdlParser) { vhdlParser = p; }

export interface UnitInfo {
  name: string;
  kind: Unit['kind'];
  lang: Unit['lang'];
  file: string;
  of?: string;
}

export class Library {
  modules = new Map<string, Unit>();      // Verilog modules and VHDL entities
  archs = new Map<string, Unit[]>();      // entity -> architectures (latest last)
  packages = new Map<string, Unit>();
  bodies = new Map<string, Unit>();
  constructor(public name: string) {}

  add(u: Unit) {
    switch (u.kind) {
      case 'module': case 'entity': this.modules.set(u.name, u); if (u.kind === 'entity') this.archs.delete(u.name); break;
      case 'architecture': {
        const list = (this.archs.get(u.of!) ?? []).filter(a => a.name !== u.name);
        list.push(u);
        this.archs.set(u.of!, list);
        break;
      }
      case 'package': this.packages.set(u.name, u); break;
      case 'package_body': this.bodies.set(u.name, u); break;
    }
  }

  list(): UnitInfo[] {
    const out: UnitInfo[] = [];
    for (const u of this.modules.values()) out.push({ name: u.name, kind: u.kind, lang: u.lang, file: u.file });
    for (const [e, as] of this.archs) for (const a of as) out.push({ name: a.name, kind: 'architecture', lang: 'vhdl', file: a.file, of: e });
    for (const u of this.packages.values()) out.push({ name: u.name, kind: 'package', lang: 'vhdl', file: u.file });
    for (const u of this.bodies.values()) out.push({ name: u.name, kind: 'package_body', lang: 'vhdl', file: u.file });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  remove(name: string) {
    this.modules.delete(name); this.archs.delete(name); this.packages.delete(name); this.bodies.delete(name);
  }

  clear() { this.modules.clear(); this.archs.clear(); this.packages.clear(); this.bodies.clear(); }
}

export interface CompileResult {
  ok: boolean;
  units: Unit[];
  errors: { msg: string; file: string; line: number }[];
  log: string[];
}

export class LibraryManager implements DesignResolver {
  libs = new Map<string, Library>();
  defines = new Map<string, Macro>();

  constructor() { this.ensure('work'); }

  ensure(name: string): Library {
    let l = this.libs.get(name);
    if (!l) { l = new Library(name); this.libs.set(name, l); }
    return l;
  }

  compile(lang: 'verilog' | 'vhdl', src: string, file: string, libName = 'work', include?: (n: string) => string | undefined): CompileResult {
    const lib = this.ensure(libName);
    const log: string[] = [];
    try {
      let units: Unit[];
      if (lang === 'verilog') {
        units = parseVerilog(src, file, { defines: new Map(this.defines), include });
      } else {
        if (!vhdlParser) throw new CompileError('VHDL front-end not available');
        units = vhdlParser(src, file);
        // validate architecture/body references
        for (const u of units) {
          if (u.kind === 'architecture' && !lib.modules.has(u.of!) && !units.some(x => x.kind === 'entity' && x.name === u.of)) {
            throw new CompileError(`(vcom-1136) Unknown entity "${u.of}" for architecture "${u.name}".`, { file, line: u.line });
          }
        }
      }
      for (const u of units) {
        u.source = undefined;
        lib.add(u);
        log.push(lang === 'verilog' ? `-- Compiling module ${u.name}` : `-- Compiling ${u.kind.replace('_', ' ')} ${u.name}${u.of ? ` of ${u.of}` : ''}`);
      }
      return { ok: true, units, errors: [], log };
    } catch (e) {
      if (e instanceof CompileError) {
        return { ok: false, units: [], errors: [{ msg: e.message, file: e.loc?.file ?? file, line: e.loc?.line ?? 0 }], log };
      }
      throw e;
    }
  }

  findDesign(name: string, lib?: string, arch?: string) {
    const libs = lib ? [this.libs.get(lib)].filter(Boolean) as Library[] : [this.libs.get('work')!, ...[...this.libs.values()].filter(l => l.name !== 'work')];
    for (const l of libs) {
      let u = l.modules.get(name);
      if (!u) for (const [n, m] of l.modules) if (n.toLowerCase() === name.toLowerCase()) { u = m; break; }
      if (!u) continue;
      if (u.kind === 'entity') {
        const as = l.archs.get(u.name) ?? [];
        const a = arch ? as.find(x => x.name === arch.toLowerCase()) : as[as.length - 1];
        if (!a) throw new CompileError(`(vsim-3173) Entity '${u.name}' has no architecture${arch ? ` '${arch}'` : ''}.`);
        return { unit: u, arch: a, libName: l.name };
      }
      return { unit: u, libName: l.name };
    }
    return undefined;
  }

  findPackage(name: string, lib?: string) {
    const l = this.libs.get(lib ?? 'work') ?? this.libs.get('work')!;
    const pkg = l.packages.get(name);
    if (!pkg) return undefined;
    return { pkg, body: l.bodies.get(name), libName: l.name };
  }

  /** Names of units that are not instantiated by any other unit (candidate tops). */
  topLevels(libName = 'work'): string[] {
    const lib = this.libs.get(libName);
    if (!lib) return [];
    const used = new Set<string>();
    const scan = (items: Unit['items']) => {
      for (const it of items) {
        if (it.k === 'inst') used.add(it.module.toLowerCase());
        if (it.k === 'genfor') scan(it.items);
        if (it.k === 'genif') { scan(it.then); if (it.else) scan(it.else); }
      }
    };
    for (const u of lib.modules.values()) scan(u.items);
    for (const as of lib.archs.values()) for (const a of as) scan(a.items);
    return [...lib.modules.keys()].filter(n => !used.has(n.toLowerCase()));
  }
}
