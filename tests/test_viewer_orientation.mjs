import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../apps/studio-web/node_modules/three/build/three.module.js';

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

function fixture(skinned = false) {
  const gltf = asset(skinned);
  const original = gltf.scene.matrix.clone();
  const runtime = new Function('THREE', 'gltf', `
    let request=0, disposed=false, ready=false, model, mixer, action, ragdoll, skeleton;
    let sourceOrientation=false, orientationPreview=false, triangles=0, rigAvailable=false;
    let clipName='', patrol=false, playing=true, animationTime=0;
    const previewRotation={x:0,y:0,z:0}, placement=new THREE.Vector3();
    const basePosition=new THREE.Vector3(), baseQuaternion=new THREE.Quaternion();
    const scene=new THREE.Scene(), container={dataset:{}}, props=[], BONES=[];
    const playground=false;
    const camera=new THREE.Object3D(), initialCamera=new THREE.Vector3(3,2,5);
    const controls={target:new THREE.Vector3(),update(){}};
    const emit=()=>{}, disposeObject=()=>{}, ensurePhysics=async()=>{};
    const clearModel=()=>{ready=false;model=undefined;sourceOrientation=false;orientationPreview=false;};
    const GLTFLoader=class{async loadAsync(){return gltf;}};
    ${declaration('load')}
    ${declaration('applyPreviewRotation')}
    ${declaration('setPosition')}
    ${declaration('resetCamera')}
    ${declaration('reset')}
    return {load,setPosition,reset,setOrientation:applyPreviewRotation,
      get model(){return model;},get sourceOrientation(){return sourceOrientation;},
      get orientationPreview(){return orientationPreview;},get basePosition(){return basePosition;}};
  `)(THREE, gltf);
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
console.log('PASS: owner/shared/regular source transforms match; asset root preserved; live rotation does not compound; placement+reset retained; baked rig orientation ignored');
