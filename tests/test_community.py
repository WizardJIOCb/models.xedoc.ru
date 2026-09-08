"""Real HTTP/SQLite account and publication tests with the fake GPU pipeline."""
import asyncio
import base64
import hashlib
import io
import json
import sqlite3
import unittest
import uuid
from unittest.mock import patch

import aiohttp
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

import test_studio

server = test_studio.server


class CommunityHTTPTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_studio.StudioHTTPTests.asyncSetUp
    asyncTearDown = test_studio.StudioHTTPTests.asyncTearDown
    upload = test_studio.StudioHTTPTests.upload
    create = test_studio.StudioHTTPTests.create

    async def request(self, method, path, client=None, **kwargs):
        client = client or self.client
        url = path if client is self.client else self.client.make_url(path)
        return await client.request(method, url, **kwargs)

    async def register(self, username='maker_one', client=None, **kwargs):
        data = {'username': username, 'displayName': 'Мастер один', 'password': 'safe test password 123'}
        data.update(kwargs)
        response = await self.request('POST', '/api/model-studio/auth/register', client, json=data)
        self.assertEqual(response.status, 200, await response.text())
        return (await response.json())['user']

    async def publish(self, job, client=None, **kwargs):
        response = await self.request('PATCH', f"/api/model-studio/jobs/{job['id']}/publication", client, json=kwargs)
        self.assertEqual(response.status, 200, await response.text())
        return (await response.json())['job']

    async def get_json(self, path, client=None):
        response = await self.request('GET', path, client)
        self.assertEqual(response.status, 200, await response.text())
        return await response.json()

    def preview_data(self, fmt='PNG', color=(30, 100, 90)):
        output = io.BytesIO()
        image = Image.new('RGB', (120, 80), color)
        image.save(output, fmt)
        return 'data:image/' + fmt.lower() + ';base64,' + base64.b64encode(output.getvalue()).decode('ascii')

    async def test_new_public_default_and_explicit_private_preserve_legacy_privacy(self):
        public = await self.create()
        self.assertEqual(public['visibility'], 'public')
        form = self.upload()
        form.add_field('visibility', 'private')
        response = await self.client.post('/api/model-studio/jobs', data=form)
        self.assertEqual(response.status, 202, await response.text())
        private = await response.json()
        await self.studio.queue.join()
        legacy = await self.create()
        self.studio.jobs[legacy['id']].pop('visibility')
        self.studio.save(self.studio.jobs[legacy['id']])
        gallery = await self.get_json('/api/model-studio/gallery', self.outsider)
        self.assertEqual([row['id'] for row in gallery['models']], [public['id']])
        self.assertEqual((await self.get_json(f"/api/model-studio/jobs/{legacy['id']}"))['visibility'], 'private')
        for job in (private, legacy):
            self.assertEqual((await self.request('GET', f"/api/model-studio/models/{job['id']}", self.outsider)).status, 404)
        self.assertEqual((await self.get_json(f"/api/model-studio/models/{public['id']}", self.outsider))['canEdit'], False)

    async def test_public_model_views_are_persisted_and_hidden_models_do_not_count(self):
        job = await self.create()
        endpoint = f"/api/model-studio/models/{job['id']}/view"
        self.assertEqual((await self.get_json(f"/api/model-studio/models/{job['id']}", self.outsider))['model']['viewsCount'], 0)
        response = await self.request('POST', endpoint, self.outsider)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())['viewsCount'], 1)
        self.assertEqual((await self.get_json('/api/model-studio/gallery', self.outsider))['models'][0]['viewsCount'], 1)
        self.assertEqual((await self.get_json(f"/api/model-studio/models/{job['id']}", self.outsider))['model']['viewsCount'], 1)
        await self.publish(job, visibility='private')
        self.assertEqual((await self.request('POST', endpoint, self.outsider)).status, 404)

    async def test_register_claims_job_and_logout_removes_anonymous_access(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        legacy_owner = saved['_owner']
        user = await self.register()
        self.assertIs(self.studio.jobs[job['id']], saved)
        self.assertEqual(saved['_accountId'], user['id'])
        owner_job = await self.get_json(f"/api/model-studio/jobs/{job['id']}")
        self.assertEqual(owner_job['author']['username'], 'maker_one')
        self.assertNotIn('_accountId', json.dumps(owner_job))
        self.assertNotIn(legacy_owner, json.dumps(owner_job))
        self.assertEqual((await self.client.post('/api/model-studio/auth/logout')).status, 200)
        self.assertEqual((await self.get_json('/api/model-studio/auth/me'))['user'], None)
        self.assertEqual((await self.client.get(f"/api/model-studio/jobs/{job['id']}")).status, 404)
        self.assertEqual((await self.client.get(job['sourceImageUrl'])).status, 404)
        self.assertEqual((await self.get_json('/api/model-studio/jobs'))['jobs'], [])
        response = await self.request('POST', '/api/model-studio/auth/login', self.outsider,
                                      json={'username': 'MAKER_ONE', 'password': 'safe test password 123'})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await self.get_json('/api/model-studio/jobs', self.outsider))['jobs'][0]['id'], job['id'])
        self.assertEqual((await self.request('GET', job['sourceImageUrl'], self.outsider)).status, 200)

    async def test_registration_does_not_publish_old_jobs_and_login_claims_new_anonymous_jobs(self):
        job = await self.create()
        self.studio.jobs[job['id']].pop('visibility')
        user = await self.register()
        self.assertEqual(user['modelCount'], 0)
        self.assertNotIn('visibility', self.studio.jobs[job['id']])
        await self.client.post('/api/model-studio/auth/logout')
        second = await self.create()
        response = await self.client.post('/api/model-studio/auth/login', json={'username': 'maker_one', 'password': 'safe test password 123'})
        self.assertEqual(response.status, 200)
        self.assertEqual(self.studio.jobs[second['id']]['_accountId'], user['id'])
        self.assertEqual((await response.json())['user']['modelCount'], 1)

    async def test_profile_edit_search_and_model_metadata_search(self):
        user = await self.register()
        await self.register('other_user', self.outsider, displayName='Другой автор')
        job = await self.create()
        updated = await self.publish(job, title='Боевой орк', description='Красная броня', visibility='public')
        self.assertEqual(updated['title'], 'Боевой орк')
        response = await self.client.patch('/api/model-studio/auth/profile', json={'displayName': 'Кузнец', 'bio': 'Скульптуры <script>plain text</script>'})
        self.assertEqual(response.status, 200)
        profile = (await self.get_json('/api/model-studio/profiles/MAKER_ONE', self.outsider))['profile']
        self.assertEqual(profile['displayName'], 'Кузнец')
        self.assertEqual(profile['modelCount'], 1)
        self.assertEqual(profile['id'], user['id'])
        self.assertNotIn('password', json.dumps(profile))
        profiles = await self.get_json('/api/model-studio/profiles?q=КУЗ', self.outsider)
        self.assertEqual([row['username'] for row in profiles['profiles']], ['maker_one'])
        for query in ('Боевой', 'броня', 'Кузнец', 'maker_one'):
            result = await self.get_json('/api/model-studio/gallery?q=' + query, self.outsider)
            self.assertEqual(result['total'], 1)
        self.assertEqual((await self.get_json('/api/model-studio/gallery?author=OTHER_USER', self.outsider))['total'], 0)
        page = await self.get_json('/api/model-studio/profiles?offset=1&limit=1')
        self.assertEqual(page['total'], 2)
        self.assertEqual(len(page['profiles']), 1)

    async def test_private_hides_all_public_routes_revokes_share_and_preserves_comments(self):
        job = await self.create()
        await self.register()
        await self.register('commenter', self.outsider)
        token = (await (await self.client.post(f"/api/model-studio/jobs/{job['id']}/share")).json())['token']
        comment_response = await self.request('POST', f"/api/model-studio/models/{job['id']}/comments", self.outsider, json={'body': 'Отличная модель'})
        self.assertEqual(comment_response.status, 201)
        response = await self.client.post(f"/api/model-studio/jobs/{job['id']}/preview", json={'image': self.preview_data()})
        self.assertEqual(response.status, 200, await response.text())
        await self.publish(job, visibility='private')
        self.assertNotIn('_shareToken', self.studio.jobs[job['id']])
        for suffix in ('', '/files/model.glb', '/files/input.png', '/preview', '/comments'):
            response = await self.request('GET', f"/api/model-studio/models/{job['id']}" + suffix, self.outsider)
            self.assertEqual(response.status, 404, suffix)
        self.assertEqual((await self.request('GET', '/api/model-studio/shares/' + token, self.outsider)).status, 404)
        self.assertEqual((await self.get_json('/api/model-studio/gallery', self.outsider))['total'], 0)
        self.assertEqual((await self.get_json('/api/model-studio/profiles/maker_one', self.outsider))['profile']['modelCount'], 0)
        self.assertEqual((await self.request('POST', f"/api/model-studio/models/{job['id']}/comments", self.outsider, json={'body': 'Hidden'})).status, 404)
        await self.publish(job, visibility='public')
        self.assertEqual((await self.get_json(f"/api/model-studio/models/{job['id']}/comments", self.outsider))['total'], 1)
        self.assertEqual((await self.request('GET', '/api/model-studio/shares/' + token, self.outsider)).status, 404)

    async def test_preview_is_reencoded_public_artifacts_never_expose_source_or_prompt(self):
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        saved['error'] = 'PRIVATE_JOB_ERROR'
        saved['rig']['error'] = 'PRIVATE_RIG_ERROR'
        saved['_shareToken'] = 'PRIVATE_SHARE_TOKEN'
        saved['motions'].append({'id': 'motion1', 'status': 'complete', 'prompt': 'PRIVATE_PROMPT', '_kimodoId': 'PRIVATE_KIMODO'})
        response = await self.client.post(f"/api/model-studio/jobs/{job['id']}/preview", json={'image': self.preview_data()})
        self.assertEqual(response.status, 200, await response.text())
        owner = (await response.json())['job']
        self.assertIn('/files/', owner['previewUrl'])
        public = await self.get_json(f"/api/model-studio/models/{job['id']}", self.outsider)
        encoded = json.dumps(public)
        for forbidden in ('PRIVATE_', 'input.png', 'sourceImageUrl', '_owner', '_accountId', '_previewRevision', 'seed', 'quality'):
            self.assertNotIn(forbidden, encoded)
        self.assertEqual(public['job']['artifacts']['modelUrl'], f"/api/model-studio/models/{job['id']}/files/model.glb")
        image_response = await self.request('GET', public['model']['previewUrl'], self.outsider)
        self.assertEqual(image_response.status, 200)
        with Image.open(io.BytesIO(await image_response.read())) as image:
            self.assertEqual(image.format, 'WEBP')
        for path in (job['sourceImageUrl'], owner['previewUrl'], f"/api/model-studio/models/{job['id']}/files/input.png",
                     f"/api/model-studio/models/{job['id']}/files/job.json", f"/api/model-studio/models/{job['id']}/files/preview.webp"):
            self.assertEqual((await self.request('GET', path, self.outsider)).status, 404, path)

    async def test_preview_invalid_input_and_cross_owner_never_write(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/preview"
        self.assertEqual((await self.request('POST', endpoint, self.outsider, json={'image': self.preview_data()})).status, 404)
        for value in ({}, {'image': 'data:image/svg+xml;base64,PHN2Zz4='}, {'image': 'data:image/webp;base64,YmFk'},
                      {'image': 123}, {'image': self.preview_data(), 'extra': True}):
            response = await self.client.post(endpoint, json=value)
            self.assertEqual(response.status, 400, await response.text())
        self.assertFalse((server.JOB_ROOT / job['id'] / 'preview.webp').exists())
        oversized = 'data:image/webp;base64,' + 'A' * (3 * 1024 * 1024)
        response = await self.client.post(endpoint, json={'image': oversized})
        self.assertEqual(response.status, 413)

    async def test_comment_authorship_moderation_and_delete_cleanup(self):
        job = await self.create()
        await self.register('owner')
        endpoint = f"/api/model-studio/models/{job['id']}/comments"
        self.assertEqual((await self.request('POST', endpoint, self.outsider, json={'body': 'Hello'})).status, 401)
        await self.register('guest', self.outsider)
        body = '<img src=x onerror=alert(1)> обычный текст'
        response = await self.request('POST', endpoint, self.outsider, json={'body': body})
        self.assertEqual(response.status, 201)
        cid = (await response.json())['comment']['id']
        owner_comments = await self.get_json(endpoint)
        self.assertEqual(owner_comments['comments'][0]['body'], body)
        self.assertTrue(owner_comments['comments'][0]['canDelete'])
        guest_comments = await self.get_json(endpoint, self.outsider)
        self.assertTrue(guest_comments['comments'][0]['canDelete'])
        async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as third:
            await self.register('third_user', third)
            self.assertFalse((await self.get_json(endpoint, third))['comments'][0]['canDelete'])
            self.assertEqual((await self.request('DELETE', '/api/model-studio/comments/' + cid, third)).status, 404)
        self.assertEqual((await self.client.delete('/api/model-studio/comments/' + cid)).status, 200)
        response = await self.request('POST', endpoint, self.outsider, json={'body': 'Second comment'})
        second_id = (await response.json())['comment']['id']
        self.assertEqual((await self.client.delete(f"/api/model-studio/jobs/{job['id']}")).status, 200)
        self.assertEqual(self.studio.community.db.execute('SELECT COUNT(*) FROM comments').fetchone()[0], 0)
        self.assertEqual((await self.request('DELETE', '/api/model-studio/comments/' + second_id, self.outsider)).status, 404)

    async def test_unauthorized_model_mutations_and_same_origin_checks(self):
        job = await self.create()
        await self.register('owner')
        await self.register('visitor', self.outsider)
        paths = [('PATCH', '/publication', {'visibility': 'private'}), ('POST', '/preview', {'image': self.preview_data()}),
                 ('PATCH', '/placement', {'position': {'x': 0, 'y': 0, 'z': 0}}), ('POST', '/share', {})]
        for method, suffix, data in paths:
            response = await self.request(method, f"/api/model-studio/jobs/{job['id']}" + suffix, self.outsider, json=data)
            self.assertEqual(response.status, 404)
        self.assertEqual((await self.request('DELETE', f"/api/model-studio/jobs/{job['id']}", self.outsider)).status, 404)
        response = await self.client.patch('/api/model-studio/auth/profile', json={'bio': 'evil'}, headers={'Origin': 'https://evil.test'})
        self.assertEqual(response.status, 403)
        response = await self.client.post('/api/model-studio/auth/logout', headers={'Origin': 'https://evil.test'})
        self.assertEqual(response.status, 403)
        self.assertIsNotNone((await self.get_json('/api/model-studio/auth/me'))['user'])

    async def test_password_session_hashes_cookie_flags_rotation_logout_and_expiry(self):
        response = await self.client.post('/api/model-studio/auth/register', json={'username': 'secure_user', 'password': 'safe test password 123'}, headers={'X-Forwarded-Proto': 'https'})
        self.assertEqual(response.status, 200)
        cookie = response.cookies['model_studio_auth']
        self.assertTrue(cookie['httponly'])
        self.assertTrue(cookie['secure'])
        self.assertEqual(cookie['samesite'], 'Lax')
        token = cookie.value
        db = self.studio.community.db
        account = db.execute('SELECT * FROM users').fetchone()
        self.assertNotEqual(account['password_hash'], 'safe test password 123')
        self.assertEqual(len(account['password_salt']), 64)
        hashed = db.execute('SELECT token_hash FROM auth_sessions').fetchone()[0]
        self.assertNotEqual(token, hashed)
        self.assertEqual(hashed, hashlib.sha256(token.encode('ascii')).hexdigest())
        # Secure cookies are not sent over this HTTP test origin. Supply the
        # known disposable token explicitly to exercise authenticated responses.
        headers = {'Cookie': 'model_studio_auth=' + token}
        self.assertIsNotNone((await (await self.client.get('/api/model-studio/auth/me', headers=headers)).json())['user'])
        response = await self.client.post('/api/model-studio/auth/login', json={'username': 'secure_user', 'password': 'safe test password 123'}, headers=headers)
        self.assertEqual(response.status, 200)
        self.assertNotEqual(response.cookies['model_studio_auth'].value, token)
        self.assertEqual(db.execute('SELECT COUNT(*) FROM auth_sessions WHERE token_hash = ?', (hashed,)).fetchone()[0], 0)
        with db:
            db.execute('UPDATE auth_sessions SET expires_at = 0')
        self.assertEqual((await self.get_json('/api/model-studio/auth/me'))['user'], None)

    async def test_account_comments_settings_and_auth_session_survive_restart(self):
        job = await self.create()
        user = await self.register()
        await self.publish(job, title='Сохранённый орк', description='Проверка диска')
        response = await self.client.post(f"/api/model-studio/models/{job['id']}/comments", json={'body': 'Сохраняется после перезапуска'})
        self.assertEqual(response.status, 201)
        response = await self.client.patch(f"/api/model-studio/jobs/{job['id']}/placement", json={'position': {'x': 0, 'y': -0.14, 'z': 0}, 'rotation': {'x': -10, 'y': 0, 'z': 0}})
        self.assertEqual(response.status, 200)
        cookies = {cookie.key: cookie.value for cookie in self.client.session.cookie_jar}
        await self.client.close()
        self.app = server.create_app()
        self.client = TestClient(TestServer(self.app), cookie_jar=aiohttp.CookieJar(unsafe=True))
        await self.client.start_server()
        self.client.session.cookie_jar.update_cookies(cookies, response_url=self.client.make_url('/'))
        self.studio = self.app['studio']
        self.assertEqual((await self.get_json('/api/model-studio/auth/me'))['user']['id'], user['id'])
        loaded = await self.get_json(f"/api/model-studio/jobs/{job['id']}")
        self.assertEqual(loaded['title'], 'Сохранённый орк')
        self.assertEqual(loaded['placement']['y'], -0.14)
        self.assertEqual(loaded['modelRotation']['x'], -10)
        self.assertEqual((await self.get_json(f"/api/model-studio/models/{job['id']}/comments"))['total'], 1)

    async def test_registration_validation_case_insensitive_duplicate_and_bounded_fields(self):
        for data in ({'username': 'абв', 'password': 'password123'}, {'username': 'ab', 'password': 'password123'},
                     {'username': 'valid_user', 'password': 'short'}, {'username': 'valid_user', 'password': 'p' * 129},
                     {'username': 'valid_user', 'password': 'password123', 'displayName': 'x' * 61}):
            self.assertEqual((await self.client.post('/api/model-studio/auth/register', json=data)).status, 400)
        await self.register('Taken_Name')
        self.assertEqual((await self.request('POST', '/api/model-studio/auth/register', self.outsider,
                                              json={'username': 'taken_name', 'password': 'password123'})).status, 409)
        self.assertEqual(self.studio.community.db.execute('SELECT COUNT(*) FROM users').fetchone()[0], 1)
        self.assertEqual((await self.client.patch('/api/model-studio/auth/profile', json={'bio': 'x' * 1001})).status, 400)
        for query in ('offset=-1', 'limit=0', 'limit=101', 'offset=nan', 'q=' + 'x' * 101):
            self.assertEqual((await self.client.get('/api/model-studio/gallery?' + query)).status, 400)

    async def test_publication_validation_and_disk_failure_are_atomic(self):
        job = await self.create()
        token = (await (await self.client.post(f"/api/model-studio/jobs/{job['id']}/share")).json())['token']
        saved = self.studio.jobs[job['id']]
        original = json.loads(json.dumps(saved))
        endpoint = f"/api/model-studio/jobs/{job['id']}/publication"
        for data in ({'visibility': 'private', 'title': ''}, {'visibility': 'private', 'description': 'x' * 2001},
                     {'visibility': 'world'}, {'title': True}, {'unexpected': 'bad'}):
            self.assertEqual((await self.client.patch(endpoint, json=data)).status, 400)
            self.assertEqual(saved, original)
        with patch.object(self.studio, 'save', side_effect=OSError('disk unavailable')):
            response = await self.client.patch(endpoint, json={'visibility': 'private'})
            self.assertEqual(response.status, 503)
        self.assertEqual(saved, original)
        self.assertEqual(saved['_shareToken'], token)

    async def test_comment_rate_limit_and_invalid_body(self):
        job = await self.create()
        await self.register()
        endpoint = f"/api/model-studio/models/{job['id']}/comments"
        for data in ({'body': ''}, {'body': 'x' * 2001}, {'body': []}, {'body': 'okay', 'extra': True}):
            self.assertEqual((await self.client.post(endpoint, json=data)).status, 400)
        self.studio.community.rates.clear()
        for index in range(8):
            self.assertEqual((await self.client.post(endpoint, json={'body': f'Comment {index}'})).status, 201)
        self.assertEqual((await self.client.post(endpoint, json={'body': 'too many'})).status, 429)
        self.assertEqual((await self.get_json(endpoint))['total'], 8)

    async def test_auth_rate_limit_does_not_depend_on_rotating_cookie(self):
        for index in range(20):
            response = await self.request('POST', '/api/model-studio/auth/register', self.outsider,
                                          json={'username': 'x', 'password': 'short'}, headers={'Cookie': f'model_studio_session={index:048x}'})
            self.assertEqual(response.status, 400)
        response = await self.request('POST', '/api/model-studio/auth/register', self.outsider,
                                      json={'username': 'valid', 'password': 'password123'}, headers={'Cookie': 'model_studio_session=' + 'f' * 48})
        self.assertEqual(response.status, 429)
        self.assertEqual(self.studio.community.db.execute('SELECT COUNT(*) FROM users').fetchone()[0], 0)

    async def delayed_json(self, method, path, payload, interrupt, client=None):
        ready, resume = asyncio.Event(), asyncio.Event()
        original = self.studio.json_object
        async def read(request):
            data = await original(request)
            if request.path == path:
                ready.set()
                await resume.wait()
            return data
        with patch.object(self.studio, 'json_object', side_effect=read):
            task = asyncio.create_task(self.request(method, path, client, json=payload))
            await asyncio.wait_for(ready.wait(), 3)
            await interrupt()
            resume.set()
            return await task

    async def test_comment_waiting_for_body_cannot_reappear_after_private_or_delete(self):
        job = await self.create()
        await self.register('author')
        await self.register('commenter', self.outsider)
        endpoint = f"/api/model-studio/models/{job['id']}/comments"
        async def hide():
            await self.publish(job, visibility='private')
        response = await self.delayed_json('POST', endpoint, {'body': 'Late comment'}, hide, self.outsider)
        self.assertEqual(response.status, 404)
        self.assertEqual(self.studio.community.db.execute('SELECT COUNT(*) FROM comments').fetchone()[0], 0)
        await self.publish(job, visibility='public')
        async def delete():
            self.assertEqual((await self.client.delete(f"/api/model-studio/jobs/{job['id']}")).status, 200)
        response = await self.delayed_json('POST', endpoint, {'body': 'Late comment'}, delete, self.outsider)
        self.assertEqual(response.status, 404)
        self.assertEqual(self.studio.community.db.execute('SELECT COUNT(*) FROM comments').fetchone()[0], 0)

    async def test_publication_waiting_for_body_cannot_resurrect_deleted_job(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/publication"
        async def delete():
            self.assertEqual((await self.client.delete(f"/api/model-studio/jobs/{job['id']}")).status, 200)
        response = await self.delayed_json('PATCH', endpoint, {'visibility': 'public', 'title': 'Late title'}, delete)
        self.assertEqual(response.status, 404)
        self.assertNotIn(job['id'], self.studio.jobs)
        self.assertFalse((server.JOB_ROOT / job['id']).exists())

    async def test_anonymous_inflight_write_loses_access_when_registration_claims_job(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/publication"
        async def claim():
            await self.register()
        response = await self.delayed_json('PATCH', endpoint, {'title': 'Late anonymous edit'}, claim)
        self.assertEqual(response.status, 404)
        self.assertNotIn('title', self.studio.jobs[job['id']])

    async def test_delayed_gpu_requests_cannot_reserve_job_after_account_claim(self):
        for suffix, payload in (('/rig', {'rotation': {'x': 0, 'y': 0, 'z': 0}}),
                                ('/animate', {'prompt': 'walk', 'frames': 60, 'steps': 20})):
            job = await self.create()
            if suffix == '/animate':
                saved = self.studio.jobs[job['id']]
                saved['rig'].update(available=True, status='complete')
                directory = server.JOB_ROOT / job['id'] / 'rig'
                directory.mkdir()
                (directory / 'rigged.glb').write_bytes(test_studio.small_glb(rigged=True))
            async def claim():
                await self.register('rig_owner' if suffix == '/rig' else 'motion_owner')
            response = await self.delayed_json('POST', f"/api/model-studio/jobs/{job['id']}" + suffix, payload, claim)
            self.assertEqual(response.status, 404, await response.text())
            self.assertTrue(self.studio.rig_queue.empty())
            self.assertTrue(self.studio.queue.empty())
            self.assertEqual(self.studio.jobs[job['id']]['motions'], [])
            await self.client.post('/api/model-studio/auth/logout')

    async def test_streaming_preview_cannot_recreate_deleted_directory(self):
        job = await self.create()
        endpoint = f"/api/model-studio/jobs/{job['id']}/preview"
        entered, resume = asyncio.Event(), asyncio.Event()
        original_owned = self.studio.owned
        def owned(request):
            value = original_owned(request)
            if request.path == endpoint:
                entered.set()
            return value
        async def body():
            yield b'{'
            await resume.wait()
            yield json.dumps({'image': self.preview_data()}).encode('utf-8')[1:]
        with patch.object(self.studio, 'owned', side_effect=owned):
            task = asyncio.create_task(self.client.post(endpoint, data=body(), headers={'Content-Type': 'application/json'}))
            await asyncio.wait_for(entered.wait(), 3)
            self.assertEqual((await self.client.delete(f"/api/model-studio/jobs/{job['id']}")).status, 200)
            resume.set()
            response = await task
        self.assertEqual(response.status, 404, await response.text())
        self.assertFalse((server.JOB_ROOT / job['id']).exists())

    async def test_two_simultaneous_registrations_cannot_duplicate_username(self):
        data = {'username': 'same_login', 'password': 'safe test password 123'}
        results = await asyncio.gather(self.client.post('/api/model-studio/auth/register', json=data),
                                       self.request('POST', '/api/model-studio/auth/register', self.outsider, json=data))
        self.assertEqual(sorted(response.status for response in results), [200, 409])
        self.assertEqual(self.studio.community.db.execute('SELECT COUNT(*) FROM users').fetchone()[0], 1)
        self.assertEqual(self.studio.community.db.execute('SELECT COUNT(*) FROM auth_sessions').fetchone()[0], 1)

    async def test_generation_accepts_full_form_and_authenticated_owner(self):
        user = await self.register()
        form = self.upload()
        form.add_field('quality', 'standard')
        form.add_field('seed', '42')
        form.add_field('visibility', 'private')
        response = await self.client.post('/api/model-studio/jobs', data=form)
        self.assertEqual(response.status, 202, await response.text())
        job = await response.json()
        await self.studio.queue.join()
        self.assertEqual(job['visibility'], 'private')
        self.assertEqual(job['author']['id'], user['id'])
        self.assertEqual(self.studio.jobs[job['id']]['_accountId'], user['id'])
        self.assertEqual((await self.get_json('/api/model-studio/gallery'))['total'], 0)

    async def test_gallery_checks_public_artifacts_once_per_job_before_pagination(self):
        await self.register()
        job = await self.create()
        saved = self.studio.jobs[job['id']]
        for index in range(40):
            jid = str(uuid.uuid4())
            directory = server.JOB_ROOT / jid
            directory.mkdir()
            (directory / 'model.glb').write_bytes(test_studio.small_glb())
            self.studio.jobs[jid] = {**saved, 'id': jid, 'title': f'Copy {index}'}
        original = self.studio.community.is_public
        with patch.object(self.studio.community, 'is_public', wraps=original) as checks:
            result = await self.get_json('/api/model-studio/gallery?limit=8', self.outsider)
        self.assertEqual(result['total'], 41)
        self.assertEqual(len(result['models']), 8)
        self.assertEqual(result['models'][0]['author']['modelCount'], 41)
        self.assertEqual(checks.call_count, 41)


if __name__ == '__main__':
    unittest.main()
