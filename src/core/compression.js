import { readAscii, readU16, readU32, writeU16, writeU32, alignUp } from './binary.js';

// MIO0 and Yay0 are the LZ-style compression formats used by Super Mario 64
// (MIO0 in the original game / older decomp builds, Yay0 in newer decomp builds).

export function detectCompression(buf, off = 0) {
  if (off + 16 > buf.length) return null;
  const magic = readAscii(buf, off, 4);
  if (magic === 'MIO0') return 'mio0';
  if (magic === 'Yay0') return 'yay0';
  return null;
}

export function decompressedSize(buf, off = 0) {
  return readU32(buf, off + 4);
}

export function decodeMio0(buf, off = 0) {
  if (detectCompression(buf, off) !== 'mio0') throw new Error('Not MIO0 data');
  const size = readU32(buf, off + 4);
  let compPos = off + readU32(buf, off + 8);
  let rawPos = off + readU32(buf, off + 12);
  let layoutPos = off + 16;
  const out = new Uint8Array(size);
  let outPos = 0;
  let bits = 0;
  let bitsLeft = 0;
  while (outPos < size) {
    if (bitsLeft === 0) {
      bits = readU32(buf, layoutPos);
      layoutPos += 4;
      bitsLeft = 32;
    }
    const isRaw = bits & 0x80000000;
    bits = (bits << 1) >>> 0;
    bitsLeft--;
    if (isRaw) {
      out[outPos++] = buf[rawPos++];
    } else {
      const v = readU16(buf, compPos);
      compPos += 2;
      const length = (v >> 12) + 3;
      const dist = (v & 0xfff) + 1;
      if (dist > outPos) throw new Error('Corrupt MIO0 data');
      for (let i = 0; i < length && outPos < size; i++) {
        out[outPos] = out[outPos - dist];
        outPos++;
      }
    }
  }
  return out;
}

export function decodeYay0(buf, off = 0) {
  if (detectCompression(buf, off) !== 'yay0') throw new Error('Not Yay0 data');
  const size = readU32(buf, off + 4);
  let linkPos = off + readU32(buf, off + 8);
  let chunkPos = off + readU32(buf, off + 12);
  let maskPos = off + 16;
  const out = new Uint8Array(size);
  let outPos = 0;
  let bits = 0;
  let bitsLeft = 0;
  while (outPos < size) {
    if (bitsLeft === 0) {
      bits = readU32(buf, maskPos);
      maskPos += 4;
      bitsLeft = 32;
    }
    const isRaw = bits & 0x80000000;
    bits = (bits << 1) >>> 0;
    bitsLeft--;
    if (isRaw) {
      out[outPos++] = buf[chunkPos++];
    } else {
      const v = readU16(buf, linkPos);
      linkPos += 2;
      const dist = (v & 0xfff) + 1;
      const n = v >> 12;
      const length = n === 0 ? buf[chunkPos++] + 0x12 : n + 2;
      if (dist > outPos) throw new Error('Corrupt Yay0 data');
      for (let i = 0; i < length && outPos < size; i++) {
        out[outPos] = out[outPos - dist];
        outPos++;
      }
    }
  }
  return out;
}

export function decompress(buf, off = 0) {
  const kind = detectCompression(buf, off);
  if (kind === 'mio0') return decodeMio0(buf, off);
  if (kind === 'yay0') return decodeYay0(buf, off);
  throw new Error('Unknown compression format');
}

const WINDOW = 0x1000;
const MIN_MATCH = 3;
const MAX_CHAIN = 256;

// Builds a match finder over `data` using hash chains of 3-byte prefixes.
function createMatcher(data, maxLen) {
  const head = new Int32Array(1 << 16).fill(-1);
  const prev = new Int32Array(data.length).fill(-1);
  const hashAt = (i) => ((data[i] << 8) ^ (data[i + 1] << 4) ^ data[i + 2]) & 0xffff;
  let inserted = 0;
  const insertUpTo = (pos) => {
    for (; inserted < pos; inserted++) {
      if (inserted + 2 >= data.length) continue;
      const h = hashAt(inserted);
      prev[inserted] = head[h];
      head[h] = inserted;
    }
  };
  const find = (pos) => {
    insertUpTo(pos);
    if (pos + MIN_MATCH > data.length) return { length: 0, dist: 0 };
    const limit = Math.min(maxLen, data.length - pos);
    let bestLen = 0;
    let bestDist = 0;
    let cand = head[hashAt(pos)];
    let chain = 0;
    while (cand >= 0 && pos - cand <= WINDOW && chain++ < MAX_CHAIN) {
      let len = 0;
      while (len < limit && data[cand + len] === data[pos + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestDist = pos - cand;
        if (len === limit) break;
      }
      cand = prev[cand];
    }
    return bestLen >= MIN_MATCH ? { length: bestLen, dist: bestDist } : { length: 0, dist: 0 };
  };
  return find;
}

// Produces a token stream (literals and back-references) with one step of lazy matching.
function tokenize(data, maxLen) {
  const find = createMatcher(data, maxLen);
  const tokens = [];
  let pos = 0;
  while (pos < data.length) {
    const m = find(pos);
    if (m.length >= MIN_MATCH) {
      if (pos + 1 < data.length) {
        const next = find(pos + 1);
        if (next.length > m.length + 1) {
          tokens.push({ literal: data[pos] });
          pos++;
          tokens.push({ length: next.length, dist: next.dist });
          pos += next.length;
          continue;
        }
      }
      tokens.push({ length: m.length, dist: m.dist });
      pos += m.length;
    } else {
      tokens.push({ literal: data[pos] });
      pos++;
    }
  }
  return tokens;
}

function packBits(flags) {
  const words = Math.ceil(flags.length / 32);
  const out = new Uint8Array(words * 4);
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

function assemble(magic, size, layout, compressed, raw) {
  const compOffset = 16 + layout.length;
  const rawOffset = alignUp(compOffset + compressed.length, 4);
  const total = alignUp(rawOffset + raw.length, 16);
  const out = new Uint8Array(total);
  for (let i = 0; i < 4; i++) out[i] = magic.charCodeAt(i);
  writeU32(out, 4, size);
  writeU32(out, 8, compOffset);
  writeU32(out, 12, rawOffset);
  out.set(layout, 16);
  out.set(compressed, compOffset);
  out.set(raw, rawOffset);
  return out;
}

export function encodeMio0(data) {
  const tokens = tokenize(data, 18);
  const flags = [];
  const comp = new Uint8Array(tokens.length * 2);
  const raw = new Uint8Array(data.length);
  let compLen = 0;
  let rawLen = 0;
  for (const t of tokens) {
    if (t.literal !== undefined) {
      flags.push(1);
      raw[rawLen++] = t.literal;
    } else {
      flags.push(0);
      writeU16(comp, compLen, ((t.length - 3) << 12) | (t.dist - 1));
      compLen += 2;
    }
  }
  return assemble('MIO0', data.length, packBits(flags), comp.subarray(0, compLen), raw.subarray(0, rawLen));
}

export function encodeYay0(data) {
  const tokens = tokenize(data, 0x111);
  const flags = [];
  const link = new Uint8Array(tokens.length * 2);
  const chunk = new Uint8Array(data.length + tokens.length);
  let linkLen = 0;
  let chunkLen = 0;
  for (const t of tokens) {
    if (t.literal !== undefined) {
      flags.push(1);
      chunk[chunkLen++] = t.literal;
    } else {
      flags.push(0);
      if (t.length >= 0x12) {
        writeU16(link, linkLen, t.dist - 1);
        chunk[chunkLen++] = t.length - 0x12;
      } else {
        writeU16(link, linkLen, ((t.length - 2) << 12) | (t.dist - 1));
      }
      linkLen += 2;
    }
  }
  return assemble('Yay0', data.length, packBits(flags), link.subarray(0, linkLen), chunk.subarray(0, chunkLen));
}

export function compress(kind, data) {
  if (kind === 'mio0') return encodeMio0(data);
  if (kind === 'yay0') return encodeYay0(data);
  throw new Error(`Unsupported compression format: ${kind}`);
}
