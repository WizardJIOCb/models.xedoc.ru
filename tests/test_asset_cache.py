"""Browser artifact revalidation over real HTTP, without GPU workloads."""
import os
import unittest

import test_studio


server = test_studio.server


class AssetCacheHTTPTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_studio.StudioHTTPTests.asyncSetUp
    asyncTearDown = test_studio.StudioHTTPTests.asyncTearDown
    upload = test_studio.StudioHTTPTests.upload
    create = test_studio.StudioHTTPTests.create

    async def get(self, path, client=None, **kwargs):
        client = client or self.client
        url = path if client is self.client else self.client.make_url(path)
        return await client.get(url, **kwargs)

    async def assert_revalidated(self, path, client=None):
        first = await self.get(path, client)
        self.assertEqual(first.status, 200, await first.text() if first.status != 200 else path)
        self.assertEqual(first.headers['Cache-Control'], 'private, no-cache')
        body = await first.read()
        self.assertTrue(body)
        etag = first.headers['ETag']
        modified = first.headers['Last-Modified']
        for headers in ({'If-None-Match': etag}, {'If-Modified-Since': modified}):
            cached = await self.get(path, client, headers=headers)
            self.assertEqual(cached.status, 304, path)
            self.assertEqual(await cached.read(), b'')
            self.assertEqual(cached.headers['ETag'], etag)
            self.assertEqual(cached.headers['Cache-Control'], 'private, no-cache')
        return etag, body

    async def test_owner_files_revalidate_and_new_contents_invalidate(self):
        job = await self.create()
        endpoint = f"/api/model-studio/files/{job['id']}/model.glb"
        etag, original = await self.assert_revalidated(endpoint)
        path = server.JOB_ROOT / job['id'] / 'model.glb'
        original_stat = path.stat()
        replacement = test_studio.small_glb(rigged=True)
        path.write_bytes(replacement)
        os.utime(path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns + 2_000_000_000))
        response = await self.get(endpoint, headers={'If-None-Match': etag})
        self.assertEqual(response.status, 200)
        self.assertNotEqual(response.headers['ETag'], etag)
        self.assertEqual(await response.read(), replacement)
        self.assertNotEqual(replacement, original)

    async def test_owner_cache_never_bypasses_another_session_or_logout(self):
        job = await self.create()
        endpoint = f"/api/model-studio/files/{job['id']}/model.glb"
        etag, _ = await self.assert_revalidated(endpoint)
        response = await self.get(endpoint, self.outsider, headers={'If-None-Match': etag})
        self.assertEqual(response.status, 404)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        registered = await self.client.post('/api/model-studio/auth/register', json={
            'username': 'cache_owner', 'displayName': 'Cache owner', 'password': 'safe test password 123'})
        self.assertEqual(registered.status, 200, await registered.text())
        self.assertEqual((await self.client.post('/api/model-studio/auth/logout')).status, 200)
        response = await self.get(endpoint, headers={'If-None-Match': etag})
        self.assertEqual(response.status, 404)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    async def test_shared_cache_revalidates_and_revoked_link_is_denied(self):
        job = await self.create()
        share_endpoint = f"/api/model-studio/jobs/{job['id']}/share"
        link = await (await self.client.post(share_endpoint)).json()
        endpoint = '/api/model-studio/shares/' + link['token'] + '/files/model.glb'
        etag, _ = await self.assert_revalidated(endpoint, self.outsider)
        self.assertEqual((await self.client.delete(share_endpoint)).status, 200)
        response = await self.get(endpoint, self.outsider, headers={'If-None-Match': etag})
        self.assertEqual(response.status, 404)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    async def test_public_cache_revalidates_and_private_visibility_is_denied(self):
        job = await self.create()
        endpoint = f"/api/model-studio/models/{job['id']}/files/model.glb"
        etag, _ = await self.assert_revalidated(endpoint, self.outsider)
        response = await self.client.patch(f"/api/model-studio/jobs/{job['id']}/publication",
                                           json={'visibility': 'private'})
        self.assertEqual(response.status, 200, await response.text())
        response = await self.get(endpoint, self.outsider, headers={'If-None-Match': etag})
        self.assertEqual(response.status, 404)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    async def test_rigs_motions_preview_and_demo_revalidate(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        directory = server.JOB_ROOT / job['id']
        for relative in ('rigs/revision1/rigged.glb', 'motions/animation1/animated.glb', 'preview.webp'):
            path = directory / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(test_studio.small_glb(rigged=True))
        saved['rig'] = {'available': True, 'status': 'complete', '_path': 'rigs/revision1/rigged.glb'}
        saved['motions'] = [{'id': 'animation1', 'status': 'complete'}]
        self.studio.save(saved)
        for relative in ('rigs/revision1/rigged.glb', 'motions/animation1/animated.glb', 'preview.webp'):
            await self.assert_revalidated(f"/api/model-studio/files/{job['id']}/{relative}")
        await self.assert_revalidated(f"/api/model-studio/models/{job['id']}/preview", self.outsider)
        demo = server.DATA / 'demo' / 'doom-rigged.glb'
        demo.parent.mkdir(parents=True)
        demo.write_bytes(test_studio.small_glb(rigged=True))
        await self.assert_revalidated('/api/model-studio/demo/glb', self.outsider)

    async def test_metadata_errors_and_source_image_remain_no_store(self):
        job = await self.create()
        link = await (await self.client.post(f"/api/model-studio/jobs/{job['id']}/share")).json()
        for endpoint in ('/api/model-studio/jobs', f"/api/model-studio/jobs/{job['id']}",
                         '/api/model-studio/shares/' + link['token'],
                         f"/api/model-studio/models/{job['id']}", job['sourceImageUrl']):
            response = await self.get(endpoint)
            self.assertEqual(response.status, 200, endpoint)
            self.assertEqual(response.headers['Cache-Control'], 'no-store', endpoint)
            await response.read()
        response = await self.get(f"/api/model-studio/files/{job['id']}/job.json")
        self.assertEqual(response.status, 404)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')


if __name__ == '__main__':
    unittest.main()
