"""Saved model scenery and author-uploaded textures; no external URL fetching."""
import asyncio
import contextlib
import io
import json
import math
import re
import secrets
import warnings

import aiohttp
from aiohttp import web
from PIL import Image, ImageOps, UnidentifiedImageError


MAX_TEXTURE = 8 * 1024 * 1024
MAX_SETTINGS = 8192
MAX_FORM = 2 * MAX_TEXTURE + 32768
MAX_REVISION = 2**53 - 1
TEXTURE_PATH = re.compile(r'^environment/(background|ground)-[a-f0-9]{32}\.webp$')
DEFAULTS = {'background': 'studio', 'backgroundProjection': 'panorama', 'backgroundRotation': 0,
            'ground': 'grid', 'groundShape': 'plane', 'groundScale': 2, 'showGrid': True}
CHOICES = {'background': {'studio', 'dawn', 'sunset', 'night', 'custom'},
           'backgroundProjection': {'panorama', 'image'},
           'ground': {'grid', 'stone', 'sand', 'grass', 'custom'},
           'groundShape': {'plane', 'disc'}}


def valid_value(key, value):
    if key in CHOICES:
        return isinstance(value, str) and value in CHOICES[key]
    if key == 'showGrid':
        return type(value) is bool
    minimum, maximum = (-180, 180) if key == 'backgroundRotation' else (0.25, 10)
    return type(value) in (int, float) and math.isfinite(value) and minimum <= value <= maximum


def normalized(job):
    saved = job.get('environment')
    saved = saved if isinstance(saved, dict) else {}
    result = {key: saved[key] if key in saved and valid_value(key, saved[key]) else default
              for key, default in DEFAULTS.items()}
    revision = saved.get('revision', 0)
    result['revision'] = revision if type(revision) is int and 0 <= revision <= MAX_REVISION else 0
    return result


def texture_paths(job, *, active_only=False):
    saved = job.get('_environmentTextures')
    saved = saved if isinstance(saved, dict) else {}
    settings = normalized(job)
    return {kind: path for kind in ('background', 'ground')
            if isinstance(path := saved.get(kind), str) and TEXTURE_PATH.fullmatch(path)
            and path.startswith('environment/' + kind + '-')
            and (not active_only or settings[kind] == 'custom')}


def payload(job, prefix, *, active_only=False):
    result = normalized(job)
    paths = texture_paths(job, active_only=active_only)
    for kind in ('background', 'ground'):
        result[kind + 'Url'] = prefix + paths[kind] if kind in paths else None
    return result


def encode_texture(raw):
    """Decode once in a worker thread, bound pixels, and discard source metadata."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                if (source.format not in ('PNG', 'JPEG', 'WEBP')
                        or min(source.size) < 16 or max(source.size) > 16384
                        or source.width * source.height > 32_000_000
                        or getattr(source, 'is_animated', False)):
                    raise ValueError()
                image = ImageOps.exif_transpose(source).convert('RGB')
                image.thumbnail((4096, 4096), Image.Resampling.LANCZOS)
                output = io.BytesIO()
                image.save(output, 'WEBP', quality=88, method=4, exif=b'', icc_profile=b'', xmp=b'')
                return output.getvalue()
    except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError,
            Image.DecompressionBombWarning):
        raise web.HTTPBadRequest(text='Нужна обычная картинка PNG, JPEG или WebP: от 16 пикселей по стороне, до 32 мегапикселей и 8 МБ.')


class Environment:
    def __init__(self, studio, job_root):
        self.studio = studio
        self.job_root = job_root
        self.image_slots = asyncio.Semaphore(2)

    def check_current(self, request, job, revision=None):
        if self.studio.owned(request) is not job:
            raise web.HTTPNotFound(text='Модель удалена.')
        if job['status'] != 'complete' or not (self.job_root / job['id'] / 'model.glb').is_file():
            raise web.HTTPConflict(text='Окружение можно настроить у готовой модели.')
        if revision is not None and normalized(job)['revision'] != revision:
            raise web.HTTPConflict(text='Окружение уже изменилось в другой вкладке. Сбросьте настройки к сохранённым и повторите.')

    async def read_form(self, request):
        if request.content_type != 'multipart/form-data':
            raise web.HTTPBadRequest(text='Нужна форма с настройками окружения.')
        if request.content_length and request.content_length > MAX_FORM:
            raise web.HTTPRequestEntityTooLarge(max_size=MAX_FORM, actual_size=request.content_length)
        try:
            reader = await request.multipart()
            fields = {}
            async for part in reader:
                if isinstance(part, aiohttp.MultipartReader) or part.name not in ('settings', 'backgroundImage', 'groundImage') or part.name in fields:
                    raise web.HTTPBadRequest(text='Недопустимое или повторяющееся поле окружения.')
                limit = MAX_SETTINGS if part.name == 'settings' else MAX_TEXTURE
                raw = bytearray()
                while chunk := await part.read_chunk(65536):
                    raw.extend(chunk)
                    if len(raw) > limit:
                        raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=len(raw))
                fields[part.name] = bytes(raw)
        except (AssertionError, ValueError):
            raise web.HTTPBadRequest(text='Некорректная форма окружения.')
        try:
            settings = json.loads(fields.get('settings', b'').decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise web.HTTPBadRequest(text='Нужны настройки окружения в формате JSON.')
        if (not isinstance(settings, dict) or set(settings) != set(DEFAULTS) | {'expectedRevision'}
                or any(not valid_value(key, settings[key]) for key in DEFAULTS)):
            raise web.HTTPBadRequest(text='Недопустимые настройки окружения.')
        revision = settings.pop('expectedRevision')
        if type(revision) is not int or not 0 <= revision < MAX_REVISION:
            raise web.HTTPBadRequest(text='Нужна целая expectedRevision от 0 до 9007199254740990.')
        return settings, revision, {kind: fields[kind + 'Image'] for kind in ('background', 'ground') if kind + 'Image' in fields}

    async def update(self, request):
        job = self.studio.owned(request)
        self.check_current(request, job)
        settings, revision, uploads = await self.read_form(request)
        self.check_current(request, job, revision)
        encoded = {}
        for kind, raw in uploads.items():
            async with self.image_slots:
                encoded[kind] = await asyncio.to_thread(encode_texture, raw)
        # Body reads and image decoding yield. Deletion, account claiming or a
        # newer environment write during either must invalidate this request.
        self.check_current(request, job, revision)
        previous = texture_paths(job)
        textures = dict(previous)
        for kind in ('background', 'ground'):
            if settings[kind] == 'custom' and kind not in encoded and kind not in textures:
                raise web.HTTPBadRequest(text='Сначала загрузите картинку для своего фона или земли.')
        folder = self.job_root / job['id'] / 'environment'
        job_folder = self.job_root / job['id']
        if (job_folder.resolve().parent != self.job_root.resolve() or folder.is_symlink()
                or folder.resolve().parent != job_folder.resolve()):
            raise web.HTTPConflict(text='Не удалось безопасно сохранить текстуры окружения.')
        created = []
        try:
            if encoded:
                folder.mkdir(exist_ok=True)
            for kind, raw in encoded.items():
                relative = f'environment/{kind}-{secrets.token_hex(16)}.webp'
                path = job_folder / relative
                # Names are immutable and unguessable; metadata is published
                # last, so incomplete uploads never become visible to readers.
                with path.open('xb') as output:
                    created.append(path)
                    output.write(raw)
                textures[kind] = relative
            candidate = {**job, 'environment': {**settings, 'revision': revision + 1},
                         '_environmentTextures': textures}
            self.studio.save(candidate)
        except BaseException:
            for path in created:
                with contextlib.suppress(OSError):
                    path.unlink()
            raise
        job.update(candidate)
        # Superseded files have already left every API allowlist. Cleanup is
        # best effort so a Windows reader cannot turn a saved change into 503.
        for kind, path in previous.items():
            if textures.get(kind) != path:
                with contextlib.suppress(OSError):
                    (job_folder / path).unlink()
        return web.json_response({'job': self.studio.public(job)})
