import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rom } from '../src/core/rom.js';
import { readS16, readU16, readU32 } from '../src/core/binary.js';
import { decompress } from '../src/core/compression.js';
import { discoverLevels, Level } from '../src/core/level.js';
import { collisionToObj } from '../src/core/collision.js';
import { parseMapFile } from '../src/core/mapfile.js';
import {
  buildTestRom,
  FIXTURE,
  LEVEL_SCRIPT_START,
  OTHER_SCRIPT_START,
  SEG7_START,
  ROM_SIZE,
} from './fixtures.js';

function openBob(compression) {
  const rom = new Rom(buildTestRom({ compression }));
  const levels = discoverLevels(rom);
  const info = levels.find((l) => l.levelId === 9);
  return { rom, levels, level: new Level(rom, info) };
}

test('discovers levels and names them from the main scripts level table', () => {
  const { levels } = openBob('mio0');
  assert.equal(levels.length, 2);
  assert.equal(levels[0].levelId, 9);
  assert.equal(levels[0].name, 'Bob-omb Battlefield (BOB)');
  assert.equal(levels[0].romStart, LEVEL_SCRIPT_START);
  assert.equal(levels[1].levelId, null);
  assert.equal(levels[1].romStart, OTHER_SCRIPT_START);
  assert.match(levels[1].name, /Unknown level/);
});

for (const compression of ['mio0', 'yay0', 'raw']) {
  test(`parses areas, objects, warps and Mario start (${compression})`, () => {
    const { level } = openBob(compression);
    assert.deepEqual(level.warnings, []);
    assert.deepEqual([...level.areas.keys()], [1]);
    const area = level.areas.get(1);
    assert.equal(area.geoLayout, 0x0e000300);
    assert.equal(area.objects.length, 3);
    const expected = [...FIXTURE.objects, FIXTURE.localObject];
    area.objects.forEach((obj, i) => {
      const e = expected[i];
      assert.deepEqual(obj.position, e.pos);
      assert.deepEqual([obj.rx, obj.ry, obj.rz], e.rot);
      assert.equal(obj.model, e.model);
      assert.equal(obj.acts, e.acts);
      assert.equal(obj.bparam, e.bparam);
      assert.equal(obj.behavior, e.beh);
      assert.equal(obj.area, 1);
    });
    assert.equal(area.warps.length, 1);
    assert.deepEqual(
      [area.warps[0].id, area.warps[0].destLevel, area.warps[0].destArea, area.warps[0].destNode],
      [0x0a, 9, 1, 0x0a],
    );
    assert.equal(area.instantWarps.length, 1);
    assert.deepEqual([area.instantWarps[0].dx, area.instantWarps[0].dy, area.instantWarps[0].dz], [100, 200, 300]);
    assert.equal(level.marioStarts.length, 1);
    assert.deepEqual(level.marioStarts[0].position, FIXTURE.marioPos.pos);
    assert.equal(level.marioStarts[0].yaw, FIXTURE.marioPos.yaw);
    assert.equal(level.models.get(0x17).address, 0x0e000300);
  });

  test(`parses collision and macro objects (${compression})`, () => {
    const { level } = openBob(compression);
    const area = level.areas.get(1);
    const col = area.collision;
    assert.deepEqual(col.vertices, FIXTURE.vertices);
    assert.equal(col.groups.length, 2);
    assert.equal(col.groups[0].type, 0);
    assert.equal(col.groups[1].hasForce, true);
    assert.equal(col.triangles.length, 3);
    assert.deepEqual(col.triangles[1].v, [0, 2, 3]);
    assert.equal(col.triangles[2].force, 5);
    assert.equal(col.waterBoxes.length, 1);
    assert.equal(col.waterBoxes[0].y, -100);
    assert.equal(area.macroObjects.length, 2);
    assert.equal(area.macroObjects[0].preset, 0x24);
    assert.equal(area.macroObjects[0].yaw, 45);
    assert.deepEqual(area.macroObjects[1].position, [-300, 50, -300]);
    const obj = collisionToObj(col);
    assert.match(obj, /^v -1000 0 -1000$/m);
    assert.match(obj, /^f 1 3 4$/m);
    assert.match(obj, /^g SURFACE_FLOWING_WATER_1$/m);
  });

  test(`edits are committed to the ROM and survive a reload (${compression})`, () => {
    const { rom, level } = openBob(compression);
    const area = level.areas.get(1);
    area.objects[0].position = [1234, -567, 890];
    area.objects[0].setField('behavior', '0x13001234');
    area.objects[2].setField('ry', 270);
    area.macroObjects[0].position = [11, 22, 33];
    area.macroObjects[0].setField('yaw', 90);
    area.collision.setVertex(2, [1500, 100, 1500]);
    area.collision.groups[0].setField('type', 0x0a);
    level.marioStarts[0].setField('yaw', -90);
    area.warps[0].setField('destNode', 0xf0);
    assert.ok(level.dirty);
    level.commit();
    assert.ok(!level.dirty);

    // Re-open the edited ROM from scratch.
    const reopened = new Rom(rom.export());
    const info = discoverLevels(reopened).find((l) => l.levelId === 9);
    const again = new Level(reopened, info);
    const a = again.areas.get(1);
    assert.deepEqual(a.objects[0].position, [1234, -567, 890]);
    assert.equal(a.objects[0].behavior, 0x13001234);
    assert.equal(a.objects[2].ry, 270);
    assert.deepEqual(a.objects[1].position, FIXTURE.objects[1].pos);
    assert.deepEqual(a.macroObjects[0].position, [11, 22, 33]);
    assert.equal(a.macroObjects[0].yaw, 90);
    assert.equal(a.macroObjects[0].preset, 0x24);
    assert.deepEqual(a.collision.vertices[2], [1500, 100, 1500]);
    assert.equal(a.collision.groups[0].type, 0x0a);
    assert.equal(a.collision.triangles[2].force, 5);
    assert.equal(again.marioStarts[0].yaw, -90);
    assert.equal(a.warps[0].destNode, 0xf0);
    // The checksum was refreshed.
    assert.notDeepEqual(reopened.checksum, [0, 0]);
    assert.ok(reopened.size >= ROM_SIZE);
  });
}

test('object edits are patched directly into the level script bytes', () => {
  const { rom, level } = openBob('mio0');
  const obj = level.areas.get(1).objects[0];
  obj.setField('x', -42);
  level.commit();
  assert.equal(readS16(rom.data, obj.segment.romStart + obj.offset + 4), -42);
  assert.equal(obj.segment.romStart, LEVEL_SCRIPT_START);
});

test('compressed segments that grow are relocated and load commands are patched', () => {
  const { rom, level } = openBob('yay0');
  const area = level.areas.get(1);
  const seg = area.collision.segment;
  // Overwrite the well-compressing filler with noise so the segment no longer fits.
  let seed = 99;
  for (let i = 0x200; i < seg.data.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    seg.data[i] = seed >>> 24;
  }
  seg.markDirty();
  area.collision.setVertex(0, [-7, -8, -9]);
  const report = level.commit();
  assert.equal(report.relocated.length, 1);
  assert.ok(seg.romStart >= ROM_SIZE);
  assert.equal(rom.size % 16, 0);
  // LOAD_YAY0 in the level script now points at the new data.
  const loadCmd = LEVEL_SCRIPT_START + 4;
  assert.equal(readU16(rom.data, loadCmd), 0x180c);
  assert.equal(readU32(rom.data, loadCmd + 4), seg.romStart);
  assert.equal(readU32(rom.data, loadCmd + 8), seg.romEnd);
  assert.notEqual(seg.romStart, SEG7_START);
  const data = decompress(rom.data, seg.romStart);
  assert.equal(readS16(data, 4), -7);

  const reopened = new Level(rom, discoverLevels(rom).find((l) => l.levelId === 9));
  assert.deepEqual(reopened.areas.get(1).collision.vertices[0], [-7, -8, -9]);
});

test('field validation rejects out-of-range values and illegal surface changes', () => {
  const { level } = openBob('mio0');
  const area = level.areas.get(1);
  assert.throws(() => area.objects[0].setField('x', 40000), /between/);
  assert.throws(() => area.objects[0].setField('model', 'abc'), /Invalid/);
  assert.throws(() => area.collision.groups[0].setField('type', 0x0e), /force/);
  assert.throws(() => area.collision.groups[0].setField('type', 0x40), /Invalid surface/);
  assert.equal(level.dirty, false);
});

test('snapshot/restore supports undo', () => {
  const { level } = openBob('mio0');
  const obj = level.areas.get(1).objects[0];
  const before = obj.snapshot();
  obj.position = [1, 2, 3];
  obj.restore(before);
  assert.deepEqual(obj.position, FIXTURE.objects[0].pos);
  const v = level.areas.get(1).collision.vertex(1);
  const vb = v.snapshot();
  v.setField('y', 999);
  assert.equal(v.y, 999);
  v.restore(vb);
  assert.deepEqual(v.position, FIXTURE.vertices[1]);
});

test('parses decomp linker map files for behavior names', () => {
  const map = [
    ' .data          0x0000000013000000     0x5000 build/us/data/behavior_data.o',
    '                0x0000000013000000                _behaviorSegmentStart',
    '                0x0000000013000000                bhvStarDoor',
    '                0x0000000013002f60                bhvGoomba',
    '                0x0000000080246000                main_func',
    '                0x13003e3c                bhvStar',
  ].join('\n');
  const symbols = parseMapFile(map);
  assert.equal(symbols.nameFor(0x13002f60), 'bhvGoomba');
  assert.equal(symbols.nameFor(0x13000000), 'bhvStarDoor');
  assert.equal(symbols.nameFor(0x80246000), 'main_func');
  assert.equal(symbols.addressOf('bhvStar'), 0x13003e3c);
  assert.deepEqual(
    symbols.behaviors().map(([n]) => n),
    ['bhvGoomba', 'bhvStar', 'bhvStarDoor'],
  );
});

test('segments relocated to the end of the ROM are rewritten there on later saves', () => {
  const { rom, level } = openBob('mio0');
  const seg = level.areas.get(1).collision.segment;
  let seed = 7;
  const noise = () => {
    for (let i = 0x200; i < seg.data.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      seg.data[i] = seed >>> 24;
    }
    seg.markDirty();
  };
  noise();
  level.commit();
  const firstStart = seg.romStart;
  const firstSize = rom.size;
  noise();
  level.commit();
  assert.equal(seg.romStart, firstStart);
  assert.ok(rom.size <= firstSize + 0x20);
  const reopened = new Level(rom, discoverLevels(rom).find((l) => l.levelId === 9));
  assert.deepEqual([...reopened.areas.get(1).collision.segment.data], [...seg.data]);
});

test('unchanged-size recompression is written in place', () => {
  const { rom, level } = openBob('mio0');
  const seg = level.areas.get(1).collision.segment;
  seg.markDirty();
  const report = level.commit();
  assert.equal(report.relocated.length, 0);
  assert.equal(seg.romStart, SEG7_START);
  assert.equal(rom.size, ROM_SIZE);
});
