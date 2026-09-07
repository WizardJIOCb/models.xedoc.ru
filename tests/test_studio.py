"""HTTP boundary tests with fake inference: these never run a GPU workload."""
import asyncio
import importlib.util
import io
import json
import os
import struct
import tempfile
import unittest
import uuid
import secrets
import copy
from pathlib import Path
from unittest.mock import patch

import aiohttp
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

spec = importlib.util.spec_from_file_location("studio_under_test", Path(__file__).resolve().parents[1] / "studio/server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
ORIGINAL_WAIT_IDLE = server.Studio.wait_idle


def manual_fixture():
    points = {'head': [0, 1.85, 0.03], 'neck': [0, 1.67, 0]}
    for side, sign in (('l', 1), ('r', -1)):
        for name, point in {'shoulder': [.24, 1.58, 0], 'elbow': [.43, 1.27, 0],
                            'wrist': [.24, 1.08, .12], 'hand': [.15, 1.04, .13],
                            'hip': [.14, .99, 0], 'knee': [.2, .56, .02],
                            'ankle': [.22, .14, 0], 'toe': [.23, .06, .18]}.items():
            points[f'{name}_{side}'] = [point[0] * sign, *point[1:]]
    return {'version': 1, 'points': points}


def small_glb(rigged=False):
    doc = {"asset": {"version": "2.0"}, "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
           "accessors": [{"count": 3, "componentType": 5126, "type": "VEC3"}]}
    if rigged:
        doc.update(skins=[{"joints": [0]}], nodes=[{"name": "Hips"}], animations=[{"name": "Walk"}])
    text = json.dumps(doc).encode()
    text += b" " * (-len(text) % 4)
    return struct.pack("<4sIIII", b"glTF", 2, 20 + len(text), len(text), 0x4E4F534A) + text


class FakePipeline:
    submissions = 0

    def __init__(self, base_url=None, callback=None):
        self.callback = callback

    async def health(self):
        return {"ready": True, "missing_models": []}

    async def run(self, directory, image, seed, quality):
        if (directory / "model.glb").exists():
            await self.callback({"stage": "complete", "prompt_id": "fake-comfy-prompt"})
            return
        type(self).submissions += 1
        with Image.open(image) as normalized:
            assert normalized.format == "PNG"
        await self.callback({"stage": "geometry", "prompt_id": "fake-comfy-prompt"})
        (directory / "model.glb").write_bytes(small_glb())


class StudioHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.patchers = [patch.object(server, "DATA", root), patch.object(server, "JOB_ROOT", root / "jobs"),
                         patch.object(server, "DIST", root / "dist"), patch.object(server, "ComfyPipeline", FakePipeline)]
        async def idle(studio, job, motion=None):
            return None
        self.patchers.append(patch.object(server.Studio, "wait_idle", idle))
        for patcher in self.patchers:
            patcher.start()
        self.app = server.create_app()
        self.client = TestClient(TestServer(self.app), cookie_jar=aiohttp.CookieJar(unsafe=True))
        await self.client.start_server()
        self.outsider = aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True))
        self.studio = self.app["studio"]
        FakePipeline.submissions = 0

    async def asyncTearDown(self):
        await self.outsider.close()
        await self.client.close()
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def upload(self, image=None):
        if image is None:
            buffer = io.BytesIO()
            Image.new("RGB", (160, 240), (40, 90, 140)).save(buffer, "PNG")
            image = buffer.getvalue()
        form = aiohttp.FormData()
        form.add_field("image", image, filename="photo.png", content_type="image/png")
        form.add_field("mode", "object")
        return form

    async def create(self):
        response = await self.client.post("/api/model-studio/jobs", data=self.upload())
        self.assertEqual(response.status, 202, await response.text())
        job = await response.json()
        await asyncio.wait_for(self.studio.queue.join(), 10)
        return job

    async def fake_rig(self, script, args, output_dir, timeout=900):
        self.assertEqual(script, 'rig_humanoid.py')
        (output_dir / 'rigged.glb').write_bytes(small_glb(rigged=True))
        (output_dir / 'rig-report.json').write_text(json.dumps({'method': 'pose-fit'}), encoding='utf-8')

    async def rig(self, job, rotation=None):
        response = await self.client.post(f"/api/model-studio/jobs/{job['id']}/rig", json={'rotation': rotation or {'x': 0, 'y': 0, 'z': 0}})
        self.assertEqual(response.status, 202, await response.text())
        result = await response.json()
        await asyncio.wait_for(self.studio.rig_queue.join(), 10)
        return result

    async def test_delete_completed_job_removes_artifacts_and_never_reappears_after_restart(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        self.studio.run_blender = self.fake_rig
        await self.rig(job)
        motion = server.JOB_ROOT / job['id'] / 'motions' / 'finished' / 'animated.glb'
        motion.parent.mkdir(parents=True)
        motion.write_bytes(small_glb(rigged=True))
        saved['motions'].append({'id': 'finished', 'status': 'complete'})
        saved['motions'].append({'id': 'failed-motion', 'status': 'failed', 'error': 'test failure'})
        self.studio.save(saved)
        endpoint = f"/api/model-studio/jobs/{job['id']}"
        response = await self.client.delete(endpoint)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(await response.json(), {'deleted': True, 'id': job['id']})
        self.assertNotIn(job['id'], self.studio.jobs)
        self.assertFalse((server.JOB_ROOT / job['id']).exists())
        self.assertEqual((await self.client.get(endpoint)).status, 404)
        self.assertEqual((await self.client.get(saved['artifacts']['riggedUrl'])).status, 404)
        await self.client.close()
        self.app = server.create_app()
        self.client = TestClient(TestServer(self.app), cookie_jar=aiohttp.CookieJar(unsafe=True))
        await self.client.start_server()
        self.studio = self.app['studio']
        self.assertNotIn(job['id'], self.studio.jobs)
        self.assertEqual((await self.client.get(endpoint)).status, 404)

    async def test_delete_failed_job_is_owner_only_and_rejects_foreign_origin(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        saved.update(status='failed', error='Failed image inference')
        self.studio.save(saved)
        endpoint = f"/api/model-studio/jobs/{job['id']}"
        async with self.outsider.delete(self.client.make_url(endpoint)) as response:
            self.assertEqual(response.status, 404)
        response = await self.client.delete(endpoint, headers={'Origin': 'https://unrelated.example'})
        self.assertEqual(response.status, 403)
        self.assertTrue((server.JOB_ROOT / job['id']).is_dir())
        response = await self.client.delete(endpoint)
        self.assertEqual(response.status, 200)
        self.assertEqual((await self.client.delete(endpoint)).status, 404)

    async def test_delete_rejects_active_image_rig_motion_and_actual_workers(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        endpoint = f"/api/model-studio/jobs/{job['id']}"
        for status in ('queued', 'running'):
            saved['status'] = status
            self.assertEqual((await self.client.delete(endpoint)).status, 409)
            saved['status'] = 'complete'
            saved['rig']['status'] = status
            self.assertEqual((await self.client.delete(endpoint)).status, 409)
            saved['rig']['status'] = 'not_requested'
            saved['motions'] = [{'id': 'busy', 'status': status}]
            self.assertEqual((await self.client.delete(endpoint)).status, 409)
            saved['motions'] = []
        for field in ('worker_job', 'rig_worker_job'):
            setattr(self.studio, field, job['id'])
            self.assertEqual((await self.client.delete(endpoint)).status, 409)
            setattr(self.studio, field, None)
        self.studio.operation = {'kind': 'model', 'id': job['id']}
        self.assertEqual((await self.client.delete(endpoint)).status, 409)
        self.studio.operation = None
        self.assertTrue((server.JOB_ROOT / job['id'] / 'model.glb').is_file())

    async def test_delete_cleanup_error_retains_job_and_does_not_report_success(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        endpoint = f"/api/model-studio/jobs/{job['id']}"
        with patch.object(server.shutil, 'rmtree', side_effect=PermissionError('File is locked')):
            response = await self.client.delete(endpoint)
        self.assertEqual(response.status, 503)
        self.assertNotIn('deleted', await response.json())
        self.assertIn(job['id'], self.studio.jobs)
        self.assertTrue((server.JOB_ROOT / job['id'] / 'job.json').is_file())
        self.assertEqual((await self.client.get(saved['artifacts']['modelUrl'])).status, 200)
        self.assertEqual((await self.client.delete(endpoint)).status, 200)

    async def test_partial_delete_failure_restores_metadata_for_retry(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}"
        def partial_cleanup(path):
            (path / 'job.json').unlink()
            raise PermissionError('A later artifact is locked')
        with patch.object(server.shutil, 'rmtree', side_effect=partial_cleanup):
            self.assertEqual((await self.client.delete(endpoint)).status, 503)
        restored = json.loads((server.JOB_ROOT / job['id'] / 'job.json').read_text(encoding='utf-8'))
        self.assertEqual(restored['id'], job['id'])
        self.assertIn(job['id'], self.studio.jobs)
        self.assertEqual((await self.client.delete(endpoint)).status, 200)

    async def test_delete_rejects_path_escape_and_directory_junctions(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        outside = Path(self.temp.name) / 'outside-model-storage'
        outside.mkdir()
        marker = outside / 'must-stay.txt'
        marker.write_text('keep', encoding='utf-8')
        endpoint = f"/api/model-studio/jobs/{job['id']}"
        saved['id'] = '../outside-model-storage'
        self.assertEqual((await self.client.delete(endpoint)).status, 409)
        saved['id'] = job['id']
        link = server.JOB_ROOT / job['id'] / 'unsafe-link'
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError:
            if os.name != 'nt':
                raise
            import _winapi
            _winapi.CreateJunction(str(outside), str(link))
        try:
            self.assertEqual((await self.client.delete(endpoint)).status, 409)
            self.assertEqual(marker.read_text(encoding='utf-8'), 'keep')
            self.assertTrue((server.JOB_ROOT / job['id'] / 'model.glb').is_file())
        finally:
            if link.is_symlink():
                link.unlink()
            else:
                link.rmdir()

    async def test_share_exposes_only_complete_artifacts_and_no_private_metadata(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        self.studio.run_blender = self.fake_rig
        await self.rig(job)
        saved['error'] = 'private-error-marker'
        saved['rig']['error'] = 'private-rig-error-marker'
        saved['placement'] = {'x': 0.2, 'y': 0.1, 'z': -0.5}
        for mid, status in (('finished', 'complete'), ('unfinished', 'running')):
            path = server.JOB_ROOT / job['id'] / 'motions' / mid / 'animated.glb'
            path.parent.mkdir(parents=True)
            path.write_bytes(small_glb(rigged=True))
            saved['motions'].append({'id': mid, 'status': status, 'prompt': 'walk', '_kimodoId': 'private-native-id', 'error': 'private-motion-error-marker'})
        response = await self.client.post(f"/api/model-studio/jobs/{job['id']}/share")
        self.assertEqual(response.status, 200)
        shared_link = await response.json()
        token = shared_link['token']
        self.assertRegex(token, r'^[A-Za-z0-9_-]{43}$')
        response = await self.client.post(f"/api/model-studio/jobs/{job['id']}/share")
        self.assertEqual(await response.json(), shared_link, 'Sharing should reuse a persisted link')
        base = f'/api/model-studio/shares/{token}'
        async with self.outsider.get(self.client.make_url(base)) as response:
            self.assertEqual(response.status, 200)
            payload = await response.json()
        public = payload['job']
        serialized = json.dumps(payload)
        for forbidden in ('sourceImageUrl', '_owner', '_shareToken', 'private-', 'error', 'input.png'):
            self.assertNotIn(forbidden, serialized)
        self.assertEqual(public['placement'], saved['placement'])
        self.assertEqual([m['id'] for m in public['motions']], ['finished'])
        for path in (public['artifacts']['modelUrl'], public['artifacts']['riggedUrl'], public['motions'][0]['glbUrl']):
            async with self.outsider.get(self.client.make_url(path)) as response:
                self.assertEqual(response.status, 200)
        for file in ('input.png', 'job.json', 'rig-report.json', 'motions/unfinished/animated.glb', '../job.json'):
            async with self.outsider.get(self.client.make_url(base + '/files/' + file)) as response:
                self.assertEqual(response.status, 404)
        # A share link is read-only and does not join the owning browser session.
        for method, suffix in (('post', '/rig'), ('post', '/animate'), ('post', '/share'), ('delete', ''), ('patch', '/placement')):
            async with getattr(self.outsider, method)(self.client.make_url(f"/api/model-studio/jobs/{job['id']}" + suffix), json={}) as response:
                self.assertEqual(response.status, 404)
        saved['motions'][1]['status'] = 'failed'

    async def test_share_edit_entry_tracks_owner_session_and_account_login(self):
        job = await self.create()
        link = await (await self.client.post(f"/api/model-studio/jobs/{job['id']}/share")).json()
        endpoint = '/api/model-studio/shares/' + link['token']
        owner_response = await self.client.get(endpoint)
        self.assertEqual(owner_response.status, 200)
        self.assertEqual(owner_response.headers['Cache-Control'], 'no-store')
        owner_payload = await owner_response.json()
        self.assertIs(owner_payload['canEdit'], True)
        async with self.outsider.get(self.client.make_url(endpoint)) as response:
            self.assertEqual(response.status, 200)
            visitor_payload = await response.json()
        self.assertIs(visitor_payload['canEdit'], False)
        self.assertEqual(owner_payload['job'], visitor_payload['job'], 'Owner entry must not add private fields to a shared model')
        for private_field in ('sourceImageUrl', '_owner', '_accountId', '_shareToken', 'input.png'):
            self.assertNotIn(private_field, json.dumps(owner_payload))

        credentials = {'username': 'edit_owner', 'password': 'safe test password 123'}
        response = await self.client.post('/api/model-studio/auth/register', json={**credentials, 'displayName': 'Edit owner'})
        self.assertEqual(response.status, 200, await response.text())
        self.assertIs((await (await self.client.get(endpoint)).json())['canEdit'], True)
        self.assertEqual((await self.client.post('/api/model-studio/auth/logout')).status, 200)
        self.assertIs((await (await self.client.get(endpoint)).json())['canEdit'], False)
        self.assertEqual((await self.client.get(f"/api/model-studio/jobs/{job['id']}")).status, 404)

        async with self.outsider.post(self.client.make_url('/api/model-studio/auth/login'), json=credentials) as response:
            self.assertEqual(response.status, 200, await response.text())
        async with self.outsider.get(self.client.make_url(endpoint)) as response:
            self.assertEqual(response.status, 200)
            self.assertIs((await response.json())['canEdit'], True)
        self.assertIs((await (await self.client.get(endpoint)).json())['canEdit'], False)

    async def test_share_persists_across_restart_and_revocation_invalidates_every_url(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/share"
        link = await (await self.client.post(endpoint)).json()
        cookie_jar = self.client.session.cookie_jar
        await self.client.close()
        self.app = server.create_app()
        self.client = TestClient(TestServer(self.app), cookie_jar=cookie_jar)
        await self.client.start_server()
        self.studio = self.app['studio']
        base = '/api/model-studio/shares/' + link['token']
        self.assertEqual((await self.client.get(base)).status, 200)
        self.assertEqual((await self.client.post(endpoint)).status, 200)
        self.assertEqual((await self.client.delete(endpoint)).status, 200)
        self.assertEqual((await self.client.get(base)).status, 404)
        self.assertEqual((await self.client.get(base + '/files/model.glb')).status, 404)
        next_link = await (await self.client.post(endpoint)).json()
        self.assertNotEqual(next_link['token'], link['token'])
        self.assertEqual((await self.client.delete(f"/api/model-studio/jobs/{job['id']}")).status, 200)
        self.assertEqual((await self.client.get('/api/model-studio/shares/' + next_link['token'])).status, 404)

    async def test_share_requires_ready_model_and_rejects_invalid_or_unknown_tokens(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        endpoint = f"/api/model-studio/jobs/{job['id']}/share"
        for status in ('queued', 'running', 'failed'):
            saved['status'] = status
            self.assertEqual((await self.client.post(endpoint)).status, 409)
        saved['status'] = 'complete'
        for token in ('not-a-token', 'a' * 43):
            self.assertEqual((await self.client.get('/api/model-studio/shares/' + token)).status, 404)
        response = await self.client.post(endpoint, headers={'Origin': 'https://unrelated.example'})
        self.assertEqual(response.status, 403)

    async def test_placement_validates_coordinates_and_persists_without_gpu_work(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/placement"
        position = {'x': -0.75, 'y': 0.15, 'z': 5}
        response = await self.client.patch(endpoint, json={'position': position})
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())['placement'], position)
        persisted = json.loads((server.JOB_ROOT / job['id'] / 'job.json').read_text(encoding='utf-8'))
        self.assertEqual(persisted['placement'], position)
        for value in (True, '1', float('nan'), float('inf'), -5.001, 5.001, None):
            response = await self.client.patch(endpoint, json={'position': {'x': value, 'y': 0, 'z': 0}})
            self.assertEqual(response.status, 400)
        for data in ({}, {'position': {'x': 0, 'y': 0}}, {'position': position, 'other': 1}):
            self.assertEqual((await self.client.patch(endpoint, json=data)).status, 400)
        async with self.outsider.patch(self.client.make_url(endpoint), json={'position': position}) as response:
            self.assertEqual(response.status, 404)
        self.assertEqual((await self.client.patch(endpoint, json={'position': position}, headers={'Origin': 'https://unrelated.example'})).status, 403)
        self.assertEqual(self.studio.jobs[job['id']]['placement'], position)
        self.assertEqual(FakePipeline.submissions, 1)

    async def test_placement_request_cannot_resurrect_concurrently_deleted_job(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}"
        original_json = self.studio.json_object
        arrived, release = asyncio.Event(), asyncio.Event()
        async def gated_json(request):
            data = await original_json(request)
            arrived.set()
            await release.wait()
            return data
        self.studio.json_object = gated_json
        task = asyncio.create_task(self.client.patch(endpoint + '/placement', json={'position': {'x': 0, 'y': 1, 'z': 0}, 'rotation': {'x': -10, 'y': 0, 'z': 0}}))
        try:
            await asyncio.wait_for(arrived.wait(), 5)
            self.assertEqual((await self.client.delete(endpoint)).status, 200)
            release.set()
            response = await asyncio.wait_for(task, 5)
            self.assertEqual(response.status, 404)
            await response.read()
            self.assertFalse((server.JOB_ROOT / job['id']).exists())
        finally:
            release.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_model_orientation_persists_on_reopen_and_existing_anonymous_share(self):
        job = await self.create()
        self.studio.run_blender = self.fake_rig
        await self.rig(job, {'x': 4, 'y': 0, 'z': 0})
        saved = self.studio.jobs[job['id']]
        rig_url = saved['artifacts']['riggedUrl']
        rig_revision = saved['rig']['revision']
        endpoint = f"/api/model-studio/jobs/{job['id']}"
        token = (await (await self.client.post(endpoint + '/share')).json())['token']
        position, rotation = {'x': 0, 'y': -0.14, 'z': 0}, {'x': -10, 'y': 0, 'z': 0}
        response = await self.client.patch(endpoint + '/placement', json={'position': position, 'rotation': rotation})
        self.assertEqual(response.status, 200)
        public = await response.json()
        self.assertEqual(public['placement'], position)
        self.assertEqual(public['modelRotation'], rotation)
        self.assertEqual(public['rig']['appliedRotation'], {'x': 4, 'y': 0, 'z': 0})
        self.assertEqual(public['rig']['revision'], rig_revision)
        self.assertEqual(public['artifacts']['riggedUrl'], rig_url)
        async with self.outsider.get(self.client.make_url('/api/model-studio/shares/' + token)) as response:
            shared = (await response.json())['job']
        self.assertEqual(shared['placement'], position)
        self.assertEqual(shared['modelRotation'], rotation)
        self.assertEqual(shared['updatedAt'], public['updatedAt'])
        cookie_jar = self.client.session.cookie_jar
        await self.client.close()
        self.app = server.create_app()
        self.client = TestClient(TestServer(self.app), cookie_jar=cookie_jar)
        await self.client.start_server()
        self.studio = self.app['studio']
        reopened = await (await self.client.get(endpoint)).json()
        self.assertEqual(reopened['placement'], position)
        self.assertEqual(reopened['modelRotation'], rotation)
        async with self.outsider.get(self.client.make_url('/api/model-studio/shares/' + token)) as response:
            shared = (await response.json())['job']
        self.assertEqual(shared['modelRotation'], rotation)
        self.assertEqual(shared['updatedAt'], reopened['updatedAt'])
        self.assertEqual(FakePipeline.submissions, 1)

    async def test_position_only_patch_preserves_saved_orientation(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/placement"
        rotation = {'x': -10, 'y': 180, 'z': -180}
        await self.client.patch(endpoint, json={'position': {'x': 0, 'y': 0, 'z': 0}, 'rotation': rotation})
        position = {'x': 1, 'y': -0.14, 'z': -2}
        response = await self.client.patch(endpoint, json={'position': position})
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())['modelRotation'], rotation)
        persisted = json.loads((server.JOB_ROOT / job['id'] / 'job.json').read_text(encoding='utf-8'))
        self.assertEqual(persisted['placement'], position)
        self.assertEqual(persisted['modelRotation'], rotation)

    async def test_invalid_orientation_cannot_partially_save_position_or_rotation(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/placement"
        baseline = {'position': {'x': 0, 'y': -0.14, 'z': 0}, 'rotation': {'x': -10, 'y': 0, 'z': 0}}
        self.assertEqual((await self.client.patch(endpoint, json=baseline)).status, 200)
        file = server.JOB_ROOT / job['id'] / 'job.json'
        before = file.read_bytes()
        invalid = [{'position': {'x': 1, 'y': 2, 'z': 3}, 'rotation': value} for value in (None, {}, [], {'x': 0, 'y': 0})]
        invalid.extend({'position': {'x': 1, 'y': 2, 'z': 3}, 'rotation': {'x': value, 'y': 0, 'z': 0}}
                       for value in (True, '1', float('nan'), float('inf'), 180.001, -180.001, 10**400))
        invalid.extend(({'rotation': baseline['rotation']},
                        {'position': {'x': 6, 'y': 0, 'z': 0}, 'rotation': {'x': 25, 'y': 0, 'z': 0}},
                        {**baseline, 'unexpected': 1}))
        for payload in invalid:
            self.assertEqual((await self.client.patch(endpoint, json=payload)).status, 400)
            self.assertEqual(file.read_bytes(), before)
            self.assertEqual(self.studio.jobs[job['id']]['placement'], baseline['position'])
            self.assertEqual(self.studio.jobs[job['id']]['modelRotation'], baseline['rotation'])
        async with self.outsider.patch(self.client.make_url(endpoint), json=baseline) as response:
            self.assertEqual(response.status, 404)
        self.assertEqual((await self.client.patch(endpoint, json=baseline, headers={'Origin': 'https://unrelated.example'})).status, 403)
        self.assertEqual(file.read_bytes(), before)

    async def test_orientation_patch_cannot_restore_a_concurrently_revoked_share(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}"
        token = (await (await self.client.post(endpoint + '/share')).json())['token']
        original_json = self.studio.json_object
        arrived, release = asyncio.Event(), asyncio.Event()
        async def gated_json(request):
            data = await original_json(request)
            arrived.set()
            await release.wait()
            return data
        self.studio.json_object = gated_json
        task = asyncio.create_task(self.client.patch(endpoint + '/placement', json={'position': {'x': 0, 'y': -0.14, 'z': 0}, 'rotation': {'x': -10, 'y': 0, 'z': 0}}))
        try:
            await asyncio.wait_for(arrived.wait(), 5)
            self.assertEqual((await self.client.delete(endpoint + '/share')).status, 200)
            release.set()
            response = await asyncio.wait_for(task, 5)
            self.assertEqual(response.status, 200)
            await response.read()
            self.assertEqual((await self.client.get('/api/model-studio/shares/' + token)).status, 404)
            persisted = json.loads((server.JOB_ROOT / job['id'] / 'job.json').read_text(encoding='utf-8'))
            self.assertNotIn('_shareToken', persisted)
        finally:
            release.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_legacy_orientation_metadata_is_readable_on_share_without_mutation(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        saved['rig'].update(status='failed', rotation={'x': -10, 'y': 0, 'z': 0}, error='private-rig-error')
        endpoint = f"/api/model-studio/jobs/{job['id']}"
        token = (await (await self.client.post(endpoint + '/share')).json())['token']
        async with self.outsider.get(self.client.make_url('/api/model-studio/shares/' + token)) as response:
            shared = (await response.json())['job']
        self.assertEqual(shared['rig']['rotation'], saved['rig']['rotation'])
        self.assertNotIn('error', shared['rig'])
        self.assertNotIn('modelRotation', saved)

    async def test_delayed_placement_write_cannot_replace_newer_revision(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/placement"
        client_id = str(uuid.uuid4())
        old = {'position': {'x': 0, 'y': 0, 'z': 0}, 'rotation': {'x': 0, 'y': 0, 'z': 0}, 'write': {'clientId': client_id, 'revision': 1}}
        latest = {'position': {'x': 0, 'y': -0.14, 'z': 0}, 'rotation': {'x': -10, 'y': 0, 'z': 0}, 'write': {'clientId': client_id, 'revision': 2}}
        original_json = self.studio.json_object
        arrived, release = asyncio.Event(), asyncio.Event()
        async def gated_json(request):
            data = await original_json(request)
            if data.get('write', {}).get('revision') == 1:
                arrived.set()
                await release.wait()
            return data
        self.studio.json_object = gated_json
        delayed = asyncio.create_task(self.client.patch(endpoint, json=old))
        try:
            await asyncio.wait_for(arrived.wait(), 5)
            response = await self.client.patch(endpoint, json=latest)
            self.assertEqual(response.status, 200)
            latest_public = await response.json()
            before = (server.JOB_ROOT / job['id'] / 'job.json').read_bytes()
            release.set()
            response = await asyncio.wait_for(delayed, 5)
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), latest_public)
            self.assertEqual((server.JOB_ROOT / job['id'] / 'job.json').read_bytes(), before)
            self.studio.json_object = original_json
            equal = {**old, 'write': {'clientId': client_id, 'revision': 2}}
            response = await self.client.patch(endpoint, json=equal)
            self.assertEqual(await response.json(), latest_public)
            self.assertEqual((server.JOB_ROOT / job['id'] / 'job.json').read_bytes(), before)
            self.assertEqual(self.studio.jobs[job['id']]['_placementWrites'], {client_id: 2})
        finally:
            release.set()
            if not delayed.done():
                delayed.cancel()
                await asyncio.gather(delayed, return_exceptions=True)

    async def test_placement_watermarks_persist_privately_across_restart(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}"
        client_id = str(uuid.uuid4())
        first = {'position': {'x': 0, 'y': -0.14, 'z': 0}, 'rotation': {'x': -10, 'y': 0, 'z': 0}, 'write': {'clientId': client_id.upper(), 'revision': 0}}
        public = await (await self.client.patch(endpoint + '/placement', json=first)).json()
        self.assertNotIn('_placementWrites', public)
        token = (await (await self.client.post(endpoint + '/share')).json())['token']
        async with self.outsider.get(self.client.make_url('/api/model-studio/shares/' + token)) as response:
            shared = await response.json()
        self.assertNotIn('_placementWrites', json.dumps(shared))
        self.assertNotIn(client_id, json.dumps(shared))
        cookie_jar = self.client.session.cookie_jar
        await self.client.close()
        self.app = server.create_app()
        self.client = TestClient(TestServer(self.app), cookie_jar=cookie_jar)
        await self.client.start_server()
        self.studio = self.app['studio']
        before = (server.JOB_ROOT / job['id'] / 'job.json').read_bytes()
        duplicate = {**first, 'position': {'x': 2, 'y': 0, 'z': 0}, 'write': {'clientId': client_id, 'revision': 0}}
        response = await self.client.patch(endpoint + '/placement', json=duplicate)
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())['placement'], first['position'])
        self.assertEqual((server.JOB_ROOT / job['id'] / 'job.json').read_bytes(), before)
        self.assertEqual(self.studio.jobs[job['id']]['_placementWrites'], {client_id: 0})

    async def test_unrelated_placement_clients_and_legacy_updates_remain_supported(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/placement"
        first_id, second_id = str(uuid.uuid4()), str(uuid.uuid4())
        for client_id, revision, y in ((first_id, 5, 1), (second_id, 0, 2), (first_id, 6, 3)):
            response = await self.client.patch(endpoint, json={'position': {'x': 0, 'y': y, 'z': 0}, 'write': {'clientId': client_id, 'revision': revision}})
            self.assertEqual(response.status, 200)
            self.assertEqual((await response.json())['placement']['y'], y)
        response = await self.client.patch(endpoint, json={'position': {'x': 0, 'y': 4, 'z': 0}})
        self.assertEqual((await response.json())['placement']['y'], 4)
        self.assertEqual(self.studio.jobs[job['id']]['_placementWrites'], {second_id: 0, first_id: 6})

    async def test_placement_watermark_storage_is_bounded_to_64_clients(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/placement"
        clients = [str(uuid.uuid4()) for _ in range(65)]
        for client_id in clients:
            response = await self.client.patch(endpoint, json={'position': {'x': 0, 'y': 0, 'z': 0}, 'write': {'clientId': client_id, 'revision': 0}})
            self.assertEqual(response.status, 200)
            await response.read()
        watermarks = self.studio.jobs[job['id']]['_placementWrites']
        self.assertEqual(list(watermarks), clients[1:])
        persisted = json.loads((server.JOB_ROOT / job['id'] / 'job.json').read_text(encoding='utf-8'))
        self.assertEqual(len(persisted['_placementWrites']), 64)

    async def test_invalid_placement_write_metadata_does_not_mutate_any_settings(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/placement"
        client_id = str(uuid.uuid4())
        baseline = {'position': {'x': 0, 'y': -0.14, 'z': 0}, 'rotation': {'x': -10, 'y': 0, 'z': 0}, 'write': {'clientId': client_id, 'revision': 0}}
        self.assertEqual((await self.client.patch(endpoint, json=baseline)).status, 200)
        file = server.JOB_ROOT / job['id'] / 'job.json'
        before = file.read_bytes()
        invalid = [None, [], {}, {'clientId': client_id}, {'revision': 0}, {'clientId': client_id, 'revision': 0, 'other': 1}]
        invalid.extend({'clientId': value, 'revision': 1} for value in (None, 1, [], 'invalid', 'a' * 36, client_id.replace('-', '')))
        invalid.extend({'clientId': client_id, 'revision': value} for value in (-1, True, 1.0, '1', None, float('inf'), 2**53))
        for write in invalid:
            payload = {**baseline, 'position': {'x': 2, 'y': 2, 'z': 2}, 'rotation': {'x': 20, 'y': 30, 'z': 40}, 'write': write}
            self.assertEqual((await self.client.patch(endpoint, json=payload)).status, 400)
            self.assertEqual(file.read_bytes(), before)
            self.assertEqual(self.studio.jobs[job['id']]['_placementWrites'], {client_id: 0})

    async def test_failed_placement_save_keeps_memory_and_revision_retryable(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/placement"
        client_id = str(uuid.uuid4())
        baseline = {'position': {'x': 0, 'y': 0, 'z': 0}, 'rotation': {'x': 0, 'y': 0, 'z': 0}, 'write': {'clientId': client_id, 'revision': 1}}
        latest = {'position': {'x': 0, 'y': -0.14, 'z': 0}, 'rotation': {'x': -10, 'y': 0, 'z': 0}, 'write': {'clientId': client_id, 'revision': 2}}
        self.assertEqual((await self.client.patch(endpoint, json=baseline)).status, 200)
        saved = self.studio.jobs[job['id']]
        original = json.loads(json.dumps(saved))
        path = server.JOB_ROOT / job['id'] / 'job.json'
        before = path.read_bytes()
        with patch.object(server, 'atomic_json', side_effect=OSError('Simulated disk failure')):
            response = await self.client.patch(endpoint, json=latest)
        self.assertEqual(response.status, 503)
        self.assertIs(self.studio.jobs[job['id']], saved)
        self.assertEqual(saved, original)
        self.assertEqual(path.read_bytes(), before)
        response = await self.client.patch(endpoint, json=latest)
        self.assertEqual(response.status, 200)
        public = await response.json()
        self.assertEqual(public['placement'], latest['position'])
        self.assertEqual(public['modelRotation'], latest['rotation'])
        self.assertIs(self.studio.jobs[job['id']], saved)
        persisted = json.loads(path.read_text(encoding='utf-8'))
        self.assertEqual(persisted['placement'], latest['position'])
        self.assertEqual(persisted['modelRotation'], latest['rotation'])
        self.assertEqual(persisted['_placementWrites'], {client_id: 2})
        self.assertEqual(saved, persisted)

    async def test_existing_object_can_be_rigged_without_regenerating_geometry(self):
        job = await self.create()
        rotation = {'x': -4.5, 'y': 180, 'z': 12}
        calls = []
        async def rig(script, args, output_dir, timeout=900):
            calls.append(args)
            await self.fake_rig(script, args, output_dir)
        self.studio.run_blender = rig
        result = await self.rig(job, rotation)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['rig']['status'], 'queued')
        saved = self.studio.jobs[job['id']]
        self.assertEqual(saved['rig']['status'], 'complete')
        self.assertEqual(saved['rig']['appliedRotation'], rotation)
        self.assertEqual(saved['rig']['method'], 'pose-fit')
        for axis, angle in rotation.items():
            self.assertEqual(calls[0][calls[0].index(f'--rotation-{axis}') + 1], angle)
        self.assertEqual(FakePipeline.submissions, 1)
        self.assertEqual((await self.client.get(saved['artifacts']['riggedUrl'])).status, 200)
        async with self.outsider.get(self.client.make_url(saved['artifacts']['riggedUrl'])) as response:
            self.assertEqual(response.status, 404)
        public = await (await self.client.get(f"/api/model-studio/jobs/{job['id']}")).json()
        self.assertNotIn('_path', public['rig'])
        self.assertNotIn('_rigVersions', public)

    async def test_manual_rig_uses_persisted_points_without_new_geometry_or_pose_detection(self):
        job = await self.create()
        manual, rotation = manual_fixture(), {'x': -10, 'y': 0, 'z': 0}
        calls = []
        async def rig(script, args, output_dir, timeout=900):
            points_file = args[args.index('--manual-points') + 1]
            calls.append(json.loads(points_file.read_text(encoding='utf-8')))
            self.assertEqual(points_file.parent, output_dir)
            await self.fake_rig(script, args, output_dir)
        self.studio.run_blender = rig
        response = await self.client.post(f"/api/model-studio/jobs/{job['id']}/rig", json={'rotation': rotation, 'manual': manual})
        self.assertEqual(response.status, 202, await response.text())
        await asyncio.wait_for(self.studio.rig_queue.join(), 10)
        saved = self.studio.jobs[job['id']]
        self.assertEqual(calls, [manual])
        self.assertEqual(saved['rig']['method'], 'manual-landmarks')
        self.assertEqual(saved['rig']['manual'], manual)
        self.assertEqual(saved['rig']['manualRotation'], rotation)
        self.assertEqual(saved['_manualRigDraft']['manual'], manual)
        self.assertEqual(FakePipeline.submissions, 1)
        persisted = json.loads((server.JOB_ROOT / job['id'] / 'job.json').read_text(encoding='utf-8'))
        self.assertEqual(persisted['rig']['manual'], manual)

    async def test_manual_draft_is_owner_only_partial_private_and_survives_restart(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}"
        data = {'rotation': {'x': -10, 'y': 0, 'z': 0}, 'manual': {'version': 1, 'points': {'head': [0, 1.85, .03]}}}
        response = await self.client.put(endpoint + '/rig-draft', json=data)
        self.assertEqual(response.status, 200, await response.text())
        public = await response.json()
        self.assertEqual(public['manualRigDraft']['manual'], data['manual'])
        self.assertNotIn('_manualRigDraft', public)
        self.assertEqual(public['rig']['status'], 'not_requested')
        token = (await (await self.client.post(endpoint + '/share')).json())['token']
        async with self.outsider.get(self.client.make_url('/api/model-studio/shares/' + token)) as response:
            self.assertNotIn('manualRigDraft', await response.text())
        async with self.outsider.put(self.client.make_url(endpoint + '/rig-draft'), json=data) as response:
            self.assertEqual(response.status, 404)
        self.assertEqual((await self.client.put(endpoint + '/rig-draft', json=data, headers={'Origin': 'https://evil.example'})).status, 403)
        session = self.client.session.cookie_jar.filter_cookies(self.client.make_url('/'))['model_studio_session'].value
        await self.client.close()
        self.app = server.create_app()
        self.client = TestClient(TestServer(self.app), cookie_jar=aiohttp.CookieJar(unsafe=True))
        await self.client.start_server()
        self.client.session.cookie_jar.update_cookies({'model_studio_session': session}, response_url=self.client.make_url('/'))
        self.studio = self.app['studio']
        reopened = await (await self.client.get(endpoint)).json()
        self.assertEqual(reopened['manualRigDraft']['manual'], data['manual'])
        self.assertEqual(FakePipeline.submissions, 1)

    async def test_manual_bad_points_and_degenerate_bones_never_queue_work(self):
        job = await self.create()
        rotation = {'x': 0, 'y': 0, 'z': 0}
        examples = [{'version': 1, 'points': {}}, {'version': True, 'points': {}}, manual_fixture(), manual_fixture()]
        examples[2]['points']['head'][0] = True
        examples[3]['points']['wrist_l'] = examples[3]['points']['elbow_l']
        for manual in examples:
            self.studio.rates.clear()
            response = await self.client.post(f"/api/model-studio/jobs/{job['id']}/rig", json={'rotation': rotation, 'manual': manual})
            self.assertEqual(response.status, 400, await response.text())
        self.assertTrue(self.studio.rig_queue.empty())
        self.assertEqual(self.studio.jobs[job['id']]['rig']['status'], 'not_requested')

    async def test_manual_draft_stale_writes_and_failed_save_are_retryable(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/rig-draft"
        data = {'rotation': {'x': 0, 'y': 0, 'z': 0}, 'manual': {'version': 1, 'points': {}},
                'write': {'clientId': str(uuid.uuid4()), 'revision': 1}}
        self.assertEqual((await self.client.put(endpoint, json=data)).status, 200)
        changed = copy.deepcopy(data)
        changed['write']['revision'] = 2
        changed['manual']['points']['head'] = [0, 1.85, .03]
        with patch.object(self.studio, 'save', side_effect=OSError('Disk full')):
            self.assertEqual((await self.client.put(endpoint, json=changed)).status, 503)
        self.assertEqual(self.studio.jobs[job['id']]['_manualRigDraft']['manual']['points'], {})
        self.assertEqual((await self.client.put(endpoint, json=changed)).status, 200)
        response = await self.client.put(endpoint, json=data)
        self.assertEqual((await response.json())['manualRigDraft']['manual'], changed['manual'])

    async def test_failed_manual_rerig_keeps_previous_manual_rig_and_auto_can_replace_it(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/rig"
        first = {'rotation': {'x': 0, 'y': 0, 'z': 0}, 'manual': manual_fixture()}
        self.studio.run_blender = self.fake_rig
        self.assertEqual((await self.client.post(endpoint, json=first)).status, 202)
        await self.studio.rig_queue.join()
        saved = self.studio.jobs[job['id']]
        old_revision, old_url = saved['rig']['revision'], saved['artifacts']['riggedUrl']
        changed = copy.deepcopy(first)
        changed['manual']['points']['head'][1] = 1.9
        async def fail(*args, **kwargs):
            raise RuntimeError('Weighting failed')
        self.studio.run_blender = fail
        self.assertEqual((await self.client.post(endpoint, json=changed)).status, 202)
        await self.studio.rig_queue.join()
        self.assertEqual(saved['rig']['manual'], first['manual'])
        self.assertEqual(saved['rig']['revision'], old_revision)
        self.assertEqual(saved['artifacts']['riggedUrl'], old_url)
        self.assertEqual(saved['_manualRigDraft']['manual'], changed['manual'])
        async def auto(script, args, output_dir, timeout=900):
            self.assertNotIn('--manual-points', args)
            await self.fake_rig(script, args, output_dir)
        self.studio.run_blender = auto
        await self.rig(job)
        self.assertNotIn('manual', saved['rig'])
        self.assertNotIn('_manualInput', saved['rig'])

    async def test_manual_rig_restart_reuses_snapshot_in_fresh_directory(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        saved['rig'].update(status='running', operationId='manual-restart', rotation={'x': -10, 'y': 0, 'z': 0},
                            mode='manual', _manualInput=manual_fixture())
        self.studio.save(saved)
        await self.client.close()
        observed = []
        async def rig(studio, script, args, output_dir, timeout=900):
            observed.append(json.loads(args[args.index('--manual-points') + 1].read_text(encoding='utf-8')))
            await self.fake_rig(script, args, output_dir)
        with patch.object(server.Studio, 'run_blender', rig):
            self.app = server.create_app()
            self.client = TestClient(TestServer(self.app), cookie_jar=aiohttp.CookieJar(unsafe=True))
            await self.client.start_server()
            self.studio = self.app['studio']
            await asyncio.wait_for(self.studio.rig_queue.join(), 10)
        self.assertEqual(observed, [manual_fixture()])
        self.assertEqual(self.studio.jobs[job['id']]['rig']['method'], 'manual-landmarks')

    async def test_rig_rotation_rejects_nonfinite_and_non_numeric_values(self):
        job = await self.create()
        values = [None, [], {'rotation': {}}, {'rotation': {'x': 0, 'y': 0, 'z': 0}, 'other': 2}]
        for value in (True, '15', 181, -181, float('nan'), float('inf'), None, [], 10**400):
            values.append({'rotation': {'x': value, 'y': 0, 'z': 0}})
        for value in values:
            self.studio.rates.clear()
            response = await self.client.post(f"/api/model-studio/jobs/{job['id']}/rig", json=value)
            self.assertEqual(response.status, 400, str(value))
        self.assertEqual(self.studio.jobs[job['id']]['rig']['status'], 'not_requested')
        self.assertEqual(FakePipeline.submissions, 1)

    async def test_rig_and_motion_are_mutually_exclusive_and_owner_checked(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        endpoint = f"/api/model-studio/jobs/{job['id']}/rig"
        data = {'rotation': {'x': 0, 'y': 0, 'z': 0}}
        async with self.outsider.post(self.client.make_url(endpoint), json=data) as response:
            self.assertEqual(response.status, 404)
        saved['status'] = 'running'
        self.assertEqual((await self.client.post(endpoint, json=data)).status, 409)
        saved['status'] = 'complete'
        saved['motions'] = [{'id': 'pending-motion', 'status': 'queued'}]
        self.assertEqual((await self.client.post(endpoint, json=data)).status, 409)
        saved['motions'] = []
        saved['rig'].update(status='queued', available=True)
        self.assertEqual((await self.client.post(endpoint, json=data)).status, 409)
        self.studio.rates.clear()
        response = await self.client.post(f"/api/model-studio/jobs/{job['id']}/animate", json={'prompt': 'walk'})
        self.assertEqual(response.status, 409)

    async def test_failed_rerig_preserves_previous_rig_and_motion_files(self):
        job = await self.create()
        self.studio.run_blender = self.fake_rig
        await self.rig(job)
        saved = self.studio.jobs[job['id']]
        old_url, old_revision = saved['artifacts']['riggedUrl'], saved['rig']['revision']
        motion_file = server.JOB_ROOT / job['id'] / 'motions' / 'previous' / 'animated.glb'
        motion_file.parent.mkdir(parents=True)
        motion_file.write_bytes(small_glb(rigged=True))
        saved['motions'].append({'id': 'previous', 'status': 'complete', 'rigRevision': old_revision})
        attempts = []
        async def fail(script, args, output_dir, timeout=900):
            attempts.append(output_dir)
            (output_dir / 'rigged.glb').write_bytes(small_glb(rigged=True))
            raise RuntimeError('Failed after writing a partial export')
        self.studio.run_blender = fail
        await self.rig(job, {'x': 7, 'y': 0, 'z': 0})
        self.assertEqual(saved['status'], 'complete')
        self.assertEqual(saved['rig']['status'], 'failed')
        self.assertTrue(saved['rig']['available'])
        self.assertEqual(saved['rig']['revision'], old_revision)
        self.assertEqual(saved['rig']['appliedRotation']['x'], 0)
        self.assertEqual(saved['artifacts']['riggedUrl'], old_url)
        self.assertEqual((await self.client.get(old_url)).status, 200)
        self.assertEqual((await self.client.get(self.studio.file_url(saved, 'motions/previous/animated.glb'))).status, 200)
        bad_relative = (attempts[0] / 'rigged.glb').relative_to(server.JOB_ROOT / job['id']).as_posix()
        self.assertEqual((await self.client.get(self.studio.file_url(saved, bad_relative))).status, 404)
        self.assertEqual(FakePipeline.submissions, 1)

    async def test_restart_retries_rig_in_fresh_directory_and_keeps_operation(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        saved['rig'].update(status='running', operationId='interrupted-operation', rotation={'x': 1, 'y': 2, 'z': 3})
        stale = server.JOB_ROOT / job['id'] / 'rigs' / 'interrupted-export'
        stale.mkdir(parents=True)
        (stale / 'rigged.glb').write_bytes(small_glb(rigged=True))
        self.studio.save(saved)
        await self.client.close()
        calls = []
        async def rig(studio, script, args, output_dir, timeout=900):
            calls.append(output_dir)
            await self.fake_rig(script, args, output_dir)
        with patch.object(server.Studio, 'run_blender', rig):
            self.app = server.create_app()
            self.client = TestClient(TestServer(self.app), cookie_jar=aiohttp.CookieJar(unsafe=True))
            await self.client.start_server()
            self.studio = self.app['studio']
            await asyncio.wait_for(self.studio.rig_queue.join(), 10)
        restored = self.studio.jobs[job['id']]
        self.assertEqual(restored['status'], 'complete')
        self.assertEqual(restored['rig']['status'], 'complete')
        self.assertEqual(restored['rig']['operationId'], 'interrupted-operation')
        self.assertNotEqual(calls[0], stale)
        self.assertEqual(restored['rig']['appliedRotation'], {'x': 1, 'y': 2, 'z': 3})
        self.assertEqual(FakePipeline.submissions, 1)

    async def test_animation_snapshots_versioned_rig_without_exposing_internal_path(self):
        job = await self.create()
        self.studio.run_blender = self.fake_rig
        await self.rig(job)
        saved = self.studio.jobs[job['id']]
        await self.studio.gpu.acquire()
        try:
            response = await self.client.post(f"/api/model-studio/jobs/{job['id']}/animate", json={'prompt': 'walk'})
            self.assertEqual(response.status, 202, await response.text())
            public = await response.json()
            motion = saved['motions'][0]
            self.assertEqual(motion['_rigPath'], saved['rig']['_path'])
            self.assertEqual(public['rigRevision'], saved['rig']['revision'])
            self.assertNotIn('_rigPath', public)
            self.assertEqual((await self.client.post(f"/api/model-studio/jobs/{job['id']}/rig", json={'rotation': {'x': 0, 'y': 0, 'z': 0}})).status, 409)
        finally:
            # Cancel the fake test worker before releasing its GPU reservation.
            self.studio.worker.cancel()
            await asyncio.gather(self.studio.worker, return_exceptions=True)
            self.studio.gpu.release()

    async def test_successful_rerig_keeps_legacy_rig_downloadable(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        legacy_file = server.JOB_ROOT / job['id'] / 'rig' / 'rigged.glb'
        legacy_file.parent.mkdir()
        legacy_file.write_bytes(small_glb(rigged=True))
        saved['rig'].update(available=True, status='complete')
        legacy_url = self.studio.file_url(saved, 'rig/rigged.glb')
        saved['artifacts']['riggedUrl'] = legacy_url
        self.studio.run_blender = self.fake_rig
        await self.rig(job)
        self.assertNotEqual(saved['artifacts']['riggedUrl'], legacy_url)
        self.assertEqual((await self.client.get(legacy_url)).status, 200)
        self.assertEqual((await self.client.get(saved['artifacts']['riggedUrl'])).status, 200)

    async def test_retarget_uses_motion_snapshot_even_if_active_rig_changes(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        snapshot = 'rigs/old-revision/rigged.glb'
        saved['rig'].update(available=True, _path='rigs/new-revision/rigged.glb', revision='new-revision')
        motion = {'id': 'snapshot-motion', 'status': 'queued', 'frames': 30,
                  '_kimodoId': 'already-generated', '_rigPath': snapshot, 'rigRevision': 'old-revision'}
        saved['motions'].append(motion)
        async def history():
            return [{'id': 'already-generated', 'status': 'complete'}]
        class Response:
            def __init__(self, url):
                self.size = 30 * (3 if url.endswith('/root.f32') else 22 * 4) * 4
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                return None
            def raise_for_status(self):
                return None
            async def read(self):
                return b'\0' * self.size
        class HTTP:
            def get(self, url):
                return Response(url)
        inputs = []
        async def retarget(script, args, output_dir, timeout=900):
            self.assertEqual(script, 'retarget_motion.py')
            inputs.append(args[args.index('--input') + 1])
            (output_dir / 'animated.glb').write_bytes(small_glb(rigged=True))
        self.studio.legacy_history = history
        self.studio.run_blender = retarget
        real_http = self.studio.http
        try:
            self.studio.http = HTTP()
            await self.studio.motion_job(saved, motion)
        finally:
            self.studio.http = real_http
        self.assertEqual(inputs, [server.JOB_ROOT / job['id'] / snapshot])
        self.assertEqual(motion['status'], 'complete')
        self.assertEqual(motion['rigRevision'], 'old-revision')

    async def test_simultaneous_rig_requests_only_reserve_one_operation(self):
        job = await self.create()
        read_json = self.studio.json_object
        arrived, release = asyncio.Event(), asyncio.Event()
        calls = 0
        async def gated(request):
            nonlocal calls
            data = await read_json(request)
            calls += 1
            if calls == 2:
                arrived.set()
            await release.wait()
            return data
        self.studio.json_object = gated
        await self.studio.rig_lock.acquire()
        tasks = [asyncio.create_task(self.client.post(f"/api/model-studio/jobs/{job['id']}/rig", json={'rotation': {'x': 0, 'y': 0, 'z': 0}})) for _ in range(2)]
        try:
            await asyncio.wait_for(arrived.wait(), 5)
            release.set()
            responses = await asyncio.wait_for(asyncio.gather(*tasks), 5)
            self.assertEqual(sorted(r.status for r in responses), [202, 409])
            for response in responses:
                await response.read()
        finally:
            release.set()
            for task in tasks:
                if not task.done():
                    task.cancel()
            self.studio.rig_worker.cancel()
            await asyncio.gather(self.studio.rig_worker, return_exceptions=True)
            self.studio.rig_lock.release()

    async def test_cpu_rig_runs_while_gpu_is_busy_with_another_generation(self):
        job = await self.create()
        self.studio.run_blender = self.fake_rig
        await self.studio.gpu.acquire()
        self.studio.operation = {'kind': 'model', 'id': 'another-generation'}
        try:
            await self.rig(job, {'x': 5, 'y': 0, 'z': 0})
            self.assertEqual(self.studio.jobs[job['id']]['rig']['status'], 'complete')
            self.assertTrue(self.studio.gpu.locked())
            self.assertEqual(self.studio.operation, {'kind': 'model', 'id': 'another-generation'})
            self.assertEqual(FakePipeline.submissions, 1)
        finally:
            self.studio.operation = None
            self.studio.gpu.release()

    async def test_cpu_and_gpu_queues_share_pending_capacity(self):
        job = await self.create()
        # No await between filling and measuring, so neither worker can drain.
        for index in range(4):
            self.studio.queue.put_nowait(('model', job['id'], None))
            self.studio.rig_queue.put_nowait((job['id'], f'pending-{index}'))
        self.assertEqual(self.studio.pending_count(), 8)
        self.studio.worker.cancel()
        self.studio.rig_worker.cancel()
        await asyncio.gather(self.studio.worker, self.studio.rig_worker, return_exceptions=True)
        response = await self.client.post(f"/api/model-studio/jobs/{job['id']}/rig", json={'rotation': {'x': 0, 'y': 0, 'z': 0}})
        self.assertEqual(response.status, 429)
        response = await self.client.post('/api/model-studio/jobs', data=self.upload())
        self.assertEqual(response.status, 429)

    async def test_initial_and_manual_rig_share_cpu_lock(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        saved['mode'] = 'humanoid'
        entered = asyncio.Event()
        async def rig(script, args, output_dir, timeout=900):
            entered.set()
            await self.fake_rig(script, args, output_dir)
        self.studio.run_blender = rig
        await self.studio.rig_lock.acquire()
        task = asyncio.create_task(self.studio.image_job(saved))
        try:
            await asyncio.sleep(0.03)
            self.assertFalse(entered.is_set(), 'Initial generation bypassed the CPU rig reservation')
            self.studio.rig_lock.release()
            await asyncio.wait_for(task, 10)
            self.assertTrue(entered.is_set())
            self.assertEqual(saved['rig']['status'], 'complete')
        finally:
            if self.studio.rig_lock.locked():
                self.studio.rig_lock.release()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_generated_files_and_jobs_are_owned_by_session(self):
        job = await self.create()
        url = f"/api/model-studio/jobs/{job['id']}"
        response = await self.client.get(url)
        body = await response.json()
        self.assertEqual(body["status"], "complete")
        self.assertNotIn("_owner", body)
        self.assertNotIn("_comfyPromptId", body)
        response = await self.client.get(body["artifacts"]["modelUrl"])
        self.assertEqual(response.status, 200)
        for route in (url, body["artifacts"]["modelUrl"], job["sourceImageUrl"]):
            async with self.outsider.get(self.client.make_url(route)) as other:
                self.assertEqual(other.status, 404)
        async with self.outsider.get(self.client.make_url("/api/model-studio/jobs")) as other:
            self.assertEqual((await other.json())["jobs"], [])
        self.assertEqual(FakePipeline.submissions, 1)

    async def test_file_allowlist_never_exposes_internal_state(self):
        job = await self.create()
        for file in ("job.json", "comfy-state.json", "rig/rigged.blend", "../job.json", "input.png/../../job.json"):
            response = await self.client.get(f"/api/model-studio/files/{job['id']}/{file}")
            self.assertEqual(response.status, 404)

    async def test_cross_origin_generation_is_denied(self):
        response = await self.client.post("/api/model-studio/jobs", data=self.upload(), headers={"Origin": "https://unrelated.example"})
        self.assertEqual(response.status, 403)
        self.assertEqual(FakePipeline.submissions, 0)

    async def test_invalid_image_does_not_enqueue_or_write_job(self):
        response = await self.client.post("/api/model-studio/jobs", data=self.upload(b"not an image"))
        self.assertEqual(response.status, 400)
        self.assertEqual(self.studio.jobs, {})
        self.assertEqual(FakePipeline.submissions, 0)

    async def test_nonmultipart_request_is_a_client_error(self):
        response = await self.client.post("/api/model-studio/jobs", json={"image": "bad"})
        self.assertEqual(response.status, 400)

    async def test_truncated_multipart_is_a_client_error(self):
        body = b'--bad-boundary\r\nContent-Disposition: form-data; name="image"; filename="image.png"\r\nContent-Type: image/png\r\n\r\ntruncated'
        response = await self.client.post("/api/model-studio/jobs", data=body, headers={"Content-Type": "multipart/form-data; boundary=bad-boundary"})
        self.assertEqual(response.status, 400)
        self.assertEqual(FakePipeline.submissions, 0)

    async def test_animation_requires_a_json_object(self):
        job = await self.create()
        self.studio.jobs[job["id"]]["rig"] = {"available": True}
        for value in ([], None, "dance"):
            response = await self.client.post(f"/api/model-studio/jobs/{job['id']}/animate", json=value)
            self.assertEqual(response.status, 400)
        self.assertEqual(self.studio.jobs[job["id"]]["motions"], [])

    async def test_legacy_generate_does_not_bypass_gpu_lock(self):
        await self.studio.gpu.acquire()
        try:
            response = await self.client.post("/api/generate", json={"prompt": "walk"})
            self.assertEqual(response.status, 409)
        finally:
            self.studio.gpu.release()

    async def test_unknown_multipart_field_cannot_bypass_request_body_limit(self):
        form = self.upload()
        form.add_field("unused", io.BytesIO(b"x" * (22 * 1024 * 1024)), filename="unused.bin")
        response = await self.client.post("/api/model-studio/jobs", data=form)
        self.assertIn(response.status, (400, 413))
        self.assertEqual(self.studio.jobs, {})

    async def test_concurrent_uploads_respect_global_queue_capacity(self):
        count = 12
        admitted = asyncio.Event()
        upload_gate = asyncio.Event()
        calls = 0
        original_limit = self.studio.limit
        def limit(request):
            nonlocal calls
            original_limit(request)
            calls += 1
            if calls == count:
                admitted.set()
        self.studio.limit = limit
        image = io.BytesIO()
        Image.new("RGB", (160, 240), (30, 40, 50)).save(image, "PNG")
        boundary = "studio-concurrency-boundary"
        async def body():
            yield (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="input.png"\r\nContent-Type: image/png\r\n\r\n').encode()
            await upload_gate.wait()
            yield image.getvalue() + f"\r\n--{boundary}--\r\n".encode()
        await self.studio.gpu.acquire()
        tasks = [asyncio.create_task(self.outsider.post(self.client.make_url("/api/model-studio/jobs"), data=body(),
                   headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "Cookie": f"model_studio_session={secrets.token_hex(24)}"})) for _ in range(count)]
        try:
            await asyncio.wait_for(admitted.wait(), 5)
            upload_gate.set()
            responses = await asyncio.wait_for(asyncio.gather(*tasks), 5)
            statuses = [response.status for response in responses]
            for response in responses:
                await response.read()
            self.assertLessEqual(statuses.count(202), 9, statuses)
            self.assertTrue(all(status in (202, 429) for status in statuses), statuses)
        finally:
            upload_gate.set()
            for task in tasks:
                if not task.done():
                    task.cancel()
            self.studio.gpu.release()

    async def test_legacy_monitor_keeps_lock_across_transient_disconnect(self):
        calls = 0
        async def history():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise aiohttp.ClientConnectionError("temporary disconnect")
            return [{"id": "existing-motion", "status": "running"}]
        self.studio.legacy_history = history
        await self.studio.gpu.acquire()
        task = asyncio.create_task(self.studio.follow_legacy("existing-motion"))
        try:
            await asyncio.sleep(0.03)
            self.assertTrue(self.studio.gpu.locked(), "The GPU became available while legacy inference status was unknown")
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_offline_legacy_is_not_treated_as_idle_gpu(self):
        async def unavailable():
            raise aiohttp.ClientConnectionError("legacy temporarily offline")
        async def comfy(method, url, **kwargs):
            return {"queue_running": [], "queue_pending": []}
        self.studio.legacy_history = unavailable
        self.studio.request_json = comfy
        job = {"id": "unused", "stage": "queued"}
        self.studio.save = lambda item: None
        task = asyncio.create_task(ORIGINAL_WAIT_IDLE(self.studio, job))
        try:
            await asyncio.sleep(0.03)
            if task.done():
                self.assertIsNotNone(task.exception(), "Generation was allowed although the legacy GPU workload could not be checked")
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_temporary_comfy_disconnect_resumes_the_same_job(self):
        calls = []
        original = FakePipeline.run
        async def flaky(client, directory, image, seed, quality):
            calls.append(directory)
            if len(calls) == 1:
                raise aiohttp.ClientConnectionError("temporary Comfy disconnect")
            return await original(client, directory, image, seed, quality)
        with patch.object(FakePipeline, "run", flaky):
            job = await self.create()
        self.assertEqual(self.studio.jobs[job["id"]]["status"], "complete")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])

    async def test_motion_json_body_is_bounded_before_enqueue(self):
        job = await self.create()
        self.studio.jobs[job["id"]]["rig"] = {"available": True}
        response = await self.client.post(f"/api/model-studio/jobs/{job['id']}/animate", json={"prompt": "x" * 17000})
        self.assertEqual(response.status, 413)
        self.assertEqual(self.studio.jobs[job["id"]]["motions"], [])

    async def test_restart_recovers_existing_job_and_session_ownership(self):
        job = await self.create()
        saved = self.studio.jobs[job["id"]]
        owner = saved["_owner"]
        saved["status"] = "running"
        self.studio.save(saved)
        await self.client.close()
        self.app = server.create_app()
        self.client = TestClient(TestServer(self.app), cookie_jar=aiohttp.CookieJar(unsafe=True))
        await self.client.start_server()
        self.studio = self.app["studio"]
        await asyncio.wait_for(self.studio.queue.join(), 10)
        response = await self.client.get("/api/model-studio/jobs", headers={"Cookie": f"model_studio_session={owner}"})
        jobs = (await response.json())["jobs"]
        self.assertEqual([item["id"] for item in jobs], [job["id"]])
        self.assertEqual(jobs[0]["status"], "complete")
        self.assertEqual(FakePipeline.submissions, 1, "A completed cached generation should not be submitted again")


if __name__ == "__main__":
    unittest.main(verbosity=2)
