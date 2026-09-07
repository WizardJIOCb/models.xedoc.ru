"""Serve animation tracks without re-sending a GLB's meshes and textures."""
import copy
import json
import os
import struct
import uuid

from aiohttp import web


def extract_animation(raw):
    if len(raw) < 20 or struct.unpack_from('<4sII', raw) != (b'glTF', 2, len(raw)):
        raise ValueError('Invalid GLB')
    size, kind = struct.unpack_from('<II', raw, 12)
    if kind != 0x4E4F534A or size + 20 > len(raw):
        raise ValueError('Invalid GLB JSON')
    source = json.loads(raw[20:20 + size])
    offset = 20 + size
    binary = b''
    if offset < len(raw):
        count, kind = struct.unpack_from('<II', raw, offset)
        if kind != 0x004E4942 or offset + 8 + count > len(raw):
            raise ValueError('Invalid GLB buffer')
        binary = raw[offset + 8:offset + 8 + count]
    animations = source.get('animations', [])
    chosen = next((a for a in animations if any(word in a.get('name', '').lower() for word in ('motion', 'generated', 'smpl'))), None)
    chosen = chosen or next((a for a in animations if a.get('name') == 'Walk'), None)
    chosen = chosen or (animations[0] if animations else None)
    if not chosen or not chosen.get('channels'):
        raise ValueError('No skeletal animation tracks')
    animation = copy.deepcopy(chosen)
    document = {'asset': {'version': '2.0', 'generator': 'Models Studio animation-only v1'},
                'scene': source.get('scene', 0), 'scenes': copy.deepcopy(source.get('scenes', [])),
                'nodes': [], 'animations': [animation], 'accessors': [], 'bufferViews': []}
    # Keep node order/names/hierarchy so GLTFLoader gives tracks the same bindings
    # as the original rig. Do not retain material/image extras or mesh references.
    for node in source.get('nodes', []):
        document['nodes'].append({key: copy.deepcopy(node[key]) for key in
            ('name', 'children', 'matrix', 'translation', 'rotation', 'scale') if key in node})
    for channel in animation['channels']:
        target = channel['target']
        if target.get('path') not in ('translation', 'rotation', 'scale') or not 0 <= target.get('node', -1) < len(document['nodes']):
            raise ValueError('Unsupported animation target')
    chunks = bytearray()
    views, accessors = {}, {}

    def view(index):
        if index not in views:
            item = copy.deepcopy(source['bufferViews'][index])
            start, length = item.get('byteOffset', 0), item['byteLength']
            if item.get('buffer', 0) != 0 or start < 0 or length < 0 or start + length > len(binary):
                raise ValueError('Animation buffer is not embedded')
            chunks.extend(b'\0' * (-len(chunks) % 4))
            item.update(buffer=0, byteOffset=len(chunks))
            item.pop('target', None)
            chunks.extend(binary[start:start + length])
            views[index] = len(document['bufferViews'])
            document['bufferViews'].append(item)
        return views[index]

    def accessor(index):
        if index not in accessors:
            item = copy.deepcopy(source['accessors'][index])
            if 'bufferView' in item:
                item['bufferView'] = view(item['bufferView'])
            if 'sparse' in item:
                for key in ('indices', 'values'):
                    item['sparse'][key]['bufferView'] = view(item['sparse'][key]['bufferView'])
            accessors[index] = len(document['accessors'])
            document['accessors'].append(item)
        return accessors[index]

    for sampler in animation['samplers']:
        sampler['input'] = accessor(sampler['input'])
        sampler['output'] = accessor(sampler['output'])
    chunks.extend(b'\0' * (-len(chunks) % 4))
    document['buffers'] = [{'byteLength': len(chunks)}]
    text = json.dumps(document, separators=(',', ':')).encode('utf-8')
    text += b' ' * (-len(text) % 4)
    return (struct.pack('<4sIIII', b'glTF', 2, 28 + len(text) + len(chunks), len(text), 0x4E4F534A)
            + text + struct.pack('<II', len(chunks), 0x004E4942) + chunks)


def artifact_response(request, source, *, policy='private, no-cache'):
    """Call only AFTER the same access checks as the original artifact."""
    path = source
    if request.query.get('clip') == '1' and source.name == 'animated.glb':
        stat = source.stat()
        # Source paths are immutable; signature also handles legacy replacements.
        path = source.with_name(f'clip-v1-{stat.st_mtime_ns:x}-{stat.st_size:x}.glb')
        if not path.is_file():
            temporary = path.with_name(f'pending-clip-{uuid.uuid4()}.glb')
            try:
                temporary.write_bytes(extract_animation(source.read_bytes()))
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
    return web.FileResponse(path, headers={'Cache-Control': policy, 'X-Content-Type-Options': 'nosniff'})
