import * as THREE from 'three';
import { buildComponents, createTriangleTree, filterTriangles, triangleIndices } from './mesh-topology.js';

const MAX_UNDO_ENTRIES = 24;
const MAX_UNDO_INDICES = 2_000_000;
const CELL_SIZE = 64;

/** Local, reversible face edits. Saved IDs always refer to the source GLB primitive. */
export function createMeshEditor({ scene, camera, canvas, container, controls, getModel, onChange }) {
  const overlay = new THREE.Group();
  overlay.name = 'MeshCleanupSelection';
  overlay.visible = false;
  scene.add(overlay);
  const highlightMaterial = new THREE.MeshBasicMaterial({
    color: 0xffba55, opacity: 0.78, transparent: true, depthWrite: false,
    side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const initialCursor = canvas.style.cursor;
  const initialLabel = canvas.getAttribute('aria-label');
  const initialRightAction = controls.mouseButtons?.RIGHT;
  const brushCursor = globalThis.document?.createElement('div');
  if (brushCursor) {
    brushCursor.setAttribute('aria-hidden', 'true');
    brushCursor.style.cssText = 'position:absolute;display:none;pointer-events:none;border:1px solid #ffce80;border-radius:50%;background:#ffba5515;box-shadow:0 0 0 1px #0005;transform:translate(-50%,-50%);z-index:15;';
    container.append(brushCursor);
  }
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const localRay = new THREE.Ray();
  const projected = new THREE.Vector3();
  let model;
  let entries = [];
  let byKey = new Map();
  let byObject = new Map();
  let undoStack = [];
  let undoIndices = 0;
  let press;
  let stroke;
  let disposed = false;
  let appearanceActive = false;
  let message = '';
  let readinessError = '';
  let state = { enabled: false, locked: false, tool: 'part', brushSize: 32, onChange };

  function getStatus() {
    let totalTriangles = 0, deletedTriangles = 0, selectedTriangles = 0;
    for (const entry of entries) {
      totalTriangles += entry.indices.length / 3;
      deletedTriangles += entry.deleted.size;
      selectedTriangles += entry.selected.size;
    }
    return {
      enabled: state.enabled, isReady: Boolean(model && entries.length && !readinessError),
      dirty: deletedTriangles > 0, deletedTriangles, selectedTriangles, totalTriangles,
      canUndo: undoStack.length > 0, tool: state.tool, brushSize: state.brushSize,
      error: readinessError || message,
    };
  }

  function emit() {
    const status = getStatus();
    container.dataset.meshEditor = String(status.enabled);
    container.dataset.meshSelectedTriangles = String(status.selectedTriangles);
    container.dataset.meshDeletedTriangles = String(status.deletedTriangles);
    container.dataset.meshTool = status.tool;
    state.onChange?.(status);
    return status;
  }

  function redrawEntry(entry) {
    const position = entry.source.getAttribute('position');
    const selected = new Float32Array(entry.selected.size * 9);
    let cursor = 0;
    for (const face of entry.selected) for (let corner = 0; corner < 3; corner++) {
      const vertex = entry.indices[face * 3 + corner];
      selected[cursor++] = position.getX(vertex);
      selected[cursor++] = position.getY(vertex);
      selected[cursor++] = position.getZ(vertex);
    }
    for (const instance of entry.instances) {
      instance.overlay.geometry.dispose();
      instance.overlay.geometry = new THREE.BufferGeometry();
      instance.overlay.geometry.setAttribute('position', new THREE.BufferAttribute(selected, 3));
      instance.overlay.matrix.copy(instance.object.matrixWorld);
      instance.overlay.matrixWorldNeedsUpdate = true;
    }
  }

  function refreshAppearance() {
    const active = state.enabled && getStatus().isReady;
    overlay.visible = active;
    if (brushCursor && (!active || state.locked || state.tool !== 'brush')) brushCursor.style.display = 'none';
    if (controls.mouseButtons && (active || appearanceActive)) controls.mouseButtons.RIGHT = active && state.tool === 'brush' ? THREE.MOUSE.ROTATE : initialRightAction;
    if (active || appearanceActive) canvas.style.cursor = active ? state.locked ? 'wait' : 'crosshair' : initialCursor;
    if (active) canvas.setAttribute('aria-label', state.tool === 'brush'
      ? 'Удаление частей модели. Кисть выделяет видимую поверхность; Shift убирает выделение. Для вращения используйте правую кнопку или инструмент «Часть».'
      : 'Удаление частей модели. Нажмите на отдельную часть, чтобы выделить её. Перетаскивайте для вращения камеры.');
    else if (appearanceActive && initialLabel === null) canvas.removeAttribute('aria-label');
    else if (appearanceActive) canvas.setAttribute('aria-label', initialLabel);
    appearanceActive = active;
    for (const entry of entries) for (const instance of entry.instances) {
      instance.overlay.matrix.copy(instance.object.matrixWorld);
      instance.overlay.matrixWorldNeedsUpdate = true;
    }
  }

  function applyDeletion(entry) {
    const filtered = filterTriangles(entry.source, entry.deleted, entry.indices);
    entry.surviving = filtered.sourceTriangles;
    for (const instance of entry.instances) {
      if (!instance.preview) instance.preview = instance.source.clone();
      const geometry = instance.preview;
      geometry.setIndex(new THREE.BufferAttribute(filtered.index, 1));
      geometry.clearGroups();
      filtered.groups.forEach((group) => geometry.addGroup(group.start, group.count, group.materialIndex));
      geometry.setDrawRange(0, filtered.index.length);
      // clone() retained the complete source attributes and original bounds.
      instance.object.geometry = geometry;
    }
  }

  function pushUndo(changes, kind = 'selection') {
    const useful = changes.filter((change) => change.added.length || change.removed.length);
    if (!useful.length) return;
    const size = useful.reduce((sum, change) => sum + change.added.length + change.removed.length, 0);
    if (size > MAX_UNDO_INDICES) { undoStack = []; undoIndices = 0; return; }
    undoStack.push({ kind, changes: useful, size });
    undoIndices += size;
    while (undoStack.length > MAX_UNDO_ENTRIES || undoIndices > MAX_UNDO_INDICES) {
      undoIndices -= undoStack.shift().size;
    }
  }

  function changeSelection(entry, faces, subtract, changes) {
    let change = changes.get(entry.key);
    if (!change) { change = { key: entry.key, added: [], removed: [] }; changes.set(entry.key, change); }
    let changed = false;
    for (const face of faces) {
      if (entry.deleted.has(face)) continue;
      if (subtract && entry.selected.delete(face)) { change.removed.push(face); changed = true; }
      else if (!subtract && !entry.selected.has(face)) { entry.selected.add(face); change.added.push(face); changed = true; }
    }
    return changed;
  }

  function finishSelection(changes) {
    pushUndo([...changes.values()].map((change) => ({
      key: change.key, added: Uint32Array.from(change.added), removed: Uint32Array.from(change.removed),
    })));
  }

  function endStroke(commit = true) {
    if (!stroke) return;
    const previous = stroke;
    stroke = undefined;
    controls.enabled = previous.controlsEnabled;
    if (canvas.hasPointerCapture?.(previous.pointerId)) canvas.releasePointerCapture(previous.pointerId);
    if (commit) finishSelection(previous.changes);
    emit();
  }

  function clearRecords(disposeSource = false) {
    endStroke();
    press = undefined;
    for (const entry of entries) for (const instance of entry.instances) {
      instance.object.geometry = instance.source;
      instance.preview?.dispose();
      if (disposeSource) instance.source.dispose();
      instance.overlay.geometry.dispose();
      instance.overlay.removeFromParent();
    }
    entries = [];
    byKey = new Map();
    byObject = new Map();
    undoStack = [];
    undoIndices = 0;
    message = '';
    readinessError = '';
  }

  function refreshModel() {
    if (disposed) return;
    const next = getModel();
    if (next === model) { model?.updateMatrixWorld(true); refreshAppearance(); return; }
    clearRecords(true);
    model = next;
    if (model) {
      model.updateMatrixWorld(true);
      model.traverse((object) => {
        if (!object.isMesh || !object.geometry?.getAttribute('position')) return;
        const id = object.userData.studioPrimitive;
        if (object.isSkinnedMesh) {
          readinessError = 'Для очистки откройте исходную модель до создания скелета.'; return;
        }
        if (!id || !Number.isInteger(id.mesh) || id.mesh < 0 || !Number.isInteger(id.primitive) || id.primitive < 0) {
          readinessError = 'Не удалось сопоставить поверхность с исходным GLB. Откройте исходную модель повторно.'; return;
        }
        if (Object.keys(object.geometry.morphAttributes).length) {
          readinessError = 'Очистка модели с морфингом пока не поддерживается.'; return;
        }
        const key = `${id.mesh}:${id.primitive}`;
        const geometry = object.geometry;
        let entry = byKey.get(key);
        if (!entry) {
          const indices = triangleIndices(geometry);
          entry = { key, mesh: id.mesh, primitive: id.primitive, source: geometry, indices,
            surviving: Uint32Array.from({ length: indices.length / 3 }, (_, i) => i),
            selected: new Set(), deleted: new Set(), instances: [] };
          byKey.set(key, entry);
          entries.push(entry);
        } else if (geometry !== entry.source) {
          // GLTFLoader shares geometry for real instances. Different geometry
          // under the same primitive ID must not produce ambiguous saved edits.
          readinessError = 'В GLB несколько разных поверхностей с одинаковым идентификатором. Очистка этой модели недоступна.';
          return;
        }
        const highlight = new THREE.Mesh(new THREE.BufferGeometry(), highlightMaterial);
        highlight.matrixAutoUpdate = false;
        highlight.frustumCulled = false;
        highlight.renderOrder = 5;
        overlay.add(highlight);
        const instance = { object, source: geometry, overlay: highlight, inverse: new THREE.Matrix4() };
        entry.instances.push(instance);
        byObject.set(object, entry);
      });
    }
    refreshAppearance();
    emit();
  }

  function setRay(clientX, clientY, bounds = canvas.getBoundingClientRect()) {
    if (!bounds.width || !bounds.height) return false;
    pointer.set((clientX - bounds.left) / bounds.width * 2 - 1, -(clientY - bounds.top) / bounds.height * 2 + 1);
    camera.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
    return true;
  }

  function nearestSurface() {
    let nearest = null;
    for (const entry of entries) {
      entry.tree ||= createTriangleTree(entry.source, entry.indices);
      for (const instance of entry.instances) {
        localRay.copy(raycaster.ray).applyMatrix4(instance.inverse);
        const hit = entry.tree.intersect(localRay, entry.deleted);
        if (!hit) continue;
        const worldPoint = hit.point.applyMatrix4(instance.object.matrixWorld);
        const distance = worldPoint.distanceToSquared(raycaster.ray.origin);
        if (!nearest || distance < nearest.distanceSquared) nearest = { entry, triangle: hit.triangle, point: worldPoint, distanceSquared: distance };
      }
    }
    return nearest;
  }

  function pickPart(event) {
    if (!setRay(event.clientX, event.clientY)) return;
    model.updateMatrixWorld(true);
    const hit = raycaster.intersectObjects([...byObject.keys()], false)[0];
    if (!hit || !Number.isInteger(hit.faceIndex)) return;
    const entry = byObject.get(hit.object);
    const face = entry.surviving[hit.faceIndex];
    if (face === undefined) return;
    entry.topology ||= buildComponents(entry.source, entry.indices);
    const faces = entry.topology.components[entry.topology.componentByFace[face]];
    const subtract = event.shiftKey || (faces.every((candidate) => entry.deleted.has(candidate) || entry.selected.has(candidate)));
    const changes = new Map();
    if (changeSelection(entry, faces, subtract, changes)) {
      redrawEntry(entry);
      finishSelection(changes);
      message = '';
      emit();
    }
  }

  function projectedGrid(bounds) {
    const grid = new Map();
    model.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    for (const entry of entries) {
      entry.tree ||= createTriangleTree(entry.source, entry.indices);
      const centers = entry.tree.centers;
      for (const instance of entry.instances) {
        instance.inverse.copy(instance.object.matrixWorld).invert();
        for (let face = 0; face < centers.length / 3; face++) {
          if (entry.deleted.has(face)) continue;
          const world = new THREE.Vector3().fromArray(centers, face * 3).applyMatrix4(instance.object.matrixWorld);
          projected.copy(world).project(camera);
          if (projected.z <= -1 || projected.z >= 1 || Math.abs(projected.x) > 1.2 || Math.abs(projected.y) > 1.2) continue;
          const x = bounds.left + (projected.x + 1) / 2 * bounds.width;
          const y = bounds.top + (1 - projected.y) / 2 * bounds.height;
          const key = `${Math.floor(x / CELL_SIZE)},${Math.floor(y / CELL_SIZE)}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push({ entry, face, x, y, world });
        }
      }
    }
    return grid;
  }

  function paint(clientX, clientY) {
    if (!stroke) return;
    const radius = state.brushSize / 2;
    const affected = new Set();
    for (let x = Math.floor((clientX - radius) / CELL_SIZE); x <= Math.floor((clientX + radius) / CELL_SIZE); x++) {
      for (let y = Math.floor((clientY - radius) / CELL_SIZE); y <= Math.floor((clientY + radius) / CELL_SIZE); y++) {
        for (const candidate of stroke.grid.get(`${x},${y}`) || []) {
          if ((candidate.x - clientX) ** 2 + (candidate.y - clientY) ** 2 > radius ** 2) continue;
          const { entry, face } = candidate;
          if (stroke.subtract ? !entry.selected.has(face) : entry.selected.has(face)) continue;
          if (!setRay(candidate.x, candidate.y, stroke.bounds)) continue;
          const hit = nearestSurface();
          if (!hit) continue;
          // A centroid must be on the nearest visible surface, including other
          // model primitives, so painting an arm cannot select the back/torso.
          const distance = candidate.world.distanceToSquared(raycaster.ray.origin);
          if (distance > hit.distanceSquared + Math.max(1e-8, hit.distanceSquared * 1e-7)) continue;
          if (changeSelection(entry, [face], stroke.subtract, stroke.changes)) affected.add(entry);
        }
      }
    }
    for (const entry of affected) redrawEntry(entry);
    if (affected.size) { message = ''; emit(); }
  }

  function pointerDown(event) {
    if (!state.enabled || state.locked || !getStatus().isReady || event.button !== 0 || !event.isPrimary) return;
    if (state.tool === 'part') {
      press = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      return; // OrbitControls continues to own drag gestures.
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const bounds = canvas.getBoundingClientRect();
    stroke = { pointerId: event.pointerId, controlsEnabled: controls.enabled, changes: new Map(),
      subtract: Boolean(event.shiftKey), bounds, grid: projectedGrid(bounds), x: event.clientX, y: event.clientY };
    controls.enabled = false;
    canvas.setPointerCapture(event.pointerId);
    paint(event.clientX, event.clientY);
  }

  function pointerMove(event) {
    if (brushCursor && state.enabled && state.tool === 'brush' && !state.locked && getStatus().isReady) {
      const bounds = container.getBoundingClientRect();
      brushCursor.style.display = 'block';
      brushCursor.style.left = `${event.clientX - bounds.left}px`;
      brushCursor.style.top = `${event.clientY - bounds.top}px`;
      brushCursor.style.width = `${state.brushSize}px`;
      brushCursor.style.height = `${state.brushSize}px`;
    }
    if (press?.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) press.moved = true;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const distance = Math.hypot(event.clientX - stroke.x, event.clientY - stroke.y);
    const steps = Math.min(32, Math.max(1, Math.ceil(distance / Math.max(3, state.brushSize / 3))));
    const fromX = stroke.x, fromY = stroke.y;
    for (let step = 1; step <= steps; step++) paint(fromX + (event.clientX - fromX) * step / steps, fromY + (event.clientY - fromY) * step / steps);
    stroke.x = event.clientX;
    stroke.y = event.clientY;
  }

  function pointerUp(event) {
    if (stroke?.pointerId === event.pointerId) {
      event.preventDefault(); event.stopImmediatePropagation(); endStroke(); return;
    }
    const start = press;
    press = undefined;
    if (!start || !state.enabled || state.locked || event.pointerId !== start.pointerId || event.button !== 0) return;
    if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 5) pickPart(event);
  }

  function cancelPointer() { press = undefined; endStroke(); }
  function pointerLeave() { if (brushCursor) brushCursor.style.display = 'none'; }
  const listeners = [['pointerdown', pointerDown], ['pointermove', pointerMove], ['pointerup', pointerUp],
    ['pointercancel', cancelPointer], ['lostpointercapture', cancelPointer], ['pointerleave', pointerLeave]];
  for (const [event, handler] of listeners) canvas.addEventListener(event, handler, true);

  function canChange() { return !disposed && state.enabled && !state.locked && getStatus().isReady; }
  return {
    get enabled() { return state.enabled; },
    getStatus,
    getEdits() {
      return entries.filter((entry) => entry.deleted.size).map((entry) => ({
        mesh: entry.mesh, primitive: entry.primitive, faces: [...entry.deleted].sort((a, b) => a - b),
      }));
    },
    setState(options = {}) {
      if (disposed) return;
      endStroke();
      press = undefined;
      state = { ...state, ...options };
      state.enabled = Boolean(state.enabled);
      state.locked = Boolean(state.locked);
      state.tool = state.tool === 'brush' ? 'brush' : 'part';
      state.brushSize = Math.max(6, Math.min(160, Number(state.brushSize) || 32));
      refreshModel();
      refreshAppearance();
      return emit();
    },
    refreshModel,
    clearSelection() {
      if (!canChange()) return false;
      const changes = [];
      for (const entry of entries) {
        if (!entry.selected.size) continue;
        changes.push({ key: entry.key, added: new Uint32Array(), removed: Uint32Array.from(entry.selected) });
        entry.selected.clear();
        redrawEntry(entry);
      }
      pushUndo(changes);
      message = '';
      emit();
      return changes.length > 0;
    },
    deleteSelection() {
      if (!canChange()) return false;
      endStroke();
      const status = getStatus();
      if (!status.selectedTriangles) return false;
      if (status.deletedTriangles + status.selectedTriangles >= status.totalTriangles) {
        message = 'Нельзя удалить всю модель. Снимите выделение и выберите меньшую часть или кисть.';
        emit();
        return false;
      }
      const changes = [];
      for (const entry of entries) {
        if (!entry.selected.size) continue;
        changes.push({ key: entry.key, added: Uint32Array.from(entry.selected), removed: new Uint32Array() });
        for (const face of entry.selected) entry.deleted.add(face);
        entry.selected.clear();
        applyDeletion(entry);
        redrawEntry(entry);
      }
      pushUndo(changes, 'deletion');
      message = '';
      emit();
      return true;
    },
    selectSmallParts(maxFaces = 100) {
      if (!canChange()) return false;
      const threshold = Math.max(1, Math.min(10_000, Math.round(Number(maxFaces) || 100)));
      const changes = new Map();
      for (const entry of entries) {
        entry.topology ||= buildComponents(entry.source, entry.indices);
        let changed = false;
        for (const part of entry.topology.components) {
          if (part.length <= threshold) changed = changeSelection(entry, part, false, changes) || changed;
        }
        if (changed) redrawEntry(entry);
      }
      finishSelection(changes);
      message = getStatus().selectedTriangles ? '' : 'Отдельных частей такого размера не найдено. Для прикреплённых деталей используйте кисть.';
      emit();
      return changes.size > 0;
    },
    undo() {
      if (!canChange()) return false;
      endStroke();
      const action = undoStack.pop();
      if (!action) return false;
      undoIndices -= action.size;
      for (const change of action.changes) {
        const entry = byKey.get(change.key);
        if (!entry) continue;
        if (action.kind === 'deletion') {
          for (const face of change.added) { entry.deleted.delete(face); entry.selected.add(face); }
          applyDeletion(entry);
        } else {
          for (const face of change.added) entry.selected.delete(face);
          for (const face of change.removed) if (!entry.deleted.has(face)) entry.selected.add(face);
        }
        redrawEntry(entry);
      }
      message = '';
      emit();
      return true;
    },
    restore() {
      // Cancel first disables interaction/callbacks, then discards the draft.
      if (disposed || !getStatus().isReady) return false;
      endStroke();
      for (const entry of entries) {
        entry.deleted.clear();
        entry.selected.clear();
        applyDeletion(entry);
        redrawEntry(entry);
      }
      undoStack = [];
      undoIndices = 0;
      message = '';
      emit();
      return true;
    },
    dispose() {
      if (disposed) return;
      clearRecords();
      disposed = true;
      for (const [event, handler] of listeners) canvas.removeEventListener(event, handler, true);
      overlay.removeFromParent();
      brushCursor?.remove();
      highlightMaterial.dispose();
      if (controls.mouseButtons) controls.mouseButtons.RIGHT = initialRightAction;
      canvas.style.cursor = initialCursor;
      if (initialLabel === null) canvas.removeAttribute('aria-label');
      else canvas.setAttribute('aria-label', initialLabel);
    },
  };
}
