// VHDL front-end registration with the library manager.
import { registerVhdlParser } from '../library';
import { parseVhdl } from './parser';

registerVhdlParser(parseVhdl);

export { parseVhdl };
