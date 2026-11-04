// The invented process of the educational ASIC flow (#75, #76): one table of layer heights and material constants,
// used by the cross-section view and by parasitic extraction, so a wire's drawn shape, its height in the section and
// its resistance and capacitance all come from the same numbers.
import { TRACK } from './cells';
import { VIA_CUT, WIRE_W } from './layout';

/** Vertical extent of each layer (nm; 0 = silicon surface). The wells and diffusions are below the surface. */
export const STACK: Record<string, { z0: number; z1: number; material: string }> = {
  NWELL: { z0: -1200, z1: 0, material: 'n-well' },
  DIFF: { z0: -150, z1: 0, material: 'diffusion (source / drain)' },
  POLY: { z0: 5, z1: 185, material: 'polysilicon gate on 5 nm gate oxide' },
  CONT: { z0: 0, z1: 600, material: 'tungsten contact' },
  M1: { z0: 600, z1: 760, material: 'metal 1' },
  VIA1: { z0: 760, z1: 1000, material: 'via 1 (tungsten)' },
  M2: { z0: 1000, z1: 1200, material: 'metal 2' },
  VIA2: { z0: 1200, z1: 1440, material: 'via 2 (tungsten)' },
  M3: { z0: 1440, z1: 1640, material: 'metal 3' },
  VIA3: { z0: 1640, z1: 1900, material: 'via 3 (tungsten)' },
  M4: { z0: 1900, z1: 2250, material: 'metal 4' },
  VIA4: { z0: 2250, z1: 2550, material: 'via 4 (tungsten)' },
  M5: { z0: 2550, z1: 3050, material: 'metal 5' },
};
/** Top of the dielectric above the last metal, and the depth of silicon drawn below the surface (nm). */
export const STACK_TOP = 3400, STACK_BOTTOM = -1600;

export const MATERIAL = {
  /** Effective resistivity of the metal lines including barrier and size effects, ohm nm (4 µohm cm). */
  rhoMetal: 40,
  /** Resistivity of the tungsten via fill, ohm nm (6 µohm cm), and the interface resistance of each via, ohm. */
  rhoVia: 60, viaInterface: 2,
  /** Relative permittivity of the inter-layer dielectric (SiO2). */
  epsR: 3.9,
};
const EPS0 = 8.854e-3;   // fF / µm

const thick = (layer: string) => (STACK[layer].z1 - STACK[layer].z0) / 1000;   // µm
/** Distance from the bottom of metal k to the layer below it: metal k-1, or the silicon surface for M1 (µm). */
export function heightAbove(k: number): number {
  const z0 = STACK[`M${k}`].z0;
  return (k === 1 ? z0 : z0 - STACK[`M${k - 1}`].z1) / 1000;
}

/** Sheet resistance of a metal (ohm / square). */
export const sheetR = (k: number) => MATERIAL.rhoMetal / (STACK[`M${k}`].z1 - STACK[`M${k}`].z0);

/**
 * Capacitance per µm of a wire of metal k over the layer below (fF / µm), with the empirical formula of Yuan and
 * Trick (1982) for a line over a plane: eps [ W/h + 0.77 + 1.06 (W/h)^0.25 + 1.06 (T/h)^0.5 ]. The first term is the
 * parallel-plate (area) part, the rest the fringe of both edges. No coupling to neighbours on the same layer.
 */
export function wireCap(k: number): { area: number; fringe: number } {
  const eps = EPS0 * MATERIAL.epsR, w = WIRE_W / 1000, h = heightAbove(k), t = thick(`M${k}`);
  return { area: eps * (w / h), fringe: eps * (0.77 + 1.06 * Math.pow(w / h, 0.25) + 1.06 * Math.sqrt(t / h)) };
}

/** One track of wire on metal k: resistance (ohm) and capacitance (fF). */
export function trackRC(k: number): { r: number; c: number } {
  const len = TRACK / 1000, { area, fringe } = wireCap(k);
  return { r: sheetR(k) * (TRACK / WIRE_W), c: (area + fringe) * len };
}

/** Resistance of the via between metal k and k+1 (ohm): fill resistance through its height plus the interface. */
export function viaR(k: number): number {
  const v = STACK[`VIA${k}`];
  return MATERIAL.rhoVia * (v.z1 - v.z0) / (VIA_CUT * VIA_CUT) + MATERIAL.viaInterface;
}
