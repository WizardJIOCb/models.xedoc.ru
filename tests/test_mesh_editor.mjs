import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../apps/studio-web/node_modules/three/build/three.module.js';
import { buildComponents, createTriangleTree, filterTriangles } from '../apps/studio-web/src/mesh-topology.js';
import { createMeshEditor } from '../apps/studio-web/src/mesh-editor.js';

function geometry(quads = [[-1.5, 0, 0], [1.5, 0, 0]]) {
  const positions = [];
  for (const [x, y, z] of quads) {
    for (const [dx, dy] of [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, -.5], [.5, .5], [-.5, .5]]) positions.push(x + dx, y + dy, z);
  }
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.setAttribute('uv', new THREE.Float32BufferAttribute(Array.from({ length: positions.length / 3 * 2 }, (_, i) => i % 5 / 5), 2));
  result.computeVertexNormals();
  quads.forEach((_, i) => result.addGroup(i * 6, 6, i));
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

function fixture(quads, duplicate = false) {
  const source = geometry(quads);
  const mesh = new THREE.Mesh(source, [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()]);
  mesh.userData.studioPrimitive = { mesh: 3, primitive: 2 };
  let model = new THREE.Group();
  model.add(mesh);
  const other = duplicate ? mesh.clone() : null;
  if (other) { other.position.y = 2; model.add(other); }
  const scene = new THREE.Scene();
  scene.add(model);
  const camera = new THREE.PerspectiveCamera(50, 1, .1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  model.updateMatrixWorld(true);
  const listeners = new Map();
  const attributes = new Map([['aria-label', 'Original viewer']]);
  const captures = new Set();
  const canvas = {
    style: { cursor: 'grab' },
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 500 }),
    setPointerCapture: (id) => captures.add(id),
    hasPointerCapture: (id) => captures.has(id),
    releasePointerCapture: (id) => captures.delete(id),
  };
  const controls = { enabled: true, mouseButtons: { RIGHT: THREE.MOUSE.PAN } };
  const states = [];
  const editor = createMeshEditor({ scene, camera, canvas, container: { dataset: {} }, controls, getModel: () => model, onChange: (state) => states.push(state) });
  editor.setState({ enabled: true });
  function event(name, x, y, extra = {}) {
    const point = new THREE.Vector3(x, y, 0).project(camera);
    const data = { clientX: (point.x + 1) * 250, clientY: (1 - point.y) * 250, pointerId: 1, button: 0, isPrimary: true,
      preventDefault() {}, stopImmediatePropagation() {}, ...extra };
    listeners.get(name)?.(data);
  }
  function click(x, y, extra) { event('pointerdown', x, y, extra); event('pointerup', x, y, extra); }
  return { editor, mesh, other, source, scene, camera, canvas, controls, states, listeners, event, click, setModel: (next) => { model = next; editor.refreshModel(); } };
}

test('connected components bridge UV seams but keep nearby detached surfaces separate', () => {
  const source = geometry();
  const topology = buildComponents(source);
  assert.deepEqual(topology.components.map((part) => [...part]), [[0, 1], [2, 3]]);
  // A tiny export-rounding discrepancy across a seam is still welded.
  source.getAttribute('position').setX(3, -2 + topology.tolerance * .2);
  assert.deepEqual(buildComponents(source).components.map((part) => [...part]), [[0, 1], [2, 3]]);
});

test('face removal preserves UVs, material groups, source IDs and original bounds', () => {
  const source = geometry();
  const before = source.clone();
  const filtered = filterTriangles(source, new Set([0, 2]));
  assert.deepEqual([...filtered.index], [3, 4, 5, 9, 10, 11]);
  assert.deepEqual([...filtered.sourceTriangles], [1, 3]);
  assert.deepEqual(filtered.groups, [{ start: 0, count: 3, materialIndex: 0 }, { start: 3, count: 3, materialIndex: 1 }]);
  assert.deepEqual(source.getAttribute('position').array, before.getAttribute('position').array);
  assert.deepEqual(source.getAttribute('uv').array, before.getAttribute('uv').array);
  assert.ok(source.boundingBox.equals(before.boundingBox));
});

test('triangle tree resolves nearest visible surface and respects deleted source faces', () => {
  const source = geometry([[0, 0, 0], [0, 0, -1]]);
  const tree = createTriangleTree(source);
  const ray = new THREE.Ray(new THREE.Vector3(.2, .1, 3), new THREE.Vector3(0, 0, -1));
  assert.equal(tree.intersect(ray).triangle, 0);
  assert.equal(tree.intersect(ray).distance, 3);
  const behind = tree.intersect(ray, new Set([0, 1]));
  assert.equal(behind.triangle, 2);
  assert.equal(behind.distance, 4);
  assert.equal(tree.intersect(ray, new Set([0, 1, 2, 3])), null);
});

test('part click, delete, undo and restore keep stable GLB primitive IDs', () => {
  const f = fixture();
  assert.equal(f.editor.getStatus().isReady, true);
  f.click(-1.4, .1);
  assert.equal(f.editor.getStatus().selectedTriangles, 2);
  assert.equal(f.editor.deleteSelection(), true);
  assert.deepEqual(f.editor.getEdits(), [{ mesh: 3, primitive: 2, faces: [0, 1] }]);
  assert.equal(f.mesh.geometry.index.count, 6);
  assert.deepEqual(f.mesh.geometry.getAttribute('uv').array, f.source.getAttribute('uv').array);
  assert.ok(f.mesh.geometry.boundingBox.equals(f.source.boundingBox));
  assert.deepEqual(f.mesh.geometry.groups, [{ start: 0, count: 6, materialIndex: 1 }]);
  f.editor.undo();
  assert.equal(f.editor.getStatus().deletedTriangles, 0);
  assert.equal(f.editor.getStatus().selectedTriangles, 2);
  f.editor.undo();
  assert.equal(f.editor.getStatus().selectedTriangles, 0);
  f.click(1.4, .1);
  f.editor.deleteSelection();
  assert.deepEqual(f.editor.getEdits()[0].faces, [2, 3]);
  f.editor.restore();
  assert.equal(f.mesh.geometry.index.count, 12);
  assert.equal(f.editor.getStatus().dirty, false);
  assert.equal(f.editor.getStatus().canUndo, false);
  f.editor.dispose();
  assert.equal(f.mesh.geometry, f.source);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.canvas.getAttribute('aria-label'), 'Original viewer');
});

test('drag or shift removal does not accidentally delete a clicked component', () => {
  const f = fixture();
  f.event('pointerdown', -1.4, .1);
  f.event('pointermove', -1.1, .1);
  f.event('pointerup', -1.1, .1);
  assert.equal(f.editor.getStatus().selectedTriangles, 0);
  assert.equal(f.controls.enabled, true);
  f.click(-1.4, .1);
  f.click(-1.4, .1, { shiftKey: true });
  assert.equal(f.editor.getStatus().selectedTriangles, 0);
  f.editor.selectSmallParts(3);
  assert.equal(f.editor.getStatus().selectedTriangles, 4);
  assert.equal(f.editor.deleteSelection(), false);
  assert.match(f.editor.getStatus().error, /всю модель/);
  f.editor.dispose();
});

test('brush selects only front visible faces, disables paint orbit and restores right orbit binding', () => {
  const f = fixture([[0, 0, 0], [0, 0, -.5]]);
  f.editor.setState({ tool: 'brush', brushSize: 120 });
  assert.equal(f.controls.mouseButtons.RIGHT, THREE.MOUSE.ROTATE);
  f.event('pointerdown', 0, 0);
  assert.equal(f.controls.enabled, false);
  f.event('pointerup', 0, 0);
  assert.equal(f.controls.enabled, true);
  assert.equal(f.editor.getStatus().selectedTriangles, 2);
  f.editor.deleteSelection();
  assert.deepEqual(f.editor.getEdits(), [{ mesh: 3, primitive: 2, faces: [0, 1] }]);
  f.editor.undo();
  f.click(0, 0, { shiftKey: true });
  assert.equal(f.editor.getStatus().selectedTriangles, 0);
  f.editor.setState({ enabled: false });
  assert.equal(f.controls.mouseButtons.RIGHT, THREE.MOUSE.PAN);
  f.editor.dispose();
});

test('shared primitive instances are edited together and saved only once', () => {
  const f = fixture(undefined, true);
  f.click(-1.4, .1);
  f.editor.deleteSelection();
  assert.equal(f.editor.getStatus().deletedTriangles, 2);
  assert.equal(f.editor.getEdits().length, 1);
  assert.equal(f.mesh.geometry.index.count, 6);
  assert.equal(f.other.geometry.index.count, 6);
  f.editor.dispose();
});

test('changing the source clears draft and rejects unmapped or skinned surfaces', () => {
  const f = fixture();
  f.click(-1.4, .1);
  f.editor.deleteSelection();
  f.setModel(new THREE.Group());
  assert.equal(f.editor.getStatus().dirty, false);
  assert.equal(f.editor.getStatus().isReady, false);
  const unknown = new THREE.Group();
  unknown.add(new THREE.Mesh(geometry()));
  f.setModel(unknown);
  assert.equal(f.editor.getStatus().isReady, false);
  assert.match(f.editor.getStatus().error, /сопоставить/);
  const skinned = new THREE.Group();
  skinned.add(new THREE.SkinnedMesh(geometry()));
  f.setModel(skinned);
  assert.equal(f.editor.getStatus().isReady, false);
  assert.match(f.editor.getStatus().error, /до создания скелета/);
  f.editor.dispose();
});

test('save lock keeps draft and cancel can restore after disabling editor callbacks', () => {
  const f = fixture();
  f.click(-1.4, .1);
  f.editor.deleteSelection();
  f.editor.setState({ enabled: false, onChange: null });
  assert.deepEqual(f.editor.getEdits(), [{ mesh: 3, primitive: 2, faces: [0, 1] }]);
  assert.equal(f.editor.deleteSelection(), false);
  assert.equal(f.editor.restore(), true);
  assert.equal(f.editor.getStatus().dirty, false);
  assert.equal(f.mesh.geometry.index.count, 12);
  f.editor.dispose();
});

test('an inactive cleanup editor does not override the manual skeleton cursor', () => {
  const f = fixture();
  f.editor.setState({ enabled: false });
  f.canvas.setAttribute('aria-label', 'Manual skeleton');
  f.canvas.style.cursor = 'move';
  f.editor.refreshModel();
  assert.equal(f.canvas.getAttribute('aria-label'), 'Manual skeleton');
  assert.equal(f.canvas.style.cursor, 'move');
  f.editor.dispose();
});
