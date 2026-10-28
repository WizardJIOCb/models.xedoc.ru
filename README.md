# models.xedoc.ru

MVP-сервис для генерации 3D ассетов: веб-интерфейс на слабом сервере, очередь задач, загрузка референсов, экспорт артефактов и отдельный GPU-worker для домашнего ПК с RTX 4070 Ti.

## Что внутри

- `apps/web` - React + Vite интерфейс: prompt, reference images, provider, formats, queue, Three.js preview.
- `apps/server` - Fastify API: файловое хранилище, задания, worker endpoints, выдача артефактов.
- `apps/worker` - polling worker: забирает задания с сервера и запускает mock/local runner.
- `packages/shared` - общие типы и каталог провайдеров.
- `data/` - локальное хранилище заданий и файлов.

## Старт локально

Самый простой способ в Windows — открыть **`start.bat` в корне репозитория**. Он создаст `.env` из шаблона при первом запуске, при необходимости установит npm-зависимости, поднимет web + API и локальный worker, дождётся API, затем откроет браузер.

Повторный запуск не создаёт второй web/API или worker. Журналы лежат в `.runtime\dev.log`, `.runtime\worker.log` и файлах `*.error.log` рядом с ними. Запуск без открытия браузера: `start.bat -NoBrowser`.

Ручной вариант, если требуется видеть каждый процесс отдельно:

```bash
pnpm install
copy .env.example .env
pnpm dev:server
pnpm dev:web
pnpm dev:worker
```

Веб: `http://localhost:3420`
API: `http://localhost:3421`

По умолчанию worker работает в `RUNNER_MODE=mock` и возвращает тестовый `OBJ/MTL`, чтобы проверить весь путь: форма -> очередь -> worker -> artifacts -> preview/download.

## Рекомендуемая AI-матрица

### Локальная генерация на 4070 Ti

- `Hunyuan3D 2.1` - главный кандидат для production-like image-to-3D с PBR материалами.
- `TRELLIS.2` - сильный кандидат для high-fidelity image-to-3D и сложной топологии.
- `Stable Fast 3D` - быстрые single-image черновики, UV/material output.
- `TripoSR` - очень быстрый draft/reconstruction baseline.

### API-провайдеры

- `Meshy API` - text/image-to-3D, preview/refine workflow, удобен для массовых задач.
- `Tripo API` - text/image/multiview-to-3D, post-processing, low-poly options.
- `Hyper3D Rodin API` - hosted генерация production-ready ассетов.

### Rigging/postprocess

- `UniRig` - общий auto-rigging для разных 3D мешей.
- `Make-It-Animatable` - лучший первый выбор для humanoid/anime персонажей.
- `RigAnything` - template-free rigging для разнообразных объектов.
- `SkinTokens / TokenRig` - перспективная линия для unified skeleton + skinning, стоит держать в roadmap.
- `Puppeteer` - rig + animation pipeline, полезен как следующий этап после базового rigging.

## Подключение настоящей локальной модели

Worker ожидает, что runner получит JSON задания и папку вывода. Команда задается через `RUNNER_COMMANDS_JSON`.

Пример:

```bash
RUNNER_MODE=command
MOCK_WHEN_UNCONFIGURED=false
RUNNER_COMMANDS_JSON={"hunyuan3d-2.1":{"command":"python","args":["C:/AI/Hunyuan3D-2.1/run_job.py","--job","{jobFile}","--out","{outputDir}"],"cwd":"C:/AI/Hunyuan3D-2.1"}}
```

Также runner получает переменные окружения:

- `JOB_FILE` - путь к JSON с prompt, provider, options, references.
- `OUTPUT_DIR` - папка, куда нужно положить `.glb`, `.obj`, `.mtl`, `.png`, `.zip` и т.д.

Все файлы из `OUTPUT_DIR` worker загрузит обратно на сервер как artifacts.

## Управление локальными моделями

Выбор провайдера в форме не скачивает веса автоматически. Для этого есть блок `Локальные модели`:

- `Install` - ставит команду установки в очередь для домашнего GPU worker.
- `Test` - запускает smoke-test модели, если команда теста настроена.
- `Open folder` - просит worker открыть локальную папку модели.

Реальное скачивание начнется только если на worker задана команда в `MODEL_ACTION_COMMANDS_JSON`.

Пример:

```bash
MODEL_BASE_DIR=C:/AI/models.xedoc.ru
MODEL_ACTION_COMMANDS_JSON={"hunyuan3d-2.1:install":{"command":"powershell","args":["-File","C:/AI/install-hunyuan.ps1","-Target","{modelDir}"]},"hunyuan3d-2.1:test":{"command":"python","args":["C:/AI/Hunyuan3D-2.1/smoke_test.py","--model-dir","{modelDir}"]}}
```

Доступные placeholders:

- `{providerId}` - id провайдера, например `hunyuan3d-2.1`.
- `{modelDir}` - папка модели внутри `MODEL_BASE_DIR`.

### RigAnything

RigAnything требует `git`, `conda`, Python 3.11 окружение, PyTorch под CUDA и checkpoint из Hugging Face.
В проекте есть готовые Windows helper-скрипты:

- `scripts/model-actions/install-riganything.ps1`
- `scripts/model-actions/test-riganything.ps1`

Worker `.env` пример:

```bash
MODEL_BASE_DIR=C:/AI/models.xedoc.ru
MODEL_ACTION_COMMANDS_JSON={"riganything:install":{"command":"powershell","args":["-ExecutionPolicy","Bypass","-File","C:/Projects/models.xedoc.ru/scripts/model-actions/install-riganything.ps1","-Target","{modelDir}"]},"riganything:test":{"command":"powershell","args":["-ExecutionPolicy","Bypass","-File","C:/Projects/models.xedoc.ru/scripts/model-actions/test-riganything.ps1","-ModelDir","{modelDir}"]}}
```

После изменения env перезапустите worker и нажмите `Install` у RigAnything.

## API

- `GET /api/health`
- `GET /api/providers`
- `POST /api/jobs` multipart form-data:
  - `prompt`
  - `provider`
  - `quality`
  - `targetFormats`
  - `pbr`
  - `rigging`
  - `optimizeGameReady`
  - `polycountTarget`
  - `references[]`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `POST /api/jobs/:id/cancel`
- `GET /api/worker/jobs/next`
- `POST /api/worker/jobs/:id/status`
- `POST /api/worker/jobs/:id/artifacts`
- `POST /api/worker/jobs/:id/error`

Worker endpoints требуют header:

```http
Authorization: Bearer <WORKER_SECRET>
```

## Production layout

- GitHub: `WizardJIOCb/models.xedoc.ru`
- Server: `82.146.42.213`
- Domain: `models.xedoc.ru`
- Server folder: `/var/www/models.xedoc.ru`
- Heavy generation: outgoing polling worker on the Windows PC with 4070 Ti.

Recommended server env:

```bash
PORT=3421
HOST=127.0.0.1
PUBLIC_ORIGIN=https://models.xedoc.ru
DATA_DIR=/var/www/models.xedoc.ru/data
WORKER_SECRET=<long-random-token>
```

Recommended worker env:

```bash
SERVER_URL=https://models.xedoc.ru
WORKER_SECRET=<same-long-random-token>
WORKER_ID=rtx-4070-ti-home
RUNNER_MODE=command
MOCK_WHEN_UNCONFIGURED=false
RUNNER_COMMANDS_JSON={}
```

## Nginx sketch

```nginx
server {
  server_name models.xedoc.ru;

  root /var/www/models.xedoc.ru/apps/web/dist;
  index index.html;

  location /api/ {
    proxy_pass http://127.0.0.1:3421;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location /files/ {
    proxy_pass http://127.0.0.1:3421;
    proxy_set_header Host $host;
  }

  location / {
    try_files $uri /index.html;
  }
}
```

## GitHub привязка

```bash
git init
git remote add origin https://github.com/WizardJIOCb/models.xedoc.ru.git
git checkout -b main
git add .
git commit -m "Initial 3D model generation cockpit"
git push -u origin main
```
