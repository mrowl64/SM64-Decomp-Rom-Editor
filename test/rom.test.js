import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rom, detectFormat, convertByteOrder, calculateChecksum } from '../src/core/rom.js';
import { readU32 } from '../src/core/binary.js';
import { buildTestRom } from './fixtures.js';

test('detects and normalizes z64/v64/n64 byte orders', () => {
  const z64 = buildTestRom();
  const v64 = convertByteOrder(z64, 'v64');
  const n64 = convertByteOrder(z64, 'n64');
  assert.equal(detectFormat(z64), 'z64');
  assert.equal(detectFormat(v64), 'v64');
  assert.equal(detectFormat(n64), 'n64');
  for (const bytes of [z64, v64, n64]) {
    const rom = new Rom(bytes);
    assert.deepEqual(rom.data, z64);
    assert.equal(rom.title, 'SUPER MARIO 64');
    assert.equal(rom.gameCode, 'NSME');
  }
  assert.deepEqual(new Rom(v64).export('v64'), v64);
  assert.deepEqual(new Rom(n64).export('n64'), n64);
});

test('rejects non-ROM data', () => {
  assert.throws(() => new Rom(new Uint8Array(0x100)), /Not an N64 ROM/);
});

test('CIC-6102 checksum of an all-zero checksum area matches the closed form', () => {
  const data = new Uint8Array(0x101000);
  const seed = 0xf8ca4ddc;
  // With d = 0 every iteration only t1 changes: t1 += t5 (= seed), 0x40000 times.
  const expected2 = Number((BigInt(seed) * 0x40001n) & 0xffffffffn);
  assert.deepEqual(calculateChecksum(data), [seed, expected2]);
});

test('updateChecksum writes CRCs to the header and is stable', () => {
  const rom = new Rom(buildTestRom());
  assert.ok(rom.updateChecksum());
  const [c1, c2] = rom.checksum;
  assert.deepEqual(calculateChecksum(rom.data), [c1, c2]);
  rom.data[0x5000] ^= 0xff;
  rom.updateChecksum();
  assert.notDeepEqual(rom.checksum, [c1, c2]);
  assert.equal(readU32(rom.data, 0), 0x80371240);
});

test('append grows the ROM with aligned data', () => {
  const rom = new Rom(buildTestRom());
  const size = rom.size;
  const off = rom.append(Uint8Array.of(1, 2, 3));
  assert.equal(off, size);
  assert.equal(rom.size % 16, 0);
  assert.deepEqual([...rom.data.subarray(off, off + 3)], [1, 2, 3]);
});
