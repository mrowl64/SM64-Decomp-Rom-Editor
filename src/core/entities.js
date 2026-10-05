import { readU16, readU32, readS16, writeU16, writeU32, writeS16, hex } from './binary.js';

// A segment as loaded by a level script command (LOAD_RAW, LOAD_MIO0/LOAD_YAY0, EXECUTE).
// Decompressed data is loaded lazily and edits are written into `data` and marked dirty
// until they are committed back to the ROM.
export class LoadedSegment {
  constructor(rom, seg, kind, romStart, romEnd, decompress) {
    this.rom = rom;
    this.seg = seg;
    this.kind = kind; // 'raw' | 'mio0' | 'yay0'
    this.romStart = romStart;
    this.romEnd = romEnd;
    this.loadRefs = []; // level script commands that load this segment: { segment, offset }
    this.dirty = false;
    this._decompress = decompress;
    this._data = null;
  }

  get data() {
    if (!this._data) {
      if (this.kind === 'raw') {
        this._data = this.rom.slice(this.romStart, this.romEnd);
      } else {
        this._data = this._decompress(this.rom.data.subarray(this.romStart, this.romEnd));
      }
    }
    return this._data;
  }

  get isLoaded() {
    return this._data !== null;
  }

  markDirty() {
    this.dirty = true;
  }

  toString() {
    return `seg ${hex(this.seg, 2)} @ ROM ${hex(this.romStart)}-${hex(this.romEnd)} (${this.kind})`;
  }
}

// Base class for all editable level entities. Each entity is backed by bytes inside a
// LoadedSegment and knows how to read and write its fields.
export class Entity {
  constructor(segment, offset) {
    this.segment = segment;
    this.offset = offset;
  }

  get fields() {
    return this.constructor.fields;
  }

  get position() {
    return null;
  }

  set position(_) {
    throw new Error('Entity has no position');
  }

  snapshot() {
    const s = {};
    for (const f of this.fields) s[f.key] = this[f.key];
    return s;
  }

  restore(snapshot) {
    Object.assign(this, snapshot);
    this.write();
  }

  setField(key, value) {
    const f = this.fields.find((x) => x.key === key);
    if (!f) throw new Error(`Unknown field ${key}`);
    if (f.readOnly) throw new Error(`Field ${key} is read-only`);
    this[key] = validateField(f, value);
    this.write();
  }

  write() {
    const buf = this.segment.data;
    for (const f of this.fields) {
      if (f.readOnly || f.offset === undefined) continue;
      writeField(buf, this.offset + f.offset, f.type, this[f.key]);
    }
    this.segment.markDirty();
  }

  read() {
    const buf = this.segment.data;
    for (const f of this.fields) {
      if (f.offset === undefined) continue;
      this[f.key] = readField(buf, this.offset + f.offset, f.type);
    }
  }
}

const FIELD_RANGES = {
  u8: [0, 0xff],
  s16: [-0x8000, 0x7fff],
  u16: [0, 0xffff],
  u32: [0, 0xffffffff],
};

export function validateField(field, value) {
  let v = typeof value === 'string' ? parseNumber(value) : value;
  if (!Number.isFinite(v)) throw new Error(`Invalid value for ${field.label}`);
  v = Math.round(v);
  const [min, max] = field.range ?? FIELD_RANGES[field.type] ?? [-Infinity, Infinity];
  if (v < min || v > max) throw new Error(`${field.label} must be between ${min} and ${max}`);
  return v;
}

export function parseNumber(text) {
  const t = String(text).trim();
  if (/^-?0x[0-9a-f]+$/i.test(t)) {
    const neg = t.startsWith('-');
    const v = parseInt(t.replace(/^-/, ''), 16);
    return neg ? -v : v;
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return NaN;
}

function readField(buf, off, type) {
  switch (type) {
    case 'u8':
      return buf[off];
    case 's16':
      return readS16(buf, off);
    case 'u16':
      return readU16(buf, off);
    case 'u32':
      return readU32(buf, off);
    default:
      throw new Error(`Unknown field type ${type}`);
  }
}

function writeField(buf, off, type, v) {
  switch (type) {
    case 'u8':
      buf[off] = v & 0xff;
      break;
    case 's16':
      writeS16(buf, off, v);
      break;
    case 'u16':
      writeU16(buf, off, v);
      break;
    case 'u32':
      writeU32(buf, off, v >>> 0);
      break;
    default:
      throw new Error(`Unknown field type ${type}`);
  }
}

// OBJECT_WITH_ACTS(model, posX, posY, posZ, angleX, angleY, angleZ, behParam, beh, acts)
export class LevelObject extends Entity {
  static fields = [
    { key: 'model', label: 'Model ID', type: 'u8', offset: 3, hex: true },
    { key: 'x', label: 'X', type: 's16', offset: 4 },
    { key: 'y', label: 'Y', type: 's16', offset: 6 },
    { key: 'z', label: 'Z', type: 's16', offset: 8 },
    { key: 'rx', label: 'Rot X (deg)', type: 's16', offset: 10 },
    { key: 'ry', label: 'Rot Y (deg)', type: 's16', offset: 12 },
    { key: 'rz', label: 'Rot Z (deg)', type: 's16', offset: 14 },
    { key: 'bparam', label: 'Behavior Param', type: 'u32', offset: 16, hex: true },
    { key: 'behavior', label: 'Behavior', type: 'u32', offset: 20, hex: true, behavior: true },
    { key: 'acts', label: 'Acts (bitmask)', type: 'u8', offset: 2, hex: true },
  ];

  constructor(segment, offset) {
    super(segment, offset);
    this.kind = 'object';
    this.read();
  }

  get position() {
    return [this.x, this.y, this.z];
  }

  set position([x, y, z]) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.write();
  }

  get yawDegrees() {
    return this.ry;
  }
}

// MARIO_POS(area, yaw, posX, posY, posZ)
export class MarioStart extends Entity {
  static fields = [
    { key: 'area', label: 'Area', type: 'u8', offset: 2 },
    { key: 'yaw', label: 'Yaw (deg)', type: 's16', offset: 4 },
    { key: 'x', label: 'X', type: 's16', offset: 6 },
    { key: 'y', label: 'Y', type: 's16', offset: 8 },
    { key: 'z', label: 'Z', type: 's16', offset: 10 },
  ];

  constructor(segment, offset) {
    super(segment, offset);
    this.kind = 'mario';
    this.read();
  }

  get position() {
    return [this.x, this.y, this.z];
  }

  set position([x, y, z]) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.write();
  }

  get yawDegrees() {
    return this.yaw;
  }
}

export const MACRO_PRESET_OFFSET = 0x1f;
export const MACRO_OBJECT_END = 0x1e;

// MACRO_OBJECT_WITH_BHV_PARAM(preset, yaw, posX, posY, posZ, behParam): 5 halfwords.
// The first halfword packs the yaw (7 bits, in units of 45/16 degrees) and the preset ID + 0x1F.
export class MacroObject extends Entity {
  static fields = [
    { key: 'preset', label: 'Preset ID', type: 'u16', range: [0, 0x1ff - MACRO_PRESET_OFFSET], hex: true },
    { key: 'yaw', label: 'Yaw (deg, 2.8125 steps)', type: 'u16', range: [0, 359] },
    { key: 'x', label: 'X', type: 's16', offset: 2 },
    { key: 'y', label: 'Y', type: 's16', offset: 4 },
    { key: 'z', label: 'Z', type: 's16', offset: 6 },
    { key: 'bparam', label: 'Behavior Param', type: 'u16', offset: 8, hex: true },
  ];

  constructor(segment, offset) {
    super(segment, offset);
    this.kind = 'macro';
    this.read();
  }

  read() {
    super.read();
    const word = readU16(this.segment.data, this.offset);
    this.preset = (word & 0x1ff) - MACRO_PRESET_OFFSET;
    this.yaw = Math.round(((word >> 9) * 45) / 16);
  }

  write() {
    const yawField = Math.round((this.yaw * 16) / 45) & 0x7f;
    writeU16(this.segment.data, this.offset, (yawField << 9) | (this.preset + MACRO_PRESET_OFFSET));
    super.write();
  }

  get position() {
    return [this.x, this.y, this.z];
  }

  set position([x, y, z]) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.write();
  }

  get yawDegrees() {
    return this.yaw;
  }
}

// WARP_NODE / PAINTING_WARP_NODE(id, destLevel, destArea, destNode, flags)
export class WarpNode extends Entity {
  static fields = [
    { key: 'id', label: 'Warp ID', type: 'u8', offset: 2, hex: true },
    { key: 'destLevel', label: 'Dest Level', type: 'u8', offset: 3 },
    { key: 'destArea', label: 'Dest Area', type: 'u8', offset: 4 },
    { key: 'destNode', label: 'Dest Node', type: 'u8', offset: 5, hex: true },
    { key: 'flags', label: 'Flags', type: 'u8', offset: 6, hex: true },
  ];

  constructor(segment, offset, painting) {
    super(segment, offset);
    this.kind = painting ? 'paintingWarp' : 'warp';
    this.read();
  }
}

// INSTANT_WARP(index, destArea, displaceX, displaceY, displaceZ)
export class InstantWarp extends Entity {
  static fields = [
    { key: 'index', label: 'Index', type: 'u8', offset: 2 },
    { key: 'destArea', label: 'Dest Area', type: 'u8', offset: 3 },
    { key: 'dx', label: 'Displace X', type: 's16', offset: 4 },
    { key: 'dy', label: 'Displace Y', type: 's16', offset: 6 },
    { key: 'dz', label: 'Displace Z', type: 's16', offset: 8 },
  ];

  constructor(segment, offset) {
    super(segment, offset);
    this.kind = 'instantWarp';
    this.read();
  }
}

export function parseMacroObjects(segment, offset) {
  const list = [];
  const buf = segment.data;
  let off = offset;
  while (off + 10 <= buf.length) {
    const word = readU16(buf, off);
    if (word === 0xffff || (word & 0x1ff) < MACRO_PRESET_OFFSET) break;
    list.push(new MacroObject(segment, off));
    off += 10;
  }
  return list;
}
