import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../apps/studio-web/node_modules/three/build/three.module.js';

const source = readFileSync(new URL('../apps/studio-web/src/viewer.js', import.meta.url), 'utf8');
function declaration(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  let depth = 0, end = source.indexOf('{', start);
  for (let i = end; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    if (source[i] !== '}') continue;
  }
  throw new Error(`Unterminated function ${name}`);
}

// Execute the actual viewer methods with Three geometry and a small physics
// boundary fixture; no WebGL or duplicate implementation is needed here.
const fixture = new Function('THREE', `
  let ready = true, orientationPreview = true, sourceOrientation = true, playing = false, animationTime = 8;
  let mixer, action;
  const props = [], container = { dataset: {} }, previewRotation = { x:0,y:0,z:0 };
  const model = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 2, .5).translate(0, 1, 0);
  model.add(new THREE.Mesh(geometry));
  model.position.set(.3,.5,-.4);
  const basePosition = model.position.clone(), baseQuaternion = model.quaternion.clone();
  const placement = new THREE.Vector3();
  const state = { emissions:0, translations:0, resets:0 };
  const emit = () => state.emissions++;
  const entries = [new THREE.Vector3(.2,1,.3), new THREE.Vector3(.2,1.5,.3)].map((initial) => {
    const current = initial.clone();
    const visualRoot = new THREE.Group(); visualRoot.position.copy(initial);
    return { body: { translation: () => current, setTranslation: (v) => { current.copy(v);state.translations++; } }, position: initial.clone(), previousPosition: initial.clone(), visualRoot };
  });
  const ragdoll = { enabled:true, bodyEntries:entries, update(){}, reset(){state.resets++;} };
  ${declaration('setPosition')}
  ${declaration('placeOnFloor')}
  ${declaration('applyPreviewRotation')}
  ${declaration('reset')}
  return { model, basePosition, placement, entries, state, setPosition, placeOnFloor, applyPreviewRotation, reset };
`)(THREE);

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const vector = (actual, expected) => actual.toArray().forEach((n, i) => close(n, expected[i]));
const anchorDistance = fixture.entries[0].body.translation().distanceTo(fixture.entries[1].body.translation());
fixture.setPosition({ x:1,y:2,z:-3 });
vector(fixture.model.position, [1.3,2.5,-3.4]);
vector(fixture.basePosition, [1.3,2.5,-3.4]);
vector(fixture.entries[0].previousPosition, [1.2,3,-2.7]);
close(fixture.entries[0].body.translation().distanceTo(fixture.entries[1].body.translation()), anchorDistance);
const translations = fixture.state.translations;
fixture.setPosition({ x:1,y:2,z:-3 });
assert.equal(fixture.state.translations, translations, 'unchanged polling position must not wake physics bodies');
fixture.model.position.add(new THREE.Vector3(2,0,1));
fixture.setPosition({ x:-1,y:1,z:2 });
vector(fixture.model.position, [1.3,1.5,2.6]);
vector(fixture.basePosition, [-.7,1.5,1.6]);
fixture.reset();
vector(fixture.model.position, [-.7,1.5,1.6]);
assert.equal(fixture.state.resets, 1);
fixture.placeOnFloor();
close(new THREE.Box3().setFromObject(fixture.model, true).min.y, 0);
fixture.setPosition({ x:.5,y:.3,z:-.4 });
fixture.applyPreviewRotation({x:90,y:0,z:0});
const rotatedBounds = new THREE.Box3().setFromObject(fixture.model, true);
close(rotatedBounds.min.y, .3);
close(rotatedBounds.getCenter(new THREE.Vector3()).x, .5);
close(rotatedBounds.getCenter(new THREE.Vector3()).z, -.4);
fixture.setPosition({ x:99,y:-99,z:0 });
vector(fixture.placement, [5,-5,0]);
console.log('PASS: translation, body/history shift, unchanged-poll sleeping, patrol/reset origin, floor placement, rotation composition, limits');
