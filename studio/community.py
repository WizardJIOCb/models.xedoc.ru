"""Accounts, public models and comments for the local Studio service.

Generation files remain in the existing per-job folders. SQLite stores only
accounts, hashed login sessions and comments; source images are never public.
"""
import asyncio
import base64
import binascii
import hashlib
import hmac
import io
import json
import re
import secrets
import sqlite3
import time
import uuid
from datetime import datetime, timezone

from aiohttp import web
from animation_clip import artifact_response
from PIL import Image, ImageOps, UnidentifiedImageError


USERNAME_RE = re.compile(r'^[a-z0-9_]{3,24}$')
AUTH_RE = re.compile(r'^[A-Za-z0-9_-]{43}$')
AUTH_COOKIE = 'model_studio_auth'
SESSION_AGE = 30 * 86400
HASH_ROUNDS = 600_000
PREVIEW_MAX = 2 * 1024 * 1024
PREVIEW_JSON_MAX = PREVIEW_MAX * 4 // 3 + 2048


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def password_hash(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, HASH_ROUNDS).hex()


class Community:
    def __init__(self, studio, data_root, job_root):
        self.studio = studio
        self.data_root = data_root
        self.job_root = job_root
        self.db = None
        self.rates = {}
        self.hash_slots = asyncio.Semaphore(2)

    def start(self):
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.data_root / 'community.sqlite3')
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys = ON')
        self.db.execute('PRAGMA journal_mode = WAL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE,
                display_name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
                password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_expiry ON auth_sessions(expires_at);
            CREATE TABLE IF NOT EXISTS comments (
                id TEXT PRIMARY KEY, model_id TEXT NOT NULL,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                body TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS comments_model ON comments(model_id, created_at);
        ''')
        self.db.execute('DELETE FROM auth_sessions WHERE expires_at <= ?', (time.time(),))
        self.db.commit()

    def close(self):
        if self.db:
            self.db.close()
            self.db = None

    def identify(self, request):
        token = request.cookies.get(AUTH_COOKIE, '')
        request['account'] = None
        if AUTH_RE.fullmatch(token):
            token_hash = hashlib.sha256(token.encode('ascii')).hexdigest()
            request['account'] = self.db.execute('''
                SELECT u.id, u.username, u.display_name, u.bio, u.created_at
                FROM auth_sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ? AND s.expires_at > ?
            ''', (token_hash, time.time())).fetchone()

    def owns(self, request, job):
        account_id = job.get('_accountId')
        if account_id:
            return bool(request.get('account') and request['account']['id'] == account_id)
        return job.get('_owner') == request.get('session')

    def account(self, request):
        if not request.get('account'):
            raise web.HTTPUnauthorized(text='Войдите в профиль, чтобы продолжить.')
        return request['account']

    def limit(self, category, key, count, seconds):
        current = time.monotonic()
        # Bound storage even when requests rotate client identifiers.
        if len(self.rates) > 4096:
            self.rates = {k: values for k, values in self.rates.items() if values and current - values[-1] < 3600}
        bucket = (category, key)
        recent = [value for value in self.rates.get(bucket, []) if current - value < seconds]
        if len(recent) >= count:
            raise web.HTTPTooManyRequests(text='Слишком много попыток. Подождите немного и повторите.')
        self.rates[bucket] = recent + [current]

    def auth_limit(self, request):
        # The service only binds localhost; nginx supplies X-Real-IP over its
        # trusted local tunnel. Never use a freshly generated cookie as an IP limit.
        address = request.headers.get('X-Real-IP') or request.remote or 'local'
        self.limit('auth-ip', address, 20, 60)

    @staticmethod
    def text(value, name, maximum, minimum=0):
        if not isinstance(value, str):
            raise web.HTTPBadRequest(text=f'Поле «{name}» должно быть текстом.')
        value = value.strip()
        if not minimum <= len(value) <= maximum or '\x00' in value:
            raise web.HTTPBadRequest(text=f'Поле «{name}»: от {minimum} до {maximum} символов.')
        return value

    @staticmethod
    def username(value):
        if not isinstance(value, str) or not USERNAME_RE.fullmatch(value.strip().lower()):
            raise web.HTTPBadRequest(text='Логин: 3–24 латинских буквы, цифры или подчёркивание.')
        return value.strip().lower()

    @staticmethod
    def password(value):
        if not isinstance(value, str) or not 8 <= len(value) <= 128:
            raise web.HTTPBadRequest(text='Пароль должен содержать от 8 до 128 символов.')
        return value

    def model_file(self, job, name):
        directory = self.job_root / job['id']
        path = directory / name
        if not path.is_file() or not path.resolve().is_relative_to(directory.resolve()):
            raise web.HTTPNotFound(text='Файл модели не найден.')
        # The job folder itself must not redirect to another directory.
        if directory.resolve().parent != self.job_root.resolve():
            raise web.HTTPNotFound(text='Файл модели не найден.')
        return path

    def is_public(self, job):
        if job.get('visibility', 'private') != 'public' or job.get('status') != 'complete':
            return False
        try:
            self.model_file(job, 'model.glb')
            return True
        except web.HTTPNotFound:
            return False

    def public_model(self, request):
        job = self.studio.jobs.get(request.match_info['model_id'])
        if not job or not self.is_public(job):
            raise web.HTTPNotFound(text='Модель не найдена или доступна только автору.')
        return job

    def public_counts(self, jobs=None):
        counts = {}
        for job in self.studio.jobs.values() if jobs is None else jobs:
            if job.get('_accountId') and (jobs is not None or self.is_public(job)):
                account_id = job['_accountId']
                counts[account_id] = counts.get(account_id, 0) + 1
        return counts

    def user(self, row, model_counts=None):
        if row is None:
            return None
        return {'id': row['id'], 'username': row['username'], 'displayName': row['display_name'],
                'bio': row['bio'], 'createdAt': row['created_at'],
                'modelCount': model_counts.get(row['id'], 0) if model_counts is not None else sum(
                    1 for job in self.studio.jobs.values() if job.get('_accountId') == row['id'] and self.is_public(job))}

    def author(self, job, author_cache=None, model_counts=None):
        account_id = job.get('_accountId')
        if not account_id:
            return None
        if author_cache is not None and account_id in author_cache:
            return author_cache[account_id]
        profile = self.user(self.db.execute('SELECT id, username, display_name, bio, created_at FROM users WHERE id = ?', (account_id,)).fetchone(), model_counts)
        if author_cache is not None:
            author_cache[account_id] = profile
        return profile

    def owner_fields(self, job, author_cache=None, model_counts=None):
        fields = {'visibility': job.get('visibility', 'private'), 'title': job.get('title', f"Модель {job['id'][:6]}"),
                  'description': job.get('description', ''), 'author': self.author(job, author_cache, model_counts), 'previewUrl': None}
        if not job.get('_previewInvalidated') and (self.job_root / job['id'] / 'preview.webp').is_file():
            fields['previewUrl'] = self.studio.file_url(job, 'preview.webp') + '?v=' + str(job.get('_previewRevision', '1'))
        return fields

    def summary(self, job, author_cache=None, model_counts=None):
        preview = None
        try:
            if job.get('_previewInvalidated'):
                raise web.HTTPNotFound()
            self.model_file(job, 'preview.webp')
            preview = f"/api/model-studio/models/{job['id']}/preview?v={job.get('_previewRevision', '1')}"
        except web.HTTPNotFound:
            pass
        count = self.db.execute('SELECT COUNT(*) FROM comments WHERE model_id = ?', (job['id'],)).fetchone()[0]
        return {'id': job['id'], 'title': job.get('title', f"Модель {job['id'][:6]}"),
                'description': job.get('description', ''), 'createdAt': job['createdAt'],
                'updatedAt': job.get('updatedAt', job['createdAt']), 'previewUrl': preview,
                'author': self.author(job, author_cache, model_counts), 'commentsCount': count,
                'viewsCount': max(0, int(job.get('viewsCount') or 0)), 'hasRig': bool(job.get('rig', {}).get('available'))}

    def claim_jobs(self, request, account_id):
        for job in self.studio.jobs.values():
            if not job.get('_accountId') and job.get('_owner') == request['session']:
                candidate = {**job, '_accountId': account_id}
                self.studio.save(candidate)
                job.update(candidate)

    @staticmethod
    def secure(request):
        return request.secure or request.headers.get('X-Forwarded-Proto') == 'https'

    def login_response(self, request, row):
        self.claim_jobs(request, row['id'])
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode('ascii')).hexdigest()
        # Rotate an existing session token instead of retaining it on login.
        previous = request.cookies.get(AUTH_COOKIE, '')
        with self.db:
            self.db.execute('DELETE FROM auth_sessions WHERE expires_at <= ?', (time.time(),))
            if AUTH_RE.fullmatch(previous):
                self.db.execute('DELETE FROM auth_sessions WHERE token_hash = ?', (hashlib.sha256(previous.encode('ascii')).hexdigest(),))
            self.db.execute('INSERT INTO auth_sessions VALUES (?, ?, ?)', (digest, row['id'], time.time() + SESSION_AGE))
        response = web.json_response({'user': self.user(row)})
        response.set_cookie(AUTH_COOKIE, token, max_age=SESSION_AGE, httponly=True,
                            secure=self.secure(request), samesite='Lax', path='/')
        return response

    async def me(self, request):
        return web.json_response({'user': self.user(request.get('account'))})

    async def register(self, request):
        self.auth_limit(request)
        data = await self.studio.json_object(request)
        if set(data) - {'username', 'displayName', 'password'}:
            raise web.HTTPBadRequest(text='Неизвестное поле регистрации.')
        username = self.username(data.get('username'))
        display_name = self.text(data.get('displayName', username), 'Имя', 60, 1)
        password = self.password(data.get('password'))
        salt = secrets.token_bytes(32)
        async with self.hash_slots:
            digest = await asyncio.to_thread(password_hash, password, salt)
        account_id, created_at = str(uuid.uuid4()), timestamp()
        try:
            with self.db:
                self.db.execute('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)',
                                (account_id, username, display_name, '', salt.hex(), digest, created_at))
        except sqlite3.IntegrityError:
            raise web.HTTPConflict(text='Этот логин уже занят.')
        row = self.db.execute('SELECT * FROM users WHERE id = ?', (account_id,)).fetchone()
        return self.login_response(request, row)

    async def login(self, request):
        self.auth_limit(request)
        data = await self.studio.json_object(request)
        if set(data) != {'username', 'password'}:
            raise web.HTTPBadRequest(text='Нужны логин и пароль.')
        username, password = self.username(data.get('username')), self.password(data.get('password'))
        self.limit('auth-user', username, 20, 300)
        row = self.db.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
        salt = bytes.fromhex(row['password_salt']) if row else b'no-account-timing-padding-salt-32'
        async with self.hash_slots:
            digest = await asyncio.to_thread(password_hash, password, salt)
        if row is None or not hmac.compare_digest(row['password_hash'], digest):
            raise web.HTTPUnauthorized(text='Неверный логин или пароль.')
        return self.login_response(request, row)

    async def logout(self, request):
        token = request.cookies.get(AUTH_COOKIE, '')
        if AUTH_RE.fullmatch(token):
            with self.db:
                self.db.execute('DELETE FROM auth_sessions WHERE token_hash = ?', (hashlib.sha256(token.encode('ascii')).hexdigest(),))
        response = web.json_response({'ok': True})
        response.del_cookie(AUTH_COOKIE, path='/')
        return response

    async def edit_profile(self, request):
        account = self.account(request)
        data = await self.studio.json_object(request)
        if not data or set(data) - {'displayName', 'bio'}:
            raise web.HTTPBadRequest(text='Можно изменить имя и описание профиля.')
        display_name = self.text(data.get('displayName', account['display_name']), 'Имя', 60, 1)
        bio = self.text(data.get('bio', account['bio']), 'О себе', 1000)
        with self.db:
            self.db.execute('UPDATE users SET display_name = ?, bio = ? WHERE id = ?', (display_name, bio, account['id']))
        return web.json_response({'user': self.user(self.db.execute('SELECT * FROM users WHERE id = ?', (account['id'],)).fetchone())})

    @staticmethod
    def pagination(request, default=24):
        try:
            offset, limit = int(request.query.get('offset', '0')), int(request.query.get('limit', str(default)))
            if not 0 <= offset <= 100000 or not 1 <= limit <= 100:
                raise ValueError()
        except ValueError:
            raise web.HTTPBadRequest(text='Недопустимый размер страницы.')
        return offset, limit

    def query(self, request):
        return self.text(request.query.get('q', ''), 'Поиск', 100).casefold()

    async def profiles(self, request):
        offset, limit = self.pagination(request)
        query = self.query(request)
        rows = self.db.execute('SELECT id, username, display_name, bio, created_at FROM users ORDER BY created_at DESC, id').fetchall()
        rows = [row for row in rows if query in (row['username'] + ' ' + row['display_name']).casefold()]
        counts = self.public_counts()
        return web.json_response({'profiles': [self.user(row, counts) for row in rows[offset:offset + limit]], 'total': len(rows), 'offset': offset, 'limit': limit})

    async def profile(self, request):
        username = request.match_info['username'].lower()
        row = self.db.execute('SELECT id, username, display_name, bio, created_at FROM users WHERE username = ?', (username,)).fetchone()
        if row is None:
            raise web.HTTPNotFound(text='Профиль не найден.')
        return web.json_response({'profile': self.user(row)})

    async def gallery(self, request):
        offset, limit = self.pagination(request)
        query, author = self.query(request), request.query.get('author', '').lower()
        rows, authors = [], {}
        public_jobs = [job for job in self.studio.jobs.values() if self.is_public(job)]
        counts = self.public_counts(public_jobs)
        for job in public_jobs:
            profile = self.author(job, authors, counts)
            if author and (not profile or profile['username'].lower() != author):
                continue
            searchable = ' '.join([job.get('title', f"Модель {job['id'][:6]}"), job.get('description', ''),
                                   profile['username'] if profile else '', profile['displayName'] if profile else ''])
            if query in searchable.casefold():
                rows.append(job)
        rows.sort(key=lambda job: (job['createdAt'], job['id']), reverse=True)
        return web.json_response({'models': [self.summary(job, authors, counts) for job in rows[offset:offset + limit]], 'total': len(rows), 'offset': offset, 'limit': limit})

    async def model(self, request):
        job = self.public_model(request)
        prefix = f"/api/model-studio/models/{job['id']}/files/"
        public_job = self.studio.shared_payload(job, prefix, include_prompts=False)
        public_job.update(title=job.get('title', f"Модель {job['id'][:6]}"), description=job.get('description', ''), visibility='public')
        return web.json_response({'job': public_job, 'model': self.summary(job), 'canEdit': self.owns(request, job)})

    async def view(self, request):
        job = self.public_model(request)
        job['viewsCount'] = max(0, int(job.get('viewsCount') or 0)) + 1
        self.studio.save_view_count(job)
        return web.json_response({'id': job['id'], 'viewsCount': job['viewsCount']})

    async def model_artifact(self, request):
        job = self.public_model(request)
        name = request.match_info['file']
        if self.studio.motion_library.matches(name):
            return await self.studio.motion_library.artifact(request, job, name, lambda: self.public_model(request))
        if name not in self.studio.shared_files(job):
            raise web.HTTPNotFound(text='Файл модели не найден.')
        return artifact_response(request, self.model_file(job, name))

    async def model_preview(self, request):
        job = self.public_model(request)
        if job.get('_previewInvalidated'):
            raise web.HTTPNotFound(text='Превью обновляется.')
        return web.FileResponse(self.model_file(job, 'preview.webp'), headers={'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff'})

    async def publication(self, request):
        job = self.studio.owned(request)
        data = await self.studio.json_object(request)
        if not data or set(data) - {'visibility', 'title', 'description'}:
            raise web.HTTPBadRequest(text='Можно изменить видимость, название и описание модели.')
        candidate = dict(job)
        if 'visibility' in data:
            if data['visibility'] not in ('public', 'private'):
                raise web.HTTPBadRequest(text='Видимость: public или private.')
            candidate['visibility'] = data['visibility']
            if data['visibility'] == 'private':
                candidate.pop('_shareToken', None)
        if 'title' in data:
            candidate['title'] = self.text(data['title'], 'Название', 100, 1)
        if 'description' in data:
            candidate['description'] = self.text(data['description'], 'Описание', 2000)
        # The body yields; deletion or registration may change ownership meanwhile.
        if self.studio.owned(request) is not job:
            raise web.HTTPNotFound(text='Модель удалена.')
        self.studio.save(candidate)
        job.clear()
        job.update(candidate)
        return web.json_response({'job': self.studio.public(job)})

    async def preview(self, request):
        job = self.studio.owned(request)
        mesh_revision = job.get('meshEdit', {}).get('revision', 0)
        if request.content_type != 'application/json':
            raise web.HTTPBadRequest(text='Ожидается JSON с изображением превью.')
        raw = bytearray()
        async for chunk in request.content.iter_chunked(65536):
            raw.extend(chunk)
            if len(raw) > PREVIEW_JSON_MAX:
                raise web.HTTPRequestEntityTooLarge(max_size=PREVIEW_JSON_MAX, actual_size=len(raw))
        data = json.loads(raw)
        if not isinstance(data, dict) or set(data) != {'image'} or not isinstance(data['image'], str):
            raise web.HTTPBadRequest(text='Нужен image с превью PNG, JPEG или WebP.')
        match = re.fullmatch(r'data:image/(webp|png|jpeg);base64,([A-Za-z0-9+/=\r\n]+)', data['image'])
        if not match:
            raise web.HTTPBadRequest(text='Нужно превью PNG, JPEG или WebP.')
        try:
            blob = base64.b64decode(match[2], validate=True)
            if len(blob) > PREVIEW_MAX:
                raise ValueError()
            with Image.open(io.BytesIO(blob)) as source:
                if source.format not in ('WEBP', 'PNG', 'JPEG') or source.width * source.height > 4_000_000 or min(source.size) < 16:
                    raise ValueError()
                normalized = ImageOps.exif_transpose(source).convert('RGB')
                normalized.thumbnail((960, 960))
                output = io.BytesIO()
                normalized.save(output, 'WEBP', quality=82)
        except (ValueError, OSError, binascii.Error, UnidentifiedImageError, Image.DecompressionBombError):
            raise web.HTTPBadRequest(text='Некорректное превью: до 2 МБ и 4 мегапикселей.')
        if self.studio.owned(request) is not job:
            raise web.HTTPNotFound(text='Модель удалена.')
        if job.get('meshEdit', {}).get('revision', 0) != mesh_revision:
            raise web.HTTPConflict(text='Геометрия изменилась. Обнови превью модели.')
        self.model_file(job, 'model.glb')
        path = self.job_root / job['id'] / 'preview.webp'
        temporary = path.with_name('preview.upload.tmp')
        temporary.write_bytes(output.getvalue())
        temporary.replace(path)
        candidate = {**job, '_previewRevision': secrets.token_hex(8), '_previewInvalidated': False}
        self.studio.save(candidate)
        job.update(candidate)
        return web.json_response({'job': self.studio.public(job)})

    def comment(self, row, request, job):
        author = self.db.execute('SELECT id, username, display_name, bio, created_at FROM users WHERE id = ?', (row['user_id'],)).fetchone()
        can_delete = bool(request.get('account') and request['account']['id'] == row['user_id']) or self.owns(request, job)
        return {'id': row['id'], 'body': row['body'], 'createdAt': row['created_at'], 'author': self.user(author), 'canDelete': can_delete}

    def comment_model(self, request):
        job = self.studio.jobs.get(request.match_info['model_id'])
        if not job or not (self.is_public(job) or self.owns(request, job)):
            raise web.HTTPNotFound(text='Модель недоступна.')
        return job

    async def comments(self, request):
        job = self.comment_model(request)
        offset, limit = self.pagination(request, 30)
        total = self.db.execute('SELECT COUNT(*) FROM comments WHERE model_id = ?', (job['id'],)).fetchone()[0]
        rows = self.db.execute('SELECT * FROM comments WHERE model_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?', (job['id'], limit, offset)).fetchall()
        return web.json_response({'comments': [self.comment(row, request, job) for row in rows], 'total': total, 'offset': offset, 'limit': limit})

    async def add_comment(self, request):
        account = self.account(request)
        job = self.comment_model(request)
        self.limit('comment-minute', account['id'], 8, 60)
        self.limit('comment-hour', account['id'], 60, 3600)
        data = await self.studio.json_object(request)
        if set(data) != {'body'}:
            raise web.HTTPBadRequest(text='Нужен текст комментария.')
        body = self.text(data['body'], 'Комментарий', 2000, 1)
        if self.comment_model(request) is not job:
            raise web.HTTPNotFound(text='Модель удалена.')
        cid = str(uuid.uuid4())
        with self.db:
            self.db.execute('INSERT INTO comments VALUES (?, ?, ?, ?, ?)', (cid, job['id'], account['id'], body, timestamp()))
        row = self.db.execute('SELECT * FROM comments WHERE id = ?', (cid,)).fetchone()
        return web.json_response({'comment': self.comment(row, request, job)}, status=201)

    async def delete_comment(self, request):
        row = self.db.execute('SELECT * FROM comments WHERE id = ?', (request.match_info['comment_id'],)).fetchone()
        job = self.studio.jobs.get(row['model_id']) if row else None
        if row is None or not job:
            raise web.HTTPNotFound(text='Комментарий не найден.')
        is_author = bool(request.get('account') and request['account']['id'] == row['user_id'])
        if not is_author and not self.owns(request, job):
            raise web.HTTPNotFound(text='Комментарий не найден.')
        with self.db:
            self.db.execute('DELETE FROM comments WHERE id = ?', (row['id'],))
        return web.json_response({'deleted': True})

    def forget_job(self, job_id):
        with self.db:
            self.db.execute('DELETE FROM comments WHERE model_id = ?', (job_id,))

    def routes(self, prefix):
        return [web.get(prefix + '/auth/me', self.me), web.post(prefix + '/auth/register', self.register),
                web.post(prefix + '/auth/login', self.login), web.post(prefix + '/auth/logout', self.logout),
                web.patch(prefix + '/auth/profile', self.edit_profile), web.get(prefix + '/profiles', self.profiles),
                web.get(prefix + '/profiles/{username}', self.profile), web.get(prefix + '/gallery', self.gallery),
                web.get(prefix + '/models/{model_id}', self.model), web.post(prefix + '/models/{model_id}/view', self.view), web.get(prefix + '/models/{model_id}/files/{file:.*}', self.model_artifact),
                web.get(prefix + '/models/{model_id}/preview', self.model_preview), web.patch(prefix + '/jobs/{job_id}/publication', self.publication),
                web.post(prefix + '/jobs/{job_id}/preview', self.preview), web.get(prefix + '/models/{model_id}/comments', self.comments),
                web.post(prefix + '/models/{model_id}/comments', self.add_comment), web.delete(prefix + '/comments/{comment_id}', self.delete_comment)]
