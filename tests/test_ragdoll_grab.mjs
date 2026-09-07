import assert from 'node:assert/strict';
import * as THREE from '../apps/studio-web/node_modules/three/build/three.module.js';
import RAPIER from '../apps/studio-web/node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs';
import { createRagdoll } from '../apps/studio-web/src/ragdoll.js';

await RAPIER.init();
function fixture() {
  const specs = [
    ['Hips', null, [0,1,0]], ['Spine','Hips',[0,1.2,0]], ['Chest','Spine',[0,1.45,0]],
    ['Neck','Chest',[0,1.65,0]], ['Head','Neck',[0,1.8,0]],
  ];
  for (const [side, sign] of [['L',1],['R',-1]]) {
    for (const [name, parent, x,y,z] of [
      ['UpperArm','Chest',.24,1.57,0], ['LowerArm','UpperArm',.42,1.3,0], ['Hand','LowerArm',.52,1.04,0],
      ['UpperLeg','Hips',.14,.98,0], ['LowerLeg','UpperLeg',.18,.56,0], ['Foot','LowerLeg',.2,.15,0],
    ]) specs.push([name+'_'+side, parent==='Chest'||parent==='Hips'?parent:parent+'_'+side, [sign*x,y,z]]);
  }
  const model = new THREE.Group(), scene = new THREE.Scene(), nodes = new Map();
  for (const [name,parent,position] of specs) {
    const bone = new THREE.Bone(); bone.name = name;
    bone.position.fromArray(position);
    if (parent) { bone.position.sub(nodes.get(parent).world); nodes.get(parent).bone.add(bone); }
    else model.add(bone);
    nodes.set(name,{bone,world:new THREE.Vector3(...position)});
  }
  scene.add(model); model.updateMatrixWorld(true);
  const world = new RAPIER.World({x:0,y:-9.81,z:0}); world.timestep=1/120; world.numSolverIterations=12;
  world.createCollider(RAPIER.ColliderDesc.cuboid(20,.2,20).setTranslation(0,-.2,0));
  const ragdoll = createRagdoll({THREE,RAPIER,world,model,scene});
  const step = (n) => { for(let i=0;i<n;i++){ragdoll.stepGrab(1/120);world.step();ragdoll.update(1/120);} };
  return {ragdoll,world,step};
}

for (const part of ['Hand_R','Head','Foot_L']) {
  const {ragdoll:r,world,step}=fixture();
  r.update(1/120);
  const start=new THREE.Vector3().copy(r.bodies.get(part).translation());
  assert.equal(r.beginGrab(start,part),part);
  assert.equal(r.getDiagnostics().enabled,true,'Grab activates physics from animation');
  assert.equal(r.getDiagnostics().grabbedBody,part);
  const target=start.clone().add(new THREE.Vector3(.7,1.3,.2));
  r.moveGrab(target); step(360);
  const held=r.grabPoints();
  assert(held.anchor.distanceTo(target)<.85,`${part}: body follows mouse (${held.anchor.distanceTo(target)})`);
  assert.equal(r.getDiagnostics().hasNaN,false);
  assert(r.getDiagnostics().peakJointAnchorError<.25,'Grab must not tear joints apart');
  assert.equal(r.moveGrab({x:NaN,y:2,z:0}),false);
  r.moveGrab(new THREE.Vector3(100,100,100)); step(60);
  assert.equal(r.getDiagnostics().hasNaN,false,'Abrupt target changes stay finite');
  r.endGrab(); assert.equal(r.getDiagnostics().grabbedBody,null);
  assert.equal(r.getDiagnostics().enabled,true,'Release leaves the character in ragdoll');
  step(360);
  assert.equal(r.beginGrab(new THREE.Vector3().copy(r.bodies.get(part).translation()),part),part,'Grab works again after falling');
  r.reset(); assert.equal(r.getDiagnostics().grabbedBody,null); assert.equal(r.getDiagnostics().enabled,false);
  r.dispose(); world.free();
}
console.log('PASS: hand/head/foot grabs, animation transition, stable joints, release, re-grab, reset');
