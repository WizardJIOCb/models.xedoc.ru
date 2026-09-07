import assert from 'node:assert/strict';
import * as THREE from '../apps/studio-web/node_modules/three/build/three.module.js';
import { createEnvironment, normalizeEnvironment } from '../apps/studio-web/src/environment.js';

globalThis.window = { location: new URL('http://127.0.0.1:5180/playground') };
let canvases = 0;
globalThis.document = { createElement() {
  canvases++;
  return { width: 1, height: 1, getContext() { return {
    createLinearGradient: () => ({addColorStop(){}}), createRadialGradient: () => ({addColorStop(){}}),
    fillRect(){}, beginPath(){}, arc(){}, ellipse(){}, fill(){}, moveTo(){}, lineTo(){}, closePath(){}, stroke(){}, putImageData(){},
    createImageData: (width,height) => ({data:new Uint8ClampedArray(width*height*4)}),
  }; } };
} };
const pending = new Map();
THREE.TextureLoader.prototype.loadAsync = function(url) {
  return new Promise((resolve,reject) => pending.set(url, {resolve,reject}));
};
function finish(path, reject=false) {
  const url = new URL(path,window.location.href).href;
  const entry = pending.get(url); assert.ok(entry, `Requested ${url}`); pending.delete(url);
  if(reject) {entry.reject(new Error('404'));return null;}
  const texture = new THREE.Texture({width:2000,height:1000});
  texture.disposals=0;texture.addEventListener('dispose',()=>texture.disposals++);
  entry.resolve(texture);return texture;
}
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40,16/9), container={dataset:{}};
const floor = new THREE.Mesh(new THREE.PlaneGeometry(60,60),new THREE.MeshStandardMaterial({color:0x141d28}));
const grid = new THREE.GridHelper(24,24), ring = new THREE.Mesh();
const hemisphere = new THREE.HemisphereLight(), key=new THREE.DirectionalLight(),rim=new THREE.DirectionalLight();
const model = new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial());
model.position.set(1,2,3); model.rotation.set(.1,.2,.3);model.updateMatrix();scene.add(model,floor,grid,ring);
const originalTransform=model.matrix.clone(), floorGeometry=floor.geometry;
const stage=createEnvironment({scene,camera,container,floor,grid,ring,hemisphere,key,rim,renderer:{capabilities:{getMaxAnisotropy:()=>8}}});
assert.equal(normalizeEnvironment({backgroundUrl:'https://external.test/input.jpg'}).backgroundUrl,null);
assert.equal(normalizeEnvironment({backgroundUrl:'javascript:alert(1)'}).backgroundUrl,null);
await stage.setEnvironment({}); assert.equal(floor.geometry,floorGeometry);
await stage.setEnvironment({background:'night',ground:'stone',groundShape:'disc',groundScale:3,showGrid:false});
assert.equal(floor.geometry.type,'CircleGeometry');assert.equal(floor.material.map.repeat.x,4);assert.equal(grid.visible,false);
assert.equal(scene.background.mapping,THREE.EquirectangularReflectionMapping);assert.equal(scene.fog.color.getHex(),0x142031);
const count=canvases;await stage.setEnvironment({background:'night',ground:'stone',groundShape:'disc',groundScale:3,showGrid:false});assert.equal(canvases,count);
const a=stage.setEnvironment({background:'custom',backgroundUrl:'/a.webp'});
const b=stage.setEnvironment({background:'custom',backgroundUrl:'/b.webp'});
const textureB=finish('/b.webp');await b;const textureA=finish('/a.webp');assert.equal(await a,null);
assert.equal(scene.background,textureB);assert.equal(textureA.disposals,1);assert.equal(textureB.disposals,0);
const failed=stage.setEnvironment({background:'custom',backgroundUrl:'/missing.webp',ground:'grass'});
finish('/missing.webp',true);await assert.rejects(failed,/Не удалось открыть/);assert.equal(scene.background,textureB);
const late=stage.setEnvironment({background:'custom',backgroundUrl:'/late.webp'});
await stage.setEnvironment({background:'custom',backgroundUrl:'/b.webp'});
const lateTexture=finish('/late.webp');await late;assert.equal(lateTexture.disposals,1);assert.equal(scene.background,textureB);
await stage.setEnvironment({background:'custom',backgroundUrl:'/b.webp',backgroundProjection:'image'});
assert.equal(scene.background,textureB);assert.equal(textureB.mapping,THREE.UVMapping);
assert.ok(Math.abs(textureB.repeat.x-8/9)<1e-8);camera.aspect=.5;stage.resize();assert.equal(textureB.repeat.x,.25);
const floorRequest=stage.setEnvironment({background:'custom',backgroundUrl:'/b.webp',ground:'custom',groundUrl:'/floor.webp',groundScale:.5});
const floorTexture=finish('/floor.webp');await floorRequest;assert.equal(floorTexture.repeat.x,120);assert.equal(floorTexture.wrapS,THREE.RepeatWrapping);
const delayed=stage.setEnvironment({background:'custom',backgroundUrl:'/after-dispose.webp'});
stage.dispose();const delayedTexture=finish('/after-dispose.webp');await delayed;
assert.equal(textureB.disposals,1);assert.equal(floorTexture.disposals,1);assert.equal(delayedTexture.disposals,1);
assert.equal(floor.geometry,floorGeometry);assert.equal(container.dataset.environment,undefined);
assert.deepEqual(model.matrix.elements,originalTransform.elements);assert.deepEqual(model.position.toArray(),[1,2,3]);
assert.deepEqual(model.rotation.toArray(),[.1,.2,.3,'XYZ']);
console.log('PASS: presets, validation, idempotency, latest-wins, failed image rollback, pending cancellation, image cover resize, floor repeat, dispose and model preservation');
