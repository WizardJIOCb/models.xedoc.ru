"""Real HTTP cache/access tests, with tiny streams and no GPU or Blender."""
import asyncio
import copy
import unittest
import uuid

from aiohttp import web
from aiohttp.test_utils import TestServer

import test_studio
import test_community

server = test_studio.server
SID = '04c476c0b516a5a6'
ROW = {'id': SID, 'prompt': 'Walk then stop', 'frames': 90, 'created_at': '2026-09-07', 'model': 'smplx-rp-v1', 'status': 'ready'}


class LibraryTests(unittest.IsolatedAsyncioTestCase):
    upload = test_studio.StudioHTTPTests.upload
    create = test_studio.StudioHTTPTests.create

    async def asyncSetUp(self):
        await test_studio.StudioHTTPTests.asyncSetUp(self)
        self.history = [copy.deepcopy(ROW)]
        self.history_calls = 0
        async def history():
            self.history_calls += 1
            return self.history
        self.studio.legacy_history = history
        self.bad_stream = False
        async def stream(request):
            size = 90 * (3 if request.match_info['file'] == 'root.f32' else 88) * 4
            return web.Response(body=bytes(size - int(self.bad_stream)))
        source = web.Application()
        source.router.add_get('/api/animations/{id}/{file}', stream)
        self.remote = TestServer(source)
        await self.remote.start_server()
        self.studio.motion_library.kimodo = str(self.remote.make_url('/')).rstrip('/')
        self.blender_calls = 0
        self.started, self.resume = asyncio.Event(), asyncio.Event()
        self.resume.set()
        async def blender(script, args, output_dir, timeout=900):
            self.assertEqual(script, 'retarget_motion.py')
            self.blender_calls += 1
            self.started.set()
            await self.resume.wait()
            output = args[args.index('--output') + 1]
            output.write_bytes(test_studio.small_glb(rigged=True))
        self.studio.run_blender = blender
        saved = await self.create()
        self.job = self.studio.jobs[saved['id']]
        self.install_rig()

    def install_rig(self):
        revision = str(uuid.uuid4())
        path = f'rigs/{revision}/rigged.glb'
        file = server.JOB_ROOT / self.job['id'] / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(test_studio.small_glb(rigged=True))
        self.job['rig'] = {'available': True, 'status': 'complete', 'revision': revision, '_path': path}
        self.job['artifacts']['riggedUrl'] = self.studio.file_url(self.job, path)
        self.studio.save(self.job)

    def url(self, public=False):
        job = self.job
        base = f"/api/model-studio/models/{job['id']}/files/" if public else self.studio.file_url(job, '')
        return base + f"library/{job['rig']['revision']}/{SID}/animated.glb"

    async def asyncTearDown(self):
        self.resume.set()
        await test_studio.StudioHTTPTests.asyncTearDown(self)
        await self.remote.close()

    async def test_catalog_ready_only_and_private_source_filter(self):
        self.history += [{**ROW, 'id': 'abcdefabcdefabcd', 'status': 'failed'},
                         {**ROW, 'id': '../bad'}, {**ROW, 'id': '1111111111111111', 'frames': True},
                         {**ROW, 'id': '2222222222222222', 'model': 'different'}]
        url = '/api/model-studio/motion-library'
        result = await (await self.client.get(url)).json()
        self.assertEqual([m['id'] for m in result['motions']], [SID])
        self.job.update(visibility='private', motions=[{'id': 'private', '_kimodoId': SID, 'status': 'complete'}])
        result = await (await self.outsider.get(self.client.make_url(url))).json()
        self.assertEqual(result['motions'], [])
        self.assertEqual(len((await (await self.client.get(url)).json())['motions']), 1)
        self.assertEqual(self.history_calls, 1)

    async def test_concurrent_cache_shared_public_owner_and_etag(self):
        self.resume.clear()
        first = asyncio.create_task(self.client.get(self.url()))
        await asyncio.wait_for(self.started.wait(), 2)
        second = asyncio.create_task(self.client.get(self.url()))
        self.resume.set()
        responses = await asyncio.gather(first, second)
        self.assertEqual([r.status for r in responses], [200, 200])
        self.assertEqual(await responses[0].read(), await responses[1].read())
        self.assertEqual(self.blender_calls, 1)
        etag = responses[0].headers['ETag']
        self.assertEqual((await self.client.get(self.url(), headers={'If-None-Match': etag})).status, 304)
        self.assertEqual((await self.outsider.get(self.client.make_url(self.url(public=True)))).status, 200)
        share = await (await self.client.post(f"/api/model-studio/jobs/{self.job['id']}/share")).json()
        token = self.job['_shareToken']
        name = f"library/{self.job['rig']['revision']}/{SID}/animated.glb"
        link = f'/api/model-studio/shares/{token}/files/{name}'
        self.assertEqual((await self.outsider.get(self.client.make_url(link))).status, 200)
        self.job.pop('_shareToken')
        self.assertEqual((await self.outsider.get(self.client.make_url(link), headers={'If-None-Match': etag})).status, 404)
        self.assertEqual(self.blender_calls, 1)
        self.assertEqual(self.job['motions'], [])

    async def test_private_model_and_new_rig_do_not_reuse_old_cache(self):
        old = self.url()
        self.assertEqual((await self.client.get(old)).status, 200)
        self.job['visibility'] = 'private'
        self.assertEqual((await self.outsider.get(self.client.make_url(self.url(public=True)))).status, 404)
        self.assertEqual((await self.outsider.get(self.client.make_url(old))).status, 404)
        self.install_rig()
        self.assertEqual((await self.client.get(old)).status, 409)
        self.assertEqual((await self.client.get(self.url())).status, 200)
        self.assertEqual(self.blender_calls, 2)

    async def test_bake_blocks_delete_cleanup_and_rig_rebuild(self):
        self.resume.clear()
        task = asyncio.create_task(self.client.get(self.url()))
        await asyncio.wait_for(self.started.wait(), 2)
        endpoint = f"/api/model-studio/jobs/{self.job['id']}"
        self.assertEqual((await self.client.delete(endpoint)).status, 409)
        self.assertEqual((await self.client.post(endpoint + '/mesh-restore', json={'expectedRevision': 0})).status, 409)
        self.assertEqual((await self.client.post(endpoint + '/rig', json={'rotation': {'x': 0, 'y': 0, 'z': 0}})).status, 409)
        self.resume.set()
        self.assertEqual((await task).status, 200)

    async def test_changed_rig_during_bake_never_publishes_old_geometry(self):
        self.resume.clear()
        old = self.url()
        task = asyncio.create_task(self.client.get(old))
        await asyncio.wait_for(self.started.wait(), 2)
        self.install_rig()
        self.resume.set()
        self.assertEqual((await task).status, 409)
        self.assertEqual(list((server.JOB_ROOT / self.job['id'] / 'library').rglob('animated.glb')), [])

    async def test_invalid_stream_is_not_cached_and_retry_recovers(self):
        self.bad_stream = True
        self.assertEqual((await self.client.get(self.url())).status, 400)
        self.assertEqual(self.blender_calls, 0)
        self.bad_stream = False
        self.assertEqual((await self.client.get(self.url())).status, 200)
        self.assertEqual(self.blender_calls, 1)


class OwnerCommentTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_studio.StudioHTTPTests.asyncSetUp
    asyncTearDown = test_studio.StudioHTTPTests.asyncTearDown
    upload = test_studio.StudioHTTPTests.upload
    create = test_studio.StudioHTTPTests.create
    register = test_community.CommunityHTTPTests.register
    request = test_community.CommunityHTTPTests.request

    async def test_owner_comments_private_model_without_exposing_it(self):
        job = await self.create()
        await self.register('private_owner')
        self.studio.jobs[job['id']]['visibility'] = 'private'
        url = f"/api/model-studio/models/{job['id']}/comments"
        self.assertEqual((await self.client.post(url, json={'body': 'Моя заметка'})).status, 201)
        self.assertEqual((await (await self.client.get(url)).json())['total'], 1)
        await self.register('guest', self.outsider)
        self.assertEqual((await self.outsider.get(self.client.make_url(url))).status, 404)
        self.assertEqual((await self.outsider.post(self.client.make_url(url), json={'body': 'Скрыто'})).status, 404)
