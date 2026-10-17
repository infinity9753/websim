import { describe, it, expect } from 'vitest';
import * as L from '../src/engine/logic';

const b = (s: string) => L.fromBits(s);

describe('4-state logic', () => {
  it('bitwise ops follow 4-state truth tables', () => {
    expect(L.toBin(L.and(b('01xz'), b('1111')))).toBe('01xx');
    expect(L.toBin(L.and(b('01xz'), b('0000')))).toBe('0000');
    expect(L.toBin(L.or(b('01xz'), b('1111')))).toBe('1111');
    expect(L.toBin(L.or(b('01xz'), b('0000')))).toBe('01xx');
    expect(L.toBin(L.xor(b('0101'), b('0011')))).toBe('0110');
    expect(L.toBin(L.not(b('01xz')))).toBe('10xx');
  });

  it('arithmetic and X propagation', () => {
    expect(L.add(L.fromInt(200, 8), L.fromInt(100, 8)).a).toBe(44n);
    expect(L.toBin(L.add(b('000x'), b('0001')))).toBe('xxxx');
    expect(L.sub(L.fromInt(0, 4), L.fromInt(1, 4)).a).toBe(15n);
    expect(L.toBin(L.div(L.fromInt(5, 4), L.fromInt(0, 4)))).toBe('xxxx');
  });

  it('comparison', () => {
    expect(L.eq(b('1x'), b('0x'))).toEqual(L.ZERO);
    expect(L.eq(b('1x'), b('1x')).b).toBe(1n);
    expect(L.caseEq(b('1x'), b('1x'))).toEqual(L.ONE);
    const m1 = L.fromInt(-1, 8, true);
    expect(L.lt(m1, L.fromInt(1, 8, true))).toEqual(L.ONE);
    expect(L.lt(m1.withSign(false), L.fromInt(1, 8))).toEqual(L.ZERO);
    expect(L.wildEq(b('1010'), b('1z1z'), 'casez')).toBe(true);
  });

  it('shifts, concat, slice, insert', () => {
    expect(L.toBin(L.shl(b('0011'), L.fromInt(1)))).toBe('0110');
    expect(L.toBin(L.ashr(L.fromBits('1000', true), L.fromInt(2)))).toBe('1110');
    expect(L.toBin(L.concat([b('10'), b('x1')]))).toBe('10x1');
    expect(L.toBin(L.slice(b('110010'), 1, 3))).toBe('001');
    expect(L.toBin(L.insert(b('0000'), 1, b('11')))).toBe('0110');
  });

  it('resolution of multiple drivers', () => {
    expect(L.toBin(L.resolve(4, [b('zz10'), b('01zz')]))).toBe('0110');
    expect(L.toBin(L.resolve(2, [b('10'), b('11')]))).toBe('1x');
  });

  it('formatting', () => {
    expect(L.toHex(L.fromInt(0xab, 8))).toBe('ab');
    expect(L.toHex(b('1x00zzzz'))).toBe('Xz');
    expect(L.toDec(L.fromInt(-3, 8, true))).toBe('-3');
    expect(L.decWidth(8)).toBe(3);
  });
});
