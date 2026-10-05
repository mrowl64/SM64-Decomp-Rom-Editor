import { readAscii, readU32, writeU32, alignUp } from './binary.js';

// First word of the ROM header in each of the common dump byte orders.
export const ROM_MAGIC = {
  z64: 0x80371240, // big endian (native)
  v64: 0x37804012, // 16-bit byte swapped
  n64: 0x40123780, // 32-bit little endian
};

export function detectFormat(bytes) {
  if (bytes.length < 0x40) return null;
  const magic = readU32(bytes, 0);
  for (const [fmt, m] of Object.entries(ROM_MAGIC)) {
    if (magic === m) return fmt;
  }
  return null;
}

// Converts between z64 (big endian) and v64/n64 byte orders. The conversion is
// symmetric, so the same function converts in both directions.
export function convertByteOrder(bytes, format) {
  const out = new Uint8Array(bytes);
  if (format === 'v64') {
    for (let i = 0; i + 1 < out.length; i += 2) {
      const a = out[i];
      out[i] = out[i + 1];
      out[i + 1] = a;
    }
  } else if (format === 'n64') {
    for (let i = 0; i + 3 < out.length; i += 4) {
      const a = out[i];
      const b = out[i + 1];
      out[i] = out[i + 3];
      out[i + 1] = out[i + 2];
      out[i + 2] = b;
      out[i + 3] = a;
    }
  }
  return out;
}

const CHECKSUM_START = 0x1000;
const CHECKSUM_LENGTH = 0x100000;
const CIC_6102_SEED = 0xf8ca4ddc;

// CIC-NUS-6102 checksum (the boot chip used by Super Mario 64).
export function calculateChecksum(data) {
  if (data.length < CHECKSUM_START + CHECKSUM_LENGTH) {
    throw new Error('ROM is too small to calculate a checksum');
  }
  let t1 = CIC_6102_SEED;
  let t2 = CIC_6102_SEED;
  let t3 = CIC_6102_SEED;
  let t4 = CIC_6102_SEED;
  let t5 = CIC_6102_SEED;
  let t6 = CIC_6102_SEED;
  for (let i = CHECKSUM_START; i < CHECKSUM_START + CHECKSUM_LENGTH; i += 4) {
    const d = readU32(data, i);
    const sum = (t6 + d) >>> 0;
    if (sum < t6) t4 = (t4 + 1) >>> 0;
    t6 = sum;
    t3 = (t3 ^ d) >>> 0;
    const s = d & 0x1f;
    const r = s === 0 ? d : ((d << s) | (d >>> (32 - s))) >>> 0;
    t5 = (t5 + r) >>> 0;
    if (t2 > d) t2 = (t2 ^ r) >>> 0;
    else t2 = (t2 ^ t6 ^ d) >>> 0;
    t1 = (t1 + ((t5 ^ d) >>> 0)) >>> 0;
  }
  return [(t6 ^ t4 ^ t3) >>> 0, (t5 ^ t2 ^ t1) >>> 0];
}

export class Rom {
  constructor(bytes) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const format = detectFormat(input);
    if (!format) {
      throw new Error('Not an N64 ROM (unknown header magic)');
    }
    this.originalFormat = format;
    this.data = format === 'z64' ? new Uint8Array(input) : convertByteOrder(input, format);
  }

  get size() {
    return this.data.length;
  }

  get title() {
    return readAscii(this.data, 0x20, 20).replace(/\0/g, '').trim();
  }

  get gameCode() {
    return readAscii(this.data, 0x3b, 4).replace(/\0/g, '');
  }

  get checksum() {
    return [readU32(this.data, 0x10), readU32(this.data, 0x14)];
  }

  slice(start, end) {
    return this.data.slice(start, end);
  }

  write(offset, bytes) {
    if (offset < 0 || offset + bytes.length > this.data.length) {
      throw new RangeError('Write outside of ROM bounds');
    }
    this.data.set(bytes, offset);
  }

  // Appends data at the end of the ROM (aligned) and returns its ROM offset.
  append(bytes, align = 16) {
    const offset = alignUp(this.data.length, align);
    const newSize = alignUp(offset + bytes.length, 16);
    const grown = new Uint8Array(newSize);
    grown.set(this.data);
    grown.set(bytes, offset);
    this.data = grown;
    return offset;
  }

  // Shrinks the ROM to `size` bytes (used to rewrite data that was appended at the end).
  truncate(size) {
    if (size < this.data.length) this.data = this.data.slice(0, size);
  }

  updateChecksum() {
    if (this.data.length < CHECKSUM_START + CHECKSUM_LENGTH) return false;
    const [c1, c2] = calculateChecksum(this.data);
    writeU32(this.data, 0x10, c1);
    writeU32(this.data, 0x14, c2);
    return true;
  }

  export(format = 'z64') {
    return format === 'z64' ? new Uint8Array(this.data) : convertByteOrder(this.data, format);
  }
}
