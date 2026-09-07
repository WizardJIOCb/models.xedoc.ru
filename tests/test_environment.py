"""HTTP persistence, texture privacy and concurrent-owner boundary regressions."""
import asyncio
import copy
import io
import json
import threading
import unittest
from unittest.mock import patch

import aiohttp
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

import test_studio
import environment


server = test_studio.server
PREFIX = '/api/model-studio'


class EnvironmentHTTPTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_studio.StudioHTTPTests.asyncSetUp
    asyncTearDown = test_studio.StudioHTTPTests.asyncTearDown
    upload = test_studio.StudioHTTPTests.upload
    create = test_studio.StudioHTTPTests.create

    @staticmethod
    def texture(fmt='PNG', color=(25, 90, 100), size=(64, 32)):
        output = io.BytesIO()
        image = Image.new('RGB', size, color)
        exif = Image.Exif()
        exif[270] = 'PRIVATE_SOURCE_DESCRIPTION'
        image.save(output, fmt, exif=exif)
        return output.getvalue()

    def form(self, revision=0, settings=None, background_image=None, ground_image=None, **changes):
        data = {**environment.DEFAULTS, 'expectedRevision': revision}
        data.update(changes)
        if settings is not None:
            data = settings
        form = aiohttp.FormData()
        form.add_field('settings', json.dumps(data), content_type='application/json')
        for kind, value in (('background', background_image), ('ground', ground_image)):
            if value is not None:
                form.add_field(kind + 'Image', value, filename='untrusted-name.png', content_type='image/png')
        return form

    async def update(self, job, form=None, client=None, status=200, **kwargs):
        client = client or self.client
        path = f"{PREFIX}/jobs/{job['id']}/environment"
        response = await client.put(path if client is self.client else self.client.make_url(path),
                                    data=form or self.form(**kwargs))
        self.assertEqual(response.status, status, await response.text())
        return await response.json()

    async def get(self, path, client=None, status=200):
        client = client or self.client
        response = await client.get(path if client is self.client else self.client.make_url(path))
        self.assertEqual(response.status, status, await response.text() if response.status != status else path)
        return response

    async def share(self, job):
        response = await self.client.post(f"{PREFIX}/jobs/{job['id']}/share")
        self.assertEqual(response.status, 200, await response.text())
        return (await response.json())['token']

    async def test_legacy_defaults_are_identical_in_owner_share_and_public_model(self):
        job = await self.create()
        self.assertNotIn('environment', self.studio.jobs[job['id']])
        expected = {**environment.DEFAULTS, 'revision': 0, 'backgroundUrl': None, 'groundUrl': None}
        self.assertEqual(job['environment'], expected)
        token = await self.share(job)
        for path in (f"{PREFIX}/shares/{token}", f"{PREFIX}/models/{job['id']}"):
            self.assertEqual((await (await self.get(path, self.outsider)).json())['job']['environment'], expected)

    async def test_settings_persist_across_restart_and_preserve_model_transform(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        saved.update(placement={'x': .4, 'y': -.14, 'z': -.2}, modelRotation={'x': -10, 'y': 35, 'z': 0})
        self.studio.save(saved)
        result = await self.update(job, background='sunset', ground='sand', groundShape='disc',
                                   backgroundProjection='image', backgroundRotation=47.5, groundScale=.5, showGrid=False)
        self.assertIs(self.studio.jobs[job['id']], saved)
        self.assertEqual(result['job']['environment']['revision'], 1)
        for key in ('placement', 'modelRotation'):
            self.assertEqual(result['job'][key], saved[key])
        on_disk = json.loads((server.JOB_ROOT / job['id'] / 'job.json').read_text(encoding='utf-8'))
        self.assertEqual(on_disk['environment']['groundShape'], 'disc')
        self.assertFalse(on_disk['environment']['showGrid'])
        self.assertEqual(test_studio.FakePipeline.submissions, 1)
        await self.client.close()
        self.app = server.create_app()
        self.client = TestClient(TestServer(self.app), cookie_jar=aiohttp.CookieJar(unsafe=True))
        await self.client.start_server()
        self.studio = self.app['studio']
        restored = self.studio.jobs[job['id']]
        self.assertEqual(restored['environment'], on_disk['environment'])
        self.assertEqual(restored['placement'], on_disk['placement'])

    async def test_custom_uploads_reencode_and_expose_only_selected_model_assets(self):
        job = await self.create()
        token = await self.share(job)
        result = await self.update(job, background='custom', ground='custom',
                                   background_image=self.texture(), ground_image=self.texture('JPEG'))
        env = result['job']['environment']
        private = self.studio.jobs[job['id']]
        self.assertNotIn('_environmentTextures', json.dumps(result))
        for kind in ('background', 'ground'):
            self.assertRegex(private['_environmentTextures'][kind], environment.TEXTURE_PATH)
            response = await self.get(env[kind + 'Url'])
            with Image.open(io.BytesIO(await response.read())) as image:
                self.assertEqual(image.format, 'WEBP')
                self.assertFalse(image.getexif())
                self.assertNotIn('PRIVATE_SOURCE_DESCRIPTION', str(image.info))
            await self.get(env[kind + 'Url'], self.outsider, status=404)
        for path in (f"{PREFIX}/shares/{token}", f"{PREFIX}/models/{job['id']}"):
            payload = await (await self.get(path, self.outsider)).json()
            for kind in ('background', 'ground'):
                await self.get(payload['job']['environment'][kind + 'Url'], self.outsider)
            for forbidden in ('input.png', 'job.json', 'environment/untrusted-name.png'):
                await self.get(path + '/files/' + forbidden, self.outsider, status=404)

    async def test_presets_retain_private_custom_assets_and_replacement_revokes_old_paths(self):
        job = await self.create()
        token = await self.share(job)
        result = await self.update(job, background='custom', background_image=self.texture())
        initial = result['job']['environment']['backgroundUrl']
        old_path = self.studio.jobs[job['id']]['_environmentTextures']['background']
        result = await self.update(job, revision=1, background='dawn')
        self.assertEqual(result['job']['environment']['backgroundUrl'], initial)
        await self.get(initial)
        for prefix in (f"{PREFIX}/shares/{token}", f"{PREFIX}/models/{job['id']}"):
            public = await (await self.get(prefix, self.outsider)).json()
            self.assertIsNone(public['job']['environment']['backgroundUrl'])
            await self.get(prefix + '/files/' + old_path, self.outsider, status=404)
        restored = await self.update(job, revision=2, background='custom')
        self.assertEqual(restored['job']['environment']['backgroundUrl'], initial)
        result = await self.update(job, revision=3, background='custom', background_image=self.texture(color=(150, 30, 10)))
        self.assertNotEqual(result['job']['environment']['backgroundUrl'], initial)
        await self.get(initial, status=404)
        for prefix in (f"{PREFIX}/shares/{token}", f"{PREFIX}/models/{job['id']}"):
            await self.get(prefix + '/files/' + old_path, self.outsider, status=404)

    async def test_owner_and_origin_are_required_and_private_model_is_not_published(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        saved['visibility'] = 'private'
        self.studio.save(saved)
        await self.update(job, client=self.outsider, status=404, background='night')
        response = await self.client.put(f"{PREFIX}/jobs/{job['id']}/environment", data=self.form(), headers={'Origin': 'https://evil.example'})
        self.assertEqual(response.status, 403)
        await self.update(job, background='night')
        self.assertEqual(saved['visibility'], 'private')
        await self.get(f"{PREFIX}/models/{job['id']}", self.outsider, status=404)
        self.assertNotIn('_shareToken', saved)

    async def test_invalid_settings_never_change_memory_or_disk(self):
        job = await self.create()
        before = copy.deepcopy(self.studio.jobs[job['id']])
        settings = {**environment.DEFAULTS, 'expectedRevision': 0}
        invalid = [{'background': 'https://example.com/texture.jpg'}, {'backgroundUrl': 'https://example.com/a'},
                   {'ground': 'water'}, {'groundShape': 'sphere'}, {'backgroundProjection': 'sphere'},
                   {'groundScale': 0}, {'groundScale': 11}, {'groundScale': True}, {'groundScale': float('nan')},
                   {'backgroundRotation': 181}, {'backgroundRotation': '-10'}, {'backgroundRotation': float('inf')},
                   {'showGrid': 1}, {'expectedRevision': -1}, {'expectedRevision': True}, {'expectedRevision': 1.5},
                   {'expectedRevision': environment.MAX_REVISION}]
        for change in invalid:
            with self.subTest(change=change):
                await self.update(job, form=self.form(settings={**settings, **change}), status=400)
        for value in ([], {}, {key: value for key, value in settings.items() if key != 'expectedRevision'}):
            await self.update(job, form=self.form(settings=value), status=400)
        self.assertEqual(self.studio.jobs[job['id']], before)
        self.assertEqual(json.loads((server.JOB_ROOT / job['id'] / 'job.json').read_text(encoding='utf-8')), before)

    async def test_custom_selection_requires_texture_and_upload_pair_is_atomic(self):
        job = await self.create()
        before = copy.deepcopy(self.studio.jobs[job['id']])
        for kind in ('background', 'ground'):
            await self.update(job, status=400, **{kind: 'custom'})
        await self.update(job, status=400, background='custom', ground='custom',
                          background_image=self.texture(), ground_image=b'<svg><script>alert(1)</script></svg>')
        self.assertEqual(self.studio.jobs[job['id']], before)
        self.assertFalse((server.JOB_ROOT / job['id'] / 'environment').exists())

    async def test_image_size_format_animation_and_pixel_limits(self):
        job = await self.create()
        for raw in (b'', b'not an image', self.texture(size=(8, 8)), self.texture('BMP')):
            await self.update(job, status=400, background_image=raw)
        output = io.BytesIO()
        Image.new('RGB', (64, 32)).save(output, 'WEBP', save_all=True,
                                       append_images=[Image.new('RGB', (64, 32), 'red')], duration=100, loop=0)
        await self.update(job, status=400, background_image=output.getvalue())
        raw = b'X' * (environment.MAX_TEXTURE + 1)
        await self.update(job, status=413, background_image=raw)
        with patch.object(environment.Image, 'open') as opened:
            opened.return_value.__enter__.return_value.format = 'PNG'
            opened.return_value.__enter__.return_value.size = (8000, 5000)
            opened.return_value.__enter__.return_value.width = 8000
            opened.return_value.__enter__.return_value.height = 5000
            await self.update(job, status=400, background_image=b'fake pixel header')
        self.assertNotIn('environment', self.studio.jobs[job['id']])

    async def test_multipart_rejects_unknown_duplicate_and_oversized_settings(self):
        job = await self.create()
        for name, value in (('settings', '{}'), ('externalUrl', 'https://example.com/texture.jpg')):
            form = self.form()
            form.add_field(name, value)
            await self.update(job, form=form, status=400)
        form = aiohttp.FormData()
        form.add_field('settings', ' ' * (environment.MAX_SETTINGS + 1), content_type='application/json')
        await self.update(job, form=form, status=413)
        response = await self.client.put(f"{PREFIX}/jobs/{job['id']}/environment", json={**environment.DEFAULTS, 'expectedRevision': 0})
        self.assertEqual(response.status, 400)

    async def test_failed_and_deleted_models_cannot_receive_environment(self):
        job = await self.create()
        self.studio.jobs[job['id']]['status'] = 'failed'
        await self.update(job, status=409)
        self.studio.jobs[job['id']]['status'] = 'complete'
        (server.JOB_ROOT / job['id'] / 'model.glb').unlink()
        await self.update(job, status=409)

    async def test_revision_conflict_preserves_newer_settings_without_uploaded_files(self):
        job = await self.create()
        await self.update(job, background='sunset')
        before = copy.deepcopy(self.studio.jobs[job['id']])
        await self.update(job, status=409, background='custom', background_image=self.texture())
        self.assertEqual(self.studio.jobs[job['id']], before)
        self.assertFalse((server.JOB_ROOT / job['id'] / 'environment').exists())

    async def test_failed_metadata_save_rolls_back_new_files_and_same_revision_can_retry(self):
        job = await self.create()
        await self.update(job, background='custom', background_image=self.texture())
        before = copy.deepcopy(self.studio.jobs[job['id']])
        directory = server.JOB_ROOT / job['id']
        before_files = set(directory.rglob('*'))
        with patch.object(self.studio, 'save', side_effect=OSError('Simulated disk failure')):
            await self.update(job, revision=1, status=503, background='custom', ground='custom',
                              background_image=self.texture(color=(200, 50, 40)), ground_image=self.texture())
        self.assertEqual(self.studio.jobs[job['id']], before)
        self.assertEqual(set(directory.rglob('*')), before_files)
        self.assertEqual(json.loads((directory / 'job.json').read_text(encoding='utf-8')), before)
        result = await self.update(job, revision=1, background='night')
        self.assertEqual(result['job']['environment']['revision'], 2)

    async def delayed_body(self, job, interrupt, expected):
        started, resume = asyncio.Event(), asyncio.Event()
        original = self.studio.environment.read_form
        async def blocked(request):
            result = await original(request)
            started.set()
            await resume.wait()
            return result
        with patch.object(self.studio.environment, 'read_form', blocked):
            task = asyncio.create_task(self.update(job, status=expected, background='custom', background_image=self.texture()))
            try:
                await asyncio.wait_for(started.wait(), 5)
                await interrupt()
            finally:
                resume.set()
            await asyncio.wait_for(task, 5)

    async def test_deletion_while_reading_upload_cannot_recreate_model_directory(self):
        job = await self.create()
        async def interrupt():
            response = await self.client.delete(f"{PREFIX}/jobs/{job['id']}")
            self.assertEqual(response.status, 200)
        await self.delayed_body(job, interrupt, 404)
        self.assertNotIn(job['id'], self.studio.jobs)
        self.assertFalse((server.JOB_ROOT / job['id']).exists())

    async def test_account_claim_while_reading_upload_revokes_anonymous_edit(self):
        job = await self.create()
        async def interrupt():
            response = await self.client.post(PREFIX + '/auth/register', json={'username': 'new_author', 'displayName': 'Author', 'password': 'safe test password 123'})
            self.assertEqual(response.status, 200, await response.text())
        await self.delayed_body(job, interrupt, 404)
        self.assertNotIn('environment', self.studio.jobs[job['id']])
        self.assertFalse((server.JOB_ROOT / job['id'] / 'environment').exists())

    async def with_delayed_decode(self, job, interrupt, expected):
        started, resume = threading.Event(), threading.Event()
        original = environment.encode_texture
        def blocked(raw):
            started.set()
            if not resume.wait(10):
                raise RuntimeError('Test failed to resume decoder')
            return original(raw)
        with patch.object(environment, 'encode_texture', blocked):
            task = asyncio.create_task(self.update(job, status=expected, background='custom', background_image=self.texture()))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 5))
                await interrupt()
            finally:
                resume.set()
            return await asyncio.wait_for(task, 10)

    async def test_new_revision_during_image_decode_wins_without_orphaned_images(self):
        job = await self.create()
        async def interrupt():
            await self.update(job, background='night')
        await self.with_delayed_decode(job, interrupt, 409)
        self.assertEqual(self.studio.jobs[job['id']]['environment']['background'], 'night')
        self.assertFalse((server.JOB_ROOT / job['id'] / 'environment').exists())

    async def test_deletion_during_image_decode_is_rechecked(self):
        job = await self.create()
        async def interrupt():
            response = await self.client.delete(f"{PREFIX}/jobs/{job['id']}")
            self.assertEqual(response.status, 200)
        await self.with_delayed_decode(job, interrupt, 404)
        self.assertFalse((server.JOB_ROOT / job['id']).exists())

    async def test_concurrent_placement_is_preserved_during_environment_upload(self):
        job = await self.create()
        position = {'x': .4, 'y': -.14, 'z': .7}
        async def interrupt():
            response = await self.client.patch(f"{PREFIX}/jobs/{job['id']}/placement", json={'position': position})
            self.assertEqual(response.status, 200)
        result = await self.with_delayed_decode(job, interrupt, 200)
        self.assertEqual(result['job']['placement'], position)
        self.assertEqual(self.studio.jobs[job['id']]['placement'], position)

    async def test_invalid_stored_paths_never_expand_allowlist_or_serialize_as_urls(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        saved['_environmentTextures'] = {'background': 'input.png', 'ground': '../../private.webp'}
        saved['environment'] = {**environment.DEFAULTS, 'background': 'custom', 'ground': 'custom'}
        token = await self.share(job)
        for path in (f"{PREFIX}/jobs/{job['id']}", f"{PREFIX}/models/{job['id']}", f"{PREFIX}/shares/{token}"):
            payload = await (await self.get(path)).json()
            env = payload.get('job', payload)['environment']
            self.assertIsNone(env['backgroundUrl'])
            self.assertIsNone(env['groundUrl'])
        await self.get(f"{PREFIX}/shares/{token}/files/input.png", self.outsider, status=404)


if __name__ == '__main__':
    unittest.main()
