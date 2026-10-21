// LEF (technology + cell abstracts) and DEF (placed and routed design) writers for the ASIC flow (#51).
import { CELLS, LIB_NAME, ROW_H, ROW_TRACKS, TRACK } from './cells';
import { cellLayout, metal, tc, VIA_CUT, VIA_PAD, WIRE_W, type Layout } from './layout';
import type { Netlist } from './netlist';
import type { Placement } from './place';
import { horizontal, powerGrid, type Routing } from './route';

const um = (nm: number) => +(nm / 1000).toFixed(3);

/** Technology and abstract views of the library cells. */
export function writeLef(layers = 5): string {
  const o = ['VERSION 5.8 ;', 'BUSBITCHARS "[]" ;', 'DIVIDERCHAR "/" ;', `# ${LIB_NAME}: invented educational technology and cells (WebSim)`, '', 'UNITS', '  DATABASE MICRONS 1000 ;', 'END UNITS', 'MANUFACTURINGGRID 0.005 ;', ''];
  for (let k = 1; k <= layers; k++) {
    o.push(`LAYER ${metal(k)}`, '  TYPE ROUTING ;', `  DIRECTION ${k === 1 || horizontal(k) ? 'HORIZONTAL' : 'VERTICAL'} ;`, `  PITCH ${um(TRACK)} ;`, `  WIDTH ${um(WIRE_W)} ;`, `  SPACING ${um(TRACK - WIRE_W)} ;`, `END ${metal(k)}`, '');
    if (k < layers) o.push(`LAYER VIA${k}`, '  TYPE CUT ;', `  WIDTH ${um(VIA_CUT)} ;`, `END VIA${k}`, '');
  }
  for (let k = 1; k < layers; k++) {
    const h = um(VIA_PAD / 2), c = um(VIA_CUT / 2);
    o.push(`VIA VIA${k}${k + 1} DEFAULT`, `  LAYER M${k} ;`, `    RECT ${-h} ${-h} ${h} ${h} ;`, `  LAYER VIA${k} ;`, `    RECT ${-c} ${-c} ${c} ${c} ;`, `  LAYER M${k + 1} ;`, `    RECT ${-h} ${-h} ${h} ${h} ;`, `END VIA${k}${k + 1}`, '');
  }
  o.push('SITE core', '  CLASS CORE ;', '  SYMMETRY X ;', `  SIZE ${um(TRACK)} BY ${um(ROW_H)} ;`, 'END core', '');
  for (const c of CELLS) {
    const lay = cellLayout(c);
    const cls = c.kind === 'fill' ? 'CORE SPACER' : c.name === 'TIEHI' ? 'CORE TIEHIGH' : c.name === 'TIELO' ? 'CORE TIELOW' : 'CORE';
    o.push(`MACRO ${c.name}`, `  CLASS ${cls} ;`, '  ORIGIN 0 0 ;', `  SIZE ${um(c.width * TRACK)} BY ${um(ROW_H)} ;`, '  SYMMETRY X Y ;', '  SITE core ;');
    for (const [name, p] of Object.entries(c.pins)) {
      const dir = name === c.output ? 'OUTPUT' : 'INPUT';
      const x = tc(p.x), y = tc(p.y);
      o.push(`  PIN ${name}`, `    DIRECTION ${dir} ;`, '    USE SIGNAL ;', '    PORT', '      LAYER M1 ;', `        RECT ${um(x - 70)} ${um(y - 0.45 * TRACK)} ${um(x + 70)} ${um(y + 0.45 * TRACK)} ;`, '    END', `  END ${name}`);
    }
    o.push('  PIN VDD', '    DIRECTION INOUT ;', '    USE POWER ;', '    SHAPE ABUTMENT ;', '    PORT', '      LAYER M1 ;', `        RECT 0 ${um(ROW_H - 120)} ${um(c.width * TRACK)} ${um(ROW_H)} ;`, '    END', '  END VDD');
    o.push('  PIN VSS', '    DIRECTION INOUT ;', '    USE GROUND ;', '    SHAPE ABUTMENT ;', '    PORT', '      LAYER M1 ;', `        RECT 0 0 ${um(c.width * TRACK)} ${um(120)} ;`, '    END', '  END VSS');
    const obs = lay.rects.filter(r => r[0] === 'M1' && r[2] > 0 && r[4] < ROW_H && !Object.values(c.pins).some(p => Math.abs(tc(p.x) - (r[1] + r[3]) / 2) < 1 && r[2] < tc(p.y) && r[4] > tc(p.y)));
    if (obs.length) o.push('  OBS', '    LAYER M1 ;', ...obs.map(r => `      RECT ${um(r[1])} ${um(r[2])} ${um(r[3])} ${um(r[4])} ;`), '  END');
    o.push(`END ${c.name}`, '');
  }
  o.push('END LIBRARY');
  return o.join('\n') + '\n';
}

const esc = (s: string) => s.replace(/[\s;]/g, '_');

/** The placed and routed design (positions in nm, 1000 DBU per micron). */
export function writeDef(nl: Netlist, p: Placement, r: Routing, l: Layout): string {
  const o = ['VERSION 5.8 ;', 'DIVIDERCHAR "/" ;', 'BUSBITCHARS "[]" ;', `DESIGN ${esc(nl.top)} ;`, 'UNITS DISTANCE MICRONS 1000 ;', `DIEAREA ( 0 0 ) ( ${l.die[0]} ${l.die[1]} ) ;`, ''];
  for (let row = 0; row < p.rows; row++) o.push(`ROW ROW_${row} core ${p.margin * TRACK} ${(p.margin + row * ROW_TRACKS) * TRACK} ${row % 2 ? 'FS' : 'N'} DO ${p.cols} BY 1 STEP ${TRACK} 0 ;`);
  o.push('');
  for (let k = 2; k <= r.layers + 1; k++) {
    o.push(`TRACKS X ${TRACK / 2} DO ${p.dieW} STEP ${TRACK} LAYER ${metal(k)} ;`, `TRACKS Y ${TRACK / 2} DO ${p.dieH} STEP ${TRACK} LAYER ${metal(k)} ;`);
  }
  o.push('', `COMPONENTS ${l.instances.length} ;`);
  for (const i of l.instances) o.push(`  - ${esc(i.name)} ${i.type} + PLACED ( ${i.x} ${i.y} ) ${i.flip ? 'FS' : 'N'} ;`);
  o.push('END COMPONENTS', '', `PINS ${nl.ports.length + 2} ;`);
  const netName = new Map(nl.nets.map(n => [n.id, esc(n.name)]));
  nl.ports.forEach((q, i) => {
    const pp = p.ports[i], h = VIA_PAD / 2;
    o.push(`  - ${esc(q.name)} + NET ${netName.get(q.net)} + DIRECTION ${q.dir.toUpperCase()} + USE SIGNAL`, `    + LAYER ${metal(pp.layer)} ( ${-h} ${-h} ) ( ${h} ${h} ) + PLACED ( ${tc(pp.x)} ${tc(pp.y)} ) N ;`);
  });
  const pg = powerGrid(p);
  for (const s of pg.straps) o.push(`  - ${s.net} + NET ${s.net} + DIRECTION INOUT + USE ${s.net === 'VDD' ? 'POWER' : 'GROUND'}`, `    + LAYER M3 ( -200 -200 ) ( 200 200 ) + PLACED ( ${tc(s.x)} ${(l.core[1] + l.core[3]) / 2} ) N ;`);
  o.push('END PINS', '', 'SPECIALNETS 2 ;');
  for (const net of ['VDD', 'VSS'] as const) {
    const parts = [`  - ${net} ( * ${net} )`];
    const shapes = l.shapes.filter(s => s.net === net && /^M\d$/.test(s.r[0]));
    shapes.forEach((s, k) => {
      const [layer, x0, y0, x1, y1] = s.r;
      const hor = x1 - x0 >= y1 - y0, w = hor ? y1 - y0 : x1 - x0;
      const a = hor ? `( ${x0} ${(y0 + y1) / 2} ) ( ${x1} * )` : `( ${(x0 + x1) / 2} ${y0} ) ( * ${y1} )`;
      parts.push(`    ${k ? 'NEW' : '+ ROUTED'} ${layer} ${w} ${a}`);
    });
    o.push(...parts, `    + USE ${net === 'VDD' ? 'POWER' : 'GROUND'} ;`);
  }
  o.push('END SPECIALNETS', '', `NETS ${r.nets.length} ;`);
  const routed = new Map(r.nets.map(n => [n.id, n]));
  for (const net of nl.nets) {
    const conns = [...net.pins.map(t => `( ${esc(nl.cells[t.cell].name)} ${t.pin} )`), ...net.ports.map(q => `( PIN ${esc(nl.ports[q].name)} )`)];
    o.push(`  - ${netName.get(net.id)} ${conns.join(' ')}`);
    const rn = routed.get(net.id);
    const segs: string[] = [];
    for (const w of rn?.wires ?? []) segs.push(`${metal(w.layer)} ( ${tc(w.x1)} ${tc(w.y1)} ) ( ${w.x1 === w.x2 ? '*' : tc(w.x2)} ${w.y1 === w.y2 ? '*' : tc(w.y2)} )`);
    for (const v of rn?.vias ?? []) segs.push(`${metal(v.layer)} ( ${tc(v.x)} ${tc(v.y)} ) VIA${v.layer}${v.layer + 1}`);
    segs.forEach((sg, k) => o.push(`    ${k ? 'NEW' : '+ ROUTED'} ${sg}`));
    o.push('    + USE SIGNAL ;');
  }
  o.push('END NETS', '', 'END DESIGN');
  return o.join('\n') + '\n';
}
