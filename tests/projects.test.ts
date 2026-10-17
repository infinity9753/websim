import { describe, it, expect, beforeEach } from 'vitest';
import { Session } from '../src/engine/commands';
import { BrowserFS, projects } from '../src/ui/vfs';
import { searchFiles } from '../src/ui/search';

// minimal localStorage for the browser file store
class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}

describe('projects, folders and search (#40)', () => {
  beforeEach(() => { (globalThis as { localStorage?: unknown }).localStorage = new MemStorage(); });

  it('keeps files per project', () => {
    const a = new BrowserFS();
    a.write('top.v', 'module top; endmodule');
    const id = projects.create('Second');
    projects.select(id);
    const b = new BrowserFS();
    expect(b.list()).toEqual([]);
    b.write('rtl/alu.v', 'module alu; endmodule');
    projects.select('default');
    expect(new BrowserFS().list()).toEqual(['top.v']);
    projects.select(id);
    expect(new BrowserFS().list()).toEqual(['rtl/alu.v']);
    expect(projects.list().map(p => p.name)).toEqual(['Default', 'Second']);
    expect(projects.remove(id)).toBe(false); // the current project cannot be deleted
  });

  it('folders: implicit, explicit, rename and remove', () => {
    const fs = new BrowserFS();
    fs.write('rtl/core/alu.v', 'a');
    fs.write('rtl/top.v', 'b');
    fs.write('tb/tb.v', 'c');
    fs.addFolder('docs');
    expect(fs.allFolders()).toEqual(['docs', 'rtl', 'rtl/core', 'tb']);
    expect(fs.renameFolder('rtl', 'src')).toBe(true);
    expect(fs.list()).toEqual(['src/core/alu.v', 'src/top.v', 'tb/tb.v']);
    fs.removeFolder('src/core');
    expect(fs.list()).toEqual(['src/top.v', 'tb/tb.v']);
  });

  it('searches every file', () => {
    const fs = new BrowserFS();
    fs.write('a.v', 'module a;\n  wire clk;\nendmodule');
    fs.write('b/b.v', 'module b; // CLK domain\nendmodule');
    expect(searchFiles(fs, 'clk', {}).map(h => `${h.file}:${h.line}:${h.col}`)).toEqual(['a.v:2:7', 'b/b.v:1:13']);
    expect(searchFiles(fs, 'clk', { caseSensitive: true }).length).toBe(1);
    expect(searchFiles(fs, 'mod', { word: true }).length).toBe(0);
    expect(searchFiles(fs, '^module \\w;', { regex: true }).map(h => h.file)).toEqual(['a.v', 'b/b.v']);
  });

  it('compiles files in folders: * stays in its folder, `include is relative to the file', async () => {
    const files: Record<string, string> = {
      'rtl/defs.vh': '`define W 4',
      'rtl/cnt.v': '`include "defs.vh"\nmodule cnt(output [`W-1:0] q); assign q = 5; endmodule',
      'inc/more.vh': '`define V 7',
      'tb/tb.v': '`include "more.vh"\nmodule tb; wire [3:0] q; cnt u(q); initial #1 $display("%0d %0d", q, `V); endmodule',
      'other.v': 'module other; endmodule',
    };
    const out: string[] = [];
    const s = new Session({ read: n => files[n], list: () => Object.keys(files) }, m => out.push(m));
    await s.exec('vlog rtl/*.v');
    expect(out.filter(l => l.startsWith('-- Compiling file'))).toEqual(['-- Compiling file rtl/cnt.v']);
    await s.exec('vlog +incdir+inc tb/tb.v');
    await s.exec('vsim tb; run 2');
    expect(out).toContain('5 7');
  });
});
