"""Owner-controlled triangle deletion with immutable source geometry and rollback."""
import asyncio
import contextlib
import copy
import json
import math
import re
import struct
import uuid

from aiohttp import web


MAX_BODY = 4 * 1024 * 1024
MAX_GLB = 128 * 1024 * 1024
MAX_JSON = 16 * 1024 * 1024
MAX_FACES = 1_000_000
MAX_VERTICES = 2_000_000
MAX_REMOVALS = 500_000
MAX_REVISION = 2**53 - 1
MESH_PATH = re.compile(r'^meshes/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/model\.glb$')
JSON_CHUNK, BIN_CHUNK = 0x4E4F534A, 0x004E4942


def active_path(job):
    path = job.get('_meshPath')
    return path if isinstance(path, str) and MESH_PATH.fullmatch(path) else 'model.glb'


def payload(job):
    saved = job.get('meshEdit', {})
    stats = job.get('stats', {})
    original = job.get('_meshOriginal', {}).get('stats', stats)
    def number(value, default=0):
        return value if type(value) is int and 0 <= value <= MAX_REVISION else default
    return {'revision': number(saved.get('revision')), 'edited': active_path(job) != 'model.glb',
            'removedTriangles': number(saved.get('removedTriangles')),
            'originalTriangles': number(saved.get('originalTriangles'), number(original.get('triangles')))}


def owner_paths(job):
    paths = {'model.glb', active_path(job)}
    paths.update(path for path in job.get('_meshVersions', []) if isinstance(path, str) and MESH_PATH.fullmatch(path))
    return paths


def history_paths(job):
    return owner_paths(job)


def fail(message='Эта модель пока не поддерживает удаление частей. Нужна обычная сетка GLB без скелета и сжатия.'):
    raise ValueError(message)


def integer(value, minimum=0, maximum=MAX_REVISION):
    return type(value) is int and minimum <= value <= maximum


def parse_glb(raw):
    if not 20 <= len(raw) <= MAX_GLB:
        fail('Размер исходной GLB должен быть не больше 128 МБ.')
    magic, version, total = struct.unpack_from('<4sII', raw)
    if magic != b'glTF' or version != 2 or total != len(raw):
        fail('Файл модели GLB повреждён.')
    chunks, offset = {}, 12
    while offset < total:
        if offset + 8 > total:
            fail('Файл модели GLB обрезан.')
        length, kind = struct.unpack_from('<II', raw, offset)
        offset += 8
        if length % 4 or offset + length > total or kind in chunks or kind not in (JSON_CHUNK, BIN_CHUNK):
            fail('Неподдерживаемая структура GLB.')
        if not chunks and kind != JSON_CHUNK or kind == JSON_CHUNK and length > MAX_JSON:
            fail('Неподдерживаемый заголовок GLB.')
        chunks[kind] = raw[offset:offset + length]
        offset += length
    try:
        document = json.loads(chunks[JSON_CHUNK])
    except (KeyError, ValueError, UnicodeDecodeError):
        fail('Заголовок модели GLB повреждён.')
    binary = chunks.get(BIN_CHUNK, b'')
    if (not isinstance(document, dict) or document.get('asset', {}).get('version') != '2.0'
            or document.get('skins') or document.get('animations') or document.get('extensionsRequired')):
        fail()
    buffers = document.get('buffers')
    if (not isinstance(buffers, list) or len(buffers) != 1 or not isinstance(buffers[0], dict)
            or buffers[0].get('uri') is not None or not integer(buffers[0].get('byteLength'))
            or not buffers[0]['byteLength'] <= len(binary) <= buffers[0]['byteLength'] + 3):
        fail('Модель должна хранить всю геометрию и текстуры внутри GLB.')
    for node in document.get('nodes', []):
        if not isinstance(node, dict) or 'skin' in node or 'weights' in node:
            fail()
    for image in document.get('images', []):
        if not isinstance(image, dict) or 'uri' in image:
            fail('Внешние текстуры в GLB не поддерживаются.')
    views = document.get('bufferViews', [])
    accessors = document.get('accessors', [])
    if not isinstance(views, list) or not isinstance(accessors, list):
        fail()
    for view in views:
        if (not isinstance(view, dict) or view.get('buffer') != 0 or view.get('extensions')
                or not integer(view.get('byteOffset', 0)) or not integer(view.get('byteLength'), 1)
                or view.get('byteOffset', 0) + view['byteLength'] > buffers[0]['byteLength']):
            fail('Недопустимые границы данных GLB.')
    return document, binary


def accessor_data(document, binary, index, *, indices=False, position=False):
    accessors = document.get('accessors', [])
    if not integer(index, 0, len(accessors) - 1):
        fail('У модели некорректный accessor.')
    accessor = accessors[index]
    views = document.get('bufferViews', [])
    if (not isinstance(accessor, dict) or accessor.get('sparse') is not None or accessor.get('extensions')
            or not integer(accessor.get('bufferView'), 0, len(views) - 1)
            or not integer(accessor.get('count'), 1, MAX_VERTICES if position else MAX_FACES * 3)):
        fail()
    components = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}.get(accessor.get('type'))
    formats = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
    fmt, size = formats.get(accessor.get('componentType'), (None, None))
    if not components or fmt is None:
        fail()
    if indices and (accessor['type'] != 'SCALAR' or accessor['componentType'] not in (5121, 5123, 5125) or accessor.get('normalized')):
        fail('У модели некорректные индексы треугольников.')
    if position and (accessor['type'] != 'VEC3' or accessor['componentType'] != 5126 or accessor.get('normalized')):
        fail('Неподдерживаемые координаты вершин модели.')
    view = views[accessor['bufferView']]
    relative = accessor.get('byteOffset', 0)
    stride = view.get('byteStride', components * size)
    if (not integer(relative) or not integer(stride, components * size, 252)
            or stride % size or relative % size
            or relative + (accessor['count'] - 1) * stride + components * size > view['byteLength']):
        fail('Недопустимые границы вершин GLB.')
    offset = view.get('byteOffset', 0) + relative
    return accessor, offset, stride, '<' + fmt * components


def original_bounds(document, primitive_bounds):
    """Keep the same local bounding-box corners used by THREE.Box3's default path."""
    existing = document.get('asset', {}).get('extras', {}).get('studioBounds')
    def vector(value, length):
        return (isinstance(value, list) and len(value) == length
                and all(type(v) in (int, float) and math.isfinite(v) for v in value))
    if existing is not None:
        if (not isinstance(existing, dict) or existing.get('version') != 1
                or not isinstance(existing.get('corners'), list) or not 1 <= len(existing['corners']) <= 8192
                or any(not vector(point, 3) for point in existing['corners'])):
            fail('У модели повреждены исходные границы редактирования.')
        sources = document['asset']['extras'].get('studioFrameSources')
        if (not isinstance(sources, list) or not 1 <= len(sources) <= 1024
                or any(not isinstance(source, dict) or set(source) != {'position', 'matrix'}
                       or not integer(source['position'], 0, len(document['accessors']) - 1)
                       or not vector(source['matrix'], 16) or any(abs(value) > 1e12 for value in source['matrix'])
                       or any(abs(source['matrix'][i]) > 1e-8 for i in (3, 7, 11))
                       or abs(source['matrix'][15] - 1) > 1e-8 for source in sources)):
            fail('У модели повреждены исходные координаты редактирования.')
        count = 0
        for source in sources:
            accessor = document['accessors'][source['position']]
            if (accessor.get('type') != 'VEC3' or accessor.get('componentType') != 5126
                    or not integer(accessor.get('count'), 1, MAX_VERTICES) or accessor.get('sparse') is not None):
                fail('У модели повреждены исходные координаты редактирования.')
            count += accessor['count']
        if count > MAX_VERTICES:
            fail('У модели слишком много вершин для сохранения исходных координат.')
        return existing, sources
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    def multiply(a, b):
        return [sum(a[k * 4 + row] * b[col * 4 + k] for k in range(4)) for col in range(4) for row in range(4)]
    def matrix(node):
        if 'matrix' in node:
            value = node['matrix']
            if (not vector(value, 16) or any(key in node for key in ('translation', 'rotation', 'scale'))
                    or any(abs(value[i]) > 1e-8 for i in (3, 7, 11)) or abs(value[15] - 1) > 1e-8):
                fail('Неподдерживаемое преобразование части модели.')
            return value
        translation, scale, rotation = node.get('translation', [0, 0, 0]), node.get('scale', [1, 1, 1]), node.get('rotation', [0, 0, 0, 1])
        if not vector(translation, 3) or not vector(scale, 3) or not vector(rotation, 4):
            fail('Некорректное преобразование части модели.')
        x, y, z, w = rotation
        if abs(x*x + y*y + z*z + w*w - 1) > .001:
            fail('Некорректный поворот части модели.')
        sx, sy, sz = scale
        return [(1 - 2*y*y - 2*z*z)*sx, (2*x*y + 2*z*w)*sx, (2*x*z - 2*y*w)*sx, 0,
                (2*x*y - 2*z*w)*sy, (1 - 2*x*x - 2*z*z)*sy, (2*y*z + 2*x*w)*sy, 0,
                (2*x*z + 2*y*w)*sz, (2*y*z - 2*x*w)*sz, (1 - 2*x*x - 2*y*y)*sz, 0,
                *translation, 1]
    nodes, scenes = document.get('nodes', []), document.get('scenes', [])
    if not isinstance(nodes, list) or len(nodes) > 8192 or not isinstance(scenes, list):
        fail()
    if scenes:
        selected = document.get('scene', 0)
        if not integer(selected, 0, len(scenes) - 1) or not isinstance(scenes[selected], dict):
            fail('Некорректная сцена модели.')
        roots = scenes[selected].get('nodes', [])
    else:
        children = {child for node in nodes for child in node.get('children', [])}
        roots = [index for index in range(len(nodes)) if index not in children]
    if not isinstance(roots, list):
        fail()
    corners, sources, count, seen, stack = [], [], 0, set(), [(node_id, identity) for node_id in roots]
    while stack:
        node_id, parent = stack.pop()
        if not integer(node_id, 0, len(nodes) - 1) or node_id in seen:
            fail('Некорректная иерархия модели.')
        seen.add(node_id)
        node = nodes[node_id]
        world = multiply(parent, matrix(node))
        if any(not math.isfinite(value) or abs(value) > 1e12 for value in world):
            fail('Преобразование модели выходит за допустимые границы.')
        if 'mesh' in node:
            mesh_id = node['mesh']
            if not integer(mesh_id, 0, len(document['meshes']) - 1):
                fail('Некорректная ссылка на часть модели.')
            for primitive_id in range(len(document['meshes'][mesh_id]['primitives'])):
                position = document['meshes'][mesh_id]['primitives'][primitive_id]['attributes']['POSITION']
                sources.append({'position': position, 'matrix': world})
                count += document['accessors'][position]['count']
                if count > MAX_VERTICES:
                    fail('У модели слишком много вершин для сохранения исходных координат.')
                low, high = primitive_bounds[(mesh_id, primitive_id)]
                for x in (low[0], high[0]):
                    for y in (low[1], high[1]):
                        for z in (low[2], high[2]):
                            point = [world[row]*x + world[4 + row]*y + world[8 + row]*z + world[12 + row] for row in range(3)]
                            if any(not math.isfinite(value) for value in point):
                                fail('Границы модели содержат недопустимые числа.')
                            corners.append(point)
                            if len(corners) > 8192:
                                fail('У модели слишком много отдельных частей для редактора.')
        children = node.get('children', [])
        if not isinstance(children, list):
            fail('Некорректная иерархия модели.')
        stack.extend((child, world) for child in children)
    if not corners:
        fail('В выбранной сцене модели нет геометрии.')
    return {'version': 1, 'corners': corners}, sources


def _rewrite_glb(raw, removal):
    """Append replacement indices; unchanged vertex and image bytes retain their frame."""
    document, binary = parse_glb(raw)
    meshes = document.get('meshes')
    if not isinstance(meshes, list) or not meshes or len(meshes) > 1024:
        fail()
    pending = {(entry['mesh'], entry['primitive']): set(entry['faces']) for entry in removal}
    total = removed = 0
    output = bytearray(binary)
    original_indices = {}
    primitive_bounds, kept_by_mesh = {}, {}
    for mesh_id, mesh in enumerate(meshes):
        if not isinstance(mesh, dict) or mesh.get('weights') or mesh.get('extensions'):
            fail()
        primitives = mesh.get('primitives')
        if not isinstance(primitives, list) or not primitives or len(primitives) > 1024:
            fail()
        kept = []
        for primitive_id, primitive in enumerate(primitives):
            if (not isinstance(primitive, dict) or primitive.get('mode', 4) != 4 or primitive.get('targets')
                    or primitive.get('extensions') or not isinstance(primitive.get('attributes'), dict)
                    or 'POSITION' not in primitive['attributes']):
                fail()
            position, start, stride, fmt = accessor_data(document, binary, primitive['attributes']['POSITION'], position=True)
            vertex_count = position['count']
            for name, index in primitive['attributes'].items():
                if name.startswith(('JOINTS_', 'WEIGHTS_')):
                    fail()
                attr, _, _, _ = accessor_data(document, binary, index)
                if attr['count'] != vertex_count:
                    fail('Число вершин в атрибутах GLB не совпадает.')
            low, high = [math.inf] * 3, [-math.inf] * 3
            for offset in range(start, start + vertex_count * stride, stride):
                point = struct.unpack_from(fmt, binary, offset)
                if not all(math.isfinite(value) for value in point):
                    fail('Координаты модели содержат недопустимые числа.')
                for axis in range(3):
                    low[axis], high[axis] = min(low[axis], point[axis]), max(high[axis], point[axis])
            primitive_bounds[(mesh_id, primitive_id)] = (low, high)
            if 'indices' in primitive:
                index_id = primitive['indices']
                if index_id not in original_indices:
                    acc, start, stride, fmt = accessor_data(document, binary, index_id, indices=True)
                    original_indices[index_id] = [struct.unpack_from(fmt, binary, start + i * stride)[0] for i in range(acc['count'])]
                values = original_indices[index_id]
            else:
                values = list(range(vertex_count))
            if len(values) % 3 or any(value >= vertex_count for value in values):
                fail('У модели некорректная сетка треугольников.')
            count = len(values) // 3
            total += count
            if total > MAX_FACES:
                fail('Редактор поддерживает модели до 1 миллиона треугольников.')
            faces = pending.pop((mesh_id, primitive_id), set())
            if faces and max(faces) >= count:
                fail('Выбранные треугольники уже изменились. Заново откройте редактор.')
            removed += len(faces)
            if len(faces) == count:
                continue
            if faces:
                indices = [value for i, value in enumerate(values) if i // 3 not in faces]
                output.extend(b'\0' * (-len(output) % 4))
                byte_offset = len(output)
                new_indices = struct.pack('<' + str(len(indices)) + 'I', *indices)
                output.extend(new_indices)
                view_id = len(document['bufferViews'])
                document['bufferViews'].append({'buffer': 0, 'byteOffset': byte_offset, 'byteLength': len(new_indices), 'target': 34963})
                accessor_id = len(document['accessors'])
                document['accessors'].append({'bufferView': view_id, 'componentType': 5125, 'count': len(indices),
                                              'type': 'SCALAR', 'min': [min(indices)], 'max': [max(indices)]})
                primitive['indices'] = accessor_id
            kept.append(primitive)
        kept_by_mesh[mesh_id] = kept
    if pending:
        fail('Выбранная часть модели уже изменилась. Заново откройте редактор.')
    if not removed:
        fail('Сначала выделите части, которые нужно удалить.')
    if removed >= total:
        fail('Нельзя удалить модель целиком. Оставьте хотя бы один треугольник.')
    bounds, sources = original_bounds(document, primitive_bounds)
    extras = document['asset'].setdefault('extras', {})
    if not isinstance(extras, dict):
        fail('Неподдерживаемые метаданные модели.')
    extras['studioBounds'] = bounds
    extras['studioFrameSources'] = sources
    for mesh_id, mesh in enumerate(meshes):
        mesh['primitives'] = kept_by_mesh[mesh_id]
    mapping = {old: new for new, old in enumerate(i for i, mesh in enumerate(meshes) if mesh['primitives'])}
    document['meshes'] = [mesh for mesh in meshes if mesh['primitives']]
    for node in document.get('nodes', []):
        if 'mesh' in node:
            old = node['mesh']
            if not integer(old, 0, len(meshes) - 1):
                fail('Некорректная ссылка на часть модели.')
            if old in mapping:
                node['mesh'] = mapping[old]
            else:
                del node['mesh']
    # Unreferenced meshes and meshes in another scene must not allow deleting
    # every visible surface of the model currently opened by the owner.
    nodes, scenes = document.get('nodes', []), document.get('scenes', [])
    if scenes:
        visible_nodes = list(scenes[document.get('scene', 0)].get('nodes', []))
    else:
        child_nodes = {child for node in nodes for child in node.get('children', [])}
        visible_nodes = [i for i in range(len(nodes)) if i not in child_nodes]
    seen, visible_geometry = set(), False
    while visible_nodes:
        index = visible_nodes.pop()
        if not integer(index, 0, len(nodes) - 1) or index in seen:
            fail('Некорректная иерархия модели.')
        seen.add(index)
        node = nodes[index]
        visible_geometry = visible_geometry or 'mesh' in node
        visible_nodes.extend(node.get('children', []))
    if not visible_geometry:
        fail('Нельзя удалить модель целиком. Оставьте хотя бы один треугольник в текущей сцене.')
    document['buffers'][0]['byteLength'] = len(output)
    encoded = json.dumps(document, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')
    encoded += b' ' * (-len(encoded) % 4)
    output.extend(b'\0' * (-len(output) % 4))
    size = 28 + len(encoded) + len(output)
    if size > MAX_GLB or len(encoded) > MAX_JSON:
        fail('После редактирования модель превышает допустимый размер 128 МБ.')
    result = (struct.pack('<4sII', b'glTF', 2, size) + struct.pack('<II', len(encoded), JSON_CHUNK) + encoded
              + struct.pack('<II', len(output), BIN_CHUNK) + output)
    return result, {'bytes': size, 'triangles': total - removed, 'meshes': len(document['meshes']), 'skins': 0, 'animations': []}, removed, total


def rewrite_glb(raw, removal):
    try:
        return _rewrite_glb(raw, removal)
    except (KeyError, TypeError, AttributeError, IndexError, struct.error, OverflowError):
        fail('Структура GLB повреждена или не поддерживается редактором.')


def edit_file(source, output, removal):
    if source.stat().st_size > MAX_GLB:
        fail('Размер исходной GLB должен быть не больше 128 МБ.')
    raw, stats, removed, total = rewrite_glb(source.read_bytes(), removal)
    with output.open('xb') as handle:
        handle.write(raw)
    return stats, removed, total


class MeshEdits:
    def __init__(self, studio, job_root):
        self.studio = studio
        self.job_root = job_root
        self.slots = asyncio.Semaphore(2)

    def current(self, request, job, revision=None):
        if self.studio.owned(request) is not job:
            raise web.HTTPNotFound(text='Модель удалена или недоступна.')
        if (job.get('status') != 'complete' or job.get('rig', {}).get('status') in ('queued', 'running')
                or any(m.get('status') in ('queued', 'running') for m in job.get('motions', []))
                or getattr(self.studio, 'worker_job', None) == job['id']
                or getattr(self.studio, 'rig_worker_job', None) == job['id']
                or (getattr(self.studio, 'operation', None) or {}).get('id') == job['id']):
            raise web.HTTPConflict(text='Дождитесь завершения генерации модели, скелета или анимации.')
        if revision is not None and payload(job)['revision'] != revision:
            raise web.HTTPConflict(text='Модель уже изменилась в другой вкладке. Заново откройте редактор.')
        folder = self.job_root / job['id']
        source = folder / active_path(job)
        if (folder.resolve().parent != self.job_root.resolve() or folder.is_symlink()
                or not source.resolve().is_relative_to(folder.resolve()) or not source.is_file()):
            raise web.HTTPConflict(text='Исходный файл модели недоступен.')
        return source

    async def body(self, request, *, restore=False):
        if request.content_type != 'application/json':
            raise web.HTTPBadRequest(text='Ожидается JSON со списком удаляемых частей.')
        raw = bytearray()
        async for chunk in request.content.iter_chunked(65536):
            raw.extend(chunk)
            if len(raw) > MAX_BODY:
                raise web.HTTPRequestEntityTooLarge(max_size=MAX_BODY, actual_size=len(raw))
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise web.HTTPBadRequest(text='Некорректный JSON редактирования модели.')
        fields = {'expectedRevision'} if restore else {'expectedRevision', 'remove'}
        if not isinstance(data, dict) or set(data) != fields or not integer(data.get('expectedRevision'), 0, MAX_REVISION - 1):
            raise web.HTTPBadRequest(text='Нужны expectedRevision и список удаляемых треугольников.')
        if not restore:
            removal = data['remove']
            if not isinstance(removal, list) or not 1 <= len(removal) <= 1024:
                raise web.HTTPBadRequest(text='Выберите части модели для удаления.')
            seen, count = set(), 0
            for entry in removal:
                if (not isinstance(entry, dict) or set(entry) != {'mesh', 'primitive', 'faces'}
                        or not integer(entry['mesh'], 0, 1023) or not integer(entry['primitive'], 0, 1023)
                        or not isinstance(entry['faces'], list) or not entry['faces']
                        or any(not integer(face, 0, MAX_FACES - 1) for face in entry['faces'])):
                    raise web.HTTPBadRequest(text='Некорректный список треугольников.')
                count += len(entry['faces'])
                key = (entry['mesh'], entry['primitive'])
                if count > MAX_REMOVALS:
                    raise web.HTTPBadRequest(text='За один раз можно удалить не более 500 тысяч треугольников.')
                if key in seen or len(set(entry['faces'])) != len(entry['faces']):
                    raise web.HTTPBadRequest(text='Части и треугольники не должны повторяться.')
                seen.add(key)
        return data

    def invalidate_preview(self, candidate):
        candidate.pop('_previewRevision', None)
        candidate['_previewInvalidated'] = True

    async def edit(self, request):
        job = self.studio.owned(request)
        self.current(request, job)
        data = await self.body(request)
        revision = data['expectedRevision']
        self.current(request, job, revision)
        folder = self.job_root / job['id']
        versions = folder / 'meshes'
        relative = f'meshes/{uuid.uuid4()}/model.glb'
        directory, destination = (folder / relative).parent, folder / relative
        try:
            async with self.slots:
                source = self.current(request, job, revision)
                if versions.is_symlink() or versions.resolve().parent != folder.resolve():
                    raise web.HTTPConflict(text='Не удалось безопасно сохранить модель.')
                versions.mkdir(exist_ok=True)
                directory.mkdir(exist_ok=False)
                # Finish a cancelled worker before cleanup so it cannot leave
                # an unreferenced GLB after the coroutine has exited.
                worker = asyncio.create_task(asyncio.to_thread(edit_file, source, destination, data['remove']))
                try:
                    stats, removed, total = await asyncio.shield(worker)
                except asyncio.CancelledError:
                    with contextlib.suppress(Exception):
                        await worker
                    raise
            self.current(request, job, revision)
            original = job.get('_meshOriginal')
            if original is None:
                original = {key: copy.deepcopy(job[key]) for key in ('stats', 'rig', 'rigStats', 'motions') if key in job}
                original['riggedUrl'] = job.get('artifacts', {}).get('riggedUrl')
            old = payload(job)
            artifacts = {**job.get('artifacts', {}), 'modelUrl': self.studio.file_url(job, relative)}
            artifacts.pop('riggedUrl', None)
            candidate = {**job, '_meshOriginal': original, '_meshPath': relative,
                         '_meshVersions': [*job.get('_meshVersions', []), relative],
                         'meshEdit': {'revision': revision + 1, 'edited': True,
                                      'removedTriangles': old['removedTriangles'] + removed,
                                      'originalTriangles': old['originalTriangles'] or total},
                         'artifacts': artifacts, 'stats': stats,
                         'rig': {'available': False, 'status': 'not_requested'}, 'motions': []}
            candidate.pop('rigStats', None)
            self.invalidate_preview(candidate)
            self.studio.save(candidate)
            job.update(candidate)
            for key in ('rigStats', '_previewRevision'):
                if key not in candidate:
                    job.pop(key, None)
        except BaseException as error:
            with contextlib.suppress(OSError):
                destination.unlink()
            with contextlib.suppress(OSError):
                directory.rmdir()
            if isinstance(error, ValueError):
                raise web.HTTPBadRequest(text=str(error))
            raise
        return web.json_response({'job': self.studio.public(job)})

    async def restore(self, request):
        job = self.studio.owned(request)
        self.current(request, job)
        data = await self.body(request, restore=True)
        revision = data['expectedRevision']
        self.current(request, job, revision)
        if active_path(job) == 'model.glb':
            return web.json_response({'job': self.studio.public(job)})
        original = job.get('_meshOriginal')
        if not isinstance(original, dict) or not (self.job_root / job['id'] / 'model.glb').is_file():
            raise web.HTTPConflict(text='Исходная версия модели недоступна.')
        artifacts = {**job.get('artifacts', {}), 'modelUrl': self.studio.file_url(job, 'model.glb')}
        artifacts.pop('riggedUrl', None)
        if original.get('riggedUrl'):
            artifacts['riggedUrl'] = original['riggedUrl']
        candidate = {**job, 'artifacts': artifacts,
                     'meshEdit': {'revision': revision + 1, 'edited': False, 'removedTriangles': 0,
                                  'originalTriangles': payload(job)['originalTriangles']}}
        for key in ('stats', 'rig', 'rigStats', 'motions'):
            candidate.pop(key, None)
            if key in original:
                candidate[key] = copy.deepcopy(original[key])
        candidate.pop('_meshPath', None)
        candidate.pop('_meshOriginal', None)
        self.invalidate_preview(candidate)
        self.studio.save(candidate)
        job.update(candidate)
        for key in ('rigStats', '_meshPath', '_meshOriginal', '_previewRevision'):
            if key not in candidate:
                job.pop(key, None)
        return web.json_response({'job': self.studio.public(job)})
