"""Local image/motion generation service. No GPU work runs on the public host."""
import argparse
import asyncio
import contextlib
import io
import json
import logging
import math
import os
import re
import secrets
import shutil
import stat
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import aiohttp
from aiohttp import web
from PIL import Image, ImageOps, UnidentifiedImageError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'studio'))
from pixal_pipeline import ComfyPipeline, glb_summary
from manual_rig import validate_manual
from community import Community
from environment import Environment, payload as environment_payload, texture_paths as environment_texture_paths
from mesh_edits import MeshEdits, active_path as mesh_path, history_paths as mesh_history_paths, payload as mesh_payload
from motion_library import MotionLibrary, prefix as motion_library_prefix
from animation_clip import artifact_response

LOG = logging.getLogger('model-studio')
DATA = ROOT / 'data'
JOB_ROOT = DATA / 'jobs'
DIST = ROOT / 'apps' / 'studio-web' / 'dist'
COMFY = 'http://127.0.0.1:8188'
KIMODO = 'http://127.0.0.1:8094'
BLENDER = os.environ.get('STUDIO_BLENDER', r'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe')
MAX_IMAGE = 20 * 1024 * 1024
SESSION_RE = re.compile(r'^[a-f0-9]{48}$')
SHARE_RE = re.compile(r'^[A-Za-z0-9_-]{43}$')
ID_RE = re.compile(r'^[a-f0-9-]{36}$')
STAGES = {'preparing': ('Подготовка изображения', 3), 'queued': ('Ожидание ComfyUI', 5),
          'background': ('Удаление фона', 8), 'camera': ('Анализ изображения', 12),
          'structure': ('Построение объёма', 18), 'geometry': ('Генерация геометрии', 30),
          'geometry_detail': ('Детализация геометрии', 43), 'geometry_decode': ('Декодирование сетки', 54),
          'texture': ('Генерация материалов', 61), 'texture_decode': ('Подготовка текстур', 69),
          'remesh': ('Подготовка поверхности', 74), 'decimate': ('Оптимизация сетки', 77),
          'uv': ('UV-развёртка', 80), 'texture_bake': ('Запекание текстур', 84),
          'normal_bake': ('Карта нормалей', 88), 'export': ('Сохранение GLB', 91),
          'complete': ('Модель создана', 93), 'reconnecting': ('Восстановление соединения', 5)}


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


class Studio:
    def __init__(self):
        self.jobs = {}
        self.gpu = asyncio.Lock()
        self.queue = asyncio.Queue()
        self.rig_lock = asyncio.Lock()
        self.rig_queue = asyncio.Queue()
        self.operation = None
        self.worker_job = None
        self.rig_worker_job = None
        self.http = None
        self.worker = None
        self.rig_worker = None
        self.health_cache = None
        self.health_at = 0
        self.legacy_tasks = set()
        self.rates = {}
        self.community = Community(self, DATA, JOB_ROOT)
        self.environment = Environment(self, JOB_ROOT)
        self.mesh_edits = MeshEdits(self, JOB_ROOT)
        self.motion_library = MotionLibrary(self, JOB_ROOT, KIMODO)

    def save(self, job):
        job['updatedAt'] = now()
        atomic_json(JOB_ROOT / job['id'] / 'job.json', job)

    def save_view_count(self, job):
        """Persist a public view without making it look like an edited model."""
        atomic_json(JOB_ROOT / job['id'] / 'job.json', job)

    def public(self, job, *, author_cache=None, model_counts=None):
        def clean(value):
            if isinstance(value, dict):
                return {k: clean(v) for k, v in value.items() if not k.startswith('_')}
            if isinstance(value, list):
                return [clean(v) for v in value]
            return value
        result = clean(job)
        if '_manualRigDraft' in job:
            result['manualRigDraft'] = clean(job['_manualRigDraft'])
        if 'artifacts' in job and 'createdAt' in job:
            result.update(self.community.owner_fields(job, author_cache, model_counts))
            result['environment'] = environment_payload(job, self.file_url(job, ''))
            result['meshEdit'] = mesh_payload(job)
            if result.get('artifacts', {}).get('modelUrl'):
                result['artifacts']['modelUrl'] = self.file_url(job, mesh_path(job))
            if url := motion_library_prefix(job, self.file_url(job, '')):
                result['artifacts']['motionLibraryUrl'] = url
        return result

    def owned(self, request):
        job = self.jobs.get(request.match_info['job_id'])
        if not job or not self.community.owns(request, job):
            raise web.HTTPNotFound(text='Модель не найдена в этой сессии.')
        return job

    def file_url(self, job, file):
        return f"/api/model-studio/files/{job['id']}/{file}"

    async def start(self, app):
        JOB_ROOT.mkdir(parents=True, exist_ok=True)
        self.community.start()
        self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30))
        for path in sorted(JOB_ROOT.glob('*/job.json')):
            try:
                job = json.loads(path.read_text(encoding='utf-8'))
                self.jobs[job['id']] = job
                if job['status'] in ('queued', 'running'):
                    job.update(status='queued', stage='Восстановление задания после запуска ПК')
                    self.queue.put_nowait(('model', job['id'], None))
                elif job['status'] == 'complete' and job.get('rig', {}).get('status') in ('queued', 'running') and job['rig'].get('operationId'):
                    job['rig'].update(status='queued', stage='Восстановление скелета после запуска ПК', progress=0)
                    self.rig_queue.put_nowait((job['id'], job['rig']['operationId']))
                for motion in job.get('motions', []):
                    if motion['status'] in ('queued', 'running'):
                        if motion.get('_submitting') and not motion.get('_kimodoId'):
                            motion.update(status='failed', error='Не удалось однозначно восстановить отправку в Kimodo. Проверьте историю анимаций перед повторным запуском.')
                        else:
                            motion['status'] = 'queued'
                            self.queue.put_nowait(('motion', job['id'], motion['id']))
                self.save(job)
            except Exception:
                LOG.exception('Cannot restore job %s', path.name)
        self.worker = asyncio.create_task(self.work())
        self.rig_worker = asyncio.create_task(self.work_rigs())

    async def stop(self, app):
        await self.motion_library.close()
        for worker in (self.worker, self.rig_worker):
            worker.cancel()
        for worker in (self.worker, self.rig_worker):
            with contextlib.suppress(asyncio.CancelledError):
                await worker
        for task in self.legacy_tasks:
            task.cancel()
        await self.http.close()
        self.community.close()

    async def request_json(self, method, url, **kwargs):
        async with self.http.request(method, url, **kwargs) as response:
            raw = await response.read()
            data = json.loads(raw) if raw else {}
            if response.status >= 400:
                raise RuntimeError(f'HTTP {response.status}: {str(data)[:500]}')
            return data

    async def legacy_history(self):
        data = await self.request_json('GET', KIMODO + '/api/animations')
        return data if isinstance(data, list) else data.get('animations', [])

    async def wait_idle(self, job, motion=None):
        # Includes jobs submitted directly to either pre-existing local UI.
        for _ in range(3600):
            try:
                history = await self.legacy_history()
            except (aiohttp.ClientError, TimeoutError, RuntimeError):
                (motion or job)['stage'] = 'Ожидание соединения с Kimodo'
                self.save(job)
                await asyncio.sleep(2)
                continue
            busy_motion = any(a.get('status') in ('queued', 'running', 'generating', 'processing') for a in history)
            q = await self.request_json('GET', COMFY + '/queue')
            busy_comfy = bool(q.get('queue_running') or q.get('queue_pending'))
            # A restored Pixal task must reconnect to its own prompt, not wait for it.
            own_prompt = job.get('_comfyPromptId') if motion is None else None
            if own_prompt and all(item[1] == own_prompt for item in q.get('queue_running', []) + q.get('queue_pending', [])):
                busy_comfy = False
            if not busy_motion and not busy_comfy:
                return
            target = motion or job
            target['stage'] = 'Ожидание свободной видеокарты'
            self.save(job)
            await asyncio.sleep(2)
        raise RuntimeError('Видеокарта занята другим заданием слишком долго.')

    async def run_blender(self, script, args, output_dir, timeout=900):
        log = output_dir / (Path(script).stem + '.log')
        with log.open('wb') as handle:
            proc = await asyncio.create_subprocess_exec(BLENDER, '--background', '--factory-startup', '--python-exit-code', '2', '--python', str(ROOT / 'scripts' / script), '--', *map(str, args), stdout=handle, stderr=asyncio.subprocess.STDOUT)
            try:
                code = await asyncio.wait_for(proc.wait(), timeout)
            except (asyncio.CancelledError, TimeoutError):
                proc.terminate()
                await proc.wait()
                raise
        if code != 0:
            tail = log.read_text(encoding='utf-8', errors='replace')[-3000:]
            LOG.error('Blender %s failed: %s', script, tail)
            raise RuntimeError('Не удалось подготовить скелет или анимацию. Подробности сохранены в локальном журнале.')

    async def image_job(self, job):
        directory = JOB_ROOT / job['id']
        job.update(status='running', error=None)
        self.save(job)
        await self.wait_idle(job)

        async def progress(state):
            stage, pct = STAGES.get(state.get('stage'), ('Генерация модели', job['progress']))
            if state.get('steps'):
                pct += min(6, 6 * state.get('step', 0) / state['steps'])
            job.update(stage=stage, progress=max(job['progress'], round(pct)))
            job['_comfyPromptId'] = state.get('prompt_id')
            self.save(job)

        pipeline = ComfyPipeline(base_url=COMFY, callback=progress)
        for attempt in range(60):
            try:
                await pipeline.run(directory, directory / 'input.png', seed=job['seed'], quality=job['quality'])
                break
            except (aiohttp.ClientError, TimeoutError):
                if attempt == 59:
                    raise
                job['stage'] = 'Восстановление соединения с ComfyUI'
                self.save(job)
                await asyncio.sleep(5)
        job['artifacts']['modelUrl'] = self.file_url(job, 'model.glb')
        job['stats'] = glb_summary(directory / 'model.glb')
        self.save(job)
        if job['mode'] == 'humanoid':
            job.update(stage='Подготовка скелета и весов', progress=95)
            job['rig'].update(status='queued', operationId=str(uuid.uuid4()), rotation={'x': 0, 'y': 0, 'z': 0}, requestedMethod='auto')
            self.save(job)
            async with self.rig_lock:
                await self.rig_job(job, job['rig']['operationId'])
        job.update(status='complete', stage='Готово', progress=100)
        self.save(job)

    async def rig_job(self, job, operation_id):
        rig = job['rig']
        if rig.get('operationId') != operation_id:
            return
        # Every attempt gets a new directory, including a restarted operation.
        # Incomplete exports can never replace a previously working rig.
        revision = str(uuid.uuid4())
        relative = f'rigs/{revision}/rigged.glb'
        directory = JOB_ROOT / job['id'] / 'rigs' / revision
        directory.mkdir(parents=True, exist_ok=False)
        rig.update(status='running', stage='Построение скелета и весов', progress=15, error=None)
        self.save(job)
        try:
            args = ['--input', JOB_ROOT / job['id'] / mesh_path(job), '--output-dir', directory]
            if mesh_path(job) != 'model.glb':
                args.extend(['--bounds-input', JOB_ROOT / job['id'] / 'model.glb'])
            for axis in ('x', 'y', 'z'):
                args.extend([f'--rotation-{axis}', rig['rotation'][axis]])
            manual = rig.get('_manualInput')
            if manual is not None:
                manual = validate_manual(manual)
                manual_file = directory / 'manual-points.json'
                atomic_json(manual_file, manual)
                args.extend(['--manual-points', manual_file])
            await self.run_blender('rig_humanoid.py', args, directory)
            report_file = directory / 'rig-report.json'
            report = json.loads(report_file.read_text(encoding='utf-8')) if report_file.exists() else {}
            rig_file = directory / 'rigged.glb'
            if not rig_file.is_file():
                raise RuntimeError(report.get('error') or 'Не удалось создать скелет для этого силуэта. Проверьте положение модели и разделение конечностей.')
            stats = glb_summary(rig_file)
            if not stats['skins']:
                raise RuntimeError(report.get('error') or 'В подготовленной модели отсутствует скелет.')
            versions = job.setdefault('_rigVersions', [])
            previous_path = rig.get('_path', 'rig/rigged.glb')
            if rig.get('available') and (JOB_ROOT / job['id'] / previous_path).is_file() and not any(v['path'] == previous_path for v in versions):
                versions.append({'revision': rig.get('revision', 'legacy'), 'path': previous_path,
                                 'rotation': rig.get('appliedRotation', {'x': 0, 'y': 0, 'z': 0}),
                                 **({'manual': rig['manual']} if rig.get('manual') else {})})
            rig.update(available=True, status='complete', stage='Скелет готов', progress=100,
                       revision=revision, appliedRotation=dict(rig['rotation']), _path=relative,
                       method='manual-landmarks' if manual is not None else report.get('method', 'humanoid-template'),
                       limitations='Суставы расставлены вручную; веса рассчитаны автоматически и могут требовать правки.' if manual is not None else
                       'Автоматический скелет человека; сложные позы могут требовать правки весов.')
            if manual is not None:
                rig.update(manual=manual, manualRotation=dict(rig['rotation']))
            else:
                rig.pop('manual', None)
                rig.pop('manualRotation', None)
            versions.append({'revision': revision, 'path': relative, 'rotation': dict(rig['rotation']),
                             **({'manual': manual} if manual is not None else {})})
            job['artifacts']['riggedUrl'] = self.file_url(job, relative)
            job['rigStats'] = stats
        except Exception as exc:
            LOG.exception('Rig failed for %s', job['id'])
            reason = str(exc)
            with contextlib.suppress(OSError, ValueError):
                reason = json.loads((directory / 'rig-report.json').read_text(encoding='utf-8')).get('error') or reason
            rig.update(status='failed', stage='Скелет не построен', error=reason[:600], progress=100)
        self.save(job)

    async def motion_job(self, job, motion):
        directory = JOB_ROOT / job['id'] / 'motions' / motion['id']
        directory.mkdir(parents=True, exist_ok=True)
        motion.update(status='running', stage='Ожидание видеокарты', progress=3)
        self.save(job)
        if not motion.get('_kimodoId'):
            await self.wait_idle(job, motion)
            await self.request_json('POST', COMFY + '/free', json={'unload_models': True, 'free_memory': True})
            motion.update(stage='Генерация движения в Kimodo', progress=10, _submitting=True)
            self.save(job)
            request = {'prompt': motion['prompt'], 'frames': motion['frames'], 'steps': motion['steps'], 'seed': motion['seed'], 'model': 'smplx-rp-v1'}
            result = await self.request_json('POST', KIMODO + '/api/generate', json=request)
            motion['_kimodoId'] = result['id']
            motion['_submitting'] = False
            self.save(job)
        kid = motion['_kimodoId']
        motion.update(stage='Генерация движения в Kimodo', progress=10)
        self.save(job)
        for _ in range(1800):
            try:
                entry = next((a for a in await self.legacy_history() if a['id'] == kid), None)
            except (aiohttp.ClientError, TimeoutError, RuntimeError):
                await asyncio.sleep(2)
                continue
            if entry and entry.get('status') in ('ready', 'complete', 'completed'):
                break
            if entry and entry.get('status') in ('error', 'failed'):
                raise RuntimeError(entry.get('error', 'Kimodo не смог сгенерировать движение.'))
            await asyncio.sleep(2)
        else:
            raise TimeoutError('Kimodo не завершил движение за отведённое время.')
        for name, components in [('root.f32', 3), ('rotations.f32', 22 * 4)]:
            async with self.http.get(KIMODO + f'/api/animations/{kid}/{name}') as response:
                response.raise_for_status()
                blob = await response.read()
            if len(blob) != motion['frames'] * components * 4:
                raise RuntimeError('Kimodo вернул движение неожиданной длины.')
            (directory / name).write_bytes(blob)
        motion.update(stage='Перенос движения на скелет модели', progress=75)
        self.save(job)
        await self.run_blender('retarget_motion.py', ['--input', JOB_ROOT / job['id'] / motion.get('_rigPath', 'rig/rigged.glb'), '--root', directory / 'root.f32', '--rotations', directory / 'rotations.f32', '--frames', motion['frames'], '--fps', 30, '--output', directory / 'animated.glb', '--name', 'Kimodo Motion'], directory)
        summary = glb_summary(directory / 'animated.glb')
        if not summary['skins'] or not summary['animations']:
            raise RuntimeError('В экспортированной модели отсутствует скелетная анимация.')
        motion.update(status='complete', stage='Анимация готова', progress=100, glbUrl=self.file_url(job, f"motions/{motion['id']}/animated.glb"), stats=summary)
        self.save(job)

    async def work(self):
        while True:
            kind, jid, mid = await self.queue.get()
            self.worker_job = jid
            job = self.jobs[jid]
            motion = next((m for m in job.get('motions', []) if m['id'] == mid), None)
            try:
                async with self.gpu:
                    self.operation = {'kind': kind, 'id': jid}
                    if kind == 'model':
                        await self.image_job(job)
                    else:
                        await self.motion_job(job, motion)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                LOG.exception('Job %s failed', jid)
                (motion or job).update(status='failed', stage='Ошибка', error=str(exc)[:700])
                self.save(job)
            finally:
                self.operation = None
                self.worker_job = None
                self.queue.task_done()

    async def work_rigs(self):
        # Pose detection, weights and Blender export run on CPU. They must not
        # wait for an unrelated long image/motion workload on the GPU.
        while True:
            jid, operation_id = await self.rig_queue.get()
            self.rig_worker_job = jid
            job = self.jobs[jid]
            try:
                async with self.rig_lock:
                    await self.rig_job(job, operation_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                LOG.exception('Rig job %s failed', jid)
                job['rig'].update(status='failed', stage='Ошибка', error=str(exc)[:700])
                self.save(job)
            finally:
                self.rig_worker_job = None
                self.rig_queue.task_done()

    def pending_count(self):
        return self.queue.qsize() + self.rig_queue.qsize()

    async def health(self, request):
        if time.monotonic() - self.health_at > 12 or self.health_cache is None:
            async def comfy():
                try:
                    result = await ComfyPipeline(COMFY).health()
                    return {'online': True, 'modelsReady': result['ready'], 'missingModels': result['missing_models']}
                except Exception:
                    return {'online': False, 'modelsReady': False}
            async def kimodo():
                try:
                    data = await self.request_json('GET', KIMODO + '/api/models')
                    items = data if isinstance(data, list) else data.get('models', [])
                    return {'online': True, 'availableModels': [m.get('id') for m in items if m.get('available')]}
                except Exception:
                    return {'online': False, 'availableModels': []}
            c, k = await asyncio.gather(comfy(), kimodo())
            self.health_cache = {'online': True, 'comfy': c, 'kimodo': k, 'capabilities': {'imageGeneration': c['modelsReady'], 'motionGeneration': 'smplx-rp-v1' in k['availableModels'], 'humanoidRigging': Path(BLENDER).exists()}, 'motionLicense': 'SMPL-X RP v1: NVIDIA Internal Scientific R&D; исследовательское, не производственное использование.'}
            self.health_at = time.monotonic()
        return web.json_response({**self.health_cache, 'service': 'model-studio', 'gpu': {'busy': self.gpu.locked(), 'operation': self.operation.get('kind') if self.operation else None},
                                  'rig': {'busy': self.rig_lock.locked(), 'queueLength': self.rig_queue.qsize()}, 'queueLength': self.pending_count()})

    async def jobs_list(self, request):
        rows = sorted((j for j in self.jobs.values() if self.community.owns(request, j)), key=lambda j: j['createdAt'], reverse=True)
        counts, authors = self.community.public_counts(), {}
        return web.json_response({'jobs': [self.public(j, author_cache=authors, model_counts=counts) for j in rows[:100]]})

    async def job_get(self, request):
        return web.json_response(self.public(self.owned(request)))

    def limit(self, request):
        if self.pending_count() >= 8:
            raise web.HTTPTooManyRequests(text='Очередь заполнена. Повторите позже.')
        key = request['account']['id'] if request.get('account') else request['session']
        recent = [t for t in self.rates.get(key, []) if time.monotonic() - t < 60]
        if len(recent) >= 4:
            raise web.HTTPTooManyRequests(text='Подождите минуту перед отправкой новых заданий.')
        self.rates[key] = recent + [time.monotonic()]

    async def create_job(self, request):
        self.limit(request)
        if request.content_type != 'multipart/form-data':
            raise web.HTTPBadRequest(text='Нужна форма с изображением.')
        if request.content_length and request.content_length > MAX_IMAGE + 1024 * 1024:
            raise web.HTTPRequestEntityTooLarge(max_size=MAX_IMAGE + 1024 * 1024, actual_size=request.content_length)
        try:
            reader = await request.multipart()
        except (AssertionError, ValueError):
            raise web.HTTPBadRequest(text='Некорректная форма загрузки.')
        fields, image = {}, None
        part_count = 0
        async for field in reader:
            part_count += 1
            if part_count > 5 or isinstance(field, aiohttp.MultipartReader):
                raise web.HTTPBadRequest(text='Слишком много полей формы.')
            if field.name == 'image':
                if image is not None:
                    raise web.HTTPBadRequest(text='Загрузите одно изображение.')
                image = bytearray()
                while chunk := await field.read_chunk(65536):
                    image.extend(chunk)
                    if len(image) > MAX_IMAGE:
                        raise web.HTTPRequestEntityTooLarge(max_size=MAX_IMAGE, actual_size=len(image))
            elif field.name in ('mode', 'quality', 'seed', 'visibility'):
                value = await field.read_chunk(256)
                if not field.at_eof():
                    raise web.HTTPBadRequest(text='Недопустимый параметр.')
                fields[field.name] = value.decode('utf-8')
            else:
                raise web.HTTPBadRequest(text='Неизвестное поле формы.')
        if not image:
            raise web.HTTPBadRequest(text='Добавьте изображение PNG, JPEG или WebP.')
        mode, quality = fields.get('mode', 'object'), fields.get('quality', 'standard')
        visibility = fields.get('visibility', 'public')
        if visibility not in ('public', 'private'):
            raise web.HTTPBadRequest(text='Видимость: public или private.')
        if mode not in ('object', 'humanoid') or quality not in ('standard', 'high'):
            raise web.HTTPBadRequest(text='Недопустимый режим генерации.')
        try:
            seed = int(fields.get('seed') or 20260907)
            if not 0 <= seed <= 2**32 - 1:
                raise ValueError()
            with Image.open(io.BytesIO(image)) as src:
                if src.format not in ('PNG', 'JPEG', 'WEBP') or src.width * src.height > 24_000_000 or min(src.size) < 96:
                    raise ValueError()
                normalized = ImageOps.exif_transpose(src).convert('RGBA')
                normalized.thumbnail((2048, 2048))
        except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError):
            raise web.HTTPBadRequest(text='Нужен корректный PNG/JPEG/WebP: от 96 пикселей по каждой стороне, до 24 мегапикселей.')
        if self.pending_count() >= 8:
            raise web.HTTPTooManyRequests(text='Очередь заполнена. Повторите позже.')
        jid = str(uuid.uuid4())
        folder = JOB_ROOT / jid
        folder.mkdir()
        normalized.save(folder / 'input.png')
        job = {'id': jid, '_owner': request['session'], 'kind': 'model', 'mode': mode, 'quality': quality, 'seed': seed,
               'visibility': visibility,
               'status': 'queued', 'stage': 'В очереди на этом ПК', 'progress': 0, 'createdAt': now(), 'updatedAt': now(),
               'artifacts': {}, 'rig': {'available': False, 'status': 'queued' if mode == 'humanoid' else 'not_requested'}, 'motions': []}
        job['sourceImageUrl'] = self.file_url(job, 'input.png')
        if request.get('account'):
            job['_accountId'] = request['account']['id']
        self.jobs[jid] = job
        self.save(job)
        self.queue.put_nowait(('model', jid, None))
        return web.json_response(self.public(job), status=202)

    async def animate(self, request):
        job = self.owned(request)
        self.limit(request)
        if job['status'] != 'complete' or not job['rig']['available']:
            raise web.HTTPConflict(text='Сначала нужна готовая модель со скелетом.')
        if job['rig'].get('status') in ('queued', 'running'):
            raise web.HTTPConflict(text='Дождитесь завершения построения скелета.')
        if any(m['status'] in ('queued', 'running') for m in job['motions']):
            raise web.HTTPConflict(text='Анимация для этой модели уже в очереди.')
        mesh_revision = mesh_payload(job)['revision']
        rig_source = (job['rig'].get('revision', 'legacy'), job['rig'].get('_path', 'rig/rigged.glb'))
        data = await self.json_object(request)
        prompt = str(data.get('prompt', '')).strip()
        try:
            frames, steps, seed = int(data.get('frames', 150)), int(data.get('steps', 50)), int(data.get('seed', 0))
            if not (30 <= frames <= 300 and 20 <= steps <= 100 and 0 <= seed <= 2**32 - 1 and 1 <= len(prompt) <= 1500):
                raise ValueError()
            if data.get('model', 'smplx-rp-v1') != 'smplx-rp-v1':
                raise ValueError()
        except (TypeError, ValueError):
            raise web.HTTPBadRequest(text='Нужны описание движения, длительность 1–10 секунд и корректные параметры.')
        if self.pending_count() >= 8:
            raise web.HTTPTooManyRequests(text='Очередь заполнена. Повторите позже.')
        if self.owned(request) is not job:
            raise web.HTTPNotFound(text='Модель удалена.')
        if job['status'] != 'complete' or not job['rig'].get('available'):
            raise web.HTTPConflict(text='Сначала нужна готовая модель со скелетом.')
        if (mesh_payload(job)['revision'] != mesh_revision
                or (job['rig'].get('revision', 'legacy'), job['rig'].get('_path', 'rig/rigged.glb')) != rig_source):
            raise web.HTTPConflict(text='Модель или скелет изменились. Откройте актуальную модель и повторите запуск движения.')
        if any(m['status'] in ('queued', 'running') for m in job['motions']):
            raise web.HTTPConflict(text='Анимация для этой модели уже в очереди.')
        if job['rig'].get('status') in ('queued', 'running'):
            raise web.HTTPConflict(text='Дождитесь завершения построения скелета.')
        rig_path = job['rig'].get('_path', 'rig/rigged.glb')
        if not (JOB_ROOT / job['id'] / rig_path).is_file():
            raise web.HTTPConflict(text='Файл скелета не найден. Постройте скелет повторно.')
        motion = {'id': str(uuid.uuid4()), 'status': 'queued', 'stage': 'В очереди', 'progress': 0, 'prompt': prompt, 'frames': frames, 'fps': 30, 'steps': steps, 'seed': seed, 'model': 'smplx-rp-v1', 'createdAt': now(),
                  '_rigPath': rig_path, 'rigRevision': job['rig'].get('revision', 'legacy')}
        job['motions'].append(motion)
        self.save(job)
        self.queue.put_nowait(('motion', job['id'], motion['id']))
        return web.json_response(self.public(motion), status=202)

    async def rig(self, request):
        job = self.owned(request)
        self.limit(request)
        def ready():
            if self.motion_library.busy(job):
                raise web.HTTPConflict(text='Дождись подготовки выбранного движения.')
            if job['status'] != 'complete' or not (JOB_ROOT / job['id'] / 'model.glb').is_file():
                raise web.HTTPConflict(text='Сначала дождитесь готовой модели.')
            if job['rig'].get('status') in ('queued', 'running') or any(m['status'] in ('queued', 'running') for m in job['motions']):
                raise web.HTTPConflict(text='Для этой модели уже выполняется построение скелета или анимации.')
        ready()
        data = await self.json_object(request)
        rotation = data.get('rotation')
        if set(data) not in ({'rotation'}, {'rotation', 'manual'}) or not isinstance(rotation, dict) or set(rotation) != {'x', 'y', 'z'}:
            raise web.HTTPBadRequest(text='Нужен rotation с углами x, y, z в градусах.')
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not -180 <= value <= 180 or not math.isfinite(value) for value in rotation.values()):
            raise web.HTTPBadRequest(text='Углы x, y, z должны быть числами от −180 до 180 градусов.')
        manual = None
        if 'manual' in data:
            try:
                manual = validate_manual(data['manual'])
            except ValueError as error:
                raise web.HTTPBadRequest(text=str(error))
        if self.pending_count() >= 8:
            raise web.HTTPTooManyRequests(text='Очередь заполнена. Повторите позже.')
        if self.owned(request) is not job:
            raise web.HTTPNotFound(text='Модель удалена.')
        ready()  # Body reads yield: recheck before reserving the operation.
        operation_id = str(uuid.uuid4())
        rig = {**job['rig'], 'status': 'queued', 'stage': 'В очереди на построение скелета', 'progress': 0,
               'operationId': operation_id, 'rotation': dict(rotation), 'error': None,
               'mode': 'manual' if manual is not None else 'auto',
               'requestedMethod': 'manual' if manual is not None else 'auto'}
        rig.pop('_manualInput', None)
        candidate = {**job, 'rig': rig}
        if manual is not None:
            rig['_manualInput'] = manual
            candidate['_manualRigDraft'] = {'rotation': dict(rotation), 'manual': manual, 'updatedAt': now()}
        # Reserve only after durable persistence, so a failed save stays retryable.
        self.save(candidate)
        job.update(candidate)
        self.rig_queue.put_nowait((job['id'], operation_id))
        return web.json_response(self.public(job), status=202)

    async def rig_draft(self, request):
        job = self.owned(request)
        data = await self.json_object(request)
        rotation = data.get('rotation')
        if not {'rotation', 'manual'} <= set(data) or set(data) - {'rotation', 'manual', 'write'}:
            raise web.HTTPBadRequest(text='Нужны rotation и manual для сохранения разметки.')
        if not isinstance(rotation, dict) or set(rotation) != {'x', 'y', 'z'} or any(
            isinstance(value, bool) or not isinstance(value, (int, float)) or not -180 <= value <= 180
            or not math.isfinite(value) for value in rotation.values()
        ):
            raise web.HTTPBadRequest(text='Углы x, y, z должны быть числами от −180 до 180 градусов.')
        try:
            manual = validate_manual(data['manual'], complete=False)
        except ValueError as error:
            raise web.HTTPBadRequest(text=str(error))
        if 'write' in data:
            write = data['write']
            try:
                if not isinstance(write, dict) or set(write) != {'clientId', 'revision'}:
                    raise ValueError()
                client_id, revision = write['clientId'], write['revision']
                if not isinstance(client_id, str) or len(client_id) != 36 or str(uuid.UUID(client_id)) != client_id.lower():
                    raise ValueError()
                if type(revision) is not int or not 0 <= revision <= 2**53 - 1:
                    raise ValueError()
                client_id = str(uuid.UUID(client_id))
            except (ValueError, TypeError, AttributeError):
                raise web.HTTPBadRequest(text='Нужны write.clientId в формате UUID и целая write.revision от 0 до 9007199254740991.')
        if self.owned(request) is not job:
            raise web.HTTPNotFound(text='Модель удалена.')
        if job['status'] != 'complete' or not (JOB_ROOT / job['id'] / 'model.glb').is_file():
            raise web.HTTPConflict(text='Сначала дождитесь готовой модели.')
        writes = dict(job.get('_manualRigWrites', {}))
        if 'write' in data:
            if revision <= writes.get(client_id, -1):
                return web.json_response(self.public(job))
            writes.pop(client_id, None)
            writes[client_id] = revision
            while len(writes) > 64:
                writes.pop(next(iter(writes)))
        candidate = {**job, '_manualRigDraft': {'rotation': dict(rotation), 'manual': manual, 'updatedAt': now()},
                     '_manualRigWrites': writes}
        self.save(candidate)
        job.update(candidate)
        return web.json_response(self.public(job))

    def job_busy(self, job):
        jid = job['id']
        return (job['status'] not in ('complete', 'failed')
                or self.motion_library.busy(job)
                or job.get('rig', {}).get('status') in ('queued', 'running')
                or any(m.get('status') in ('queued', 'running') for m in job.get('motions', []))
                or jid in (self.worker_job, self.rig_worker_job)
                or bool(self.operation and self.operation.get('id') == jid)
                or any(item[1] == jid for item in self.queue._queue)
                or any(item[0] == jid for item in self.rig_queue._queue))

    @staticmethod
    def verify_delete_tree(directory, root):
        # Reject all reparse points, including Windows directory junctions.
        # The deletion routine never traverses a user-created link outside jobs.
        if directory.resolve().parent != root and not directory.resolve().is_relative_to(root):
            raise ValueError('Unsafe model directory')
        pending = [directory]
        while pending:
            entry = pending.pop()
            info = entry.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise ValueError('Linked model files cannot be deleted recursively')
            if not entry.resolve(strict=True).is_relative_to(root):
                raise ValueError('Model file leaves job storage')
            if stat.S_ISDIR(info.st_mode):
                pending.extend(entry.iterdir())

    async def delete_job(self, request):
        job = self.owned(request)
        if self.job_busy(job):
            raise web.HTTPConflict(text='Дождитесь завершения генерации модели, скелета и всех движений перед удалением.')
        jid = job['id']
        try:
            if str(uuid.UUID(jid)) != jid or request.match_info['job_id'] != jid:
                raise ValueError('Invalid job directory name')
            root = JOB_ROOT.resolve(strict=True)
            directory = JOB_ROOT / jid
            if directory.resolve().parent != root:
                raise ValueError('Model directory leaves job storage')
            if directory.exists() or directory.is_symlink():
                self.verify_delete_tree(directory, root)
            staging = JOB_ROOT / '.deleting'
            if staging.exists() or staging.is_symlink():
                self.verify_delete_tree(staging, root)
            else:
                staging.mkdir()
            tombstone = staging / str(uuid.uuid4())
            if tombstone.resolve().parent != staging.resolve() or not tombstone.resolve().is_relative_to(root):
                raise ValueError('Unsafe deletion staging directory')
        except (OSError, ValueError):
            LOG.warning('Refused unsafe deletion of job %s', jid)
            raise web.HTTPConflict(text='Не удалось безопасно определить папку модели. Удаление не выполнено.')
        # No await between the state check, rename and registry update: another
        # request cannot reserve this job midway through the local transaction.
        try:
            if directory.exists():
                directory.rename(tombstone)
                try:
                    self.verify_delete_tree(tombstone, root)
                    shutil.rmtree(tombstone)
                except (OSError, ValueError):
                    if tombstone.exists() and not directory.exists():
                        tombstone.rename(directory)
                    # Keep the job discoverable even if the OS removed metadata
                    # before a locked file caused a partial cleanup failure.
                    self.save(job)
                    raise
        except (OSError, ValueError):
            LOG.exception('Could not completely delete job %s', jid)
            raise web.HTTPServiceUnavailable(text='Не удалось полностью удалить файлы модели. Запись сохранена; проверьте занятые файлы и повторите удаление.')
        del self.jobs[jid]
        self.community.forget_job(jid)
        return web.json_response({'deleted': True, 'id': jid})

    async def placement(self, request):
        job = self.owned(request)
        data = await self.json_object(request)
        position = data.get('position')
        if 'position' not in data or set(data) - {'position', 'rotation', 'write'} or not isinstance(position, dict) or set(position) != {'x', 'y', 'z'}:
            raise web.HTTPBadRequest(text='Нужен position с координатами x, y, z в метрах.')
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not -5 <= value <= 5 or not math.isfinite(value) for value in position.values()):
            raise web.HTTPBadRequest(text='Координаты должны быть числами от −5 до 5 метров.')
        if 'rotation' in data:
            rotation = data['rotation']
            if not isinstance(rotation, dict) or set(rotation) != {'x', 'y', 'z'}:
                raise web.HTTPBadRequest(text='Нужен rotation с углами x, y, z в градусах.')
            if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not -180 <= value <= 180 or not math.isfinite(value) for value in rotation.values()):
                raise web.HTTPBadRequest(text='Углы x, y, z должны быть числами от −180 до 180 градусов.')
        write = data.get('write')
        if 'write' in data:
            try:
                if not isinstance(write, dict) or set(write) != {'clientId', 'revision'}:
                    raise ValueError()
                client_id, revision = write['clientId'], write['revision']
                if not isinstance(client_id, str) or len(client_id) != 36 or str(uuid.UUID(client_id)) != client_id.lower():
                    raise ValueError()
                if type(revision) is not int or not 0 <= revision <= 2**53 - 1:
                    raise ValueError()
                client_id = str(uuid.UUID(client_id))
            except (ValueError, TypeError, AttributeError):
                raise web.HTTPBadRequest(text='Нужны write.clientId в формате UUID и целая write.revision от 0 до 9007199254740991.')
        # A DELETE may have completed while the request body was being read.
        if self.jobs.get(job['id']) is not job or not self.community.owns(request, job):
            raise web.HTTPNotFound(text='Модель удалена.')
        writes = None
        if 'write' in data:
            writes = dict(job.get('_placementWrites', {}))
            if revision <= writes.get(client_id, -1):
                return web.json_response(self.public(job))
            # Last accepted revisions prevent delayed unload/autosave requests
            # from replacing a newer draft from the same page. Keep 64 clients.
            writes.pop(client_id, None)
            writes[client_id] = revision
            while len(writes) > 64:
                writes.pop(next(iter(writes)))
        candidate = {**job, 'placement': dict(position)}
        if 'rotation' in data:
            # Absolute glTF XYZ Euler orientation of the original source mesh.
            # Rig exports already bake rig.appliedRotation into their geometry;
            # this viewer setting must never be applied to that rig a second time.
            candidate['modelRotation'] = dict(data['rotation'])
        if writes is not None:
            candidate['_placementWrites'] = writes
        # Commit settings and watermarks to disk before advancing live state.
        # A failed save must leave the same revision retryable, and workers keep
        # their existing reference to this job after a successful commit.
        self.save(candidate)
        job.update(candidate)
        return web.json_response(self.public(job))

    async def share_create(self, request):
        job = self.owned(request)
        if job['status'] != 'complete' or not (JOB_ROOT / job['id'] / 'model.glb').is_file():
            raise web.HTTPConflict(text='Поделиться можно только готовой моделью.')
        if not SHARE_RE.fullmatch(job.get('_shareToken', '')):
            job['_shareToken'] = secrets.token_urlsafe(32)
            self.save(job)
        token = job['_shareToken']
        return web.json_response({'url': f'/playground?share={token}', 'token': token})

    async def share_revoke(self, request):
        job = self.owned(request)
        job.pop('_shareToken', None)
        self.save(job)
        return web.json_response({'revoked': True, 'id': job['id']})

    def shared(self, request):
        token = request.match_info['token']
        if not SHARE_RE.fullmatch(token):
            raise web.HTTPNotFound(text='Ссылка недоступна.')
        job = next((job for job in self.jobs.values() if job.get('_shareToken') == token and job['status'] == 'complete'), None)
        if not job or not (JOB_ROOT / job['id'] / 'model.glb').is_file():
            raise web.HTTPNotFound(text='Ссылка недоступна.')
        return job, token

    def shared_files(self, job):
        files = {mesh_path(job)}
        files.update(environment_texture_paths(job, active_only=True).values())
        if job.get('rig', {}).get('available'):
            files.add(job['rig'].get('_path', 'rig/rigged.glb'))
        files.update(f"motions/{motion['id']}/animated.glb" for motion in job.get('motions', []) if motion.get('status') == 'complete')
        return files

    def shared_payload(self, job, prefix, include_prompts=True):
        shared = {key: job[key] for key in ('id', 'title', 'name', 'mode', 'visibility', 'stats', 'placement', 'modelRotation', 'updatedAt') if key in job}
        shared.update(status='complete', stage='Готово', progress=100,
                      artifacts={'modelUrl': prefix + mesh_path(job)},
                      rig={'available': False, 'status': 'not_requested'}, motions=[])
        shared['environment'] = environment_payload(job, prefix, active_only=True)
        shared['meshEdit'] = mesh_payload(job)
        if url := motion_library_prefix(job, prefix):
            shared['artifacts']['motionLibraryUrl'] = url
        if 'rotation' in job.get('rig', {}):
            shared['rig']['rotation'] = job['rig']['rotation']
        if job.get('rig', {}).get('available'):
            shared['artifacts']['riggedUrl'] = prefix + job['rig'].get('_path', 'rig/rigged.glb')
            shared['rig'] = {key: job['rig'][key] for key in ('available', 'revision', 'method', 'rotation', 'appliedRotation', 'limitations') if key in job['rig']}
            shared['rig']['status'] = 'complete'
            if 'rigStats' in job:
                shared['rigStats'] = job['rigStats']
        for motion in job.get('motions', []):
            if motion.get('status') != 'complete':
                continue
            keys = ('id', 'frames', 'fps', 'model', 'stats', 'rigRevision') + (('prompt',) if include_prompts else ())
            item = {key: motion[key] for key in keys if key in motion}
            item.update(status='complete', glbUrl=prefix + f"motions/{motion['id']}/animated.glb")
            shared['motions'].append(item)
        return shared

    async def share_get(self, request):
        job, token = self.shared(request)
        return web.json_response({'job': self.shared_payload(job, f'/api/model-studio/shares/{token}/files/'),
                                  'canEdit': self.community.owns(request, job)}, headers={'Cache-Control': 'no-store'})

    async def share_file(self, request):
        job, token = self.shared(request)
        name = request.match_info['file']
        if self.motion_library.matches(name):
            return await self.motion_library.artifact(request, job, name, lambda: self.shared(request)[0])
        if name not in self.shared_files(job):
            raise web.HTTPNotFound()
        path = JOB_ROOT / job['id'] / name
        if not path.is_file():
            raise web.HTTPNotFound()
        return artifact_response(request, path)

    async def file(self, request):
        job = self.owned(request)
        name = request.match_info['file']
        if self.motion_library.matches(name):
            return await self.motion_library.artifact(request, job, name, lambda: self.owned(request))
        permitted = {'input.png', 'model.glb', 'preview.webp'} | {f"motions/{m['id']}/animated.glb" for m in job['motions'] if m['status'] == 'complete'}
        permitted.update(mesh_history_paths(job))
        permitted.update(environment_texture_paths(job).values())
        permitted.update(version['path'] for version in job.get('_rigVersions', []))
        if job['rig'].get('available'):
            permitted.add(job['rig'].get('_path', 'rig/rigged.glb'))
        # Old animation snapshots still refer to the original pre-versioning rig.
        permitted.update(m['_rigPath'] for m in job['motions'] if m.get('_rigPath'))
        if name not in permitted:
            raise web.HTTPNotFound()
        path = JOB_ROOT / job['id'] / name
        if not path.is_file():
            raise web.HTTPNotFound()
        policy = 'no-store' if name == 'input.png' else 'private, no-cache'
        return artifact_response(request, path, policy=policy)

    async def demo(self, request):
        file = DATA / 'demo' / 'doom-rigged.glb'
        if not file.exists():
            raise web.HTTPNotFound(text='Демо-модель не установлена.')
        return web.FileResponse(file, headers={'Cache-Control': 'private, no-cache'})

    async def json_object(self, request):
        if request.content_type != 'application/json':
            raise web.HTTPBadRequest(text='Ожидается JSON.')
        raw = bytearray()
        async for chunk in request.content.iter_chunked(4096):
            raw.extend(chunk)
            if len(raw) > 16384:
                raise web.HTTPRequestEntityTooLarge(max_size=16384, actual_size=len(raw))
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise web.HTTPBadRequest(text='Ожидается объект JSON.')
        return data

    async def legacy_generate(self, request):
        # Exact public /api/generate is routed here so the old UI shares the GPU.
        data = await self.json_object(request)
        if self.gpu.locked() or not self.queue.empty():
            return web.json_response({'error': 'GPU занят генерацией модели или анимации. Дождитесь завершения задания и повторите.'}, status=409)
        await self.gpu.acquire()
        try:
            q = await self.request_json('GET', COMFY + '/queue')
            if q.get('queue_running') or q.get('queue_pending'):
                raise web.HTTPConflict(text='ComfyUI выполняет задание. Дождитесь завершения.')
            await self.request_json('POST', COMFY + '/free', json={'unload_models': True, 'free_memory': True})
            async with self.http.post(KIMODO + '/api/generate', json=data) as response:
                result = await response.read()
                status = response.status
            if status == 202:
                kid = json.loads(result)['id']
                self.operation = {'kind': 'legacy-motion'}
                task = asyncio.create_task(self.follow_legacy(kid))
                self.legacy_tasks.add(task)
                task.add_done_callback(self.legacy_tasks.discard)
            else:
                self.gpu.release()
            return web.Response(body=result, status=status, content_type='application/json')
        except BaseException:
            if self.gpu.locked() and self.operation is None:
                self.gpu.release()
            raise

    async def follow_legacy(self, kid):
        try:
            while True:
                try:
                    item = next((a for a in await self.legacy_history() if a['id'] == kid), None)
                except (aiohttp.ClientError, TimeoutError, RuntimeError):
                    await asyncio.sleep(2)
                    continue
                if item and item.get('status') in ('ready', 'complete', 'completed', 'error', 'failed'):
                    return
                await asyncio.sleep(2)
        finally:
            self.operation = None
            self.gpu.release()


@web.middleware
async def sessions(request, handler):
    owner = request.cookies.get('model_studio_session', '')
    fresh = not SESSION_RE.fullmatch(owner)
    if fresh:
        owner = secrets.token_hex(24)
    request['session'] = owner
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        origin = request.headers.get('Origin')
        allowed = {'https://models.xedoc.ru', 'http://127.0.0.1:8095', 'http://localhost:8095', 'http://localhost:5180', 'http://127.0.0.1:5180'}
        if origin and origin not in allowed:
            raise web.HTTPForbidden(text='Недопустимый источник запроса.')
    try:
        request.app['studio'].community.identify(request)
        response = await handler(request)
    except web.HTTPException as exc:
        response = web.json_response({'error': exc.text or exc.reason}, status=exc.status)
    except (ValueError, json.JSONDecodeError, AssertionError):
        response = web.json_response({'error': 'Некорректные параметры запроса.'}, status=400)
    except Exception:
        LOG.exception('Request failed')
        response = web.json_response({'error': 'Локальный сервис временно недоступен. Проверьте состояние ComfyUI и Kimodo.'}, status=503)
    if fresh:
        response.set_cookie('model_studio_session', owner, max_age=30 * 86400, httponly=True, samesite='Lax', secure=request.headers.get('X-Forwarded-Proto') == 'https')
    response.headers['X-Content-Type-Options'] = 'nosniff'
    if request.path.startswith('/api/model-studio'):
        # Only artifact handlers opt into browser storage. Revalidation still
        # runs their ownership/share/visibility checks before FileResponse can
        # return an ETag/Last-Modified 304; JSON, errors and input stay no-store.
        cacheable_asset = (isinstance(response, web.FileResponse) and response.status == 200
                           and response.headers.get('Cache-Control') == 'private, no-cache')
        if not cacheable_asset:
            response.headers['Cache-Control'] = 'no-store'
    return response


async def index(request):
    file = DIST / 'index.html'
    if not file.exists():
        raise web.HTTPServiceUnavailable(text='Интерфейс ещё не собран.')
    return web.FileResponse(file, headers={'Cache-Control': 'no-cache'})


def create_app():
    studio = Studio()
    app = web.Application(middlewares=[sessions], client_max_size=MAX_IMAGE + 1024 * 1024)
    app['studio'] = studio
    app.on_startup.append(studio.start)
    app.on_cleanup.append(studio.stop)
    prefix = '/api/model-studio'
    app.add_routes(studio.community.routes(prefix))
    app.add_routes([web.get(prefix + '/health', studio.health), web.get(prefix + '/jobs', studio.jobs_list),
                    web.get(prefix + '/motion-library', studio.motion_library.catalog),
                    web.post(prefix + '/jobs', studio.create_job), web.get(prefix + '/jobs/{job_id}', studio.job_get),
                    web.delete(prefix + '/jobs/{job_id}', studio.delete_job),
                    web.post(prefix + '/jobs/{job_id}/mesh-edit', studio.mesh_edits.edit),
                    web.post(prefix + '/jobs/{job_id}/mesh-restore', studio.mesh_edits.restore),
                    web.patch(prefix + '/jobs/{job_id}/placement', studio.placement),
                    web.put(prefix + '/jobs/{job_id}/environment', studio.environment.update),
                    web.post(prefix + '/jobs/{job_id}/share', studio.share_create),
                    web.delete(prefix + '/jobs/{job_id}/share', studio.share_revoke),
                    web.get(prefix + '/shares/{token}', studio.share_get),
                    web.get(prefix + '/shares/{token}/files/{file:.*}', studio.share_file),
                    web.post(prefix + '/jobs/{job_id}/rig', studio.rig),
                    web.put(prefix + '/jobs/{job_id}/rig-draft', studio.rig_draft),
                    web.post(prefix + '/jobs/{job_id}/animate', studio.animate), web.get(prefix + '/files/{job_id}/{file:.*}', studio.file),
                    web.get(prefix + '/demo/glb', studio.demo), web.post('/api/generate', studio.legacy_generate),
                    web.get('/generate-model', index), web.get('/generate-model/', index), web.get('/playground', index),
                    web.get('/playground/', index), web.get('/model-studio/', index), web.get('/', index)])
    app.add_routes([web.get('/gallery', index), web.get('/gallery/', index),
                    web.get('/profiles', index), web.get('/profiles/', index),
                    web.get('/profile', index), web.get('/profile/', index),
                    web.get('/profile/{username}', index), web.get('/profile/{username}/', index),
                    web.get('/model/{model_id}', index), web.get('/model/{model_id}/', index)])
    (DIST / 'assets').mkdir(parents=True, exist_ok=True)
    app.router.add_static('/model-studio/assets/', DIST / 'assets', show_index=False)
    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8095)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    web.run_app(create_app(), host='127.0.0.1', port=args.port, print=lambda text: LOG.info(text))
