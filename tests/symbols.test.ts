import { describe, it, expect } from 'vitest';
import { gateSymbol } from '../src/ui/synthesis';
import { CELLS } from '../src/engine/asic/cells';

describe('gate symbols in the synthesis schematic', () => {
  it('maps Yosys gates and the standard cells to IEEE distinctive shapes', () => {
    expect(gateSymbol('$_NAND_')).toEqual({ kind: 'and', inv: true });
    expect(gateSymbol('$_XNOR_')).toEqual({ kind: 'xor', inv: true });
    expect(gateSymbol('$_ANDNOT_')).toEqual({ kind: 'and', inv: false, invIn: [1] });
    expect(gateSymbol('$_SDFFE_PP0P_')?.kind).toBe('ff');
    expect(gateSymbol('$_DFF_P_')?.kind).toBe('ff');
    expect(gateSymbol('$_DLATCH_P_')?.kind).toBe('latch');
    expect(gateSymbol('OAI21')).toEqual({ kind: 'oai', inv: true });
    expect(gateSymbol('TIELO')).toMatchObject({ kind: 'tie', value: 0 });
    // FPGA primitives keep their boxes
    expect(gateSymbol('SB_LUT4')).toBeNull();
    expect(gateSymbol('TRELLIS_COMB')).toBeNull();
    // every logic cell of the educational library has a symbol
    for (const c of CELLS) if (c.kind !== 'fill') expect(gateSymbol(c.name), c.name).not.toBeNull();
  });
});
