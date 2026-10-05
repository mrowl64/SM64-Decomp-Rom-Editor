import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeMio0,
  decodeMio0,
  encodeYay0,
  decodeYay0,
  decompress,
  detectCompression,
} from '../src/core/compression.js';

function samples() {
  let seed = 42;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) >>> 24;
  const random = Uint8Array.from({ length: 5000 }, rand);
  const repetitive = Uint8Array.from({ length: 20000 }, (_, i) => (i % 13 < 9 ? 0x55 : i & 0xff));
  const zeros = new Uint8Array(4096);
  const mixed = Uint8Array.from({ length: 30000 }, (_, i) => (i % 1000 < 500 ? rand() : (i >> 4) & 0xff));
  return { empty: new Uint8Array(0), one: Uint8Array.of(7), random, repetitive, zeros, mixed };
}

for (const [kind, encode, decode] of [
  ['mio0', encodeMio0, decodeMio0],
  ['yay0', encodeYay0, decodeYay0],
]) {
  for (const [name, data] of Object.entries(samples())) {
    test(`${kind} round trip: ${name}`, () => {
      const encoded = encode(data);
      assert.equal(detectCompression(encoded), kind);
      assert.equal(encoded.length % 16, 0);
      assert.deepEqual(decode(encoded), data);
      assert.deepEqual(decompress(encoded), data);
    });
  }

  test(`${kind} actually compresses repetitive data`, () => {
    const { repetitive } = samples();
    assert.ok(encode(repetitive).length < repetitive.length / 3);
  });
}

test('decodes a hand-made MIO0 stream', () => {
  // "ABCABCABC": 3 literals then a back-reference of length 6, distance 3.
  const bytes = Uint8Array.from([
    0x4d, 0x49, 0x4f, 0x30, 0, 0, 0, 9, 0, 0, 0, 0x14, 0, 0, 0, 0x18,
    0b11100000, 0, 0, 0,
    0x30, 0x02, 0, 0,
    0x41, 0x42, 0x43,
  ]);
  assert.equal(new TextDecoder().decode(decodeMio0(bytes)), 'ABCABCABC');
});

test('decodes a hand-made Yay0 stream with a long match', () => {
  // "A" + 0x20 more "A"s via a long back-reference (count byte 0x20 - 0x12 = 0x0E).
  const bytes = Uint8Array.from([
    0x59, 0x61, 0x79, 0x30, 0, 0, 0, 0x21, 0, 0, 0, 0x14, 0, 0, 0, 0x18,
    0b10000000, 0, 0, 0,
    0x00, 0x00, 0, 0,
    0x41, 0x0e,
  ]);
  assert.equal(new TextDecoder().decode(decodeYay0(bytes)), 'A'.repeat(0x21));
});
