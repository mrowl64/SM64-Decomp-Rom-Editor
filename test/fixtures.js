// Builds small synthetic SM64-style ROMs for tests. They contain just enough structure
// (main scripts JUMP_IF table, a level script, a compressed level data segment with
// collision and macro objects) to exercise the editor core without a real ROM.
import { writeU32 } from '../src/core/binary.js';
import { compress } from '../src/core/compression.js';

export class Writer {
  constructor() {
    this.bytes = [];
  }

  get length() {
    return this.bytes.length;
  }

  u8(...vs) {
    for (const v of vs) this.bytes.push(v & 0xff);
    return this;
  }

  u16(...vs) {
    for (const v of vs) this.bytes.push((v >> 8) & 0xff, v & 0xff);
    return this;
  }

  u32(...vs) {
    for (const v of vs) this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }

  padTo(n) {
    while (this.bytes.length < n) this.bytes.push(0);
    return this;
  }

  toBytes() {
    return Uint8Array.from(this.bytes);
  }
}

export const ROM_SIZE = 0x120000;
export const MAIN_SCRIPTS_START = 0x2000;
export const LEVEL_SCRIPT_START = 0x3000;
export const LEVEL_SCRIPT_SIZE = 0x400;
export const OTHER_SCRIPT_START = 0x6000;
export const SEG7_START = 0x8000;
export const MACRO_OFFSET = 0x100;

export const FIXTURE = {
  objects: [
    { acts: 0x1f, model: 0xc0, pos: [100, 200, -300], rot: [0, 90, 0], bparam: 0x00010000, beh: 0x13002f60 },
    { acts: 0x01, model: 0x7a, pos: [-500, 0, 750], rot: [0, -45, 0], bparam: 0, beh: 0x13003e3c },
  ],
  localObject: { acts: 0x1f, model: 0x54, pos: [10, 20, 30], rot: [0, 180, 0], bparam: 0x02000000, beh: 0x13001000 },
  marioPos: { area: 1, yaw: 135, pos: [-1000, 500, 2000] },
  vertices: [
    [-1000, 0, -1000],
    [1000, 0, -1000],
    [1000, 0, 1000],
    [-1000, 0, 1000],
  ],
  macros: [
    { preset: 0x24, yawField: 16, pos: [300, 0, 300], bparam: 0x0001 },
    { preset: 0x00, yawField: 0, pos: [-300, 50, -300], bparam: 0x0000 },
  ],
};

function object(w, o) {
  w.u8(0x24, 0x18, o.acts, o.model);
  w.u16(...o.pos, ...o.rot);
  w.u32(o.bparam, o.beh);
}

export function buildLevelData() {
  const w = new Writer();
  w.u16(0x40, FIXTURE.vertices.length);
  for (const v of FIXTURE.vertices) w.u16(...v);
  w.u16(0x0000, 2, 0, 1, 2, 0, 2, 3); // SURFACE_DEFAULT, two triangles
  w.u16(0x000e, 1, 0, 1, 2, 5); // SURFACE_FLOWING_WATER, one triangle with force
  w.u16(0x41);
  w.u16(0x44, 1, 0, -2000, -2000, 2000, 2000, -100); // one water box
  w.u16(0x42);
  w.padTo(MACRO_OFFSET);
  for (const m of FIXTURE.macros) {
    w.u16((m.yawField << 9) | (m.preset + 0x1f), ...m.pos, m.bparam);
  }
  w.u16(0x1e);
  // Some filler that compresses well, like real display list / texture data.
  w.padTo(0x200);
  for (let i = 0; i < 0x300; i++) w.u8(i % 7 === 0 ? i & 0xff : 0x11);
  return w.toBytes();
}

export function buildLevelScript(loadOp, seg7Start, seg7End) {
  const w = new Writer();
  w.u32(0x1b040000); // INIT_LEVEL
  w.u8(loadOp, 0x0c, 0x00, 0x07).u32(seg7Start, seg7End); // LOAD_x(0x07, ...)
  w.u32(0x1d040000); // ALLOC_LEVEL_POOL
  w.u8(0x25, 0x0c, 0x00, 0x01).u32(0x00000001, 0x13002ec0); // MARIO
  w.u8(0x06, 0x08, 0x00, 0x00).u32(0x15000100); // JUMP_LINK into an unloaded segment
  w.u8(0x22, 0x08, 0x00, 0x17).u32(0x0e000300); // LOAD_MODEL_FROM_GEO
  w.u8(0x1f, 0x08, 0x01, 0x00).u32(0x0e000300); // AREA(1, ...)
  for (const o of FIXTURE.objects) object(w, o);
  w.u8(0x06, 0x08, 0x00, 0x00).u32(0x0e000200); // JUMP_LINK(local objects)
  w.u8(0x26, 0x08, 0x0a, 0x09).u8(0x01, 0x0a, 0x00, 0x00); // WARP_NODE
  w.u8(0x28, 0x0c, 0x00, 0x02).u16(100, 200, 300, 0); // INSTANT_WARP
  w.u8(0x2e, 0x08, 0x00, 0x00).u32(0x07000000); // TERRAIN
  w.u8(0x39, 0x08, 0x00, 0x00).u32(0x07000000 + MACRO_OFFSET); // MACRO_OBJECTS
  w.u32(0x20040000); // END_AREA
  w.u32(0x1e040000); // FREE_LEVEL_POOL
  const m = FIXTURE.marioPos;
  w.u8(0x2b, 0x0c, m.area, 0x00).u16(m.yaw, ...m.pos); // MARIO_POS
  w.u32(0x02040000); // EXIT
  w.padTo(0x200);
  object(w, FIXTURE.localObject);
  w.u32(0x07040000); // RETURN
  w.padTo(LEVEL_SCRIPT_SIZE);
  return w.toBytes();
}

function execute(seg, start, end, entry) {
  return new Writer().u8(0x00, 0x18, 0x00, seg).u32(start, end, entry).toBytes();
}

// compression: 'mio0' | 'yay0' | 'raw'
export function buildTestRom({ compression = 'mio0' } = {}) {
  const rom = new Uint8Array(ROM_SIZE);
  writeU32(rom, 0, 0x80371240);
  writeU32(rom, 8, 0x80246000);
  rom.set(new TextEncoder().encode('SUPER MARIO 64      '), 0x20);
  rom.set(new TextEncoder().encode('NSME'), 0x3b);
  // Fill the boot/code area with deterministic noise so the checksum is non-trivial.
  for (let i = 0x40; i < 0x1000; i++) rom[i] = (i * 31) & 0xff;

  const levelData = buildLevelData();
  const seg7 = compression === 'raw' ? levelData : compress(compression, levelData);
  const seg7End = SEG7_START + seg7.length;
  rom.set(seg7, SEG7_START);

  rom.set(buildLevelScript(compression === 'raw' ? 0x17 : 0x18, SEG7_START, seg7End), LEVEL_SCRIPT_START);

  // Entry point of the "game": executes the main scripts segment.
  rom.set(execute(0x15, MAIN_SCRIPTS_START, MAIN_SCRIPTS_START + 0x100, 0x15000000), 0x1000);

  // Main scripts: GET_OR_SET + JUMP_IF table for level 9 (BOB).
  const main = new Writer();
  main.u32(0x3c040000);
  main.u8(0x0c, 0x0c, 0x02, 0x00).u32(9, 0x15000020); // JUMP_IF(OP_EQ, LEVEL_BOB, script_exec_bob)
  main.u32(0x02040000);
  main.padTo(0x20);
  main.u8(...execute(0x0e, LEVEL_SCRIPT_START, LEVEL_SCRIPT_START + LEVEL_SCRIPT_SIZE, 0x0e000000));
  main.u32(0x07040000);
  rom.set(main.toBytes(), MAIN_SCRIPTS_START);

  // A second level script that is not in the level table (should still be found).
  const other = new Writer();
  other.u32(0x1b040000);
  other.u8(0x1f, 0x08, 0x02, 0x00).u32(0);
  object(other, FIXTURE.objects[0]);
  other.u32(0x20040000, 0x02040000);
  other.padTo(0x40);
  rom.set(other.toBytes(), OTHER_SCRIPT_START);
  rom.set(execute(0x0e, OTHER_SCRIPT_START, OTHER_SCRIPT_START + 0x40, 0x0e000000), 0x1100);

  // Random-ish data for the remainder of the checksummed area.
  let seed = 1234;
  for (let i = 0x10000; i < 0x101000; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    rom[i] = seed >>> 24;
  }
  return rom;
}
