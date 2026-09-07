import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../apps/studio-web/node_modules/three/build/three.module.js';
import { readStudioFramePoints } from '../apps/studio-web/src/studio-frame.js';
import { createManualRigEditor } from '../apps/studio-web/src/manual-rig-editor.js';

const source = readFileSync(new URL('../apps/studio-web/src/viewer.js', import.meta.url), 'utf8');
function declaration(name) {
  const match = new RegExp(`  (?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, name);
  const start = match.index;
  // Default object arguments contain braces; the body starts after the signature.
  const open = source.indexOf(' {\n', start) + 1;
  assert.ok(open > start, name);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unterminated ${name}`);
}

function asset(skinned = false) {
  const root = new THREE.Group();
  root.position.set(.4, .2, -.7);
  root.rotation.set(.1, .2, -.1);
  root.scale.set(1.1, .9, 1);
  const geometry = new THREE.BoxGeometry(.7, 2, .6).translate(.2, 1, .1);
  const mesh = skinned ? new THREE.SkinnedMesh(geometry) : new THREE.Mesh(geometry);
  if (skinned) {
    const joint = new THREE.Bone();
    root.add(joint);
    mesh.bind(new THREE.Skeleton([joint]));
  }
  root.add(mesh);
  root.updateMatrix();
  return { scene: root, animations: [] };
}

function fixture(skinned = false, suppliedAsset = null) {
  const gltf = suppliedAsset || asset(skinned);
  const original = gltf.scene.matrix.clone();
  const runtime = new Function('THREE', 'gltf', 'readStudioFramePoints', `
    let request=0, disposed=false, ready=false, model, mixer, action, ragdoll, skeleton;
    let sourceOrientation=false, orientationPreview=false, triangles=0, rigAvailable=false;
    let clipName='', patrol=false, playing=true, animationTime=0;
    const previewRotation={x:0,y:0,z:0}, placement=new THREE.Vector3();
    const basePosition=new THREE.Vector3(), baseQuaternion=new THREE.Quaternion();
    const scene=new THREE.Scene(), container={dataset:{}}, props=[], BONES=[];
    const playground=false;
    const camera=new THREE.Object3D(), initialCamera=new THREE.Vector3(3,2,5);
    const controls={target:new THREE.Vector3(),update(){}};
    const manualEditor={refreshModel(){},enabled:false};
    const meshEditor={refreshModel(){},getStatus(){return {enabled:false};}};
    const emit=()=>{}, disposeObject=()=>{}, ensurePhysics=async()=>{};
    const clearModel=()=>{ready=false;model=undefined;sourceOrientation=false;orientationPreview=false;};
    const modelFiles={async load(){return new ArrayBuffer(20);}};
    const window={location:{href:'http://localhost/playground'}};
    const GLTFLoader=class{async parseAsync(){return gltf;}};
    ${declaration('load')}
    ${declaration('applyPreviewRotation')}
    ${declaration('setPosition')}
    ${declaration('resetCamera')}
    ${declaration('reset')}
    return {load,setPosition,reset,setOrientation:applyPreviewRotation,
      get model(){return model;},get sourceOrientation(){return sourceOrientation;},
      get orientationPreview(){return orientationPreview;},get basePosition(){return basePosition;}};
  `)(THREE, gltf, readStudioFramePoints);
  return { runtime, gltf, original };
}

function close(a, b) { assert.ok(Math.abs(a-b)<1e-6, `${a} != ${b}`); }
function matrixClose(a,b) { a.elements.forEach((n,i)=>close(n,b.elements[i])); }
function points(root) {
  root.updateMatrixWorld(true);
  const result=[];
  root.traverse((object)=>{
    if (!object.isMesh) return;
    for(let i=0;i<object.geometry.attributes.position.count;i++) result.push(...new THREE.Vector3().fromBufferAttribute(object.geometry.attributes.position,i).applyMatrix4(object.matrixWorld));
  });
  return result;
}
function equalPoints(a,b) { assert.equal(a.length,b.length);a.forEach((n,i)=>close(n,b[i])); }

const owner=fixture(), shared=fixture(), regular=fixture();
const options={rotation:{x:-10,y:0,z:0},position:{x:0,y:-.14,z:0}};
await owner.runtime.load('source.glb',{...options,prepare:true});
await shared.runtime.load('source.glb',{...options,prepare:false});
await regular.runtime.load('source.glb',options);
assert.equal(owner.runtime.orientationPreview,true);
assert.equal(shared.runtime.orientationPreview,false);
equalPoints(points(owner.runtime.model),points(shared.runtime.model));
equalPoints(points(owner.runtime.model),points(regular.runtime.model));
matrixClose(shared.gltf.scene.matrix,shared.original);
close(new THREE.Box3().setFromObject(shared.runtime.model,true).min.y,-.14);
assert.notEqual(shared.runtime.model,shared.gltf.scene,'source must have an external rotation wrapper');

const edited={x:37,y:-23,z:11};
assert.equal(shared.runtime.setOrientation(edited),true,'static shared-style path supports live saved rotation');
owner.runtime.setOrientation(edited);
equalPoints(points(owner.runtime.model),points(shared.runtime.model));
const once=points(shared.runtime.model);
shared.runtime.setOrientation(edited);
equalPoints(once,points(shared.runtime.model));
close(new THREE.Box3().setFromObject(shared.runtime.model,true).min.y,-.14);
const savedPosition=shared.runtime.model.position.clone(), savedQuaternion=shared.runtime.model.quaternion.clone();
shared.runtime.model.position.add(new THREE.Vector3(1,2,3));
shared.runtime.model.quaternion.identity();
shared.runtime.reset();
close(shared.runtime.model.position.distanceTo(savedPosition),0);
close(shared.runtime.model.quaternion.angleTo(savedQuaternion),0);

const rig=fixture(true);
const originalPosition=rig.gltf.scene.position.clone(),originalQuaternion=rig.gltf.scene.quaternion.clone();
await rig.runtime.load('rig.glb',{prepare:true,rotation:{x:90,y:180,z:-45},position:{x:.3,y:-.14,z:.2}});
assert.equal(rig.runtime.sourceOrientation,false);
assert.equal(rig.runtime.orientationPreview,false);
assert.equal(rig.runtime.model,rig.gltf.scene);
close(rig.runtime.model.quaternion.angleTo(originalQuaternion),0);
close(rig.runtime.model.position.distanceTo(originalPosition.add(new THREE.Vector3(.3,-.14,.2))),0);
const baked=points(rig.runtime.model);
assert.equal(rig.runtime.setOrientation({x:-30,y:80,z:12}),false);
equalPoints(baked,points(rig.runtime.model));

// A detached rope used to contribute to normalization. Deleting its entire
// primitive must leave every retained body vertex at the same displayed point.
function withDetachedPart() {
  const gltf = asset();
  gltf.scene.children[0].name = 'retained-body';
  const detached = new THREE.Mesh(new THREE.BoxGeometry(.2, .3, .2).translate(3, -.2, -1));
  detached.name = 'detached-rope';
  gltf.scene.add(detached);
  gltf.scene.updateMatrixWorld(true);
  const corners = [];
  const positions = [], frameSources = [];
  gltf.scene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    const { min, max } = mesh.geometry.boundingBox;
    frameSources.push({ position: positions.length, matrix: mesh.matrixWorld.toArray() });
    positions.push(mesh.geometry.getAttribute('position'));
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
      corners.push(new THREE.Vector3(x, y, z).applyMatrix4(mesh.matrixWorld).toArray());
    }
  });
  gltf.parser = {
    json: { accessors: positions.map((position) => ({ type: 'VEC3', count: position.count })) },
    async getDependency(type, index) { assert.equal(type, 'accessor'); return positions[index]; },
  };
  return { gltf, corners, frameSources };
}
const originalAsset = withDetachedPart();
const cleanedAsset = withDetachedPart();
cleanedAsset.gltf.asset = { extras: { studioBounds: { version: 1, corners: cleanedAsset.corners }, studioFrameSources: cleanedAsset.frameSources } };
cleanedAsset.gltf.scene.getObjectByName('detached-rope').removeFromParent();
const beforeCleanup = fixture(false, originalAsset.gltf);
const afterCleanup = fixture(false, cleanedAsset.gltf);
const retainedPoints = (runtime) => points(runtime.model.getObjectByName('retained-body'));
await beforeCleanup.runtime.load('source.glb', { rotation: edited, position: options.position });
await afterCleanup.runtime.load('cleaned.glb', { rotation: edited, position: options.position });
equalPoints(retainedPoints(beforeCleanup.runtime), retainedPoints(afterCleanup.runtime));
assert.ok(afterCleanup.runtime.model.userData.studioBounds);
assert.ok(afterCleanup.runtime.model.userData.studioFramePoints instanceof Float32Array);
assert.notEqual(afterCleanup.runtime.model.userData.studioBounds, cleanedAsset.corners, 'metadata must be copied');
function manualFrame(runtime) {
  const scene = new THREE.Scene();
  const canvas = { style: {}, getAttribute: () => null, setAttribute() {}, removeAttribute() {},
    getBoundingClientRect: () => ({ width: 500, height: 500, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {} };
  const editor = createManualRigEditor({ scene, camera: new THREE.PerspectiveCamera(), canvas, container: { dataset: {} },
    controls: {}, getModel: () => runtime.model });
  editor.refreshModel();
  const overlay = scene.getObjectByName('ManualRigEditor');
  const frame = [...overlay.position.toArray(), ...overlay.scale.toArray()];
  editor.dispose();
  return frame;
}
equalPoints(manualFrame(beforeCleanup.runtime), manualFrame(afterCleanup.runtime));
for (const rotation of [{ x: -40, y: 65, z: 10 }, { x: 0, y: 0, z: 0 }]) {
  beforeCleanup.runtime.setOrientation(rotation);
  afterCleanup.runtime.setOrientation(rotation);
  equalPoints(retainedPoints(beforeCleanup.runtime), retainedPoints(afterCleanup.runtime));
  equalPoints(manualFrame(beforeCleanup.runtime), manualFrame(afterCleanup.runtime));
}
beforeCleanup.runtime.setPosition({ x: .6, y: -.4, z: .3 });
afterCleanup.runtime.setPosition({ x: .6, y: -.4, z: .3 });
equalPoints(manualFrame(beforeCleanup.runtime), manualFrame(afterCleanup.runtime));
// Malformed metadata falls back to the ordinary geometry bounds.
for (const bad of [
  { version: 2, corners: cleanedAsset.corners },
  { version: 1, corners: [[0, 0, 0]] },
  { version: 1, corners: Array.from({ length: 8 }, () => [Infinity, 0, 0]) },
  { version: 1, corners: Array.from({ length: 8200 }, () => [0, 0, 0]) },
]) {
  const invalidAsset = asset();
  invalidAsset.asset = { extras: { studioBounds: bad } };
  const invalid = fixture(false, invalidAsset);
  await invalid.runtime.load('invalid-metadata.glb', options);
  assert.equal(invalid.runtime.model.userData.studioBounds, undefined);
  equalPoints(points(invalid.runtime.model), points(regular.runtime.model));
}
console.log('PASS: owner/shared/regular transforms; asset root; noncompounding rotation; placement+reset; baked rig; cleaned whole-primitive normalization retained; invalid metadata fallback');
