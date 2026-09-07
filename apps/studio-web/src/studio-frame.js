import * as THREE from 'three';

const MAX_FRAME_POINTS = 2_000_000;
const frameBounds = new WeakMap();

/** Reconstruct the original geometry frame, including now-removed primitives. */
export async function readStudioFramePoints(gltf) {
  const sources = gltf.asset?.extras?.studioFrameSources;
  const parser = gltf.parser;
  if (!Array.isArray(sources) || !sources.length || sources.length > 1024 || !parser?.getDependency) return null;
  let count = 0;
  for (const source of sources) {
    const accessor = parser.json?.accessors?.[source?.position];
    const matrix = source?.matrix;
    if (!Number.isInteger(source?.position) || source.position < 0 || !accessor || accessor.type !== 'VEC3'
      || !Number.isInteger(accessor.count) || accessor.count <= 0
      || !Array.isArray(matrix) || matrix.length !== 16
      || !matrix.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e12)
      || matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) return null;
    count += accessor.count;
    if (count > MAX_FRAME_POINTS) return null;
  }
  const points = new Float32Array(count * 3);
  const attributes = new Map();
  let offset = 0;
  try {
    for (const source of sources) {
      if (!attributes.has(source.position)) attributes.set(source.position, await parser.getDependency('accessor', source.position));
      const position = attributes.get(source.position);
      const count = parser.json.accessors[source.position].count;
      if (position?.itemSize !== 3 || position.count !== count) return null;
      const m = source.matrix;
      for (let i = 0; i < count; i++) {
        const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
        const worldX = m[0] * x + m[4] * y + m[8] * z + m[12];
        const worldY = m[1] * x + m[5] * y + m[9] * z + m[13];
        const worldZ = m[2] * x + m[6] * y + m[10] * z + m[14];
        if (!Number.isFinite(worldX) || !Number.isFinite(worldY) || !Number.isFinite(worldZ)
          || Math.max(Math.abs(worldX), Math.abs(worldY), Math.abs(worldZ)) > 1e12) return null;
        points[offset++] = worldX;
        points[offset++] = worldY;
        points[offset++] = worldZ;
      }
    }
  } catch { return null; }
  return points;
}

/** Precise bounds are cached by rotation/scale; placement only adds translation. */
export function getStudioFrameBounds(model) {
  const points = model?.userData?.studioFramePoints;
  if (!(points instanceof Float32Array) || !points.length || points.length % 3 || points.length > MAX_FRAME_POINTS * 3) return null;
  const matrix = model.matrixWorld.elements;
  const linear = [matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[6], matrix[8], matrix[9], matrix[10]];
  let cached = frameBounds.get(model);
  if (!cached || cached.points !== points || cached.linear.some((value, index) => value !== linear[index])) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < points.length; i += 3) {
      const px = points[i], py = points[i + 1], pz = points[i + 2];
      const x = linear[0] * px + linear[3] * py + linear[6] * pz;
      const y = linear[1] * px + linear[4] * py + linear[7] * pz;
      const z = linear[2] * px + linear[5] * py + linear[8] * pz;
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
    }
    if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return null;
    cached = { points, linear, minX, minY, minZ, maxX, maxY, maxZ };
    frameBounds.set(model, cached);
  }
  return new THREE.Box3(
    new THREE.Vector3(cached.minX + matrix[12], cached.minY + matrix[13], cached.minZ + matrix[14]),
    new THREE.Vector3(cached.maxX + matrix[12], cached.maxY + matrix[13], cached.maxZ + matrix[14]),
  );
}
