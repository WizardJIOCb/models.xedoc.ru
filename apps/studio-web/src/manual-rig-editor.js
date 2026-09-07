import * as THREE from 'three';

export const MANUAL_RIG_JOINT_IDS = [
  'head', 'neck',
  ...['l', 'r'].flatMap((side) => ['shoulder', 'elbow', 'wrist', 'hand', 'hip', 'knee', 'ankle', 'toe'].map((joint) => `${joint}_${side}`)),
];

const JOINTS = new Set(MANUAL_RIG_JOINT_IDS);
const CHAINS = [
  ['head', 'neck'],
  ...['l', 'r'].flatMap((side) => [
    ['neck', `shoulder_${side}`, `elbow_${side}`, `wrist_${side}`, `hand_${side}`],
    [`hip_${side}`, `knee_${side}`, `ankle_${side}`, `toe_${side}`],
  ]),
  ['hip_l', 'hip_r'],
];

function copyPoints(points) {
  const result = {};
  for (const id of MANUAL_RIG_JOINT_IDS) {
    const value = points?.[id];
    if (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) result[id] = [...value];
  }
  return result;
}

/**
 * Points use oriented glTF axes, with the exact model height normalized to 2,
 * the bottom at y=0 and x/z centered. The scene's display scale and placement
 * are applied only by this overlay group and never written into saved points.
 */
export function createManualRigEditor({ scene, camera, canvas, container, controls, getModel }) {
  const overlay = new THREE.Group();
  overlay.name = 'ManualRigEditor';
  overlay.visible = false;
  scene.add(overlay);
  const sphere = new THREE.SphereGeometry(0.024, 16, 12);
  const materials = {
    center: new THREE.MeshBasicMaterial({ color: 0xf1f6ff, depthTest: false, depthWrite: false }),
    left: new THREE.MeshBasicMaterial({ color: 0x36ddd2, depthTest: false, depthWrite: false }),
    right: new THREE.MeshBasicMaterial({ color: 0xa2acff, depthTest: false, depthWrite: false }),
    selected: new THREE.MeshBasicMaterial({ color: 0xffd36b, depthTest: false, depthWrite: false }),
  };
  const markers = new Map();
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(128 * 3), 3));
  lineGeometry.setDrawRange(0, 0);
  const lineMaterial = new THREE.LineBasicMaterial({ color: 0x6cd8d5, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.renderOrder = 30;
  overlay.add(lines);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let state = { enabled: false, locked: false, points: {}, selected: 'head' };
  let model;
  let surfaceMeshes = [];
  let drag;
  let press;
  let disposed = false;
  let lastPointSignature = '';
  let lastSelected;
  const initialCursor = canvas.style.cursor;
  const initialLabel = canvas.getAttribute('aria-label');

  function updateDiagnostics() {
    container.dataset.manualRig = String(Boolean(state.enabled && model));
    container.dataset.manualPointCount = String(Object.keys(state.points).length);
    container.dataset.manualSelected = state.selected || '';
    container.dataset.manualLocked = String(state.locked);
    const bounds = canvas.getBoundingClientRect();
    const projected = {};
    if (overlay.visible && bounds.width && bounds.height) {
      camera.updateMatrixWorld(true);
      overlay.updateMatrixWorld(true);
      for (const [id, coordinates] of Object.entries(state.points)) {
        const point = overlay.localToWorld(new THREE.Vector3(...coordinates)).project(camera);
        projected[id] = {
          x: Math.round((bounds.left + (point.x + 1) / 2 * bounds.width) * 10) / 10,
          y: Math.round((bounds.top + (1 - point.y) / 2 * bounds.height) * 10) / 10,
          visible: point.z > -1 && point.z < 1 && Math.abs(point.x) < 1 && Math.abs(point.y) < 1,
        };
      }
    }
    container.dataset.manualProjectedPoints = JSON.stringify(projected);
  }

  function redraw() {
    overlay.visible = Boolean(state.enabled && model);
    canvas.style.cursor = overlay.visible ? (state.locked ? 'wait' : drag ? 'grabbing' : 'crosshair') : initialCursor;
    if (overlay.visible) canvas.setAttribute('aria-label', 'Расстановка суставов. Выберите сустав справа и нажмите на персонажа. Перетаскивайте точки для уточнения, переключайте виды для проверки глубины.');
    else if (initialLabel !== null) canvas.setAttribute('aria-label', initialLabel);
    else canvas.removeAttribute('aria-label');
    updateDiagnostics();
    const signature = JSON.stringify(state.points);
    if (signature === lastPointSignature && lastSelected === state.selected) return;
    lastPointSignature = signature;
    lastSelected = state.selected;
    for (const [id, marker] of markers) {
      if (!state.points[id]) { marker.removeFromParent(); markers.delete(id); }
    }
    for (const [id, position] of Object.entries(state.points)) {
      let marker = markers.get(id);
      if (!marker) {
        marker = new THREE.Mesh(sphere, materials.center);
        marker.userData.manualJoint = id;
        marker.renderOrder = 31;
        markers.set(id, marker);
        overlay.add(marker);
      }
      marker.position.fromArray(position);
      marker.material = id === state.selected ? materials.selected : id.endsWith('_l') ? materials.left : id.endsWith('_r') ? materials.right : materials.center;
      marker.scale.setScalar(id === state.selected ? 1.35 : 1);
    }
    const vertices = [];
    for (const chain of CHAINS) {
      for (let index = 1; index < chain.length; index++) {
        const start = state.points[chain[index - 1]], end = state.points[chain[index]];
        if (start && end) vertices.push(...start, ...end);
      }
    }
    if (state.points.neck && state.points.hip_l && state.points.hip_r) {
      const pelvis = state.points.hip_l.map((value, index) => (value + state.points.hip_r[index]) / 2);
      vertices.push(...state.points.neck, ...pelvis);
    }
    lineGeometry.attributes.position.array.fill(0);
    lineGeometry.attributes.position.array.set(vertices);
    lineGeometry.attributes.position.needsUpdate = true;
    lineGeometry.setDrawRange(0, vertices.length / 3);
    lineGeometry.computeBoundingSphere();
    overlay.updateMatrixWorld(true);
  }

  function endDrag() {
    if (!drag) return;
    const previous = drag;
    drag = undefined;
    controls.enabled = previous.controlsEnabled;
    if (canvas.hasPointerCapture(previous.pointerId)) canvas.releasePointerCapture(previous.pointerId);
    redraw();
  }

  function setState(next = {}) {
    state = {
      ...state, ...next,
      enabled: next.enabled === undefined ? state.enabled : Boolean(next.enabled),
      locked: next.locked === undefined ? state.locked : Boolean(next.locked),
      points: Object.hasOwn(next, 'points') ? copyPoints(next.points) : state.points,
      selected: Object.hasOwn(next, 'selected') ? (JOINTS.has(next.selected) ? next.selected : null) : state.selected,
    };
    if (!state.enabled || state.locked) { press = undefined; endDrag(); }
    redraw();
  }

  function refreshModel() {
    endDrag();
    press = undefined;
    model = getModel();
    surfaceMeshes = [];
    if (model) {
      model.updateMatrixWorld(true);
      // Precise vertex bounds match the backend even for a rotated source whose
      // transformed local bounding box contains substantial empty space.
      const bounds = new THREE.Box3().setFromObject(model, true);
      const center = bounds.getCenter(new THREE.Vector3());
      overlay.position.set(center.x, bounds.min.y, center.z);
      overlay.scale.setScalar(Math.max(bounds.max.y - bounds.min.y, 0.001) / 2);
      model.traverse((object) => { if (object.isMesh && object.visible) surfaceMeshes.push(object); });
      overlay.updateMatrixWorld(true);
    }
    redraw();
  }

  function setRay(event) {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return false;
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return true;
  }

  function emitPoint(id, position) {
    const point = overlay.worldToLocal(position.clone()).toArray().map((value) => Math.round(value * 1000000) / 1000000);
    if (!point.every(Number.isFinite)) return;
    if (state.points[id]?.every((value, index) => value === point[index])) return;
    state.points = { ...state.points, [id]: point };
    const updatedPoints = copyPoints(state.points);
    redraw();
    // UI callbacks can synchronously call setState (including advancing the
    // selected joint), so publish this edit before any hint triggers a repaint.
    state.onChange?.(updatedPoints);
    state.onHint?.('');
  }

  function surfacePoint() {
    // Double-sided raycasts expose the exit of the nearest solid segment. Restore
    // shared materials immediately, before rendering can observe this change.
    const originalSides = new Map();
    for (const mesh of surfaceMeshes) {
      for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material])) {
        if (material && !originalSides.has(material)) { originalSides.set(material, material.side); material.side = THREE.DoubleSide; }
      }
    }
    let hits;
    try { hits = raycaster.intersectObjects(surfaceMeshes, false); }
    finally { for (const [material, side] of originalSides) material.side = side; }
    const first = hits[0];
    if (!first) return null;
    const scale = overlay.scale.x;
    const next = hits.find((hit) => hit.object === first.object && hit.distance - first.distance > scale * 0.0001);
    if (next && next.distance - first.distance < scale * 0.5 && first.face && next.face) {
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(first.object.matrixWorld);
      const entryFacing = first.face.normal.clone().applyNormalMatrix(normalMatrix).dot(raycaster.ray.direction);
      const exitFacing = next.face.normal.clone().applyNormalMatrix(normalMatrix).dot(raycaster.ray.direction);
      if (entryFacing < -0.00001 && exitFacing > 0.00001) return first.point.clone().lerp(next.point, 0.5);
    }
    // Open, layered or disconnected meshes do not provide a reliable exit. A
    // small inward offset is safer than averaging across a limb and the torso.
    return first.point.clone().addScaledVector(raycaster.ray.direction, scale * 0.012);
  }

  function pointerDown(event) {
    if (!state.enabled || state.locked || !model || event.button !== 0 || !event.isPrimary || !setRay(event)) return;
    press = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    overlay.updateMatrixWorld(true);
    let marker = raycaster.intersectObjects([...markers.values()], false)[0]?.object;
    if (!marker) {
      // Small markers remain easy to grab without enlarging the drawn joints.
      // Prefer a real sphere hit, then the nearest visible marker in CSS pixels.
      const bounds = canvas.getBoundingClientRect();
      let nearestSquared = (event.pointerType === 'touch' ? 14 : 8) ** 2;
      for (const candidate of markers.values()) {
        const projected = candidate.getWorldPosition(new THREE.Vector3()).project(camera);
        if (projected.z <= -1 || projected.z >= 1 || Math.abs(projected.x) >= 1 || Math.abs(projected.y) >= 1) continue;
        const x = bounds.left + (projected.x + 1) / 2 * bounds.width;
        const y = bounds.top + (1 - projected.y) / 2 * bounds.height;
        const distanceSquared = (event.clientX - x) ** 2 + (event.clientY - y) ** 2;
        if (distanceSquared < nearestSquared) { marker = candidate; nearestSquared = distanceSquared; }
      }
    }
    if (!marker) return; // OrbitControls owns ordinary camera drags.
    event.preventDefault();
    event.stopImmediatePropagation();
    const id = marker.userData.manualJoint;
    const position = marker.getWorldPosition(new THREE.Vector3());
    const normal = camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, position);
    const planePoint = raycaster.ray.intersectPlane(plane, new THREE.Vector3()) ?? position;
    drag = { id, plane, offset: position.clone().sub(planePoint), pointerId: event.pointerId, controlsEnabled: controls.enabled };
    controls.enabled = false;
    canvas.setPointerCapture(event.pointerId);
    state.selected = id;
    redraw();
    state.onSelect?.(id);
  }

  function pointerMove(event) {
    if (press?.pointerId === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) press.moved = true;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!setRay(event)) return;
    const intersection = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
    if (intersection) emitPoint(drag.id, intersection.add(drag.offset));
  }

  function pointerUp(event) {
    if (drag?.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopImmediatePropagation();
      endDrag();
      press = undefined;
      return;
    }
    const start = press;
    press = undefined;
    if (!state.enabled || state.locked || !model || !start || start.pointerId !== event.pointerId || event.button !== 0) return;
    if (start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
    if (!state.selected) { state.onHint?.('Выберите сустав в списке справа.'); return; }
    if (!setRay(event)) return;
    const point = surfacePoint();
    if (point) emitPoint(state.selected, point);
    else state.onHint?.('Нажмите на персонажа, чтобы поставить выбранную точку.');
  }

  function pointerCancel() { press = undefined; endDrag(); }
  for (const [event, handler] of [['pointerdown', pointerDown], ['pointermove', pointerMove], ['pointerup', pointerUp], ['pointercancel', pointerCancel], ['lostpointercapture', pointerCancel]]) {
    canvas.addEventListener(event, handler, true);
  }

  return {
    get enabled() { return state.enabled; },
    setState,
    refreshModel,
    view(direction) {
      if (!model || !['front', 'left', 'right', 'back'].includes(direction)) return false;
      endDrag();
      const target = overlay.localToWorld(new THREE.Vector3(0, 1, 0));
      const offsets = { front: [0, 0, 1], left: [1, 0, 0], right: [-1, 0, 0], back: [0, 0, -1] };
      const distance = Math.max(3.6, 4.1 * overlay.scale.x);
      // Flush any residual OrbitControls damping before choosing an exact side.
      const damping = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();
      controls.target.copy(target);
      camera.position.copy(target).addScaledVector(new THREE.Vector3(...offsets[direction]), distance);
      controls.update();
      controls.enableDamping = damping;
      container.dataset.manualView = direction;
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      endDrag();
      for (const [event, handler] of [['pointerdown', pointerDown], ['pointermove', pointerMove], ['pointerup', pointerUp], ['pointercancel', pointerCancel], ['lostpointercapture', pointerCancel]]) {
        canvas.removeEventListener(event, handler, true);
      }
      overlay.removeFromParent();
      sphere.dispose();
      Object.values(materials).forEach((material) => material.dispose());
      lineGeometry.dispose();
      lineMaterial.dispose();
      markers.clear();
      canvas.style.cursor = initialCursor;
      if (initialLabel !== null) canvas.setAttribute('aria-label', initialLabel);
      else canvas.removeAttribute('aria-label');
    },
  };
}
