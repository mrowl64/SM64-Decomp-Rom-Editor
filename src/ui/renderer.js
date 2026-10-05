import { modelMatrix, vec3 } from './math.js';

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec3 aColor;
uniform mat4 uViewProjection;
uniform mat4 uModel;
varying vec3 vNormal;
varying vec3 vColor;
void main() {
  gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0);
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vNormal;
varying vec3 vColor;
uniform vec3 uTint;
uniform float uUseTint;
uniform float uLit;
uniform float uAlpha;
void main() {
  vec3 color = mix(vColor, uTint, uUseTint);
  float light = 1.0;
  if (uLit > 0.5) {
    vec3 n = normalize(vNormal);
    light = 0.4 + 0.45 * abs(dot(n, normalize(vec3(0.35, 0.85, 0.4)))) + 0.15 * max(n.y, 0.0);
  }
  gl_FragColor = vec4(color * light, uAlpha);
}`;

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// Colors for common surface types; everything else gets a stable hashed color.
const SURFACE_COLORS = {
  0x00: [0.62, 0.72, 0.58],
  0x01: [0.95, 0.35, 0.15],
  0x05: [0.75, 0.55, 0.3],
  0x0a: [0.25, 0.1, 0.1],
  0x0d: [0.2, 0.45, 0.95],
  0x0e: [0.25, 0.6, 1.0],
  0x13: [0.7, 0.9, 1.0],
  0x14: [0.6, 0.8, 0.95],
  0x15: [0.5, 0.55, 0.45],
  0x2e: [0.8, 0.95, 1.0],
  0x30: [0.55, 0.6, 0.65],
  0x32: [0.85, 0.3, 0.9],
  0x7b: [0.5, 0.3, 0.8],
};

export function surfaceColor(type) {
  if (SURFACE_COLORS[type]) return SURFACE_COLORS[type];
  const h = ((type * 2654435761) >>> 0) / 0xffffffff;
  const r = 0.45 + 0.5 * Math.abs(Math.sin(h * 6.28));
  const g = 0.45 + 0.5 * Math.abs(Math.sin(h * 6.28 + 2.1));
  const b = 0.45 + 0.5 * Math.abs(Math.sin(h * 6.28 + 4.2));
  return [r, g, b];
}

function buildCube() {
  const faces = [
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
    [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
    [[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
    [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
    [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
  ];
  const pos = [];
  const nrm = [];
  for (const [n, q] of faces) {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      pos.push(...q[i]);
      nrm.push(...n);
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm) };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { antialias: true }) || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL is not available in this browser');
    this.gl = gl;
    this.program = this.createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
    this.loc = {
      aPosition: gl.getAttribLocation(this.program, 'aPosition'),
      aNormal: gl.getAttribLocation(this.program, 'aNormal'),
      aColor: gl.getAttribLocation(this.program, 'aColor'),
      uViewProjection: gl.getUniformLocation(this.program, 'uViewProjection'),
      uModel: gl.getUniformLocation(this.program, 'uModel'),
      uTint: gl.getUniformLocation(this.program, 'uTint'),
      uUseTint: gl.getUniformLocation(this.program, 'uUseTint'),
      uLit: gl.getUniformLocation(this.program, 'uLit'),
      uAlpha: gl.getUniformLocation(this.program, 'uAlpha'),
    };
    const cube = buildCube();
    this.cube = this.createMesh(cube.positions, cube.normals, new Float32Array(cube.positions.length).fill(1));
    this.collisionMesh = null;
    this.wireMesh = null;
    this.lineBuffers = this.createMesh(new Float32Array(0), new Float32Array(0), new Float32Array(0));
  }

  createProgram(vsSource, fsSource) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  createMesh(positions, normals, colors) {
    const gl = this.gl;
    const mk = (data) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      return b;
    };
    return { position: mk(positions), normal: mk(normals), color: mk(colors), count: positions.length / 3 };
  }

  updateMesh(mesh, positions, normals, colors) {
    const gl = this.gl;
    for (const [buf, data] of [
      [mesh.position, positions],
      [mesh.normal, normals],
      [mesh.color, colors],
    ]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    }
    mesh.count = positions.length / 3;
  }

  // Builds flat-shaded triangle buffers for a Collision, colored by surface type.
  setCollision(collision, highlightGroup = null) {
    if (!collision) {
      this.collisionMesh = null;
      this.wireMesh = null;
      return;
    }
    const n = collision.triangles.length;
    const positions = new Float32Array(n * 9);
    const normals = new Float32Array(n * 9);
    const colors = new Float32Array(n * 9);
    collision.triangles.forEach((tri, i) => {
      const [a, b, c] = collision.triangleVertices(tri);
      const normal = vec3.normalize(vec3.cross(vec3.sub(b, a), vec3.sub(c, a)));
      let color = surfaceColor(tri.group.type);
      if (highlightGroup && tri.group === highlightGroup) color = [1.0, 0.85, 0.2];
      [a, b, c].forEach((v, k) => {
        positions.set(v, i * 9 + k * 3);
        normals.set(normal, i * 9 + k * 3);
        colors.set(color, i * 9 + k * 3);
      });
    });
    if (!this.collisionMesh) this.collisionMesh = this.createMesh(positions, normals, colors);
    else this.updateMesh(this.collisionMesh, positions, normals, colors);

    const wire = new Float32Array(n * 18);
    for (let i = 0; i < n; i++) {
      const p = (k) => positions.subarray(i * 9 + k * 3, i * 9 + k * 3 + 3);
      [0, 1, 1, 2, 2, 0].forEach((k, j) => wire.set(p(k), i * 18 + j * 3));
    }
    const zeros = new Float32Array(wire.length);
    if (!this.wireMesh) this.wireMesh = this.createMesh(wire, zeros, zeros);
    else this.updateMesh(this.wireMesh, wire, zeros, zeros);
  }

  bindMesh(mesh) {
    const gl = this.gl;
    for (const [attr, buf] of [
      [this.loc.aPosition, mesh.position],
      [this.loc.aNormal, mesh.normal],
      [this.loc.aColor, mesh.color],
    ]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(attr);
      gl.vertexAttribPointer(attr, 3, gl.FLOAT, false, 0, 0);
    }
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return w / h;
  }

  // scene: { camera, markers: [{position, yaw, size, height, color}], lines: [[from, to, color]],
  //          overlayLines: [[from, to, color]], wireframe }
  draw(scene) {
    const gl = this.gl;
    const aspect = this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.11, 0.13, 0.17, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(this.program);
    const vp = scene.camera.viewProjection(aspect);
    gl.uniformMatrix4fv(this.loc.uViewProjection, false, vp);
    gl.uniform1f(this.loc.uAlpha, 1);

    if (this.collisionMesh && this.collisionMesh.count) {
      this.bindMesh(this.collisionMesh);
      gl.uniformMatrix4fv(this.loc.uModel, false, IDENTITY);
      gl.uniform1f(this.loc.uUseTint, 0);
      gl.uniform1f(this.loc.uLit, 1);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      gl.drawArrays(gl.TRIANGLES, 0, this.collisionMesh.count);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      if (scene.wireframe && this.wireMesh) {
        this.bindMesh(this.wireMesh);
        gl.uniform1f(this.loc.uUseTint, 1);
        gl.uniform1f(this.loc.uLit, 0);
        gl.uniform3fv(this.loc.uTint, [0.05, 0.05, 0.08]);
        gl.drawArrays(gl.LINES, 0, this.wireMesh.count);
      }
    }

    this.bindMesh(this.cube);
    gl.uniform1f(this.loc.uUseTint, 1);
    gl.uniform1f(this.loc.uLit, 1);
    for (const m of scene.markers ?? []) {
      const h = m.height ?? m.size;
      const model = modelMatrix([m.position[0], m.position[1] + h, m.position[2]], ((m.yaw ?? 0) * Math.PI) / 180, [
        m.size,
        h,
        m.size,
      ]);
      gl.uniformMatrix4fv(this.loc.uModel, false, model);
      gl.uniform3fv(this.loc.uTint, m.color);
      gl.drawArrays(gl.TRIANGLES, 0, this.cube.count);
    }

    this.drawLines(scene.lines ?? []);
    gl.disable(gl.DEPTH_TEST);
    this.drawLines(scene.overlayLines ?? []);
    gl.enable(gl.DEPTH_TEST);
  }

  drawLines(lines) {
    if (!lines.length) return;
    const gl = this.gl;
    const positions = new Float32Array(lines.length * 6);
    const colors = new Float32Array(lines.length * 6);
    lines.forEach(([a, b, color], i) => {
      positions.set(a, i * 6);
      positions.set(b, i * 6 + 3);
      colors.set(color, i * 6);
      colors.set(color, i * 6 + 3);
    });
    this.updateMesh(this.lineBuffers, positions, new Float32Array(positions.length), colors);
    this.bindMesh(this.lineBuffers);
    gl.uniformMatrix4fv(this.loc.uModel, false, IDENTITY);
    gl.uniform1f(this.loc.uUseTint, 0);
    gl.uniform1f(this.loc.uLit, 0);
    gl.drawArrays(gl.LINES, 0, this.lineBuffers.count);
  }
}
