/// <reference types="vite/client" />

declare module 'virtual:yosys-sim' {
  /** Yosys simulation models of FPGA primitives, by path in the Yosys share directory (see vite.config.ts). */
  const files: Record<string, string>;
  export default files;
}
