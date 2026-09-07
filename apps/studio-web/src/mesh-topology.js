import * as THREE from 'three';

export function triangleIndices(geometry) {
  const position = geometry.getAttribute('position');
  if (!position || position.itemSize < 3) throw new Error('В модели отсутствуют координаты поверхности.');
  const count = Math.floor((geometry.index?.count ?? position.count) / 3) * 3;
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = geometry.index ? geometry.index.getX(i) : i;
  return indices;
}

/** Weld positions, rather than UV/normal indices, so a texture seam is not a part. */
export function buildComponents(geometry, indices = triangleIndices(geometry)) {
  const position = geometry.getAttribute('position');
  const bounds = new THREE.Box3().setFromBufferAttribute(position);
  const tolerance = Math.max(bounds.getSize(new THREE.Vector3()).length() * 1e-6, 1e-9);
  const squaredTolerance = tolerance ** 2;
  const cells = new Map();
  const vertexRoots = new Int32Array(position.count).fill(-1);
  const parent = new Int32Array(indices.length / 3).map((_, i) => i);
  const find = (value) => {
    while (parent[value] !== value) { parent[value] = parent[parent[value]]; value = parent[value]; }
    return value;
  };
  const join = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const weldedFace = new Map();
  for (let corner = 0; corner < indices.length; corner++) {
    const vertex = indices[corner];
    if (vertexRoots[vertex] < 0) {
      const x = position.getX(vertex), y = position.getY(vertex), z = position.getZ(vertex);
      const cx = Math.floor(x / tolerance), cy = Math.floor(y / tolerance), cz = Math.floor(z / tolerance);
      let welded = -1;
      search: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const other of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) || []) {
          if ((x - position.getX(other)) ** 2 + (y - position.getY(other)) ** 2 + (z - position.getZ(other)) ** 2 <= squaredTolerance) {
            welded = other; break search;
          }
        }
      }
      vertexRoots[vertex] = welded < 0 ? vertex : welded;
      if (welded < 0) {
        const key = `${cx},${cy},${cz}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(vertex);
      }
    }
    const welded = vertexRoots[vertex];
    const face = Math.floor(corner / 3);
    const previous = weldedFace.get(welded);
    if (previous === undefined) weldedFace.set(welded, face);
    else join(face, previous);
  }
  const grouped = new Map();
  for (let face = 0; face < parent.length; face++) {
    const root = find(face);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(face);
  }
  const components = [...grouped.values()].map((faces) => Uint32Array.from(faces));
  const componentByFace = new Uint32Array(parent.length);
  components.forEach((faces, component) => { for (const face of faces) componentByFace[face] = component; });
  return { components, componentByFace, tolerance };
}

/** Keep vertex attributes and their bounds unchanged; only the draw index changes. */
export function filterTriangles(geometry, deleted, indices = triangleIndices(geometry)) {
  const faceCount = indices.length / 3;
  const offsets = new Uint32Array(faceCount + 1);
  let count = 0;
  for (let face = 0; face < faceCount; face++) {
    offsets[face] = count;
    if (!deleted.has(face)) count++;
  }
  offsets[faceCount] = count;
  const index = new Uint32Array(count * 3);
  const sourceTriangles = new Uint32Array(count);
  for (let face = 0, destination = 0; face < faceCount; face++) {
    if (deleted.has(face)) continue;
    index.set(indices.subarray(face * 3, face * 3 + 3), destination * 3);
    sourceTriangles[destination++] = face;
  }
  const groups = geometry.groups.map((group) => {
    const first = Math.max(0, Math.min(faceCount, Math.ceil(group.start / 3)));
    const end = Math.max(first, Math.min(faceCount, Math.floor((group.start + group.count) / 3)));
    return { start: offsets[first] * 3, count: (offsets[end] - offsets[first]) * 3, materialIndex: group.materialIndex };
  }).filter((group) => group.count > 0);
  return { index, groups, sourceTriangles };
}

/** A small CPU triangle tree for brush occlusion tests, built once per source. */
export function createTriangleTree(geometry, indices = triangleIndices(geometry)) {
  const position = geometry.getAttribute('position');
  const count = indices.length / 3;
  const centers = new Float64Array(count * 3);
  const order = Uint32Array.from({ length: count }, (_, i) => i);
  for (let face = 0; face < count; face++) {
    for (let axis = 0; axis < 3; axis++) {
      const get = axis === 0 ? 'getX' : axis === 1 ? 'getY' : 'getZ';
      centers[face * 3 + axis] = (position[get](indices[face * 3]) + position[get](indices[face * 3 + 1]) + position[get](indices[face * 3 + 2])) / 3;
    }
  }
  const vertex = new THREE.Vector3();
  const size = new THREE.Vector3();
  function build(start, end) {
    const box = new THREE.Box3();
    for (let i = start; i < end; i++) for (let corner = 0; corner < 3; corner++) {
      box.expandByPoint(vertex.fromBufferAttribute(position, indices[order[i] * 3 + corner]));
    }
    const node = { box, start, end };
    if (end - start <= 12) return node;
    box.getSize(size);
    const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
    order.subarray(start, end).sort((a, b) => centers[a * 3 + axis] - centers[b * 3 + axis]);
    const middle = (start + end) >>> 1;
    node.left = build(start, middle);
    node.right = build(middle, end);
    return node;
  }
  const root = count ? build(0, count) : null;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const intersection = new THREE.Vector3(), boxPoint = new THREE.Vector3();
  function intersect(ray, deleted = new Set()) {
    let distanceSquared = Infinity, nearest = null;
    function visit(node) {
      if (!node || !ray.intersectBox(node.box, boxPoint)) return;
      // intersectBox returns the exit when the origin is inside the box.
      if (!node.box.containsPoint(ray.origin) && ray.origin.distanceToSquared(boxPoint) > distanceSquared) return;
      if (node.left) { visit(node.left); visit(node.right); return; }
      for (let i = node.start; i < node.end; i++) {
        const face = order[i];
        if (deleted.has(face)) continue;
        a.fromBufferAttribute(position, indices[face * 3]);
        b.fromBufferAttribute(position, indices[face * 3 + 1]);
        c.fromBufferAttribute(position, indices[face * 3 + 2]);
        if (!ray.intersectTriangle(a, b, c, false, intersection)) continue;
        const distance = ray.origin.distanceToSquared(intersection);
        if (distance < distanceSquared) { distanceSquared = distance; nearest = { triangle: face, point: intersection.clone(), distance: Math.sqrt(distance) }; }
      }
    }
    visit(root);
    return nearest;
  }
  return { centers, intersect };
}
