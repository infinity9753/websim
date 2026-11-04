// Minimal ZIP writer (#59): stored entries (no compression), CRC-32, UTF-8 names. Enough for project downloads.
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

export function crc32(d: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A .zip archive of `files` (path -> text or bytes), dated `date` (DOS time, local fields as given). */
export function zip(files: Record<string, string | Uint8Array>, date = new Date(2026, 0, 1)): Uint8Array {
  const enc = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const n = enc.encode(name), d = typeof content === 'string' ? enc.encode(content) : content, crc = crc32(d);
    const local = new Uint8Array(30 + n.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true); lv.setUint16(12, day, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, d.length, true); lv.setUint32(22, d.length, true); lv.setUint16(26, n.length, true); lv.setUint16(28, 0, true);
    local.set(n, 30);
    const cen = new Uint8Array(46 + n.length), cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true); cv.setUint16(14, day, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, d.length, true); cv.setUint32(24, d.length, true); cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    cen.set(n, 46);
    parts.push(local, d); central.push(cen);
    offset += local.length + d.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, size, true); ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end], out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

/** Entries of a stored .zip (for tests and round trips). */
export function unzip(z: Uint8Array): Record<string, Uint8Array> {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength), dec = new TextDecoder(), out: Record<string, Uint8Array> = {};
  let e = z.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('unzip: no end of central directory');
  let p = v.getUint32(e + 16, true);
  for (let i = 0, n = v.getUint16(e + 10, true); i < n; i++) {
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    const name = dec.decode(z.subarray(p + 46, p + 46 + nl));
    const size = v.getUint32(off + 18, true), lnl = v.getUint16(off + 26, true), lxl = v.getUint16(off + 28, true);
    out[name] = z.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + size);
    p += 46 + nl + xl + cl;
  }
  return out;
}
