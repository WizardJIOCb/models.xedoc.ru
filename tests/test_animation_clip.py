import json
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'studio'))
from animation_clip import extract_animation


def pack(document, binary):
    text = json.dumps(document).encode()
    text += b' ' * (-len(text) % 4)
    return struct.pack('<4sIIII', b'glTF', 2, 28 + len(text) + len(binary), len(text), 0x4e4f534a) + text + struct.pack('<II', len(binary), 0x004e4942) + binary


def unpack(raw):
    size = struct.unpack_from('<I', raw, 12)[0]
    return json.loads(raw[20:20 + size]), raw[28 + size:]


def animated_fixture():
    data = b'x' * 4096 + struct.pack('<8f', 0, 1, 0, 0, 0, 0.2, 1, 0.3)
    doc = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': [0]}],
           'nodes': [{'name': 'Rig', 'children': [1, 2]}, {'name': 'Hips'}, {'name': 'Body', 'mesh': 0, 'skin': 0}],
           'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}], 'images': [{'bufferView': 0}],
           'textures': [{'source': 0}], 'materials': [{}], 'skins': [{'joints': [1]}],
           'buffers': [{'byteLength': len(data)}],
           'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': 4096}, {'buffer': 0, 'byteOffset': 4096, 'byteLength': 8}, {'buffer': 0, 'byteOffset': 4104, 'byteLength': 24}],
           'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 3, 'type': 'VEC3'},
                         {'bufferView': 1, 'componentType': 5126, 'count': 2, 'type': 'SCALAR'},
                         {'bufferView': 2, 'componentType': 5126, 'count': 2, 'type': 'VEC3'}],
           'animations': [{'name': 'Idle'}, {'name': 'Library Motion', 'samplers': [{'input': 1, 'output': 2, 'interpolation': 'LINEAR'}],
                'channels': [{'sampler': 0, 'target': {'node': 1, 'path': 'translation'}}]}]}
    return pack(doc, data)


class AnimationClipTests(unittest.TestCase):
    def test_tracks_are_exact_but_geometry_and_textures_are_absent(self):
        raw = animated_fixture()
        compact = extract_animation(raw)
        doc, data = unpack(compact)
        self.assertLess(len(compact), len(raw) / 3)
        self.assertFalse(set(doc) & {'meshes', 'images', 'textures', 'materials', 'skins'})
        self.assertEqual(doc['nodes'][2], {'name': 'Body'})
        self.assertEqual(doc['animations'][0]['channels'][0]['target']['node'], 1)
        self.assertEqual(doc['animations'][0]['name'], 'Library Motion')
        self.assertEqual(data, unpack(raw)[1][4096:])
        self.assertEqual(doc['accessors'][0]['bufferView'], 0)
        self.assertEqual(doc['accessors'][1]['bufferView'], 1)
        self.assertEqual(doc['animations'][0]['samplers'][0]['output'], 1)

    def test_invalid_buffer_and_morph_target_are_rejected(self):
        doc, data = unpack(animated_fixture())
        doc['bufferViews'][1]['byteLength'] = len(data) * 2
        with self.assertRaises(ValueError):
            extract_animation(pack(doc, data))
        doc, data = unpack(animated_fixture())
        doc['animations'][1]['channels'][0]['target']['path'] = 'weights'
        with self.assertRaises(ValueError):
            extract_animation(pack(doc, data))

