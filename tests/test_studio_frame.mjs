import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../apps/studio-web/node_modules/three/build/three.module.js';
import { readStudioFramePoints, getStudioFrameBounds } from '../apps/studio-web/src/studio-frame.js';

function asset(sources) {
  const position = new THREE.Float32BufferAttribute([-.4, -.2, 0, .3, 1.5, -.1, .2, .5, .6], 3);
  let reads = 0;
  return {
    get reads() { return reads; },
    asset: { extras: { studioFrameSources: sources || [{ position: 0, matrix: new THREE.Matrix4().toArray() }] } },
    parser: { json: { accessors: [{ type: 'VEC3', count: position.count }] },
      async getDependency(type, index) { reads++; assert.equal(type, 'accessor'); assert.equal(index, 0); return position; } },
  };
}

test('original accessor instances retain their individual world transforms and load once', async () => {
  const first = new THREE.Matrix4().makeTranslation(2, 3, 4);
  const second = new THREE.Matrix4().makeRotationY(Math.PI / 2);
  const gltf = asset([{ position: 0, matrix: first.toArray() }, { position: 0, matrix: second.toArray() }]);
  const points = await readStudioFramePoints(gltf);
  assert.ok(points instanceof Float32Array);
  assert.equal(points.length, 18);
  assert.equal(gltf.reads, 1);
  const vertex = new THREE.Vector3(-.4, -.2, 0);
  assert.ok(vertex.clone().applyMatrix4(first).distanceTo(new THREE.Vector3().fromArray(points)) < 1e-6);
  assert.ok(vertex.clone().applyMatrix4(second).distanceTo(new THREE.Vector3().fromArray(points, 9)) < 1e-6);
});

test('precise frame survives model translation, rotation and scaling', async () => {
  const points = await readStudioFramePoints(asset());
  const model = new THREE.Group();
  model.userData.studioFramePoints = points;
  function expected() {
    const box = new THREE.Box3();
    for (let i = 0; i < points.length; i += 3) box.expandByPoint(new THREE.Vector3().fromArray(points, i).applyMatrix4(model.matrixWorld));
    return box;
  }
  for (const [rotation, position, scale] of [[.6, .5, 2], [.6, -2, 2], [-.4, .8, .3]]) {
    model.rotation.set(rotation, rotation * .5, rotation * 2);
    model.position.set(position, position * 2, -position);
    model.scale.set(scale, scale * .7, scale * 1.2);
    model.updateMatrixWorld(true);
    const actual = getStudioFrameBounds(model), desired = expected();
    assert.ok(actual.min.distanceTo(desired.min) < 1e-8);
    assert.ok(actual.max.distanceTo(desired.max) < 1e-8);
  }
  assert.equal(getStudioFrameBounds(new THREE.Group()), null);
});

test('untrusted oversized or invalid frame metadata is rejected before accessor loading', async () => {
  for (const change of [
    (gltf) => { gltf.asset.extras.studioFrameSources[0].matrix[3] = 1; },
    (gltf) => { gltf.asset.extras.studioFrameSources[0].position = -1; },
    (gltf) => { gltf.asset.extras.studioFrameSources[0].matrix[4] = Infinity; },
    (gltf) => { gltf.parser.json.accessors[0].count = 2_000_001; },
    (gltf) => { gltf.asset.extras.studioFrameSources = Array(1025).fill(gltf.asset.extras.studioFrameSources[0]); },
  ]) {
    const gltf = asset();
    change(gltf);
    assert.equal(await readStudioFramePoints(gltf), null);
    assert.equal(gltf.reads, 0);
  }
  const invalidPoints = asset();
  invalidPoints.parser.getDependency = async () => new THREE.Float32BufferAttribute([0, NaN, 1, 0, 0, 0, 1, 1, 1], 3);
  assert.equal(await readStudioFramePoints(invalidPoints), null);
});
