import { readU32, writeU32, hex, alignUp } from './binary.js';
import { compress, decompress, detectCompression } from './compression.js';
import { Collision } from './collision.js';
import {
  LoadedSegment,
  LevelObject,
  MarioStart,
  WarpNode,
  InstantWarp,
  parseMacroObjects,
} from './entities.js';
import { levelName } from './names.js';

const SEG_LEVEL_SCRIPT = 0x0e;
const SEG_MAIN_SCRIPTS = 0x15;
const MAX_SCRIPT_SEGMENT = 0x400000;
const OP_EQ = 2;

function looksLikeScript(buf, off, end) {
  if (off + 4 > end) return false;
  const op = buf[off];
  const len = buf[off + 1];
  return op <= 0x3c && len >= 4 && len % 4 === 0 && off + len <= end;
}

// Reads an EXECUTE(seg, romStart, romEnd, entry) command at `off`, or returns null.
function readExecute(buf, off, wantSeg) {
  if (off + 0x18 > buf.length) return null;
  if (buf[off] !== 0x00 || buf[off + 1] !== 0x18 || buf[off + 2] !== 0x00) return null;
  const seg = buf[off + 3];
  if (wantSeg !== undefined && seg !== wantSeg) return null;
  const romStart = readU32(buf, off + 4);
  const romEnd = readU32(buf, off + 8);
  const entry = readU32(buf, off + 12);
  if (!(romStart < romEnd && romEnd <= buf.length && romEnd - romStart <= MAX_SCRIPT_SEGMENT)) return null;
  if (entry >>> 24 !== seg || (entry & 0xffffff) >= romEnd - romStart) return null;
  if (!looksLikeScript(buf, romStart + (entry & 0xffffff), romEnd)) return null;
  return { seg, romStart, romEnd, entry };
}

// Finds all level scripts in the ROM. Level scripts are loaded into segment 0x0E by
// EXECUTE commands; the level numbers are recovered from the JUMP_IF table in the
// main scripts segment (0x15), which works for vanilla and decomp built ROMs alike.
export function discoverLevels(rom) {
  const buf = rom.data;
  const levels = new Map();
  const mainScripts = new Map();
  for (let off = 0; off + 0x18 <= buf.length; off += 4) {
    if (buf[off] !== 0x00 || buf[off + 1] !== 0x18 || buf[off + 2] !== 0x00) continue;
    const seg = buf[off + 3];
    if (seg !== SEG_LEVEL_SCRIPT && seg !== SEG_MAIN_SCRIPTS) continue;
    const exec = readExecute(buf, off, seg);
    if (!exec) continue;
    if (seg === SEG_LEVEL_SCRIPT) {
      const key = `${exec.romStart}:${exec.entry}`;
      if (!levels.has(key)) levels.set(key, { ...exec, levelId: null, executeOffsets: [] });
      levels.get(key).executeOffsets.push(off);
    } else {
      mainScripts.set(`${exec.romStart}:${exec.romEnd}`, exec);
    }
  }

  for (const main of mainScripts.values()) {
    for (let off = main.romStart; off + 12 <= main.romEnd; off += 4) {
      const op = buf[off];
      if ((op !== 0x0c && op !== 0x0d) || buf[off + 1] !== 0x0c || buf[off + 2] !== OP_EQ) continue;
      const levelId = readU32(buf, off + 4);
      const target = readU32(buf, off + 8);
      if (target >>> 24 !== SEG_MAIN_SCRIPTS || levelId > 0xff) continue;
      const exec = readExecute(buf, main.romStart + (target & 0xffffff), SEG_LEVEL_SCRIPT);
      if (!exec) continue;
      const level = levels.get(`${exec.romStart}:${exec.entry}`);
      if (level && level.levelId === null) level.levelId = levelId;
    }
  }

  return [...levels.values()]
    .map((l) => ({
      ...l,
      name: l.levelId !== null ? levelName(l.levelId) : `Unknown level @ ${hex(l.romStart)}`,
    }))
    .sort((a, b) => {
      if (a.levelId !== null && b.levelId !== null) return a.levelId - b.levelId;
      if (a.levelId !== null) return -1;
      if (b.levelId !== null) return 1;
      return a.romStart - b.romStart;
    });
}

export class Area {
  constructor(index) {
    this.index = index;
    this.geoLayout = null;
    this.objects = [];
    this.macroObjects = [];
    this.warps = [];
    this.instantWarps = [];
    this.collision = null;
    this.terrainAddress = null;
    this.macroAddress = null;
  }
}

// A parsed level: walks the level script, collecting areas, objects, warps,
// collision and macro objects, and writes edits back into the ROM on commit().
export class Level {
  constructor(rom, info) {
    this.rom = rom;
    this.info = info;
    this.name = info.name ?? `Level @ ${hex(info.romStart)}`;
    this.levelId = info.levelId ?? null;
    this.segments = new Map();
    this.segTable = new Map();
    this.areas = new Map();
    this.looseObjects = [];
    this.marioStarts = [];
    this.models = new Map();
    this.warnings = [];
    this.visited = new Set();
    this.currentArea = null;

    this.scriptSegment = this.getSegment(SEG_LEVEL_SCRIPT, 'raw', info.romStart, info.romEnd);
    this.segTable.set(SEG_LEVEL_SCRIPT, this.scriptSegment);
    this.run(this.scriptSegment, info.entry & 0xffffff, 0);
    this.currentArea = null;
  }

  getSegment(seg, kind, romStart, romEnd) {
    const key = `${seg}:${kind}:${romStart}:${romEnd}`;
    if (!this.segments.has(key)) {
      this.segments.set(key, new LoadedSegment(this.rom, seg, kind, romStart, romEnd, decompress));
    }
    return this.segments.get(key);
  }

  getArea(index) {
    if (!this.areas.has(index)) this.areas.set(index, new Area(index));
    return this.areas.get(index);
  }

  resolve(address) {
    const seg = this.segTable.get(address >>> 24);
    if (!seg) return null;
    const offset = address & 0xffffff;
    let data;
    try {
      data = seg.data;
    } catch (e) {
      this.warnings.push(`Cannot load ${seg}: ${e.message}`);
      return null;
    }
    if (offset >= data.length) return null;
    return { segment: seg, offset };
  }

  run(segment, start, depth) {
    if (depth > 32) {
      this.warnings.push('Level script nesting too deep');
      return;
    }
    const buf = segment.data;
    let off = start;
    for (let guard = 0; guard < 50000; guard++) {
      if (off + 4 > buf.length) return;
      const key = `${segment.romStart}:${off}`;
      if (this.visited.has(key)) return;
      this.visited.add(key);
      const op = buf[off];
      const len = buf[off + 1];
      if (len < 4 || off + len > buf.length || op > 0x3c) {
        this.warnings.push(`Invalid level script command ${hex(op, 2)} at ${segment} + ${hex(off, 6)}`);
        return;
      }
      switch (op) {
        case 0x02: // EXIT
        case 0x07: // RETURN
          return;
        case 0x05: {
          // JUMP
          const t = this.resolve(readU32(buf, off + 4));
          if (t) this.run(t.segment, t.offset, depth + 1);
          return;
        }
        case 0x06: {
          // JUMP_LINK
          const t = this.resolve(readU32(buf, off + 4));
          if (t) this.run(t.segment, t.offset, depth + 1);
          break;
        }
        case 0x0c: // JUMP_IF
        case 0x0d: {
          // JUMP_LINK_IF
          const t = this.resolve(readU32(buf, off + 8));
          if (t) this.run(t.segment, t.offset, depth + 1);
          break;
        }
        case 0x17: // LOAD_RAW
        case 0x18: // LOAD_MIO0 / LOAD_YAY0
        case 0x1a: {
          // LOAD_MIO0_TEXTURE / LOAD_YAY0_TEXTURE
          const seg = buf[off + 3];
          const romStart = readU32(buf, off + 4);
          const romEnd = readU32(buf, off + 8);
          if (romStart >= romEnd || romEnd > this.rom.size) {
            this.warnings.push(`Load command for segment ${hex(seg, 2)} points outside the ROM`);
            break;
          }
          const kind = op === 0x17 ? 'raw' : (detectCompression(this.rom.data, romStart) ?? 'unknown');
          const loaded = this.getSegment(seg, kind, romStart, romEnd);
          if (!loaded.loadRefs.some((r) => r.segment === segment && r.offset === off)) {
            loaded.loadRefs.push({ segment, offset: off });
          }
          this.segTable.set(seg, loaded);
          break;
        }
        case 0x1f: {
          // AREA
          this.currentArea = this.getArea(buf[off + 2]);
          this.currentArea.geoLayout = readU32(buf, off + 4);
          break;
        }
        case 0x20: // END_AREA
          this.currentArea = null;
          break;
        case 0x21: // LOAD_MODEL_FROM_DL
        case 0x22: {
          // LOAD_MODEL_FROM_GEO
          const model = op === 0x21 ? ((buf[off + 2] << 8) | buf[off + 3]) & 0xfff : buf[off + 3];
          this.models.set(model, { address: readU32(buf, off + 4), type: op === 0x21 ? 'dl' : 'geo' });
          break;
        }
        case 0x24: {
          // OBJECT_WITH_ACTS
          const obj = new LevelObject(segment, off);
          obj.area = this.currentArea?.index ?? null;
          if (this.currentArea) this.currentArea.objects.push(obj);
          else this.looseObjects.push(obj);
          break;
        }
        case 0x26: // WARP_NODE
        case 0x27: {
          // PAINTING_WARP_NODE
          if (this.currentArea) this.currentArea.warps.push(new WarpNode(segment, off, op === 0x27));
          break;
        }
        case 0x28: {
          // INSTANT_WARP
          if (this.currentArea) this.currentArea.instantWarps.push(new InstantWarp(segment, off));
          break;
        }
        case 0x2b: {
          // MARIO_POS
          this.marioStarts.push(new MarioStart(segment, off));
          break;
        }
        case 0x2e: {
          // TERRAIN
          const address = readU32(buf, off + 4);
          if (!this.currentArea) break;
          this.currentArea.terrainAddress = address;
          const t = this.resolve(address);
          if (!t) {
            this.warnings.push(`Area ${this.currentArea.index}: collision at ${hex(address)} is not loaded`);
            break;
          }
          try {
            this.currentArea.collision = new Collision(t.segment, t.offset);
          } catch (e) {
            this.warnings.push(`Area ${this.currentArea.index}: ${e.message}`);
          }
          break;
        }
        case 0x39: {
          // MACRO_OBJECTS
          const address = readU32(buf, off + 4);
          if (!this.currentArea) break;
          this.currentArea.macroAddress = address;
          const t = this.resolve(address);
          if (!t) {
            this.warnings.push(`Area ${this.currentArea.index}: macro objects at ${hex(address)} are not loaded`);
            break;
          }
          this.currentArea.macroObjects = parseMacroObjects(t.segment, t.offset);
          break;
        }
        default:
          break;
      }
      off += len;
    }
  }

  get areaList() {
    return [...this.areas.values()].sort((a, b) => a.index - b.index);
  }

  marioStartsInArea(index) {
    return this.marioStarts.filter((m) => m.area === index);
  }

  get dirty() {
    for (const s of this.segments.values()) if (s.dirty) return true;
    return false;
  }

  // Writes all edits back into the ROM. Raw segments are patched in place; compressed
  // segments are recompressed and either written in place (when they still fit) or
  // appended to the end of the ROM, updating the level script commands that load them.
  commit() {
    const report = { written: [], relocated: [] };
    let pending;
    while ((pending = [...this.segments.values()].filter((s) => s.dirty && s.kind !== 'raw')).length) {
      for (const s of pending) {
        if (s.kind !== 'mio0' && s.kind !== 'yay0') {
          throw new Error(`Cannot write ${s}: unsupported compression`);
        }
        const encoded = compress(s.kind, s.data);
        const slot = s.romEnd - s.romStart;
        if (encoded.length <= slot) {
          const padded = new Uint8Array(slot);
          padded.set(encoded);
          this.rom.write(s.romStart, padded);
          report.written.push(s);
        } else {
          if (s.loadRefs.length === 0) throw new Error(`Cannot relocate ${s}: no load command found`);
          // A segment that already lives at the end of the ROM (e.g. relocated by an earlier
          // save) is rewritten in place instead of being appended again.
          if (s.romStart % 16 === 0 && alignUp(s.romEnd, 16) >= this.rom.size) this.rom.truncate(s.romStart);
          const start = this.rom.append(encoded);
          s.romStart = start;
          s.romEnd = start + encoded.length;
          for (const ref of s.loadRefs) {
            writeU32(ref.segment.data, ref.offset + 4, s.romStart);
            writeU32(ref.segment.data, ref.offset + 8, s.romEnd);
            ref.segment.markDirty();
          }
          report.relocated.push(s);
        }
        s.dirty = false;
      }
    }
    for (const s of this.segments.values()) {
      if (!s.dirty) continue;
      this.rom.write(s.romStart, s.data);
      s.dirty = false;
      report.written.push(s);
    }
    this.rom.updateChecksum();
    return report;
  }
}

export function loadLevel(rom, info) {
  return new Level(rom, info);
}
