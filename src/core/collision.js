import { readS16, readU16, writeS16, writeU16 } from './binary.js';
import { surfaceTypeName } from './names.js';

// Collision ("terrain") data commands, see include/surface_terrain.h in the decomp.
export const TERRAIN_LOAD_VERTICES = 0x40;
export const TERRAIN_LOAD_CONTINUE = 0x41;
export const TERRAIN_LOAD_END = 0x42;
export const TERRAIN_LOAD_OBJECTS = 0x43;
export const TERRAIN_LOAD_ENVIRONMENT = 0x44;

// Surface types whose triangles carry an extra "force" halfword (surface_has_force()).
const FORCE_SURFACES = new Set([0x04, 0x0e, 0x24, 0x25, 0x27, 0x2c, 0x2d]);

export function surfaceHasForce(type) {
  return FORCE_SURFACES.has(type);
}

function isSurfaceType(type) {
  return type < TERRAIN_LOAD_VERTICES || type >= 0x65;
}

export class CollisionVertex {
  constructor(collision, index) {
    this.kind = 'vertex';
    this.collision = collision;
    this.index = index;
  }

  get fields() {
    return CollisionVertex.fields;
  }

  get position() {
    return this.collision.vertices[this.index].slice();
  }

  set position(pos) {
    this.collision.setVertex(this.index, pos);
  }

  get x() {
    return this.collision.vertices[this.index][0];
  }

  get y() {
    return this.collision.vertices[this.index][1];
  }

  get z() {
    return this.collision.vertices[this.index][2];
  }

  snapshot() {
    return { position: this.position };
  }

  restore(s) {
    this.position = s.position;
  }

  setField(key, value) {
    const axis = { x: 0, y: 1, z: 2 }[key];
    if (axis === undefined) throw new Error(`Unknown field ${key}`);
    const v = Math.round(Number(value));
    if (!Number.isFinite(v) || v < -0x8000 || v > 0x7fff) {
      throw new Error(`${key.toUpperCase()} must be between -32768 and 32767`);
    }
    const pos = this.position;
    pos[axis] = v;
    this.position = pos;
  }

  static fields = [
    { key: 'x', label: 'X', type: 's16' },
    { key: 'y', label: 'Y', type: 's16' },
    { key: 'z', label: 'Z', type: 's16' },
  ];
}

export class SurfaceGroup {
  constructor(collision, offset, type) {
    this.kind = 'surfaceGroup';
    this.collision = collision;
    this.offset = offset; // offset of the surface type halfword
    this.type = type;
    this.hasForce = surfaceHasForce(type);
    this.triangles = [];
  }

  get fields() {
    return SurfaceGroup.fields;
  }

  get typeName() {
    return surfaceTypeName(this.type);
  }

  snapshot() {
    return { type: this.type };
  }

  restore(s) {
    this.setField('type', s.type);
  }

  setField(key, value) {
    if (key !== 'type') throw new Error(`Unknown field ${key}`);
    const type = typeof value === 'string' ? parseInt(value, value.trim().toLowerCase().startsWith('0x') ? 16 : 10) : value;
    if (!Number.isInteger(type) || type < 0 || type > 0xffff || !isSurfaceType(type)) {
      throw new Error('Invalid surface type (must be < 0x40 or >= 0x65)');
    }
    if (surfaceHasForce(type) !== this.hasForce) {
      throw new Error(
        'Cannot switch between surface types with and without a force parameter in place ' +
          '(this would change the size of the collision data)',
      );
    }
    this.type = type;
    writeU16(this.collision.segment.data, this.offset, type);
    this.collision.segment.markDirty();
  }

  static fields = [{ key: 'type', label: 'Surface Type', type: 'u16', hex: true }];
}

// Parses collision data starting at `offset` inside `segment`. Vertices and surface
// triangles are fully parsed and can be edited in place; special objects and
// environment boxes are kept untouched.
export class Collision {
  constructor(segment, offset) {
    this.segment = segment;
    this.offset = offset;
    this.vertices = [];
    this.vertexOffset = -1;
    this.groups = [];
    this.triangles = [];
    this.waterBoxes = [];
    this.hasSpecialObjects = false;
    this.parse();
  }

  parse() {
    const buf = this.segment.data;
    let off = this.offset;
    const end = buf.length;
    const need = (n) => {
      if (off + n > end) throw new Error('Collision data runs past the end of its segment');
    };
    for (let guard = 0; guard < 100000; guard++) {
      need(2);
      const cmd = readU16(buf, off);
      off += 2;
      if (cmd === TERRAIN_LOAD_VERTICES) {
        need(2);
        const count = readU16(buf, off);
        off += 2;
        need(count * 6);
        this.vertexOffset = off;
        this.vertices = [];
        for (let i = 0; i < count; i++) {
          this.vertices.push([readS16(buf, off), readS16(buf, off + 2), readS16(buf, off + 4)]);
          off += 6;
        }
      } else if (cmd === TERRAIN_LOAD_CONTINUE) {
        continue;
      } else if (cmd === TERRAIN_LOAD_END) {
        this.endOffset = off;
        return;
      } else if (cmd === TERRAIN_LOAD_OBJECTS) {
        // Special object entries have preset dependent sizes; stop parsing here.
        this.hasSpecialObjects = true;
        this.endOffset = off;
        return;
      } else if (cmd === TERRAIN_LOAD_ENVIRONMENT) {
        need(2);
        const count = readU16(buf, off);
        off += 2;
        need(count * 12);
        for (let i = 0; i < count; i++) {
          this.waterBoxes.push({
            id: readS16(buf, off),
            x1: readS16(buf, off + 2),
            z1: readS16(buf, off + 4),
            x2: readS16(buf, off + 6),
            z2: readS16(buf, off + 8),
            y: readS16(buf, off + 10),
          });
          off += 12;
        }
      } else if (isSurfaceType(cmd)) {
        const group = new SurfaceGroup(this, off - 2, cmd);
        need(2);
        const count = readU16(buf, off);
        off += 2;
        const stride = group.hasForce ? 8 : 6;
        need(count * stride);
        for (let i = 0; i < count; i++) {
          const tri = {
            group,
            index: this.triangles.length,
            v: [readU16(buf, off), readU16(buf, off + 2), readU16(buf, off + 4)],
            force: group.hasForce ? readS16(buf, off + 6) : null,
          };
          group.triangles.push(tri);
          this.triangles.push(tri);
          off += stride;
        }
        this.groups.push(group);
      } else {
        throw new Error(`Unknown collision command 0x${cmd.toString(16)}`);
      }
    }
    throw new Error('Collision data is too long');
  }

  setVertex(index, [x, y, z]) {
    const v = [x, y, z].map((c) => Math.max(-0x8000, Math.min(0x7fff, Math.round(c))));
    this.vertices[index] = v;
    const buf = this.segment.data;
    const off = this.vertexOffset + index * 6;
    writeS16(buf, off, v[0]);
    writeS16(buf, off + 2, v[1]);
    writeS16(buf, off + 4, v[2]);
    this.segment.markDirty();
  }

  vertex(index) {
    return new CollisionVertex(this, index);
  }

  triangleVertices(tri) {
    return tri.v.map((i) => this.vertices[i] ?? [0, 0, 0]);
  }

  bounds() {
    if (this.vertices.length === 0) return null;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const v of this.vertices) {
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], v[i]);
        max[i] = Math.max(max[i], v[i]);
      }
    }
    return { min, max };
  }
}

// Exports collision geometry as a Wavefront OBJ, one group per surface type.
export function collisionToObj(collision, name = 'collision') {
  const lines = [`# SM64 collision exported by SM64-Decomp-Rom-Editor`, `o ${name}`];
  for (const [x, y, z] of collision.vertices) lines.push(`v ${x} ${y} ${z}`);
  collision.groups.forEach((group, i) => {
    lines.push(`g ${group.typeName}_${i}`);
    for (const tri of group.triangles) {
      lines.push(`f ${tri.v[0] + 1} ${tri.v[1] + 1} ${tri.v[2] + 1}`);
    }
  });
  return lines.join('\n') + '\n';
}
