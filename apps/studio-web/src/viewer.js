import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createRagdoll } from './ragdoll.js';
import { createManualRigEditor } from './manual-rig-editor.js';
import { createEnvironment } from './environment.js';
import { createMeshEditor } from './mesh-editor.js';
import { readStudioFramePoints } from './studio-frame.js';
import { modelFiles } from './model-file-cache.js';

const BONES = ['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'UpperArm_L', 'LowerArm_L', 'Hand_L', 'UpperArm_R', 'LowerArm_R', 'Hand_R', 'UpperLeg_L', 'LowerLeg_L', 'Foot_L', 'UpperLeg_R', 'LowerLeg_R', 'Foot_R'];
let physicsPromise;

export function createViewer({ container, playground = false, onState = () => {} }) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', playground ? 'Интерактивная 3D-арена. Левая кнопка: вращение и удар. Удерживайте правую кнопку на теле, чтобы тащить ragdoll.' : 'Просмотр 3D-модели. Перетаскивайте для вращения.');
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
  let loading = false, loadedPercent = 0, loadError = null, loadPhase = '';
  let model, mixer, action, ragdoll, skeleton, clipName = '', rigAvailable = false;
  let baseClip, restTransforms = [], animationRequest = 0;
  let motionLoading = false, motionPercent = 0, motionError = '', motionPhase = '';
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
    if (Object.hasOwn(extra, 'phase')) loadPhase = extra.phase;
    if (Object.hasOwn(extra, 'error')) loadError = extra.error;
    if (Object.hasOwn(extra, 'motionLoading')) motionLoading = extra.motionLoading;
    if (Object.hasOwn(extra, 'motionPercent')) motionPercent = extra.motionPercent;
    if (Object.hasOwn(extra, 'motionError')) motionError = extra.motionError;
    if (Object.hasOwn(extra, 'motionPhase')) motionPhase = extra.motionPhase;
    const diagnostics = ragdoll?.getDiagnostics();
    const state = {
      ready, loading, loadedPercent, phase: loadPhase, error: loadError,
      motionLoading, motionPercent, motionError, motionPhase,
      triangles, rigAvailable, clipName, playing, slow, hitCount, fps, orientationPreview,
      sourceOrientation, rotation: sourceOrientation ? { ...previewRotation } : { x: 0, y: 0, z: 0 },
      position: { x: placement.x, y: placement.y, z: placement.z },
      mode: ragdoll?.enabled ? 'ragdoll' : clipName ? 'animation' : 'static',
      bodyCount: diagnostics?.bodyCount ?? 0,
      jointCount: diagnostics?.jointCount ?? 0,
      grabbedBody: diagnostics?.grabbedBody || null,
      finite: diagnostics ? !diagnostics.hasNaN : true,
      rootHeight: diagnostics?.rootHeight,
      ...extra,
    };
    container.dataset.ready = String(ready);
    container.dataset.mode = state.mode;
    container.dataset.rigAvailable = String(rigAvailable);
    container.dataset.finite = String(state.finite);
    container.dataset.grabbedBody = state.grabbedBody || '';
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
    endBodyDrag();
    animationRequest++;
    baseClip = undefined;
    restTransforms = [];
    motionLoading = false;
    motionError = '';
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
    emit({ loading: true, loadedPercent: 0, phase: 'starting', error: null });
    let gltf;
    try {
      if (stageSettings !== undefined) await stage.setEnvironment(stageSettings);
      if (disposed || sequence !== request) return;
      const data = await modelFiles.load(url, (progress) => {
        if (sequence === request) emit({ loading: true, ...progress });
      });
      if (disposed || sequence !== request) return;
      emit({ loading: true, phase: 'parsing', loadedPercent: 100 });
      gltf = await new GLTFLoader().parseAsync(data, new URL('.', new URL(url, window.location.href)).href);
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
      baseClip = clip;
      model.traverse((node) => restTransforms.push({ node, position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone() }));
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

  async function setAnimation(url = null) {
    endBodyDrag();
    const sequence = ++animationRequest, target = model;
    if (!ready || !target || sourceOrientation) return;
    let loaded;
    try {
      let clip = baseClip;
      if (url) {
        emit({ motionLoading: true, motionPercent: 0, motionPhase: 'starting', motionError: '' });
        const bytes = await modelFiles.load(url, ({ phase, loadedPercent }) => {
          if (sequence === animationRequest) emit({ motionPhase: phase, motionPercent: loadedPercent });
        });
        if (disposed || sequence !== animationRequest || target !== model) return;
        loaded = await new GLTFLoader().parseAsync(bytes, new URL('.', new URL(url, window.location.href)).href);
        if (disposed || sequence !== animationRequest || target !== model) return;
        clip = loaded.animations[0];
        if (!clip?.tracks.length) throw new Error('В файле нет движения. Выбери другую анимацию.');
        for (const track of clip.tracks) {
          const binding = THREE.PropertyBinding.parseTrackName(track.name);
          if (!THREE.PropertyBinding.findNode(model, binding.nodeName))
            throw new Error('Движение относится к другому скелету. Обнови страницу.');
        }
      }
      if (!clip) return;
      ragdoll?.reset();
      mixer?.stopAllAction();
      mixer?.uncacheRoot(model);
      for (const rest of restTransforms) {
        rest.node.position.copy(rest.position);
        rest.node.quaternion.copy(rest.quaternion);
        rest.node.scale.copy(rest.scale);
      }
      // Placement may have been edited since the model was first loaded.
      model.position.copy(basePosition);
      model.quaternion.copy(baseQuaternion);
      mixer = new THREE.AnimationMixer(model);
      action = mixer.clipAction(clip).reset().play();
      mixer.update(0);
      clipName = clip.name;
      patrol = playground && !url && clipName === 'Walk';
      animationTime = 0;
      playing = true;
      model.updateMatrixWorld(true);
      ragdoll?.update(0);
      emit({ motionLoading: false, motionError: '' });
    } catch (error) {
      if (disposed || sequence !== animationRequest || target !== model) return;
      emit({ motionLoading: false, motionError: error.message });
      throw error;
    } finally {
      if (loaded) disposeObject(loaded.scene);
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
    endBodyDrag();
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
  let pointerStart, bodyDrag = null;
  const dragPlane = new THREE.Plane(), dragTarget = new THREE.Vector3();
  const grabMarker = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), new THREE.MeshBasicMaterial({ color: 0x50ffe5, depthTest: false }));
  const grabLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x50ffe5, depthTest: false, transparent: true, opacity: 0.8 }));
  grabMarker.visible = grabLine.visible = false;
  grabMarker.renderOrder = grabLine.renderOrder = 20;
  grabLine.frustumCulled = false;
  scene.add(grabMarker, grabLine);

  function pointerRay(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  }

  function pickedBone(intersection) {
    const mesh = intersection.object, face = intersection.face;
    const indices = mesh.geometry?.attributes.skinIndex, weights = mesh.geometry?.attributes.skinWeight;
    if (!mesh.isSkinnedMesh || !face || !indices || !weights) return null;
    const vertices = [face.a, face.b, face.c].map((i) => mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
    const bary = new THREE.Triangle(...vertices).getBarycoord(intersection.point, new THREE.Vector3());
    if (!bary) return null;
    const totals = new Map();
    [face.a, face.b, face.c].forEach((index, corner) => {
      for (let slot = 0; slot < 4; slot++) {
        const name = mesh.skeleton.bones[indices.getComponent(index, slot)]?.name;
        if (BONES.includes(name)) totals.set(name, (totals.get(name) || 0) + weights.getComponent(index, slot) * bary.getComponent(corner));
      }
    });
    return [...totals].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  function endBodyDrag() {
    if (!bodyDrag) return;
    const previous = bodyDrag;
    bodyDrag = null;
    ragdoll?.endGrab();
    controls.enabled = previous.controlsEnabled;
    canvas.style.cursor = previous.cursor;
    grabMarker.visible = grabLine.visible = false;
    if (canvas.hasPointerCapture(previous.pointerId)) canvas.releasePointerCapture(previous.pointerId);
    emit();
  }

  function pointerDown(event) {
    if (bodyDrag) return;
    pointerStart = event.button === 0 ? { x: event.clientX, y: event.clientY, time: performance.now() } : null;
    if (event.button !== 2 || !playground || !ready || !ragdoll || manualEditor.enabled || meshEditor.getStatus().enabled) return;
    pointerRay(event);
    model.updateMatrixWorld(true);
    model.traverse((object) => { if (object.isSkinnedMesh) object.computeBoundingSphere(); });
    const intersection = raycaster.intersectObject(model, true)[0];
    if (!intersection) return;
    const name = ragdoll.beginGrab(intersection.point, pickedBone(intersection));
    if (!name) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    bodyDrag = { pointerId: event.pointerId, controlsEnabled: controls.enabled, cursor: canvas.style.cursor };
    controls.enabled = false;
    canvas.style.cursor = 'grabbing';
    canvas.setPointerCapture(event.pointerId);
    dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), intersection.point);
    grabMarker.position.copy(intersection.point);
    grabMarker.visible = true;
    emit();
  }

  function pointerMove(event) {
    if (!bodyDrag || event.pointerId !== bodyDrag.pointerId) return;
    if (!(event.buttons & 2)) { endBodyDrag(); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    pointerRay(event);
    if (raycaster.ray.intersectPlane(dragPlane, dragTarget)) {
      dragTarget.clamp(new THREE.Vector3(-12, 0.02, -12), new THREE.Vector3(12, 8, 12));
      ragdoll.moveGrab(dragTarget);
    }
  }

  function pointerUp(event) {
    if (bodyDrag && event.pointerId === bodyDrag.pointerId) {
      event.preventDefault(); event.stopImmediatePropagation(); endBodyDrag(); pointerStart = null; return;
    }
    if (manualEditor.enabled || meshEditor.getStatus().enabled || !playground || !pointerStart || !ready || !ragdoll || event.button !== 0) return;
    if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5 || performance.now() - pointerStart.time > 500) return;
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    model.traverse((object) => { if (object.isSkinnedMesh) object.computeBoundingSphere(); });
    raycaster.setFromCamera(pointer, camera);
    const intersection = raycaster.intersectObject(model, true)[0];
    if (intersection) hit(intersection.point);
  }
  function pointerCancel(event) { if (event.pointerId === bodyDrag?.pointerId) endBodyDrag(); pointerStart = null; }
  function contextMenu(event) { if (playground && ready && ragdoll && !manualEditor.enabled && !meshEditor.getStatus().enabled) event.preventDefault(); }
  function visibilityChanged() { if (document.hidden) endBodyDrag(); }
  canvas.addEventListener('pointerdown', pointerDown, true);
  canvas.addEventListener('pointermove', pointerMove, true);
  canvas.addEventListener('pointerup', pointerUp, true);
  canvas.addEventListener('pointercancel', pointerCancel);
  canvas.addEventListener('lostpointercapture', pointerCancel);
  canvas.addEventListener('contextmenu', contextMenu);
  window.addEventListener('blur', endBodyDrag);
  document.addEventListener('visibilitychange', visibilityChanged);
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
      ragdoll?.stepGrab(STEP);
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
    if (playground && ready && !bodyDrag && !orientationPreview && !manualEditor.enabled && !meshEditor.getStatus().enabled && model.getObjectByName('Hips')) {
      const target = model.getObjectByName('Hips').getWorldPosition(new THREE.Vector3());
      target.y = Math.max(0.55, Math.min(1.1, target.y));
      controls.target.lerp(target, 1 - Math.exp(-realDt * 1.2));
    }
    if (!bodyDrag) controls.update();
    const held = ragdoll?.grabPoints();
    if (held) {
      grabMarker.position.copy(held.anchor);
      const line = grabLine.geometry.attributes.position;
      line.setXYZ(0, held.anchor.x, held.anchor.y, held.anchor.z);
      line.setXYZ(1, held.target.x, held.target.y, held.target.z);
      line.needsUpdate = true;
      grabLine.visible = true;
    }
    renderer.render(scene, camera);
    fpsElapsed += realDt;
    frameCount++;
    stateTime += realDt;
    if (fpsElapsed > 0.7) { fps = Math.round(frameCount / fpsElapsed); frameCount = 0; fpsElapsed = 0; }
    if (stateTime > 0.4) { stateTime = 0; emit(); }
  });
  return {
    load, setAnimation, hit, reset, resetCamera, frontView, setPosition, placeOnFloor,
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
      canvas.removeEventListener('pointerdown', pointerDown, true);
      canvas.removeEventListener('pointermove', pointerMove, true);
      canvas.removeEventListener('pointerup', pointerUp, true);
      canvas.removeEventListener('pointercancel', pointerCancel);
      canvas.removeEventListener('lostpointercapture', pointerCancel);
      canvas.removeEventListener('contextmenu', contextMenu);
      window.removeEventListener('blur', endBodyDrag);
      document.removeEventListener('visibilitychange', visibilityChanged);
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
