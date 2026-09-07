"""Reuse completed Kimodo motions, baking a cached GLB for each rig revision."""
import asyncio
import contextlib
import re
import time
import uuid

from aiohttp import web

SOURCE_ID = re.compile(r'^[a-f0-9]{16}$')
REVISION = r'(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|legacy)'
ARTIFACT = re.compile(rf'^library/({REVISION})/([a-f0-9]{{16}})/animated\.glb$')


def prefix(job, file_prefix):
    rig = job.get('rig', {})
    revision = rig.get('revision', 'legacy')
    if not rig.get('available') or not re.fullmatch(REVISION, str(revision)):
        return None
    return file_prefix + f'library/{revision}/'


class MotionLibrary:
    def __init__(self, studio, job_root, kimodo):
        self.studio, self.job_root, self.kimodo = studio, job_root, kimodo
        self.cached = []
        self.cached_at = 0
        self.catalog_lock = asyncio.Lock()
        self.tasks = {}

    def busy(self, job):
        return any(key[0] == job['id'] and not task.done() for key, task in self.tasks.items())

    async def close(self):
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def entries(self, request):
        async with self.catalog_lock:
            if time.monotonic() - self.cached_at > 30:
                history = await self.studio.legacy_history()
                rows = {}
                for row in history:
                    sid, frames = row.get('id'), row.get('frames')
                    if (isinstance(sid, str) and SOURCE_ID.fullmatch(sid)
                            and row.get('status') in ('ready', 'complete', 'completed')
                            and row.get('model') == 'smplx-rp-v1'
                            and type(frames) is int and 1 <= frames <= 1000):
                        rows[sid] = {'id': sid, 'prompt': str(row.get('prompt', 'Движение'))[:1500],
                                     'frames': frames, 'fps': 30, 'createdAt': str(row.get('created_at', ''))}
                self.cached = sorted(rows.values(), key=lambda row: (row['createdAt'], row['id']), reverse=True)
                self.cached_at = time.monotonic()
        # Studio-created private motions keep their access boundary even though
        # the older standalone Kimodo UI has no account system.
        restricted = set()
        for job in self.studio.jobs.values():
            if not self.studio.community.is_public(job) and not self.studio.community.owns(request, job):
                restricted.update(m.get('_kimodoId') for m in job.get('motions', []))
                restricted.update(m.get('_kimodoId') for m in job.get('_meshOriginal', {}).get('motions', []))
        return [dict(row) for row in self.cached if row['id'] not in restricted]

    async def catalog(self, request):
        return web.json_response({'motions': await self.entries(request)})

    @staticmethod
    def matches(name):
        return ARTIFACT.fullmatch(name)

    def check(self, request, job, revision, authorize):
        if authorize() is not job or self.studio.jobs.get(job['id']) is not job:
            raise web.HTTPNotFound(text='Модель недоступна.')
        rig = job.get('rig', {})
        if job.get('status') != 'complete' or not rig.get('available') or str(rig.get('revision', 'legacy')) != revision:
            raise web.HTTPConflict(text='Скелет модели изменился. Обнови страницу и выбери движение заново.')
        if rig.get('status') in ('queued', 'running'):
            raise web.HTTPConflict(text='Дождись готовности скелета.')

    def path(self, job, name):
        folder = self.job_root / job['id']
        path = folder / name
        if folder.resolve().parent != self.job_root.resolve() or folder.is_symlink() or not path.resolve().is_relative_to(folder.resolve()):
            raise web.HTTPConflict(text='Файл движения недоступен.')
        return path

    async def artifact(self, request, job, name, authorize):
        match = ARTIFACT.fullmatch(name)
        if not match:
            raise web.HTTPNotFound()
        revision, sid = match.groups()
        self.check(request, job, revision, authorize)
        entry = next((entry for entry in await self.entries(request) if entry['id'] == sid), None)
        if not entry:
            raise web.HTTPNotFound(text='Готовое движение не найдено.')
        self.check(request, job, revision, authorize)
        output = self.path(job, name)
        if not output.is_file():
            key = (job['id'], revision, sid)
            task = self.tasks.get(key)
            if task is None:
                if len(self.tasks) >= 8:
                    raise web.HTTPTooManyRequests(text='Движения подготавливаются. Повтори через несколько секунд.')
                task = asyncio.create_task(self.bake(request, job, revision, entry, output, authorize))
                self.tasks[key] = task
                def finished(done):
                    self.tasks.pop(key, None)
                    if not done.cancelled():
                        done.exception()  # Consume failures after a client disconnects.
                task.add_done_callback(finished)
            await asyncio.shield(task)
        self.check(request, job, revision, authorize)
        # Rights may change while another request's bake was running.
        if not any(row['id'] == sid for row in await self.entries(request)):
            raise web.HTTPNotFound(text='Движение недоступно.')
        return web.FileResponse(output, headers={'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff'})

    async def bake(self, request, job, revision, entry, output, authorize):
        async with self.studio.rig_lock:
            self.check(request, job, revision, authorize)
            rig_path = self.path(job, job['rig'].get('_path', 'rig/rigged.glb'))
            if not rig_path.is_file():
                raise web.HTTPConflict(text='Файл скелета не найден.')
            folder = output.parent
            folder.mkdir(parents=True, exist_ok=True)
            temporary = folder / f'pending-{uuid.uuid4()}.glb'
            try:
                for name, components in [('root.f32', 3), ('rotations.f32', 88)]:
                    expected = entry['frames'] * components * 4
                    async with self.studio.http.get(f"{self.kimodo}/api/animations/{entry['id']}/{name}") as response:
                        response.raise_for_status()
                        data = bytearray()
                        async for chunk in response.content.iter_chunked(65536):
                            data.extend(chunk)
                            if len(data) > expected:
                                raise ValueError('Неверный размер движения.')
                    if len(data) != expected:
                        raise ValueError('Движение содержит неполные данные.')
                    (folder / name).write_bytes(data)
                await self.studio.run_blender('retarget_motion.py', [
                    '--input', rig_path, '--root', folder / 'root.f32', '--rotations', folder / 'rotations.f32',
                    '--frames', entry['frames'], '--fps', entry['fps'], '--output', temporary,
                    '--name', 'Library Motion', '--report', folder / 'retarget.json',
                ], folder, timeout=300)
                self.check(request, job, revision, authorize)
                if not temporary.is_file() or temporary.stat().st_size < 20:
                    raise RuntimeError('Не удалось сохранить движение.')
                temporary.replace(output)
            finally:
                with contextlib.suppress(OSError):
                    temporary.unlink()
