"""Geometry preservation and owner/revision boundaries; fake inference only."""
import asyncio
import base64
import copy
import io
import json
import struct
import threading
import unittest
from unittest.mock import patch

from aiohttp import web
from PIL import Image

import test_studio
import mesh_edits


server = test_studio.server
PREFIX = '/api/model-studio'


def pack_glb(document, binary):
    document = copy.deepcopy(document)
    document['buffers'] = [{'byteLength': len(binary)}]
    encoded = json.dumps(document).encode()
    encoded += b' ' * (-len(encoded) % 4)
    binary += b'\0' * (-len(binary) % 4)
    return (struct.pack('<4sII', b'glTF', 2, 28 + len(encoded) + len(binary))
            + struct.pack('<II', len(encoded), mesh_edits.JSON_CHUNK) + encoded
            + struct.pack('<II', len(binary), mesh_edits.BIN_CHUNK) + binary)


def fixture(indexed=True, multiple=False):
    positions = [(0., 0., 0.), (1., 0., 0.), (1., 1., 0.), (0., 1., 0.),
                 (2., 0., 0.), (3., 0., 0.), (3., 1., 0.), (2., 1., 0.)]
    triangles = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]
    if not indexed:
        positions = [positions[index] for index in triangles]
    binary = bytearray()
    views, accessors = [], []
    def add(blob, kind, count, component):
        binary.extend(b'\0' * (-len(binary) % 4))
        view = len(views)
        views.append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(blob)})
        binary.extend(blob)
        accessors.append({'bufferView': view, 'type': kind, 'count': count, 'componentType': component})
        return len(accessors) - 1
    position = add(struct.pack('<' + 'f' * len(positions) * 3, *[v for point in positions for v in point]), 'VEC3', len(positions), 5126)
    uv = add(struct.pack('<' + 'f' * len(positions) * 2, *[v for point in positions for v in point[:2]]), 'VEC2', len(positions), 5126)
    normal = add(struct.pack('<' + 'f' * len(positions) * 3, *[v for point in positions for v in (0., 0., 1.)]), 'VEC3', len(positions), 5126)
    primitive = {'attributes': {'POSITION': position, 'TEXCOORD_0': uv, 'NORMAL': normal}, 'material': 0}
    if indexed:
        primitive['indices'] = add(struct.pack('<12H', *triangles), 'SCALAR', len(triangles), 5123)
    binary.extend(b'\0' * (-len(binary) % 4))
    views.append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': 12})
    binary.extend(b'fakePNGbytes')
    document = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': [0]}],
                'nodes': [{'mesh': 0, 'translation': [.5, 0, -.2]}],
                'meshes': [{'name': 'Character', 'primitives': [primitive]}],
                'bufferViews': views, 'accessors': accessors,
                'images': [{'bufferView': len(views) - 1, 'mimeType': 'image/png'}],
                'textures': [{'source': 0}],
                'materials': [{'doubleSided': True, 'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}}}]}
    if multiple:
        document['meshes'].append(copy.deepcopy(document['meshes'][0]))
        document['nodes'].append({'mesh': 1})
        document['scenes'][0]['nodes'].append(1)
    return pack_glb(document, bytes(binary))


def selection(faces=None, mesh=0, primitive=0):
    return [{'mesh': mesh, 'primitive': primitive, 'faces': faces if faces is not None else [2, 3]}]


class GeometryTests(unittest.TestCase):
    def test_materials_images_vertices_transforms_and_original_bytes_are_preserved(self):
        original = fixture()
        doc, binary = mesh_edits.parse_glb(original)
        result, stats, removed, total = mesh_edits.rewrite_glb(original, selection())
        changed, new_binary = mesh_edits.parse_glb(result)
        for key in ('images', 'materials', 'textures', 'nodes', 'scenes'):
            self.assertEqual(changed[key], doc[key])
        self.assertEqual(changed['accessors'][:len(doc['accessors'])], doc['accessors'])
        self.assertEqual(new_binary[:len(binary)], binary)
        self.assertEqual(stats['triangles'], 2)
        self.assertEqual((removed, total), (2, 4))
        primitive = changed['meshes'][0]['primitives'][0]
        accessor, start, stride, fmt = mesh_edits.accessor_data(changed, new_binary, primitive['indices'], indices=True)
        self.assertEqual([struct.unpack_from(fmt, new_binary, start + i * stride)[0] for i in range(accessor['count'])], [0, 1, 2, 0, 2, 3])

    def test_nonindexed_triangles_become_indexed_without_vertex_reordering(self):
        raw = fixture(indexed=False)
        result, stats, _, _ = mesh_edits.rewrite_glb(raw, selection([1]))
        doc, binary = mesh_edits.parse_glb(result)
        self.assertEqual(stats['triangles'], 3)
        self.assertEqual(doc['accessors'][0]['count'], 12)
        acc, start, stride, fmt = mesh_edits.accessor_data(doc, binary, doc['meshes'][0]['primitives'][0]['indices'], indices=True)
        values = [struct.unpack_from(fmt, binary, start + i * stride)[0] for i in range(acc['count'])]
        self.assertEqual(values, [0, 1, 2, 6, 7, 8, 9, 10, 11])

    def test_empty_mesh_is_removed_and_node_mesh_references_are_remapped(self):
        raw = fixture(multiple=True)
        result, stats, _, _ = mesh_edits.rewrite_glb(raw, selection([0, 1, 2, 3]))
        doc, _ = mesh_edits.parse_glb(result)
        self.assertEqual(stats['meshes'], 1)
        self.assertNotIn('mesh', doc['nodes'][0])
        self.assertEqual(doc['nodes'][1]['mesh'], 0)
        self.assertEqual(doc['nodes'][0]['translation'], [.5, 0, -.2])
        corners = doc['asset']['extras']['studioBounds']['corners']
        self.assertEqual(len(corners), 16)
        self.assertEqual([min(point[axis] for point in corners) for axis in range(3)], [0., 0., -.2])
        self.assertEqual([max(point[axis] for point in corners) for axis in range(3)], [3.5, 1., 0.])
        again, _, _, _ = mesh_edits.rewrite_glb(result, selection([1]))
        second, _ = mesh_edits.parse_glb(again)
        self.assertEqual(second['asset']['extras']['studioBounds'], doc['asset']['extras']['studioBounds'])
        self.assertEqual(second['asset']['extras']['studioFrameSources'], doc['asset']['extras']['studioFrameSources'])
        self.assertEqual(doc['asset']['extras']['studioFrameSources'][0]['position'], 0)
        self.assertIn([.5, 0, -.2], [source['matrix'][12:15] for source in doc['asset']['extras']['studioFrameSources']])
        self.assertEqual(len(doc['asset']['extras']['studioFrameSources']), 2)

    def test_bounds_apply_nested_node_rotation_scale_and_only_active_scene(self):
        doc, binary = mesh_edits.parse_glb(fixture(multiple=True))
        doc['nodes'] = [{'children': [1], 'translation': [10, 20, 30]},
                        {'mesh': 0, 'rotation': [0, 0, 2**-.5, 2**-.5], 'scale': [2, 3, 1]},
                        {'mesh': 1, 'translation': [999, 999, 999]}]
        doc['scenes'] = [{'nodes': [0]}, {'nodes': [2]}]
        result, _, _, _ = mesh_edits.rewrite_glb(pack_glb(doc, binary), selection([1]))
        changed, _ = mesh_edits.parse_glb(result)
        corners = changed['asset']['extras']['studioBounds']['corners']
        self.assertEqual(len(corners), 8)
        self.assertEqual([round(min(p[a] for p in corners), 6) for a in range(3)], [7., 20., 30.])
        self.assertEqual([round(max(p[a] for p in corners), 6) for a in range(3)], [10., 26., 30.])

    def test_rejects_full_deletion_out_of_range_and_nonexistent_primitives(self):
        for removal in (selection([0, 1, 2, 3]), selection([4]), selection(mesh=2), selection(primitive=1)):
            with self.subTest(removal=removal), self.assertRaises(ValueError):
                mesh_edits.rewrite_glb(fixture(), removal)

    def test_hidden_other_scene_geometry_does_not_allow_deleting_whole_visible_model(self):
        document, binary = mesh_edits.parse_glb(fixture(multiple=True))
        document['scenes'] = [{'nodes': [0]}, {'nodes': [1]}]
        with self.assertRaisesRegex(ValueError, 'целиком'):
            mesh_edits.rewrite_glb(pack_glb(document, binary), selection([0, 1, 2, 3]))

    def test_rejects_skin_sparse_morph_compression_bad_accessor_and_external_resources(self):
        base, binary = mesh_edits.parse_glb(fixture())
        changes = [lambda d: d.update(skins=[{'joints': [0]}]), lambda d: d.update(animations=[{}]),
                   lambda d: d['meshes'][0]['primitives'][0].update(mode=5),
                   lambda d: d['meshes'][0]['primitives'][0].update(targets=[{'POSITION': 0}]),
                   lambda d: d['meshes'][0]['primitives'][0].update(extensions={'KHR_draco_mesh_compression': {}}),
                   lambda d: d['accessors'][0].update(sparse={}),
                   lambda d: d['accessors'][0].update(count=1_000_000),
                   lambda d: d['accessors'][3].update(componentType=5126),
                   lambda d: d['images'][0].update(uri='https://example.com/private.png'),
                   lambda d: d['bufferViews'][0].update(byteOffset=999999),
                   lambda d: d.update(asset=[])]
        for change in changes:
            doc = copy.deepcopy(base)
            change(doc)
            with self.subTest(document=doc), self.assertRaises(ValueError):
                mesh_edits.rewrite_glb(pack_glb(doc, binary), selection())
        with self.assertRaises(ValueError):
            mesh_edits.rewrite_glb(fixture()[:-1], selection())


class MeshHTTPTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = test_studio.StudioHTTPTests.asyncTearDown
    upload = test_studio.StudioHTTPTests.upload

    async def asyncSetUp(self):
        original_create = server.create_app
        def create_app():
            app = original_create()
            if not any(route.resource.canonical.endswith('/mesh-edit') for route in app.router.routes()):
                edits = mesh_edits.MeshEdits(app['studio'], server.JOB_ROOT)
                app['studio'].mesh_edits = edits
                app.add_routes([web.post(PREFIX + '/jobs/{job_id}/mesh-edit', edits.edit),
                                web.post(PREFIX + '/jobs/{job_id}/mesh-restore', edits.restore)])
            return app
        with patch.object(server, 'create_app', create_app):
            await test_studio.StudioHTTPTests.asyncSetUp(self)

    async def create(self):
        job = await test_studio.StudioHTTPTests.create(self)
        current = self.studio.jobs[job['id']]
        path = server.JOB_ROOT / job['id'] / 'model.glb'
        path.write_bytes(fixture())
        current['stats'] = server.glb_summary(path)
        self.studio.save(current)
        return current

    async def edit(self, job, revision=0, remove=None, status=200, client=None, restore=False, body=None):
        path = f"{PREFIX}/jobs/{job['id']}/" + ('mesh-restore' if restore else 'mesh-edit')
        data = {'expectedRevision': revision}
        if not restore:
            data['remove'] = selection() if remove is None else remove
        response = await (client or self.client).post(path if client is None else self.client.make_url(path), json=data if body is None else body)
        self.assertEqual(response.status, status, await response.text())
        return await response.json()

    async def test_edit_original_immutable_revision_counts_and_restore_preserves_current_scene(self):
        job = await self.create()
        original_path = server.JOB_ROOT / job['id'] / 'model.glb'
        original_bytes = original_path.read_bytes()
        original_stats = copy.deepcopy(job['stats'])
        job.update(rig={'available': True, 'status': 'complete', 'revision': 'original-rig', '_path': 'rig/rigged.glb'},
                   motions=[{'id': 'original-motion', 'status': 'complete'}], rigStats={'triangles': 4},
                   placement={'x': .2, 'y': -.1, 'z': 0}, modelRotation={'x': -11, 'y': 0, 'z': 0},
                   environment={'background': 'sunset'}, _manualRigDraft={'keep': 'points'}, _previewRevision='old-preview')
        job['artifacts']['riggedUrl'] = self.studio.file_url(job, 'rig/rigged.glb')
        self.studio.save(job)
        result = (await self.edit(job))['job']
        self.assertEqual(result['meshEdit'], {'revision': 1, 'edited': True, 'removedTriangles': 2, 'originalTriangles': 4})
        self.assertEqual(result['stats']['triangles'], 2)
        self.assertFalse(result['rig']['available'])
        self.assertEqual(result['motions'], [])
        self.assertNotIn('riggedUrl', result['artifacts'])
        self.assertNotIn('rigStats', job)
        self.assertNotIn('_previewRevision', job)
        self.assertTrue(job['_previewInvalidated'])
        self.assertEqual(job['_manualRigDraft'], {'keep': 'points'})
        self.assertEqual(original_path.read_bytes(), original_bytes)
        self.assertTrue((server.JOB_ROOT / job['id'] / mesh_edits.active_path(job)).is_file())
        first_path = mesh_edits.active_path(job)
        result = (await self.edit(job, revision=1, remove=selection([0])))['job']
        self.assertEqual(result['meshEdit']['removedTriangles'], 3)
        self.assertNotEqual(mesh_edits.active_path(job), first_path)
        job['placement']['y'] = -.25
        job['environment']['background'] = 'night'
        self.studio.save(job)
        restored = (await self.edit(job, revision=2, restore=True))['job']
        self.assertEqual(restored['meshEdit'], {'revision': 3, 'edited': False, 'removedTriangles': 0, 'originalTriangles': 4})
        self.assertEqual(restored['stats'], original_stats)
        self.assertEqual(restored['rig']['revision'], 'original-rig')
        self.assertEqual(restored['motions'][0]['id'], 'original-motion')
        self.assertEqual(restored['placement']['y'], -.25)
        self.assertEqual(restored['environment']['background'], 'night')
        self.assertEqual(mesh_edits.active_path(job), 'model.glb')
        self.assertNotIn('_meshOriginal', job)
        self.assertEqual(original_path.read_bytes(), original_bytes)
        disk = json.loads((original_path.parent / 'job.json').read_text(encoding='utf-8'))
        self.assertEqual(disk['meshEdit'], restored['meshEdit'])

    async def test_owner_origin_busy_and_revision_boundaries(self):
        job = await self.create()
        await self.edit(job, client=self.outsider, status=404)
        response = await self.client.post(f"{PREFIX}/jobs/{job['id']}/mesh-edit", json={'expectedRevision': 0, 'remove': selection()}, headers={'Origin': 'https://evil.example'})
        self.assertEqual(response.status, 403)
        for target in ('status', 'rig', 'motion', 'worker_job', 'rig_worker_job'):
            before = copy.deepcopy(job)
            if target == 'status': job['status'] = 'running'
            elif target == 'rig': job['rig']['status'] = 'queued'
            elif target == 'motion': job['motions'] = [{'status': 'running'}]
            else: setattr(self.studio, target, job['id'])
            await self.edit(job, status=409)
            job.clear(); job.update(before)
            if target in ('worker_job', 'rig_worker_job'): setattr(self.studio, target, None)
        await self.edit(job)
        before = copy.deepcopy(job)
        await self.edit(job, status=409)
        await self.edit(job, restore=True, status=409)
        self.assertEqual(job, before)

    async def test_invalid_selections_leave_job_and_disk_unchanged(self):
        job = await self.create()
        before = copy.deepcopy(job)
        invalid = [{}, {'expectedRevision': True, 'remove': selection()}, {'expectedRevision': -1, 'remove': selection()},
                   {'expectedRevision': 0, 'remove': []}, {'expectedRevision': 0, 'remove': selection([True])},
                   {'expectedRevision': 0, 'remove': selection([2, 2])}, {'expectedRevision': 0, 'remove': selection([-1])},
                   {'expectedRevision': 0, 'remove': selection([0, 1, 2, 3])},
                   {'expectedRevision': 0, 'remove': selection(mesh=1)},
                   {'expectedRevision': 0, 'remove': selection() + selection()},
                   {'expectedRevision': 0, 'remove': selection(), 'path': '../model.glb'}]
        for data in invalid:
            await self.edit(job, body=data, status=400)
        self.assertEqual(job, before)
        self.assertFalse(list((server.JOB_ROOT / job['id']).glob('meshes/*/model.glb')))

    async def test_failed_save_rolls_back_generated_mesh_and_all_metadata(self):
        job = await self.create()
        before = copy.deepcopy(job)
        with patch.object(self.studio, 'save', side_effect=OSError('simulated disk failure')):
            await self.edit(job, status=503)
        self.assertEqual(job, before)
        self.assertFalse(list((server.JOB_ROOT / job['id']).glob('meshes/*/model.glb')))
        await self.edit(job)
        before = copy.deepcopy(job)
        with patch.object(self.studio, 'save', side_effect=OSError('simulated restore failure')):
            await self.edit(job, revision=1, restore=True, status=503)
        self.assertEqual(job, before)

    async def test_concurrent_edits_only_one_revision_commits(self):
        job = await self.create()
        barrier = threading.Barrier(2)
        original = mesh_edits.edit_file
        def delayed(*args):
            barrier.wait(timeout=10)
            return original(*args)
        path = f"{PREFIX}/jobs/{job['id']}/mesh-edit"
        with patch.object(mesh_edits, 'edit_file', delayed):
            results = await asyncio.gather(*[self.client.post(path, json={'expectedRevision': 0, 'remove': selection()}) for _ in range(2)])
        self.assertEqual(sorted(result.status for result in results), [200, 409])
        for result in results: await result.read()
        self.assertEqual(job['meshEdit']['revision'], 1)
        self.assertEqual(len(list((server.JOB_ROOT / job['id']).glob('meshes/*/model.glb'))), 1)

    async def test_delete_during_offloop_edit_cannot_resurrect_job(self):
        job = await self.create()
        entered, proceed = threading.Event(), threading.Event()
        original = mesh_edits.edit_file
        def delayed(*args):
            result = original(*args)
            entered.set()
            proceed.wait(timeout=10)
            return result
        with patch.object(mesh_edits, 'edit_file', delayed):
            task = asyncio.create_task(self.edit(job, status=404))
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 5)
            response = await self.client.delete(f"{PREFIX}/jobs/{job['id']}")
            self.assertEqual(response.status, 200, await response.text())
            proceed.set()
            await task
        self.assertNotIn(job['id'], self.studio.jobs)
        self.assertFalse((server.JOB_ROOT / job['id']).exists())

    async def test_scene_change_during_offloop_edit_is_preserved(self):
        job = await self.create()
        entered, proceed = threading.Event(), threading.Event()
        original = mesh_edits.edit_file
        def delayed(*args):
            result = original(*args)
            entered.set()
            proceed.wait(timeout=10)
            return result
        with patch.object(mesh_edits, 'edit_file', delayed):
            task = asyncio.create_task(self.edit(job))
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 5)
            job.update(placement={'x': 1, 'y': -.33, 'z': .2}, environment={'background': 'night'})
            self.studio.save(job)
            proceed.set()
            await task
        self.assertEqual(job['placement']['y'], -.33)
        self.assertEqual(job['environment']['background'], 'night')

    async def test_owner_or_busy_change_during_rewrite_prevents_commit(self):
        for change in ('owner', 'busy'):
            job = await self.create()
            entered, proceed = threading.Event(), threading.Event()
            original = mesh_edits.edit_file
            def delayed(*args):
                result = original(*args)
                entered.set()
                proceed.wait(timeout=10)
                return result
            with patch.object(mesh_edits, 'edit_file', delayed):
                task = asyncio.create_task(self.edit(job, status=404 if change == 'owner' else 409))
                await asyncio.wait_for(asyncio.to_thread(entered.wait), 5)
                if change == 'owner':
                    job['_owner'] = 'b' * 48
                else:
                    job['rig']['status'] = 'queued'
                self.studio.save(job)
                proceed.set()
                await task
            self.assertNotIn('_meshPath', job)
            self.assertFalse(list((server.JOB_ROOT / job['id']).glob('meshes/*/model.glb')))

    async def test_request_body_is_bounded_and_json_only(self):
        job = await self.create()
        path = f"{PREFIX}/jobs/{job['id']}/mesh-edit"
        response = await self.client.post(path, data='{"expectedRevision":0}')
        self.assertEqual(response.status, 400)
        with patch.object(mesh_edits, 'MAX_BODY', 64):
            response = await self.client.post(path, data=' ' * 65, headers={'Content-Type': 'application/json'})
            self.assertEqual(response.status, 413)
        self.assertNotIn('_meshPath', job)

    async def test_owner_share_public_serve_active_mesh_and_hide_original_or_previous_versions(self):
        job = await self.create()
        response = await self.client.post(f"{PREFIX}/jobs/{job['id']}/share")
        self.assertEqual(response.status, 200, await response.text())
        token = (await response.json())['token']
        prefixes = (f'{PREFIX}/shares/{token}', f"{PREFIX}/models/{job['id']}")
        await self.edit(job)
        first = mesh_edits.active_path(job)
        await self.edit(job, revision=1, remove=selection([0]))
        active = mesh_edits.active_path(job)
        for prefix in prefixes:
            response = await self.outsider.get(self.client.make_url(prefix))
            self.assertEqual(response.status, 200, await response.text())
            public = (await response.json())['job']
            self.assertEqual(public['artifacts']['modelUrl'], prefix + '/files/' + active)
            self.assertEqual(public['meshEdit']['revision'], 2)
            response = await self.outsider.get(self.client.make_url(public['artifacts']['modelUrl']))
            self.assertEqual(response.status, 200, await response.text() if response.status != 200 else '')
            self.assertEqual(server.glb_summary(server.JOB_ROOT / job['id'] / active)['triangles'], 1)
            await response.read()
            for path in ('model.glb', first, 'input.png', 'job.json'):
                response = await self.outsider.get(self.client.make_url(prefix + '/files/' + path))
                self.assertEqual(response.status, 404, path)
                await response.read()
        for path in ('model.glb', first, active):
            response = await self.client.get(self.studio.file_url(job, path))
            self.assertEqual(response.status, 200, path)
            await response.read()
        await self.edit(job, revision=2, restore=True)
        for prefix in prefixes:
            response = await self.outsider.get(self.client.make_url(prefix + '/files/model.glb'))
            self.assertEqual(response.status, 200)
            await response.read()
            response = await self.outsider.get(self.client.make_url(prefix + '/files/' + active))
            self.assertEqual(response.status, 404)
            await response.read()

    async def test_preview_is_hidden_after_edit_and_successful_upload_restores_it(self):
        job = await self.create()
        output = io.BytesIO()
        Image.new('RGB', (64, 64), '#336699').save(output, 'PNG')
        data = {'image': 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode()}
        upload = f"{PREFIX}/jobs/{job['id']}/preview"
        public = f"{PREFIX}/models/{job['id']}/preview"
        response = await self.client.post(upload, json=data)
        self.assertEqual(response.status, 200, await response.text())
        self.assertIsNotNone((await response.json())['job']['previewUrl'])
        response = await self.outsider.get(self.client.make_url(public))
        self.assertEqual(response.status, 200)
        await response.read()
        result = (await self.edit(job))['job']
        self.assertIsNone(result['previewUrl'])
        self.assertIsNone(self.studio.community.summary(job)['previewUrl'])
        response = await self.outsider.get(self.client.make_url(public))
        self.assertEqual(response.status, 404)
        await response.read()
        response = await self.client.post(upload, json=data)
        self.assertEqual(response.status, 200, await response.text())
        self.assertFalse(job.get('_previewInvalidated'))
        self.assertIsNotNone((await response.json())['job']['previewUrl'])
        response = await self.outsider.get(self.client.make_url(public))
        self.assertEqual(response.status, 200)
        await response.read()

    async def test_rig_uses_active_geometry_and_immutable_original_bounds_reference(self):
        job = await self.create()
        await self.edit(job)
        captured = []
        async def blender(script, args, output_dir, timeout=900):
            self.assertEqual(script, 'rig_humanoid.py')
            captured.extend(args)
            (output_dir / 'rigged.glb').write_bytes(test_studio.small_glb(rigged=True))
            (output_dir / 'rig-report.json').write_text(json.dumps({'method': 'pose-fit'}), encoding='utf-8')
        self.studio.run_blender = blender
        response = await self.client.post(f"{PREFIX}/jobs/{job['id']}/rig", json={'rotation': {'x': -11, 'y': 0, 'z': 0}})
        self.assertEqual(response.status, 202, await response.text())
        await asyncio.wait_for(self.studio.rig_queue.join(), 5)
        self.assertEqual(captured[captured.index('--input') + 1], server.JOB_ROOT / job['id'] / mesh_edits.active_path(job))
        self.assertEqual(captured[captured.index('--bounds-input') + 1], server.JOB_ROOT / job['id'] / 'model.glb')
        self.assertTrue(job['rig']['available'])

    async def test_animation_body_races_cannot_queue_old_geometry_or_replaced_rig(self):
        for transition in ('cleaned', 'cleaned-and-restored', 'rig-replaced'):
            with self.subTest(transition=transition):
                self.studio.rates.clear()
                job = await self.create()
                legacy = server.JOB_ROOT / job['id'] / 'rig' / 'rigged.glb'
                legacy.parent.mkdir()
                legacy.write_bytes(test_studio.small_glb(rigged=True))
                job['rig'] = {'available': True, 'status': 'complete', 'revision': 'legacy', '_path': 'rig/rigged.glb'}
                job['artifacts']['riggedUrl'] = self.studio.file_url(job, 'rig/rigged.glb')
                self.studio.save(job)
                entered, proceed = asyncio.Event(), asyncio.Event()
                original = self.studio.json_object
                async def delayed(request):
                    data = await original(request)
                    if request.path.endswith('/animate'):
                        entered.set()
                        await proceed.wait()
                    return data
                with patch.object(self.studio, 'json_object', delayed):
                    request = asyncio.create_task(self.client.post(f"{PREFIX}/jobs/{job['id']}/animate", json={'prompt': 'Walk forward'}))
                    await asyncio.wait_for(entered.wait(), 5)
                    if transition == 'rig-replaced':
                        job['rig']['revision'] = 'new-rig'
                        self.studio.save(job)
                    else:
                        await self.edit(job)
                        if transition == 'cleaned-and-restored':
                            await self.edit(job, revision=1, restore=True)
                    proceed.set()
                    response = await asyncio.wait_for(request, 5)
                self.assertEqual(response.status, 409, await response.text())
                self.assertEqual(job['motions'], [])
                self.assertTrue(legacy.is_file())


if __name__ == '__main__':
    unittest.main()
