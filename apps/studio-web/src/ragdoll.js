/**
 * A 17-body humanoid ragdoll for the exported Doom Slayer skeleton.
 *
 * Call update(dt) after AnimationMixer.update while animated, or after the
 * fixed physics step while enabled. The caller owns and steps the world.
 * Body frames share anatomical axes at bind time; collider frames follow
 * each limb. This separates bone roll from the physics joint axes.
 */
export function createRagdoll({ THREE, RAPIER, world, model, scene }) {
  const V = () => new THREE.Vector3();
  const Q = () => new THREE.Quaternion();
  const ZERO = { x: 0, y: 0, z: 0 };
  const boneNames = [
    'Hips', 'Spine', 'Chest', 'Neck', 'Head',
    'UpperArm_L', 'LowerArm_L', 'Hand_L',
    'UpperArm_R', 'LowerArm_R', 'Hand_R',
    'UpperLeg_L', 'LowerLeg_L', 'Foot_L',
    'UpperLeg_R', 'LowerLeg_R', 'Foot_R',
  ];
  const children = {
    Hips: 'Spine', Spine: 'Chest', Chest: 'Neck', Neck: 'Head',
    UpperArm_L: 'LowerArm_L', LowerArm_L: 'Hand_L',
    UpperArm_R: 'LowerArm_R', LowerArm_R: 'Hand_R',
    UpperLeg_L: 'LowerLeg_L', LowerLeg_L: 'Foot_L',
    UpperLeg_R: 'LowerLeg_R', LowerLeg_R: 'Foot_R',
  };
  const bones = new Map();
  model.traverse((object) => {
    if (object.isBone && boneNames.includes(object.name)) bones.set(object.name, object);
  });
  const missing = boneNames.filter((name) => !bones.has(name));
  if (missing.length) throw new Error(`Ragdoll skeleton is missing: ${missing.join(', ')}`);
  if (!world.impulseJoints.raw.jointSetLimits) {
    throw new Error('Ragdoll requires Rapier 0.20 per-axis joint limits.');
  }

  model.updateMatrixWorld(true);
  const modelFrame = model.getWorldQuaternion(Q());
  const invModelFrame = modelFrame.clone().invert();
  const up = new THREE.Vector3(0, 1, 0);
  const restPose = boneNames.map((name) => {
    const bone = bones.get(name);
    return { bone, position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone() };
  });
  const bodies = new Map();
  const bodyEntries = [];
  const entriesByName = new Map();
  const joints = [];
  const debugGroup = new THREE.Group();
  debugGroup.name = 'Ragdoll colliders';
  debugGroup.visible = false;
  scene.add(debugGroup);
  let enabled = false;
  let disposed = false;
  let samples = 0;
  let elapsed = 0;
  let peakAnchorError = 0;
  let invalidPose = false;

  function bodyShape(name, length) {
    if (name === 'Hips') return { box: [0.185, Math.max(0.07, length * 0.55), 0.13], mass: 12 };
    if (name === 'Spine') return { box: [0.175, Math.max(0.075, length * 0.5), 0.125], mass: 8 };
    if (name === 'Chest') return { box: [0.235, Math.max(0.095, length * 0.5), 0.15], mass: 18 };
    if (name === 'Neck') return { radius: 0.064, mass: 1 };
    if (name === 'Head') return { radius: 0.115, mass: 5 };
    if (name.startsWith('UpperArm')) return { radius: 0.089, mass: 3.5 };
    if (name.startsWith('LowerArm')) return { radius: 0.077, mass: 2.5 };
    if (name.startsWith('Hand')) return { radius: 0.065, mass: 1 };
    if (name.startsWith('UpperLeg')) return { radius: 0.118, mass: 10 };
    if (name.startsWith('LowerLeg')) return { radius: 0.098, mass: 5 };
    return { box: [0.088, 0.09, 0.155], mass: 1.5 };
  }

  for (const name of boneNames) {
    const bone = bones.get(name);
    const origin = bone.getWorldPosition(V());
    const boneRotation = bone.getWorldQuaternion(Q());
    let end;
    if (children[name]) end = bones.get(children[name]).getWorldPosition(V());
    else if (name === 'Head') end = origin.clone().add(new THREE.Vector3(0, 0.19, 0).applyQuaternion(modelFrame));
    else if (name.startsWith('Foot')) end = origin.clone().add(new THREE.Vector3(0, -0.18, 0.18).applyQuaternion(modelFrame));
    else {
      const parentOrigin = bone.parent.getWorldPosition(V());
      end = origin.clone().add(origin.clone().sub(parentOrigin).normalize().multiplyScalar(0.15));
    }
    const segment = end.clone().sub(origin);
    const length = Math.max(0.06, segment.length());
    const center = origin.clone().lerp(end, 0.5);
    const direction = segment.normalize();
    const shape = bodyShape(name, length);
    const bodyRotation = modelFrame.clone();
    const colliderRotation = name.startsWith('Foot')
      ? Q()
      : Q().setFromUnitVectors(up, direction.clone().applyQuaternion(invModelFrame));
    let colliderDesc;
    let geometry;
    if (shape.box) {
      colliderDesc = RAPIER.ColliderDesc.cuboid(...shape.box);
      geometry = new THREE.BoxGeometry(...shape.box.map((half) => half * 2));
    } else {
      const halfHeight = Math.max(0.005, length * 0.5 - shape.radius);
      colliderDesc = RAPIER.ColliderDesc.capsule(halfHeight, shape.radius);
      geometry = new THREE.CapsuleGeometry(shape.radius, halfHeight * 2, 4, 8);
    }
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(center.x, center.y, center.z)
        .setRotation(bodyRotation)
        .setLinearDamping(0.12)
        .setAngularDamping(0.8)
        .setCcdEnabled(true)
        .setCanSleep(true)
        .setAdditionalSolverIterations(6),
    );
    body.userData = { ragdoll: true, bone: name };
    const collider = world.createCollider(
      colliderDesc.setRotation(colliderRotation).setMass(shape.mass)
        .setFriction(0.65).setRestitution(0.015), body,
    );
    const wire = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color: name.endsWith('_L') ? 0x59ffc9 : name.endsWith('_R') ? 0xffa75c : 0xeaffff,
      wireframe: true, transparent: true, opacity: 0.7, depthTest: false,
    }));
    wire.renderOrder = 20;
    wire.name = name;
    const visualRoot = new THREE.Group();
    wire.quaternion.copy(colliderRotation);
    visualRoot.add(wire);
    debugGroup.add(visualRoot);
    const entry = {
      name, bone, body, collider, visualRoot, shape,
      bindDirection: direction.clone(),
      // Express the center in the bone's rotation frame (world units), not its scaled local frame.
      boneToCenter: center.clone().sub(origin).applyQuaternion(boneRotation.clone().invert()),
      boneToBody: boneRotation.clone().invert().multiply(bodyRotation),
      bodyToBone: bodyRotation.clone().invert().multiply(boneRotation),
      bodyToOrigin: origin.clone().sub(center).applyQuaternion(bodyRotation.clone().invert()),
      position: center.clone(), rotation: bodyRotation.clone(),
      previousPosition: center.clone(), previousRotation: bodyRotation.clone(),
      linearVelocity: V(), angularVelocity: V(),
    };
    bodies.set(name, body);
    bodyEntries.push(entry);
    entriesByName.set(name, entry);
  }

  function nearestBodyParent(bone) {
    for (let node = bone.parent; node; node = node.parent) {
      if (entriesByName.has(node.name)) return entriesByName.get(node.name);
    }
    return null;
  }

  function limitsFor(name) {
    if (name === 'Spine') return [[-0.3, 0.35], [-0.22, 0.22], [-0.24, 0.24]];
    if (name === 'Chest') return [[-0.28, 0.35], [-0.3, 0.3], [-0.25, 0.25]];
    if (name === 'Neck') return [[-0.38, 0.38], [-0.45, 0.45], [-0.3, 0.3]];
    if (name === 'Head') return [[-0.38, 0.42], [-0.5, 0.5], [-0.3, 0.3]];
    if (name.startsWith('UpperArm')) return [[-2.0, 1.0], [-0.8, 0.8], [-1.4, 1.4]];
    if (name.startsWith('UpperLeg')) return [[-1.65, 0.55], [-0.55, 0.55], [-0.8, 0.8]];
    if (name.startsWith('Hand')) return [[-0.55, 0.55], [-0.25, 0.25], [-0.3, 0.3]];
    if (name.startsWith('Foot')) return [[-0.5, 0.65], [-0.2, 0.2], [-0.22, 0.22]];
    return [[-0.5, 0.5], [-0.5, 0.5], [-0.5, 0.5]];
  }

  for (const child of bodyEntries) {
    const parent = nearestBodyParent(child.bone);
    if (!parent) continue;
    const anchor = child.bone.getWorldPosition(V());
    const anchor1 = anchor.clone().sub(parent.position).applyQuaternion(parent.rotation.clone().invert());
    const anchor2 = anchor.clone().sub(child.position).applyQuaternion(child.rotation.clone().invert());
    const hinge = child.name.startsWith('LowerLeg') || child.name.startsWith('LowerArm');
    let hingeAxis;
    let bindAngle = 0;
    if (hinge) {
      const incoming = anchor.clone().sub(parent.bone.getWorldPosition(V())).normalize();
      const normal = incoming.clone().cross(child.bindDirection);
      // Flexion is positive at knees and negative at elbows. A straight limb
      // has no bend plane, so use the model's forward axis to establish one.
      const axis = normal.length() > 0.08
        ? normal.clone().normalize().multiplyScalar(child.name.startsWith('LowerLeg') ? 1 : -1)
        : new THREE.Vector3(0, 0, 1).applyQuaternion(modelFrame).cross(incoming);
      if (axis.lengthSq() < 1e-8) axis.copy(up).applyQuaternion(modelFrame).cross(incoming);
      axis.normalize();
      bindAngle = Math.atan2(normal.dot(axis), incoming.dot(child.bindDirection));
      hingeAxis = axis.applyQuaternion(invModelFrame);
    }
    const data = hinge
      ? RAPIER.JointData.revolute(anchor1, anchor2, hingeAxis)
      : RAPIER.JointData.spherical(anchor1, anchor2);
    const joint = world.createImpulseJoint(data, parent.body, child.body, true);
    joint.setContactsEnabled(false);
    let limits;
    if (hinge) {
      limits = child.name.startsWith('LowerLeg') ? [-0.04, 2.25] : [-2.25, 0.05];
      // Body frames coincide at bind even when the elbow is already flexed.
      // Rapier therefore measures zero at that bend, not at the straight limb.
      limits = limits.map((angle) => angle - bindAngle);
      joint.setLimits(...limits);
      joint.configureMotorVelocity(0, 0.08);
      joint.setMotorMaxForce(2);
    } else {
      limits = limitsFor(child.name);
      // Rapier 0.20 exposes spherical motors at the high level, but angular
      // limits through ImpulseJointSet.raw. These are solver-enforced limits,
      // not per-frame quaternion clamps or a visual approximation.
      for (const [i, axis] of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ].entries()) {
        world.impulseJoints.raw.jointSetLimits(joint.handle, axis, ...limits[i]);
        // The WASM build may classify a limited spherical joint as Generic.
        // Configure these per-axis motors on the same public raw joint set.
        world.impulseJoints.raw.jointConfigureMotorVelocity(joint.handle, axis, 0, 0.06);
        world.impulseJoints.raw.jointSetMotorMaxForce(joint.handle, axis, 1.5);
      }
    }
    joints.push({ joint, parent, child, anchor1, anchor2, hinge, limits, hingeAxis, bindAngle });
  }
  for (const entry of bodyEntries) entry.body.setEnabled(false);

  const tempP = V();
  const tempQ = Q();
  const tempParentQ = Q();
  const tempDelta = Q();
  const tempAxis = V();

  function sampleAnimation(dt, captureVelocity = true) {
    model.updateMatrixWorld(true);
    for (const entry of bodyEntries) {
      entry.bone.getWorldPosition(tempP);
      entry.bone.getWorldQuaternion(tempQ);
      entry.position.copy(entry.boneToCenter).applyQuaternion(tempQ).add(tempP);
      entry.rotation.copy(tempQ).multiply(entry.boneToBody).normalize();
      if (captureVelocity && samples > 0 && dt > 0.0001 && dt < 0.2) {
        entry.linearVelocity.copy(entry.position).sub(entry.previousPosition).divideScalar(dt).clampLength(0, 7);
        tempDelta.copy(entry.rotation).multiply(entry.previousRotation.clone().invert()).normalize();
        if (tempDelta.w < 0) tempDelta.set(-tempDelta.x, -tempDelta.y, -tempDelta.z, -tempDelta.w);
        const angle = 2 * Math.acos(THREE.MathUtils.clamp(tempDelta.w, -1, 1));
        tempAxis.set(tempDelta.x, tempDelta.y, tempDelta.z);
        entry.angularVelocity.copy(tempAxis.lengthSq() > 1e-12 ? tempAxis.normalize().multiplyScalar(angle / dt) : ZERO).clampLength(0, 12);
      }
      entry.previousPosition.copy(entry.position);
      entry.previousRotation.copy(entry.rotation);
      entry.body.setTranslation(entry.position, false);
      entry.body.setRotation(entry.rotation, false);
      entry.visualRoot.position.copy(entry.position);
      entry.visualRoot.quaternion.copy(entry.rotation);
    }
    samples++;
  }

  function setEnabled(value) {
    if (disposed || Boolean(value) === enabled) return;
    if (value) {
      sampleAnimation(0, false);
      enabled = true;
      elapsed = 0;
      peakAnchorError = 0;
      invalidPose = false;
      for (const entry of bodyEntries) {
        entry.body.setEnabled(true);
        entry.body.resetForces(false);
        entry.body.resetTorques(false);
        entry.body.setLinvel(entry.linearVelocity, false);
        entry.body.setAngvel(entry.angularVelocity, false);
        entry.body.wakeUp();
      }
    } else {
      enabled = false;
      for (const entry of bodyEntries) {
        entry.body.setLinvel(ZERO, false);
        entry.body.setAngvel(ZERO, false);
        entry.body.resetForces(false);
        entry.body.resetTorques(false);
        entry.body.setEnabled(false);
        entry.linearVelocity.set(0, 0, 0);
        entry.angularVelocity.set(0, 0, 0);
      }
      samples = 0;
    }
  }

  function update(dt = 1 / 60) {
    if (disposed) return;
    if (!enabled) {
      sampleAnimation(dt);
      return;
    }
    elapsed += dt;
    model.updateMatrixWorld(true);
    for (const entry of bodyEntries) {
      entry.position.copy(entry.body.translation());
      entry.rotation.copy(entry.body.rotation());
      if (![...entry.position, entry.rotation.x, entry.rotation.y, entry.rotation.z, entry.rotation.w].every(Number.isFinite)) {
        invalidPose = true;
        continue;
      }
      // Bodies are ordered parent first. Update each matrix before evaluating
      // its children, including the armature's conversion transform.
      tempP.copy(entry.bodyToOrigin).applyQuaternion(entry.rotation).add(entry.position);
      tempQ.copy(entry.rotation).multiply(entry.bodyToBone);
      if (entry.bone.parent) {
        entry.bone.parent.worldToLocal(tempP);
        entry.bone.parent.getWorldQuaternion(tempParentQ).invert();
        tempQ.premultiply(tempParentQ);
      }
      entry.bone.position.copy(tempP);
      entry.bone.quaternion.copy(tempQ).normalize();
      entry.bone.updateMatrixWorld(true);
      entry.visualRoot.position.copy(entry.position);
      entry.visualRoot.quaternion.copy(entry.rotation);
    }
  }

  function impulseAt(point, impulse) {
    if (disposed) return null;
    if (!enabled) setEnabled(true);
    let nearest = bodyEntries[0];
    let distance = Infinity;
    const position = new THREE.Vector3(point.x, point.y, point.z);
    for (const entry of bodyEntries) {
      const d = tempP.copy(entry.body.translation()).distanceToSquared(position);
      if (d < distance) { nearest = entry; distance = d; }
      entry.body.wakeUp();
    }
    // Keep clicks on the rendered armor from producing an excessive lever arm
    // when a coarse collision capsule is some distance beneath the surface.
    const applicationPoint = position.clone().sub(nearest.body.translation()).clampLength(0, 0.28).add(nearest.body.translation());
    nearest.body.applyImpulseAtPoint(impulse, applicationPoint, true);
    return nearest.name;
  }

  function getDiagnostics() {
    let maxJointAnchorError = 0;
    for (const item of joints) {
      const a = item.anchor1.clone().applyQuaternion(item.parent.body.rotation()).add(item.parent.body.translation());
      const b = item.anchor2.clone().applyQuaternion(item.child.body.rotation()).add(item.child.body.translation());
      maxJointAnchorError = Math.max(maxJointAnchorError, a.distanceTo(b));
    }
    peakAnchorError = Math.max(peakAnchorError, maxJointAnchorError);
    const perBody = bodyEntries.map(({ name, body }) => ({
      name, position: { ...body.translation() }, velocity: { ...body.linvel() },
      sleeping: body.isSleeping(), mass: body.mass(),
    }));
    return {
      enabled, bodyCount: bodyEntries.length, jointCount: joints.length,
      hingeCount: joints.filter((item) => item.hinge).length,
      limitedJointCount: joints.length,
      massKg: perBody.reduce((sum, item) => sum + item.mass, 0),
      elapsedSeconds: elapsed, maxJointAnchorError, peakJointAnchorError: peakAnchorError,
      hasNaN: invalidPose || perBody.some((item) => !Object.values(item.position).every(Number.isFinite)),
      sleepingBodies: perBody.filter((item) => item.sleeping).length,
      rootHeight: bodies.get('Hips').translation().y,
      bodies: perBody,
    };
  }

  function reset() {
    setEnabled(false);
    for (const rest of restPose) {
      rest.bone.position.copy(rest.position);
      rest.bone.quaternion.copy(rest.quaternion);
      rest.bone.scale.copy(rest.scale);
    }
    samples = 0;
    elapsed = 0;
    peakAnchorError = 0;
    invalidPose = false;
    sampleAnimation(0, false);
    samples = 0;
  }

  function dispose() {
    if (disposed) return;
    for (const item of joints) world.removeImpulseJoint(item.joint, false);
    for (const entry of bodyEntries) world.removeRigidBody(entry.body);
    debugGroup.traverse((object) => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
    debugGroup.removeFromParent();
    disposed = true;
  }

  sampleAnimation(0, false);
  samples = 0;
  return {
    get enabled() { return enabled; },
    bodies, bodyEntries, joints, debugGroup,
    setEnabled, update, impulseAt, reset, dispose, getDiagnostics,
  };
}
