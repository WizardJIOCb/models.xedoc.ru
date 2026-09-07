import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createRagdoll } from './ragdoll.js';
import { createManualRigEditor } from './manual-rig-editor.js';
import { createEnvironment } from './environment.js';
import { createMeshEditor } from './mesh-editor.js';
import { readStudioFramePoints } from './studio-frame.js';

const BONES = ['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'UpperArm_L', 'LowerArm_L', 'Hand_L', 'UpperArm_R', 'LowerArm_R', 'Hand_R', 'UpperLeg_L', 'LowerLeg_L', 'Foot_L', 'UpperLeg_R', 'LowerLeg_R', 'Foot_R'];
let physicsPromise;

export function createViewer({ container, playground = false, onState = () => {} }) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', playground ? 'Интерактивная 3D-арена. Перетаскивайте для вращения, нажмите на персонажа для удара.' : 'Просмотр 3D-модели. Перетаскивайте для вращения.');
  canvas.tabIndex = 0;
  container.append(canvas);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d131a);
  scene.fog = new THREE.Fog(0x0d131a, 13, 35);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 70);
  const initialCamera = new THREE.Vector3(playground ? 4.3 : 3.4, playground ? 2.9 : 2.3, playground ? 6.3 : 5.2);
  camera.position.copy(initialCamera);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    canvas.remove();
    throw new Error('WebGL недоступен в этом браузере. Включите аппаратное ускорение или откройте сайт в другом браузере.');
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.95, 0);
  controls.enableDamping = true;
  controls.minDistance = 1.4;
  controls.maxDistance = playground ? 16 : 12;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.enablePan = !playground;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.48;
  room.dispose();
  pmrem.dispose();
  const hemisphere = new THREE.HemisphereLight(0xb3d4e5, 0x202a35, 1.8);
  scene.add(hemisphere);
  const key = new THREE.DirectionalLight(0xfff1d7, 3.2);
  key.position.set(-4, 7, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 0.5, far: 25 });
  key.shadow.normalBias = 0.028;
  key.shadow.bias = -0.0003;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x51d6d1, 2.2);
  rim.position.set(3, 5, -4);
  scene.add(rim);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0x141d28, roughness: 0.8, metalness: 0.2 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.01;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(playground ? 24 : 14, playground ? 24 : 14, 0x345360, 0x213240);
  grid.position.y = 0.001;
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  scene.add(grid);
  const ring = new THREE.Mesh(new THREE.RingGeometry(playground ? 2.88 : 1.5, playground ? 2.9 : 1.515, 96), new THREE.MeshBasicMaterial({ color: 0x3bd3d0, side: THREE.DoubleSide, transparent: true, opacity: 0.4 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.008;
  scene.add(ring);
  const stage = createEnvironment({ scene, renderer, camera, container, floor, grid, ring, key, rim, hemisphere });

  let disposed = false, request = 0, ready = false, world, RAPIER;
  let loading = false, loadedPercent = 0, loadError = null;
  let model, mixer, action, ragdoll, skeleton, clipName = '', rigAvailable = false;
  let orientationPreview = false;
  let sourceOrientation = false;
  const previewRotation = { x: 0, y: 0, z: 0 };
  let patrol = false;
  const basePosition = new THREE.Vector3(), baseQuaternion = new THREE.Quaternion();
  const placement = new THREE.Vector3();
  let triangles = 0, slow = false, playing = true, hitCount = 0, power = 5;
  let last = performance.now(), accumulator = 0, animationTime = 0, stateTime = 0;
  const FRAME_INTERVAL_MS = 1000 / 60;
  let nextRenderAt = last + FRAME_INTERVAL_MS;
  let frameCount = 0, fpsElapsed = 0, fps = 0;
  const props = [], particles = [];
  const STEP = 1 / 120;
  const emit = (extra = {}) => {
    if (disposed) return;
    // Frame updates must retain the load lifecycle between network events.
    // Otherwise the empty placeholder reappears beneath the loading overlay.
    if (Object.hasOwn(extra, 'loading')) loading = extra.loading;
    if (Object.hasOwn(extra, 'loadedPercent')) loadedPercent = extra.loadedPercent;
    if (Object.hasOwn(extra, 'error')) loadError = extra.error;
    const diagnostics = ragdoll?.getDiagnostics();
    const state = {
      ready, loading, loadedPercent, error: loadError,
      triangles, rigAvailable, clipName, playing, slow, hitCount, fps, orientationPreview,
      sourceOrientation, rotation: sourceOrientation ? { ...previewRotation } : { x: 0, y: 0, z: 0 },
      position: { x: placement.x, y: placement.y, z: placement.z },
      mode: ragdoll?.enabled ? 'ragdoll' : clipName ? 'animation' : 'static',
      bodyCount: diagnostics?.bodyCount ?? 0,
      jointCount: diagnostics?.jointCount ?? 0,
      finite: diagnostics ? !diagnostics.hasNaN : true,
      rootHeight: diagnostics?.rootHeight,
      ...extra,
    };
    container.dataset.ready = String(ready);
    container.dataset.mode = state.mode;
    container.dataset.rigAvailable = String(rigAvailable);
    container.dataset.finite = String(state.finite);
    container.dataset.orientationPreview = String(orientationPreview);
    container.dataset.rotation = JSON.stringify(state.rotation);
    container.dataset.position = JSON.stringify(state.position);
    onState(state);
  };
  const manualEditor = createManualRigEditor({
    scene, camera, canvas, container, controls,
    getModel: () => ready && sourceOrientation ? model : null,
  });
  const meshEditor = createMeshEditor({
    scene, camera, canvas, container, controls,
    getModel: () => ready && sourceOrientation ? model : null,
  });

  function disposeObject(root) {
    const textures = new Set(), materials = new Set(), geometries = new Set();
    root?.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of (Array.isArray(object.material) ? object.material : [object.material]).filter(Boolean)) {
        materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    textures.forEach((texture) => texture.dispose());
  }

  function clearModel() {
    ready = false;
    meshEditor.refreshModel();
    rigAvailable = false;
    ragdoll?.dispose();
    ragdoll = undefined;
    skeleton?.removeFromParent();
    skeleton?.dispose();
    skeleton = undefined;
    if (model) {
      mixer?.stopAllAction();
      mixer?.uncacheRoot(model);
      model.removeFromParent();
      disposeObject(model);
    }
    model = mixer = action = undefined;
    manualEditor.refreshModel();
    clipName = '';
    patrol = false;
    orientationPreview = false;
    sourceOrientation = false;
    triangles = 0;
    animationTime = 0;
    hitCount = 0;
  }

  async function ensurePhysics() {
    if (world) return;
    physicsPromise ??= import('@dimforge/rapier3d-compat').then(async ({ default: rapier }) => { await rapier.init(); return rapier; });
    RAPIER = await physicsPromise;
    if (disposed) return;
    world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = STEP;
    world.numSolverIterations = 12;
    world.numInternalPgsIterations = 2;
    const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.2, 30).setTranslation(0, -0.21, 0).setFriction(0.8), ground);
    for (const [x, z, size] of [[-3, -2, 0.65], [3.2, -2.3, 0.7], [3, 2.4, 0.55]]) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial({ color: 0x344f5d, roughness: 0.6, metalness: 0.4 }));
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0x549394 })));
      mesh.position.set(x, size / 2, z);
      scene.add(mesh);
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, size / 2, z).setLinearDamping(0.15).setAngularDamping(0.3));
      world.createCollider(RAPIER.ColliderDesc.cuboid(size / 2, size / 2, size / 2).setMass(12).setFriction(0.65).setRestitution(0.08), body);
      props.push({ mesh, body, initial: { x, y: size / 2, z } });
    }
  }

  async function load(url, { allowRagdoll = false, animation = true, prepare = false, rotation = {}, position = {}, environment: stageSettings } = {}) {
    const sequence = ++request;
    clearModel();
    placement.set(...['x', 'y', 'z'].map((axis) => Math.max(-5, Math.min(5, Number(position[axis]) || 0))));
    emit({ loading: true, loadedPercent: 0, error: null });
    let gltf;
    try {
      if (stageSettings !== undefined) await stage.setEnvironment(stageSettings);
      if (disposed || sequence !== request) return;
      gltf = await new GLTFLoader().loadAsync(url, (event) => {
        if (sequence === request) emit({ loading: true, loadedPercent: event.total ? Math.round(event.loaded / event.total * 100) : null });
      });
      if (disposed || sequence !== request) { disposeObject(gltf.scene); return; }
      let skins = 0;
      gltf.scene.traverse((object) => {
        if (object.isMesh) {
          const association = gltf.parser?.associations?.get(object);
          if (Number.isInteger(association?.meshes) && Number.isInteger(association?.primitives)) {
            object.userData.studioPrimitive = { mesh: association.meshes, primitive: association.primitives };
          }
          object.castShadow = object.receiveShadow = true;
          object.frustumCulled = false;
          triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
        }
        if (object.isSkinnedMesh) skins++;
      });
      const sourceFramePoints = skins === 0 ? await readStudioFramePoints(gltf) : null;
      if (disposed || sequence !== request) { disposeObject(gltf.scene); return; }
      sourceOrientation = skins === 0;
      orientationPreview = Boolean(prepare && sourceOrientation);
      // Every source view uses the same world-axis transform and normalization,
      // including shared links. A wrapper preserves the asset's own root matrix.
      // Rigged exports already contain their orientation in the bind pose.
      model = sourceOrientation ? new THREE.Group() : gltf.scene;
      if (sourceOrientation) {
        model.add(gltf.scene);
        if (sourceFramePoints) model.userData.studioFramePoints = sourceFramePoints;
        // Mesh cleanup can remove an entire extremity/primitive. Retaining the
        // original world-space primitive boxes keeps its saved placement stable.
        const sourceBounds = gltf.asset?.extras?.studioBounds;
        const corners = sourceBounds?.corners;
        if (sourceBounds?.version === 1 && Array.isArray(corners) && corners.length >= 8 && corners.length <= 8192 && corners.length % 8 === 0
          && corners.every((point) => Array.isArray(point) && point.length === 3 && point.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e12))) {
          model.userData.studioBounds = corners.map((point) => [...point]);
        }
      }
      scene.add(model);
      rigAvailable = Boolean(!orientationPreview && allowRagdoll && skins && BONES.every((name) => model.getObjectByName(name)?.isBone));
      // Generated rig exports already have a 2 m bind pose on the ground. Static
      // models are centered for inspection without changing their downloaded file.
      if (sourceOrientation) {
        applyPreviewRotation(rotation);
      } else model.position.add(placement);
      model.updateMatrixWorld(true);
      basePosition.copy(model.position);
      baseQuaternion.copy(model.quaternion);
      if (playground && rigAvailable) {
        await ensurePhysics();
        if (disposed || sequence !== request) return;
        ragdoll = createRagdoll({ THREE, RAPIER, world, model, scene });
        skeleton = new THREE.SkeletonHelper(model);
        skeleton.visible = false;
        skeleton.material.depthTest = false;
        skeleton.renderOrder = 10;
        scene.add(skeleton);
      }
      const clip = gltf.animations.find((item) => /generated|motion|smpl/i.test(item.name)) ?? gltf.animations.find((item) => /walk/i.test(item.name)) ?? gltf.animations[0];
      if (clip && animation && !orientationPreview) {
        mixer = new THREE.AnimationMixer(model);
        action = mixer.clipAction(clip).play();
        mixer.update(0);
        clipName = clip.name;
        patrol = playground && clipName === 'Walk';
      }
      playing = true;
      ready = true;
      manualEditor.refreshModel();
      meshEditor.refreshModel();
      resetCamera();
      emit({ loading: false, error: null });
    } catch (error) {
      if (disposed || sequence !== request) return;
      clearModel();
      emit({ loading: false, error: error.message || 'Не удалось открыть 3D-модель.' });
      throw error;
    }
  }

  function resetCamera() {
    controls.target.set(0, 0.95, 0).add(placement);
    camera.position.copy(initialCamera).add(placement);
    controls.update();
  }

  function applyPreviewRotation(rotation) {
    if (!model || !sourceOrientation) return false;
    for (const axis of ['x', 'y', 'z']) previewRotation[axis] = Math.max(-180, Math.min(180, Number(rotation[axis]) || 0));
    model.position.set(0, 0, 0);
    model.scale.setScalar(1);
    model.rotation.set(...['x', 'y', 'z'].map((axis) => THREE.MathUtils.degToRad(previewRotation[axis])), 'XYZ');
    model.updateMatrixWorld(true);
    const boundsForModel = () => {
      const corners = model.userData.studioBounds;
      if (!corners) return new THREE.Box3().setFromObject(model);
      const box = new THREE.Box3(), point = new THREE.Vector3();
      for (const corner of corners) box.expandByPoint(point.fromArray(corner).applyMatrix4(model.matrixWorld));
      return box;
    };
    const bounds = boundsForModel();
    const extent = bounds.getSize(new THREE.Vector3());
    model.scale.setScalar(2 / Math.max(extent.x, extent.y, extent.z, 0.001));
    model.updateMatrixWorld(true);
    const scaled = boundsForModel();
    const center = scaled.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -scaled.min.y, -center.z).add(placement);
    model.updateMatrixWorld(true);
    basePosition.copy(model.position);
    baseQuaternion.copy(model.quaternion);
    container.dataset.rotation = JSON.stringify(previewRotation);
    manualEditor.refreshModel();
    meshEditor.refreshModel();
    return true;
  }

  function frontView() {
    controls.target.set(0, 1, 0).add(placement);
    camera.position.set(0, 1.05, 5.8).add(placement);
    controls.update();
  }

  function setPosition(position) {
    if (!model || !ready) return null;
    const next = new THREE.Vector3(...['x', 'y', 'z'].map((axis) => Math.max(-5, Math.min(5, Number(position[axis]) || 0))));
    const delta = next.clone().sub(placement);
    if (delta.lengthSq() < 1e-12) return { x: placement.x, y: placement.y, z: placement.z };
    placement.copy(next);
    // Translate the live pose and its reset/patrol origin together. Also shift
    // the physics bodies so a running ragdoll does not snap back on the next step.
    model.position.add(delta);
    basePosition.add(delta);
    model.updateMatrixWorld(true);
    manualEditor.refreshModel();
    meshEditor.refreshModel();
    for (const entry of ragdoll?.bodyEntries || []) {
      const translated = new THREE.Vector3().copy(entry.body.translation()).add(delta);
      entry.body.setTranslation(translated, true);
      entry.position.add(delta);
      entry.previousPosition.add(delta);
      entry.visualRoot.position.add(delta);
    }
    ragdoll?.update(0);
    emit();
    return { x: placement.x, y: placement.y, z: placement.z };
  }

  function placeOnFloor() {
    if (!model || !ready) return null;
    model.updateMatrixWorld(true);
    model.traverse((object) => { if (object.isSkinnedMesh) object.skeleton.update(); });
    const bounds = new THREE.Box3().setFromObject(model, true);
    if (bounds.isEmpty() || !Number.isFinite(bounds.min.y)) return null;
    return setPosition({ x: placement.x, y: placement.y - bounds.min.y, z: placement.z });
  }

  function reset() {
    if (!ready) return;
    model.position.copy(basePosition);
    model.quaternion.copy(baseQuaternion);
    ragdoll?.reset();
    mixer?.stopAllAction();
    action?.reset().play();
    mixer?.update(0);
    model.updateMatrixWorld(true);
    ragdoll?.update(0);
    playing = true;
    animationTime = 0;
    for (const { body, initial } of props) {
      body.setTranslation(initial, true);
      body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    emit();
  }

  function hit(point) {
    if (!ready || !ragdoll || manualEditor.enabled || meshEditor.getStatus().enabled) return false;
    const center = point?.clone() ?? model.getObjectByName('Chest').getWorldPosition(new THREE.Vector3());
    const direction = center.clone().sub(camera.position);
    direction.y = 0;
    direction.normalize();
    const impulse = direction.clone().multiplyScalar(65 + power * 22);
    impulse.y = 12 + power * 6;
    ragdoll.impulseAt(center, impulse);
    hitCount++;
    for (let n = 0; n < 18; n++) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 0.05), new THREE.MeshBasicMaterial({ color: n % 3 ? 0x54ebe3 : 0xd9fffb, transparent: true }));
      mesh.position.copy(center);
      scene.add(mesh);
      particles.push({ mesh, life: 0.3 + Math.random() * 0.3, velocity: new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 3 + 0.6, (Math.random() - 0.5) * 3).addScaledVector(direction, 0.5) });
    }
    emit();
    return true;
  }

  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  let pointerStart;
  function pointerDown(event) { pointerStart = { x: event.clientX, y: event.clientY, time: performance.now() }; }
  function pointerUp(event) {
    if (manualEditor.enabled || meshEditor.getStatus().enabled || !playground || !pointerStart || !ready || !ragdoll || event.button !== 0) return;
    if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5 || performance.now() - pointerStart.time > 500) return;
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    model.traverse((object) => { if (object.isSkinnedMesh) object.computeBoundingSphere(); });
    raycaster.setFromCamera(pointer, camera);
    const intersection = raycaster.intersectObject(model, true)[0];
    if (intersection) hit(intersection.point);
  }
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointerup', pointerUp);
  const resize = () => {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height || disposed) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    stage.resize();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  renderer.setAnimationLoop(() => {
    if (disposed) return;
    const now = performance.now();
    // Keep requestAnimationFrame scheduling but skip excess frames on high
    // refresh displays. Elapsed time still drives fixed 120 Hz physics, so
    // limiting render work does not change animation or ragdoll speed.
    if (now + 0.5 < nextRenderAt) return;
    nextRenderAt += Math.max(1, Math.floor((now - nextRenderAt) / FRAME_INTERVAL_MS) + 1) * FRAME_INTERVAL_MS;
    const realDt = Math.min((now - last) / 1000, 0.06);
    last = now;
    const dt = realDt * (slow ? 0.2 : 1);
    accumulator = Math.min(accumulator + dt, 0.1);
    while (accumulator >= STEP) {
      if (ready && !ragdoll?.enabled && playing && !manualEditor.enabled && !meshEditor.getStatus().enabled) {
        animationTime += STEP;
        if (patrol) {
          const angle = animationTime * 0.29;
          model.position.copy(basePosition).add(new THREE.Vector3(1.45 * (1 - Math.cos(angle)), 0, 1.3 * Math.sin(angle)));
          const heading = Math.atan2(1.45 * Math.sin(angle), 1.3 * Math.cos(angle));
          model.quaternion.copy(baseQuaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading));
        }
        mixer?.update(STEP);
        model.updateMatrixWorld(true);
        ragdoll?.update(STEP);
      }
      world?.step();
      if (ragdoll?.enabled) ragdoll.update(STEP);
      for (const { body, mesh } of props) { mesh.position.copy(body.translation()); mesh.quaternion.copy(body.rotation()); }
      accumulator -= STEP;
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const particle = particles[i];
      particle.life -= dt;
      particle.velocity.y -= 9.81 * dt;
      particle.mesh.position.addScaledVector(particle.velocity, dt);
      particle.mesh.material.opacity = Math.min(1, particle.life * 4);
      if (particle.life <= 0) { particle.mesh.removeFromParent(); disposeObject(particle.mesh); particles.splice(i, 1); }
    }
    if (playground && ready && !orientationPreview && !manualEditor.enabled && !meshEditor.getStatus().enabled && model.getObjectByName('Hips')) {
      const target = model.getObjectByName('Hips').getWorldPosition(new THREE.Vector3());
      target.y = Math.max(0.55, Math.min(1.1, target.y));
      controls.target.lerp(target, 1 - Math.exp(-realDt * 1.2));
    }
    controls.update();
    renderer.render(scene, camera);
    fpsElapsed += realDt;
    frameCount++;
    stateTime += realDt;
    if (fpsElapsed > 0.7) { fps = Math.round(frameCount / fpsElapsed); frameCount = 0; fpsElapsed = 0; }
    if (stateTime > 0.4) { stateTime = 0; emit(); }
  });
  return {
    load, hit, reset, resetCamera, frontView, setPosition, placeOnFloor,
    setEnvironment: stage.setEnvironment,
    meshEditor,
    setManualRig(options) {
      const cleaning = meshEditor.getStatus().enabled;
      manualEditor.setState(cleaning ? { ...options, enabled: false } : options);
      if (cleaning) meshEditor.refreshModel();
    },
    manualView(direction) { return manualEditor.view(direction); },
    capturePreview() {
      if (!ready || disposed || !canvas.width || !canvas.height) return null;
      renderer.render(scene, camera);
      const preview = document.createElement('canvas');
      const factor = Math.min(640 / canvas.width, 480 / canvas.height, 1);
      preview.width = Math.max(1, Math.round(canvas.width * factor));
      preview.height = Math.max(1, Math.round(canvas.height * factor));
      // Copy the freshly rendered frame before WebGL discards its draw buffer.
      preview.getContext('2d').drawImage(canvas, 0, 0, preview.width, preview.height);
      return preview.toDataURL('image/webp', 0.86);
    },
    setOrientation(rotation) { if (manualEditor.enabled || meshEditor.getStatus().enabled) return false; const changed = applyPreviewRotation(rotation); if (changed) emit(); return changed; },
    setPower(value) { power = Math.max(1, Math.min(10, Number(value))); },
    setSlow(value) { slow = Boolean(value); emit(); },
    setPlaying(value) { playing = Boolean(value); emit(); },
    setDebug(value) { if (ragdoll) ragdoll.debugGroup.visible = Boolean(value); if (skeleton) skeleton.visible = Boolean(value); },
    dispose() {
      if (disposed) return;
      disposed = true;
      request++;
      renderer.setAnimationLoop(null);
      clearModel();
      manualEditor.dispose();
      meshEditor.dispose();
      observer.disconnect();
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointerup', pointerUp);
      controls.dispose();
      world?.free();
      stage.dispose();
      disposeObject(scene);
      environment.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
