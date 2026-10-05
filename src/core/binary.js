// Big-endian binary helpers operating on Uint8Array buffers.

export function readU8(buf, off) {
  return buf[off];
}

export function readU16(buf, off) {
  return (buf[off] << 8) | buf[off + 1];
}

export function readS16(buf, off) {
  const v = readU16(buf, off);
  return v & 0x8000 ? v - 0x10000 : v;
}

export function readU32(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

export function writeU8(buf, off, v) {
  buf[off] = v & 0xff;
}

export function writeU16(buf, off, v) {
  buf[off] = (v >> 8) & 0xff;
  buf[off + 1] = v & 0xff;
}

export const writeS16 = writeU16;

export function writeU32(buf, off, v) {
  buf[off] = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8) & 0xff;
  buf[off + 3] = v & 0xff;
}

export function readAscii(buf, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[off + i]);
  return s;
}

export function hex(v, width = 8) {
  return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(width, '0');
}

export function alignUp(v, align) {
  return Math.ceil(v / align) * align;
}

export function clampS16(v) {
  return Math.max(-32768, Math.min(32767, Math.round(v)));
}
