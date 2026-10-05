import {
  Rom,
  discoverLevels,
  Level,
  parseMapFile,
  collisionToObj,
  hex,
  SURFACE_TYPES,
  surfaceHasForce,
  surfaceTypeName,
} from '../core/index.js';
import { Renderer, surfaceColor } from './renderer.js';
import { Camera, vec3, rayAabb, rayPlane, rayTriangle } from './math.js';

const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const MARKERS = {
  object: { size: 50, height: 50, color: [0.9, 0.32, 0.25] },
  macro: { size: 45, height: 45, color: [0.3, 0.55, 1.0] },
  mario: { size: 40, height: 80, color: [0.25, 0.85, 0.35] },
};
const DISABLED_COLOR = [0.45, 0.45, 0.5];
const SELECTED_COLOR = [1, 0.85, 0.15];
const HEX_WIDTH = { u8: 2, u16: 4, u32: 8, s16: 4 };
const KIND_TITLES = {
  object: 'Object',
  macro: 'Macro Object',
  mario: 'Mario Start',
  warp: 'Warp Node',
  paintingWarp: 'Painting Warp Node',
  instantWarp: 'Instant Warp',
  vertex: 'Collision Vertex',
  surfaceGroup: 'Surface Group',
};

export class App {
  constructor() {
    this.rom = null;
    this.romName = 'rom.z64';
    this.levels = [];
    this.level = null;
    this.area = null;
    this.mode = 'objects';
    this.selection = null; // { entity, tri? }
    this.symbols = null;
    this.undoStack = [];
    this.redoStack = [];
    this.camera = new Camera();
    this.keys = new Set();
    this.drag = null;
    this.needsRedraw = true;
    this.wireframe = true;
    this.canvas = $('#view');
    try {
      this.renderer = new Renderer(this.canvas);
    } catch (e) {
      this.renderer = null;
      this.setStatus(`3D view unavailable: ${e.message}`, true);
    }
    this.bindUi();
    this.bindViewport();
    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---------------------------------------------------------------- UI wiring

  bindUi() {
    $('#rom-input').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) this.openRom(f);
      e.target.value = '';
    });
    $('#map-input').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) this.openMap(f);
      e.target.value = '';
    });
    $('#level-select').addEventListener('change', (e) => this.loadLevel(Number(e.target.value)));
    $('#area-select').addEventListener('change', (e) => this.selectArea(Number(e.target.value)));
    for (const b of document.querySelectorAll('[data-mode]')) {
      b.addEventListener('click', () => this.setMode(b.dataset.mode));
    }
    $('#wireframe').addEventListener('change', (e) => {
      this.wireframe = e.target.checked;
      this.needsRedraw = true;
    });
    $('#undo').addEventListener('click', () => this.undo());
    $('#redo').addEventListener('click', () => this.redo());
    $('#save-rom').addEventListener('click', () => this.saveRom());
    $('#export-obj').addEventListener('click', () => this.exportObj());

    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      for (const f of e.dataTransfer.files) {
        if (/\.(map|txt)$/i.test(f.name)) this.openMap(f);
        else this.openRom(f);
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  setStatus(text, isError = false) {
    const s = $('#status');
    s.textContent = text;
    s.classList.toggle('error', isError);
  }

  get hasUnsavedChanges() {
    return this.romDirty || (this.level?.dirty ?? false);
  }

  updateButtons() {
    $('#undo').disabled = this.undoStack.length === 0;
    $('#redo').disabled = this.redoStack.length === 0;
    $('#save-rom').disabled = !this.rom;
    $('#save-rom').classList.toggle('dirty', this.hasUnsavedChanges);
    $('#export-obj').disabled = !this.area?.collision;
  }

  // ---------------------------------------------------------------- loading

  async openRom(file) {
    if (this.hasUnsavedChanges && !window.confirm('Discard unsaved changes to the current ROM?')) return;
    try {
      const rom = new Rom(await file.arrayBuffer());
      const levels = discoverLevels(rom);
      if (levels.length === 0) throw new Error('No level scripts were found in this ROM');
      this.rom = rom;
      this.romName = file.name;
      this.romDirty = false;
      this.levels = levels;
      this.level = null;
      const select = $('#level-select');
      select.replaceChildren(
        ...levels.map((l, i) => el('option', { value: i }, `${l.name}  [${hex(l.romStart)}]`)),
      );
      select.disabled = false;
      $('#drop-hint').classList.add('hidden');
      this.loadLevel(0);
      this.setStatus(
        `Loaded "${rom.title}" (${rom.gameCode}, ${rom.originalFormat}, ${(rom.size / 0x100000).toFixed(1)} MB) — ` +
          `${levels.length} level scripts found.`,
      );
    } catch (e) {
      this.setStatus(`Could not open ${file.name}: ${e.message}`, true);
    }
  }

  async openMap(file) {
    try {
      this.symbols = parseMapFile(await file.text());
      const behaviors = this.symbols.behaviors();
      $('#behavior-list').replaceChildren(...behaviors.map(([name]) => el('option', { value: name })));
      this.renderOutline();
      this.renderProperties();
      this.setStatus(`Loaded ${this.symbols.size} symbols (${behaviors.length} behaviors) from ${file.name}.`);
    } catch (e) {
      this.setStatus(`Could not read map file: ${e.message}`, true);
    }
  }

  commitLevel() {
    if (!this.level?.dirty) return null;
    const report = this.level.commit();
    this.romDirty = true;
    return report;
  }

  loadLevel(index) {
    try {
      this.commitLevel();
    } catch (e) {
      this.setStatus(`Could not apply edits: ${e.message}`, true);
      $('#level-select').value = String(this.levels.indexOf(this.level?.info));
      return;
    }
    const info = this.levels[index];
    try {
      this.level = new Level(this.rom, info);
    } catch (e) {
      this.level = null;
      this.setStatus(`Could not parse ${info.name}: ${e.message}`, true);
      return;
    }
    $('#level-select').value = String(index);
    this.undoStack = [];
    this.redoStack = [];
    const areas = this.level.areaList;
    const areaSelect = $('#area-select');
    areaSelect.replaceChildren(...areas.map((a) => el('option', { value: a.index }, `Area ${a.index}`)));
    areaSelect.disabled = areas.length === 0;
    if (areas.length) {
      const best = areas.find((a) => a.collision) ?? areas[0];
      this.selectArea(best.index);
    } else {
      this.area = null;
      this.select(null);
      this.renderer?.setCollision(null);
    }
    if (this.level.warnings.length) {
      this.setStatus(`${info.name}: ${this.level.warnings.length} warning(s): ${this.level.warnings.join('; ')}`, true);
    } else {
      const objCount = areas.reduce((n, a) => n + a.objects.length + a.macroObjects.length, 0);
      this.setStatus(`${info.name}: ${areas.length} area(s), ${objCount} objects.`);
    }
    this.updateButtons();
  }

  selectArea(index) {
    this.area = this.level.areas.get(index) ?? null;
    $('#area-select').value = String(index);
    this.selection = null;
    this.rebuildCollision();
    this.frameArea();
    this.renderOutline();
    this.renderProperties();
    this.updateButtons();
  }

  setMode(mode) {
    this.mode = mode;
    for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('active', b.dataset.mode === mode);
    this.select(null);
    this.renderOutline();
  }

  // ---------------------------------------------------------------- entities

  positionalEntities() {
    if (!this.area) return [];
    return [...this.area.objects, ...this.area.macroObjects, ...this.level.marioStartsInArea(this.area.index)];
  }

  markerFor(entity) {
    const base = MARKERS[entity.kind];
    let color = base.color;
    if (entity.kind === 'object' && entity.acts === 0) color = DISABLED_COLOR;
    if (this.selection?.entity === entity) color = SELECTED_COLOR;
    return { position: entity.position, yaw: entity.yawDegrees, size: base.size, height: base.height, color };
  }

  behaviorName(address) {
    return this.symbols?.nameFor(address) ?? null;
  }

  entityLabel(entity) {
    switch (entity.kind) {
      case 'object': {
        const beh = this.behaviorName(entity.behavior) ?? hex(entity.behavior);
        return `${beh} · model ${hex(entity.model, 2)}${entity.acts === 0 ? ' (disabled)' : ''}`;
      }
      case 'macro':
        return `Preset ${hex(entity.preset, 2)} · param ${hex(entity.bparam, 4)}`;
      case 'mario':
        return `Mario start (yaw ${entity.yaw}°)`;
      case 'warp':
      case 'paintingWarp':
        return `${entity.kind === 'warp' ? 'Warp' : 'Painting'} ${hex(entity.id, 2)} → L${entity.destLevel} A${entity.destArea} N${hex(entity.destNode, 2)}`;
      case 'instantWarp':
        return `Instant ${entity.index} → area ${entity.destArea}`;
      case 'surfaceGroup':
        return `${entity.typeName} (${entity.triangles.length})`;
      default:
        return entity.kind;
    }
  }

  select(entity, extra = {}) {
    this.selection = entity ? { entity, ...extra } : null;
    if (this.mode === 'geometry') this.rebuildCollision();
    this.renderOutline();
    this.renderProperties();
    this.needsRedraw = true;
  }

  // ---------------------------------------------------------------- panels

  renderOutline() {
    const root = $('#outline');
    if (!this.level) {
      root.replaceChildren(el('p', { class: 'hint' }, this.rom ? 'No level loaded.' : 'Open a ROM to begin.'));
      return;
    }
    if (!this.area) {
      root.replaceChildren(el('p', { class: 'hint' }, 'This level has no areas.'));
      return;
    }
    const sections = [];
    const item = (entity, label, extraClass = '', swatch = null) =>
      el(
        'button',
        {
          class: `${this.selection?.entity === entity ? 'selected' : ''} ${extraClass}`,
          title: label,
          onclick: () => {
            this.select(entity);
            if (entity.position) this.focusSelection(false);
          },
        },
        swatch ? el('span', { class: 'swatch', style: `background:${swatch}` }) : null,
        label,
      );
    const section = (title, entities, mapFn) => {
      sections.push(el('h3', {}, `${title} (${entities.length})`));
      sections.push(el('div', { class: 'list' }, entities.map(mapFn)));
    };

    if (this.mode === 'objects') {
      const marios = this.level.marioStartsInArea(this.area.index);
      if (marios.length) section('Mario', marios, (m) => item(m, this.entityLabel(m)));
      section('Objects', this.area.objects, (o, i) =>
        item(o, `${i}: ${this.entityLabel(o)}`, o.acts === 0 ? 'disabled-object' : ''),
      );
      section('Macro objects', this.area.macroObjects, (o, i) => item(o, `${i}: ${this.entityLabel(o)}`));
      section('Warps', [...this.area.warps, ...this.area.instantWarps], (w) => item(w, this.entityLabel(w)));
    } else {
      const col = this.area.collision;
      if (!col) {
        sections.push(el('p', { class: 'hint' }, 'This area has no collision data.'));
      } else {
        sections.push(
          el(
            'p',
            { class: 'meta' },
            `${col.vertices.length} vertices, ${col.triangles.length} triangles, ${col.waterBoxes.length} water boxes` +
              (col.hasSpecialObjects ? ', has special objects' : ''),
          ),
        );
        section('Surface groups', col.groups, (g) => {
          const [r, gr, b] = surfaceColor(g.type).map((c) => Math.round(c * 255));
          return item(g, this.entityLabel(g), '', `rgb(${r},${gr},${b})`);
        });
      }
    }
    root.replaceChildren(
      el('p', { class: 'meta' }, `${this.level.name}`, el('br'), `Script ${hex(this.level.info.romStart)}`),
      ...sections,
    );
  }

  renderProperties() {
    const root = $('#properties');
    const sel = this.selection;
    if (!sel) {
      root.replaceChildren(
        el(
          'p',
          { class: 'hint' },
          this.mode === 'objects'
            ? 'Click an object in the 3D view or the list to edit it.'
            : 'Click collision geometry to select a triangle and its nearest vertex.',
        ),
      );
      return;
    }
    const entity = sel.entity;
    const nodes = [el('h3', {}, KIND_TITLES[entity.kind] ?? entity.kind)];
    const segment = entity.segment ?? entity.collision?.segment;
    if (segment) {
      const offset = entity.offset ?? (entity.kind === 'vertex' ? entity.collision.vertexOffset + entity.index * 6 : 0);
      const where =
        segment.kind === 'raw'
          ? `ROM ${hex(segment.romStart + offset)}`
          : `${hex((segment.seg << 24) | offset)} in ${segment.kind.toUpperCase()} block @ ROM ${hex(segment.romStart)}`;
      nodes.push(el('p', { class: 'meta' }, where));
    }

    for (const f of entity.fields) {
      nodes.push(this.fieldEditor(entity, f));
    }

    if (sel.tri) {
      const g = sel.tri.group;
      nodes.push(
        el('p', { class: 'meta' }, `Triangle #${sel.tri.index}: vertices ${sel.tri.v.join(', ')}`),
        el('p', { class: 'meta' }, `Surface: ${g.typeName}${sel.tri.force !== null ? ` (force ${sel.tri.force})` : ''}`),
      );
    }

    const actions = [];
    if (entity.position) {
      actions.push(el('button', { onclick: () => this.focusSelection(true) }, 'Focus (F)'));
      actions.push(el('button', { onclick: () => this.dropToGround() }, 'Drop to ground (G)'));
    }
    if (sel.tri) {
      actions.push(el('button', { onclick: () => this.select(sel.tri.group) }, 'Select surface group'));
    }
    if (entity.kind === 'object') {
      actions.push(
        el(
          'button',
          {
            title: 'Objects with an act mask of 0 are never spawned',
            onclick: () => this.edit(entity, () => entity.setField('acts', entity.acts === 0 ? 0x1f : 0)),
          },
          entity.acts === 0 ? 'Enable (acts=0x1F)' : 'Disable (acts=0)',
        ),
      );
    }
    if (actions.length) nodes.push(el('div', { class: 'actions' }, actions));
    root.replaceChildren(...nodes);
  }

  formatValue(field, value) {
    if (field.hex) return hex(value, HEX_WIDTH[field.type] ?? 4);
    return String(value);
  }

  fieldEditor(entity, field) {
    const value = entity[field.key];
    let input;
    let note = null;
    if (entity.kind === 'surfaceGroup' && field.key === 'type') {
      const options = Object.entries(SURFACE_TYPES)
        .map(([t, name]) => [Number(t), name])
        .filter(([t]) => surfaceHasForce(t) === entity.hasForce);
      if (!options.some(([t]) => t === value)) options.unshift([value, surfaceTypeName(value)]);
      input = el(
        'select',
        { onchange: (e) => this.edit(entity, () => entity.setField('type', Number(e.target.value))) },
        options.map(([t, name]) => el('option', { value: t, selected: t === value }, `${hex(t, 2)} ${name}`)),
      );
      note = el('small', {}, entity.hasForce ? 'Only surface types with a force parameter' : 'Types with a force parameter cannot be chosen in place');
    } else {
      input = el('input', {
        type: 'text',
        value: this.formatValue(field, value),
        spellcheck: false,
        onchange: (e) => {
          let v = e.target.value.trim();
          if (field.behavior && this.symbols && /^[A-Za-z_]\w*$/.test(v)) {
            const addr = this.symbols.addressOf(v);
            if (addr === undefined) {
              this.setStatus(`Unknown symbol ${v}`, true);
              this.renderProperties();
              return;
            }
            v = addr;
          }
          this.edit(entity, () => entity.setField(field.key, v));
        },
      });
      if (field.behavior) {
        input.setAttribute('list', 'behavior-list');
        const name = this.behaviorName(value);
        note = el('small', {}, name ?? (this.symbols ? 'No symbol at this address' : 'Load a .map file for behavior names'));
      }
    }
    return el('label', { class: 'field' }, el('span', {}, field.label), input, note);
  }

  // ---------------------------------------------------------------- editing / undo

  edit(entity, fn) {
    const before = entity.snapshot();
    try {
      fn();
    } catch (e) {
      this.setStatus(e.message, true);
      this.renderProperties();
      return false;
    }
    this.recordUndo(entity, before);
    this.afterEdit(entity);
    return true;
  }

  recordUndo(entity, before) {
    const after = entity.snapshot();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    this.undoStack.push({ entity, before, after });
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
  }

  afterEdit(entity) {
    if (entity.kind === 'vertex' || entity.kind === 'surfaceGroup') this.rebuildCollision();
    this.renderOutline();
    this.renderProperties();
    this.updateButtons();
    this.needsRedraw = true;
  }

  undo() {
    const action = this.undoStack.pop();
    if (!action) return;
    action.entity.restore(action.before);
    this.redoStack.push(action);
    this.afterEdit(action.entity);
    this.setStatus('Undo');
  }

  redo() {
    const action = this.redoStack.pop();
    if (!action) return;
    action.entity.restore(action.after);
    this.undoStack.push(action);
    this.afterEdit(action.entity);
    this.setStatus('Redo');
  }

  dropToGround() {
    const entity = this.selection?.entity;
    const col = this.area?.collision;
    if (!entity?.position || !col) return;
    const [x, y, z] = entity.position;
    const down = [0, -1, 0];
    let best = null;
    for (const origin of [[x, y + 50, z], [x, 32767, z]]) {
      for (const tri of col.triangles) {
        const [a, b, c] = col.triangleVertices(tri);
        const t = rayTriangle(origin, down, a, b, c);
        if (t !== null && (best === null || t < best.t)) best = { t, y: origin[1] - t };
      }
      if (best) break;
    }
    if (!best) {
      this.setStatus('No ground found below the selection', true);
      return;
    }
    this.edit(entity, () => {
      entity.position = [x, Math.round(best.y), z];
    });
  }

  // ---------------------------------------------------------------- save / export

  download(bytes, name, type = 'application/octet-stream') {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  saveRom() {
    if (!this.rom) return;
    let report = null;
    try {
      report = this.commitLevel();
      this.rom.updateChecksum();
    } catch (e) {
      this.setStatus(`Save failed: ${e.message}`, true);
      return;
    }
    const format = this.rom.originalFormat;
    const base = this.romName.replace(/\.[^.]+$/, '');
    this.download(this.rom.export(format), `${base}.edited.${format}`);
    this.romDirty = false;
    this.updateButtons();
    const relocated = report?.relocated.length ?? 0;
    this.setStatus(
      `Saved ${base}.edited.${format} (checksum updated` +
        (relocated ? `, ${relocated} compressed segment(s) relocated to the end of the ROM` : '') +
        ').',
    );
  }

  exportObj() {
    const col = this.area?.collision;
    if (!col) return;
    const name = `${this.level.name.replace(/[^A-Za-z0-9]+/g, '_')}_area${this.area.index}`;
    this.download(collisionToObj(col, name), `${name}.obj`, 'text/plain');
  }

  // ---------------------------------------------------------------- viewport

  frameArea() {
    const col = this.area?.collision;
    let center = [0, 0, 0];
    let radius = 3000;
    const b = col?.bounds();
    if (b) {
      center = vec3.scale(vec3.add(b.min, b.max), 0.5);
      radius = Math.max(1000, vec3.length(vec3.sub(b.max, b.min)) / 2);
    } else {
      const ents = this.positionalEntities();
      if (ents.length) {
        center = vec3.scale(ents.reduce((s, e) => vec3.add(s, e.position), [0, 0, 0]), 1 / ents.length);
      }
    }
    this.camera.yaw = Math.PI;
    this.camera.pitch = -0.5;
    this.camera.lookAt(center, radius * 1.4);
    this.needsRedraw = true;
  }

  focusSelection(close = true) {
    const pos = this.selection?.entity?.position;
    if (!pos) return;
    const dist = vec3.length(vec3.sub(this.camera.position, pos));
    this.camera.lookAt(pos, close ? 900 : Math.min(Math.max(dist, 900), 4000));
    this.needsRedraw = true;
  }

  rebuildCollision() {
    if (!this.renderer) return;
    const highlight = this.selection?.entity?.kind === 'surfaceGroup' ? this.selection.entity : null;
    this.renderer.setCollision(this.area?.collision ?? null, highlight);
    this.needsRedraw = true;
  }

  mouseNdc(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * 2 - 1,
      y: -(((e.clientY - r.top) / r.height) * 2 - 1),
      aspect: r.width / r.height,
    };
  }

  rayAt(e) {
    const { x, y, aspect } = this.mouseNdc(e);
    return this.camera.ray(x, y, aspect);
  }

  pick(e) {
    const { origin, dir } = this.rayAt(e);
    let best = null;
    if (this.mode === 'objects') {
      for (const entity of this.positionalEntities()) {
        const m = MARKERS[entity.kind];
        const p = entity.position;
        const t = rayAabb(origin, dir, [p[0] - m.size, p[1], p[2] - m.size], [p[0] + m.size, p[1] + 2 * m.height, p[2] + m.size]);
        if (t !== null && (!best || t < best.t)) best = { t, entity };
      }
    } else {
      const col = this.area?.collision;
      if (!col) return null;
      for (const tri of col.triangles) {
        const [a, b, c] = col.triangleVertices(tri);
        const t = rayTriangle(origin, dir, a, b, c);
        if (t !== null && (!best || t < best.t)) best = { t, tri };
      }
      if (best) {
        const hit = vec3.add(origin, vec3.scale(dir, best.t));
        const verts = col.triangleVertices(best.tri);
        let k = 0;
        for (let i = 1; i < 3; i++) {
          if (vec3.length(vec3.sub(verts[i], hit)) < vec3.length(vec3.sub(verts[k], hit))) k = i;
        }
        best.entity = col.vertex(best.tri.v[k]);
      }
    }
    return best;
  }

  bindViewport() {
    const canvas = this.canvas;
    canvas.tabIndex = 0;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      canvas.focus();
      const start = { x: e.clientX, y: e.clientY, last: { x: e.clientX, y: e.clientY }, moved: false };
      if (e.button === 0 && this.level) {
        const hit = this.pick(e);
        if (hit) {
          if (this.selection?.entity !== hit.entity) this.select(hit.entity, hit.tri ? { tri: hit.tri } : {});
          this.drag = { ...start, mode: 'pending', entity: hit.entity, before: hit.entity.snapshot() };
          return;
        }
        this.drag = { ...start, mode: 'look', clickToDeselect: true };
      } else if (e.button === 2 || e.button === 0) {
        this.drag = { ...start, mode: 'look' };
      } else if (e.button === 1) {
        e.preventDefault();
        this.drag = { ...start, mode: 'pan' };
      }
    });
    window.addEventListener('mousemove', (e) => {
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.last.x;
      const dy = e.clientY - d.last.y;
      d.last = { x: e.clientX, y: e.clientY };
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
      if (d.mode === 'look') {
        this.camera.rotate(-dx * 0.005, -dy * 0.005);
      } else if (d.mode === 'pan') {
        const speed = 4;
        this.camera.move(vec3.add(vec3.scale(this.camera.right, -dx * speed), vec3.scale(this.camera.up, dy * speed)));
      } else if (d.mode === 'pending' && d.moved && d.entity.position) {
        d.mode = 'drag';
        this.beginDrag(d, e);
      }
      if (d.mode === 'drag') this.dragTo(d, e);
      this.needsRedraw = true;
    });
    window.addEventListener('mouseup', () => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      if (d.mode === 'drag') {
        this.recordUndo(d.entity, d.before);
        this.afterEdit(d.entity);
      } else if (d.clickToDeselect && !d.moved) {
        this.select(null);
      }
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const speed = e.shiftKey ? 8 : 2;
        this.camera.move(vec3.scale(this.camera.forward, -e.deltaY * speed));
        this.needsRedraw = true;
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === 'y') {
        e.preventDefault();
        this.redo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (key === 'f') this.focusSelection(true);
      else if (key === 'g') this.dropToGround();
      else if (key === 'escape') this.select(null);
      else if ('wasdqe'.includes(key) && key.length === 1) this.keys.add(key);
      this.shift = e.shiftKey;
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
      this.shift = e.shiftKey;
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  dragPlane(d, vertical) {
    const pos = d.entity.position;
    if (vertical) {
      const f = this.camera.forward;
      const n = vec3.normalize([f[0], 0, f[2]]);
      return { point: pos, normal: n };
    }
    return { point: pos, normal: [0, 1, 0] };
  }

  beginDrag(d, e) {
    d.vertical = e.shiftKey;
    d.startPos = d.entity.position;
    d.plane = this.dragPlane(d, d.vertical);
    const { origin, dir } = this.rayAt(e);
    const t = rayPlane(origin, dir, d.plane.point, d.plane.normal);
    d.grab = t === null ? [0, 0, 0] : vec3.sub(d.startPos, vec3.add(origin, vec3.scale(dir, t)));
  }

  dragTo(d, e) {
    if (e.shiftKey !== d.vertical) this.beginDrag(d, e);
    const { origin, dir } = this.rayAt(e);
    const t = rayPlane(origin, dir, d.plane.point, d.plane.normal);
    if (t === null || t > 100000) return;
    const hit = vec3.add(vec3.add(origin, vec3.scale(dir, t)), d.grab);
    const s = d.startPos;
    const next = d.vertical ? [s[0], hit[1], s[2]] : [hit[0], s[1], hit[2]];
    d.entity.position = next.map((c) => Math.max(-32768, Math.min(32767, Math.round(c))));
    if (d.entity.kind === 'vertex') this.rebuildCollision();
    this.renderProperties();
  }

  // ---------------------------------------------------------------- render loop

  frame(now) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.keys.size) {
      const speed = (this.shift ? 12000 : 3000) * dt;
      const f = this.camera.forward;
      const r = this.camera.right;
      let move = [0, 0, 0];
      if (this.keys.has('w')) move = vec3.add(move, f);
      if (this.keys.has('s')) move = vec3.sub(move, f);
      if (this.keys.has('d')) move = vec3.add(move, r);
      if (this.keys.has('a')) move = vec3.sub(move, r);
      if (this.keys.has('e')) move = vec3.add(move, [0, 1, 0]);
      if (this.keys.has('q')) move = vec3.sub(move, [0, 1, 0]);
      this.camera.move(vec3.scale(move, speed));
      this.needsRedraw = true;
    }
    if (this.needsRedraw && this.renderer) {
      this.needsRedraw = false;
      this.renderer.draw(this.buildScene());
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  buildScene() {
    const lines = [];
    const overlayLines = [];
    // Ground grid in the XZ plane (SM64 levels span -8192..8192).
    const gridColor = [0.22, 0.25, 0.32];
    for (let i = -8192; i <= 8192; i += 1024) {
      lines.push([[i, 0, -8192], [i, 0, 8192], gridColor]);
      lines.push([[-8192, 0, i], [8192, 0, i], gridColor]);
    }
    const markers = [];
    if (this.area) {
      for (const entity of this.positionalEntities()) {
        const m = this.markerFor(entity);
        markers.push(m);
        const yaw = ((m.yaw ?? 0) * Math.PI) / 180;
        const c = [m.position[0], m.position[1] + m.height, m.position[2]];
        const tip = vec3.add(c, [Math.sin(yaw) * m.size * 2.5, 0, Math.cos(yaw) * m.size * 2.5]);
        lines.push([c, tip, m.color]);
      }
    }
    const sel = this.selection;
    if (sel?.tri && this.area?.collision) {
      const [a, b, c] = this.area.collision.triangleVertices(sel.tri);
      const yellow = SELECTED_COLOR;
      overlayLines.push([a, b, yellow], [b, c, yellow], [c, a, yellow]);
    }
    if (sel?.entity?.kind === 'vertex') {
      const p = sel.entity.position;
      const s = 40;
      const red = [1, 0.3, 0.3];
      overlayLines.push(
        [vec3.add(p, [-s, 0, 0]), vec3.add(p, [s, 0, 0]), red],
        [vec3.add(p, [0, -s, 0]), vec3.add(p, [0, s, 0]), red],
        [vec3.add(p, [0, 0, -s]), vec3.add(p, [0, 0, s]), red],
      );
    }
    return { camera: this.camera, markers, lines, overlayLines, wireframe: this.wireframe };
  }
}

window.app = new App();
