import * as THREE from 'three';

export const DEFAULT_ENVIRONMENT = Object.freeze({
  background: 'studio', backgroundProjection: 'panorama', backgroundRotation: 0,
  ground: 'grid', groundShape: 'plane', groundScale: 2, showGrid: true,
  backgroundUrl: null, groundUrl: null, revision: 0,
});

function finite(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function imageUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value) return null;
  try {
    const url = new URL(value, window.location.href);
    // Saved assets are served by Studio; the editor uses local object URLs.
    return (url.protocol === 'blob:' || (['http:', 'https:'].includes(url.protocol) && url.origin === window.location.origin)) ? url.href : null;
  } catch { return null; }
}

export function normalizeEnvironment(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  const choice = (key, values) => values.includes(value[key]) ? value[key] : DEFAULT_ENVIRONMENT[key];
  return {
    background: choice('background', ['studio', 'dawn', 'sunset', 'night', 'custom']),
    backgroundProjection: choice('backgroundProjection', ['panorama', 'image']),
    backgroundRotation: finite(value.backgroundRotation, 0, -180, 180),
    ground: choice('ground', ['grid', 'stone', 'sand', 'grass', 'custom']),
    groundShape: choice('groundShape', ['plane', 'disc']),
    groundScale: finite(value.groundScale, 2, 0.25, 10),
    showGrid: typeof value.showGrid === 'boolean' ? value.showGrid : true,
    backgroundUrl: imageUrl(value.backgroundUrl), groundUrl: imageUrl(value.groundUrl),
    revision: Math.max(0, Math.floor(finite(value.revision, 0, 0, Number.MAX_SAFE_INTEGER))),
  };
}

const PALETTES = {
  studio: { fog: 0x0d131a, key: 0xfff1d7, rim: 0x51d6d1, sky: 0xb3d4e5, earth: 0x202a35 },
  dawn: { fog: 0xc0cdd2, key: 0xffead4, rim: 0x9fceef, sky: 0xc3ddf4, earth: 0x4d5146 },
  sunset: { fog: 0xb57972, key: 0xffd2a0, rim: 0xa69fd9, sky: 0xd5bdde, earth: 0x443b4d },
  night: { fog: 0x142031, key: 0xcddcff, rim: 0x6ab8dd, sky: 0x829bc5, earth: 0x1a2430 },
};

function canvasTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function random(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

function skyTexture(preset) {
  const canvas = document.createElement('canvas');
  canvas.width = 2048; canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  const colors = {
    dawn: ['#25466c', '#527faa', '#b6ccd8', '#f9ddbb', '#909d99'],
    sunset: ['#201f45', '#655377', '#d28b83', '#ffc18c', '#665369'],
    night: ['#060b1b', '#101d37', '#25394e', '#506478', '#192532'],
  }[preset];
  const sky = ctx.createLinearGradient(0, 0, 0, 1024);
  [0, 0.28, 0.45, 0.51, 1].forEach((stop, index) => sky.addColorStop(stop, colors[index]));
  ctx.fillStyle = sky; ctx.fillRect(0, 0, 2048, 1024);
  const rand = random(1387);
  if (preset === 'night') {
    for (let index = 0; index < 700; index++) {
      const x = rand() * 2048, y = 75 + rand() * 400;
      ctx.fillStyle = `rgba(216,232,255,${0.18 + rand() * 0.6})`;
      ctx.beginPath(); ctx.arc(x, y, 0.35 + rand() * 0.75, 0, Math.PI * 2); ctx.fill();
    }
  }
  const lightX = 1330, lightY = preset === 'night' ? 292 : 482;
  const glow = ctx.createRadialGradient(lightX, lightY, 3, lightX, lightY, preset === 'night' ? 115 : 390);
  glow.addColorStop(0, preset === 'night' ? '#d9eaff55' : '#ffddbba0');
  glow.addColorStop(0.3, preset === 'night' ? '#adcfff18' : '#ffb57e33');
  glow.addColorStop(1, '#ffffff00');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, 2048, 700);
  ctx.fillStyle = preset === 'night' ? '#dce8f4' : '#fff1d3';
  ctx.beginPath(); ctx.ellipse(lightX, lightY, preset === 'night' ? 9 : 14, preset === 'night' ? 8 : 13, 0, 0, Math.PI * 2); ctx.fill();
  // Periodic, low mountain silhouettes join cleanly across the panorama seam.
  for (let layer = 0; layer < 3; layer++) {
    ctx.fillStyle = preset === 'night' ? ['#34495b', '#26384a', '#1a293a'][layer]
      : preset === 'sunset' ? ['#9e737c', '#796374', '#615b6b'][layer] : ['#91a6b4', '#80949d', '#71858c'][layer];
    ctx.beginPath();
    for (let x = 0; x <= 2048; x += 4) {
      const angle = x / 2048 * Math.PI * 2;
      const ridge = Math.sin(angle * (4 + layer) + layer) * 10 + Math.sin(angle * 13 + layer * 2) * 4 + Math.cos(angle * 23) * 2;
      const y = 531 + layer * 17 - ridge * (1.6 - layer * 0.3);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineTo(2048, 1024); ctx.lineTo(0, 1024); ctx.closePath(); ctx.fill();
  }
  const texture = canvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  return texture;
}

function groundTexture(preset) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(512, 512), rand = random(98712);
  const base = { stone: [98, 107, 113], sand: [191, 164, 118], grass: [76, 94, 58] }[preset];
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const ax = x / 512 * Math.PI * 2, ay = y / 512 * Math.PI * 2;
    let grain = (rand() - 0.5) * (preset === 'grass' ? 32 : 17);
    grain += Math.sin(ax * 3 + Math.sin(ay * 2)) * Math.cos(ay * 4) * 5;
    if (preset === 'sand') grain += Math.sin(ay * 18 + Math.sin(ax * 2) * 3) * 3;
    if (preset === 'stone') {
      const row = Math.floor(y / 128), jointX = (x + (row % 2) * 128) % 256;
      if (y % 128 < 3 || jointX < 3) grain -= 33;
      else grain += ((row + Math.floor((x + (row % 2) * 128) / 256)) % 3 - 1) * 7;
    }
    const offset = (y * 512 + x) * 4;
    for (let c = 0; c < 3; c++) pixels.data[offset + c] = Math.max(0, Math.min(255, base[c] + grain));
    pixels.data[offset + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  if (preset === 'grass') {
    for (let blade = 0; blade < 6500; blade++) {
      const x = rand() * 512, y = rand() * 512;
      ctx.strokeStyle = rand() > 0.5 ? '#b2b77555' : '#273e2860';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + rand() * 3 - 1.5, y - 2 - rand() * 5); ctx.stroke();
    }
  }
  return canvasTexture(canvas);
}

function clippedGrid(radius) {
  const points = [];
  for (let position = -Math.floor(radius); position <= radius; position++) {
    const extent = Math.sqrt(Math.max(0, radius * radius - position * position));
    points.push(position, 0, -extent, position, 0, extent, -extent, 0, position, extent, 0, position);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const colors = [];
  const color = new THREE.Color(0x345360);
  for (let index = 0; index < points.length / 3; index++) colors.push(color.r, color.g, color.b);
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

/** Owns visual stage assets only. The viewer's model and physics stay untouched. */
export function createEnvironment({ scene, renderer, camera, container, floor, grid, ring, key, rim, hemisphere }) {
  const originalFloor = floor.geometry, originalGrid = grid.geometry;
  const discGeometry = new THREE.CircleGeometry(6, 128), discGrid = clippedGrid(5.98);
  const edge = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 0.18, 128), new THREE.MeshStandardMaterial({ color: 0x263541, roughness: 0.64, metalness: 0.35 }));
  edge.position.y = -0.11; edge.receiveShadow = true; edge.visible = false;
  scene.add(edge);
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  let disposed = false, sequence = 0, pendingKey = null, pendingPromise = null;
  let current = { ...DEFAULT_ENVIRONMENT }, currentKey = JSON.stringify(current);
  let background = null, backgroundKey = 'studio', ground = null, groundKey = 'grid';
  container.dataset.environment = JSON.stringify(current);

  function fitImage() {
    if (!background || current.background !== 'custom' || current.backgroundProjection !== 'image') return;
    const aspect = (background.image?.width || 1) / (background.image?.height || 1);
    const x = Math.min(1, camera.aspect / aspect), y = Math.min(1, aspect / camera.aspect);
    background.repeat.set(x, y); background.offset.set((1 - x) / 2, (1 - y) / 2);
  }

  function apply(settings, skyMap, floorMap) {
    const palette = PALETTES[settings.background] || PALETTES.studio;
    const image = settings.background === 'custom' && settings.backgroundProjection === 'image';
    scene.background = skyMap || new THREE.Color(0x0d131a);
    if (skyMap) {
      skyMap.mapping = image ? THREE.UVMapping : THREE.EquirectangularReflectionMapping;
      skyMap.repeat.set(1, 1); skyMap.offset.set(0, 0); skyMap.needsUpdate = true;
    }
    scene.backgroundRotation.set(0, THREE.MathUtils.degToRad(settings.backgroundRotation), 0);
    scene.backgroundIntensity = settings.background === 'night' ? 0.8 : 1;
    scene.fog = settings.background === 'custom' ? null : new THREE.Fog(palette.fog, settings.background === 'studio' ? 13 : 20, settings.background === 'studio' ? 35 : 57);
    hemisphere.color.setHex(palette.sky); hemisphere.groundColor.setHex(palette.earth);
    key.color.setHex(palette.key); rim.color.setHex(palette.rim);
    const disc = settings.groundShape === 'disc', diameter = disc ? 12 : 60;
    floor.geometry = disc ? discGeometry : originalFloor;
    grid.geometry = disc ? discGrid : originalGrid;
    edge.visible = disc;
    grid.visible = settings.showGrid;
    ring.visible = settings.showGrid;
    floor.material.map = floorMap;
    floor.material.color.setHex(floorMap ? 0xffffff : 0x141d28);
    floor.material.roughness = floorMap ? 0.96 : 0.8;
    floor.material.metalness = floorMap ? 0.02 : 0.2;
    if (floorMap) {
      floorMap.wrapS = floorMap.wrapT = THREE.RepeatWrapping;
      floorMap.repeat.set(diameter / settings.groundScale, diameter / settings.groundScale);
      floorMap.anisotropy = anisotropy; floorMap.needsUpdate = true;
    }
    floor.material.needsUpdate = true;
  }

  async function texture(url, label) {
    if (!url) throw new Error(`Загрузите ${label}.`);
    try {
      const result = await new THREE.TextureLoader().loadAsync(url);
      result.colorSpace = THREE.SRGBColorSpace;
      return result;
    } catch { throw new Error(`Не удалось открыть ${label}. Попробуйте загрузить изображение ещё раз.`); }
  }

  function setEnvironment(value) {
    if (disposed) return Promise.resolve(null);
    const settings = normalizeEnvironment(value), signature = JSON.stringify(settings);
    if (signature === pendingKey) return pendingPromise;
    const ticket = ++sequence;
    if (signature === currentKey) {
      pendingKey = pendingPromise = null;
      return Promise.resolve({ ...current });
    }
    const nextBackgroundKey = settings.background === 'custom' ? `custom:${settings.backgroundUrl}` : settings.background;
    const nextGroundKey = settings.ground === 'custom' ? `custom:${settings.groundUrl}` : settings.ground;
    const oldBackground = background, oldGround = ground;
    const skyRequest = nextBackgroundKey === backgroundKey ? Promise.resolve(background)
      : settings.background === 'studio' ? Promise.resolve(null)
      : settings.background === 'custom' ? texture(settings.backgroundUrl, 'изображение фона') : Promise.resolve(skyTexture(settings.background));
    const groundRequest = nextGroundKey === groundKey ? Promise.resolve(ground)
      : settings.ground === 'grid' ? Promise.resolve(null)
      : settings.ground === 'custom' ? texture(settings.groundUrl, 'текстуру земли') : Promise.resolve(groundTexture(settings.ground));
    pendingKey = signature;
    pendingPromise = Promise.allSettled([skyRequest, groundRequest]).then((results) => {
      const skyMap = results[0].status === 'fulfilled' ? results[0].value : null;
      const floorMap = results[1].status === 'fulfilled' ? results[1].value : null;
      const releaseUnused = () => {
        if (skyMap && skyMap !== oldBackground) skyMap.dispose();
        if (floorMap && floorMap !== oldGround) floorMap.dispose();
      };
      if (disposed || ticket !== sequence) { releaseUnused(); return null; }
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) { releaseUnused(); throw failure.reason; }
      apply(settings, skyMap, floorMap);
      if (background && background !== skyMap) background.dispose();
      if (ground && ground !== floorMap) ground.dispose();
      background = skyMap; ground = floorMap;
      backgroundKey = nextBackgroundKey; groundKey = nextGroundKey;
      current = settings; currentKey = signature;
      fitImage();
      container.dataset.environment = JSON.stringify(settings);
      return { ...settings };
    }).finally(() => { if (ticket === sequence) pendingKey = pendingPromise = null; });
    return pendingPromise;
  }

  return {
    setEnvironment, resize: fitImage,
    dispose() {
      if (disposed) return;
      disposed = true; sequence++;
      floor.geometry = originalFloor; grid.geometry = originalGrid;
      floor.material.map = null;
      background?.dispose(); ground?.dispose();
      background = ground = null;
      discGeometry.dispose(); discGrid.dispose();
      edge.removeFromParent(); edge.geometry.dispose(); edge.material.dispose();
      delete container.dataset.environment;
    },
  };
}
