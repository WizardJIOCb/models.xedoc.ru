import './style.css';
import './placement.css';
import './library-actions.css';
import './community-integration.css';
import { mountCommunityHeader, mountGallerySection, mountComments, renderPublicationPanel } from './community.js';
import { renderEnvironmentPanel, getEnvironmentPreview, saveEnvironmentPanel } from './environment-panel.js';
import { manualRigMarkup, createManualRigPanel } from './manual-rig-panel.js';
import { createMeshEditPanel } from './mesh-edit-panel.js';

const API = '/api/model-studio';
const settingsClientId = crypto.randomUUID();
const params = new URLSearchParams(location.search);
const shareToken = params.get('share');
const publicModelId = params.get('model');
const isShared = Boolean(shareToken || publicModelId);
const isPlayground = isShared || location.pathname.replace(/\/$/, '') === '/playground';
const $ = (id) => document.getElementById(id);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icons = {
  cube: '<svg viewBox="0 0 24 24" fill="none"><path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m3 7 9 5 9-5M12 12v10M7.5 4.5l9 5"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none"><path d="m8 4 12 8-12 8V4Z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/></svg>',
  reset: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none"><path d="m14 2-10 12h7l-1 8L21 9h-8l1-7Z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none"><path d="m5 12 4 4L19 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none"><path d="m6 6 12 12M6 18 18 6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none"><circle cx="18" cy="4" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="20" r="3"/><path d="m8.5 10.5 7-5m-7 8 7 5"/></svg>',
  person: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="4" r="2"/><path d="M12 7v8m-8-6 8 2 8-2M7 22l5-7 5 7"/></svg>',
};
const icon = (name) => `<span class="icon" aria-hidden="true">${icons[name] ?? icons.cube}</span>`;
const statusLabels = { queued: 'В очереди', running: 'Создаётся', complete: 'Готово', failed: 'Ошибка' };
const stageLabels = {
  queued: 'Ожидает свободную видеокарту', uploading: 'Загрузка изображения', preparing: 'Подготовка изображения',
  background_removal: 'Отделяем объект от фона', generating: 'Создаём геометрию и текстуры', generation: 'Создаём геометрию и текстуры',
  texturing: 'Добавляем текстуры', saving: 'Сохраняем модель', rigging: 'Создаём скелет персонажа',
  autorig: 'Создаём скелет персонажа', animating: 'Генерируем движение', retargeting: 'Переносим движение на персонажа',
  exporting: 'Сохраняем результат', complete: 'Модель готова', failed: 'Не удалось завершить',
};
const state = {
  file: null, filePreview: null, mode: 'object', quality: 'standard', jobs: [], health: null,
  selectedId: isShared ? null : params.get('job') || localStorage.getItem('model-studio-selected') || null,
  selectedMotion: params.get('motion') || null, demo: !isShared && params.get('demo') === '1',
  submitting: false, animating: false, polling: false, viewer: null, viewerKey: '',
  viewerState: {}, selectionSignature: '', motionSignature: '', listSignature: '', healthTime: 0,
  healthError: null, healthFailures: 0, healthPolling: false, jobsTime: 0,
  viewerRequest: 0, jobsError: null, slow: false, debug: false, playing: true,
  rigDrafts: new Map(), rigEditingId: null, rigSubmittingId: null,
  placementDrafts: new Map(),
  deleteTargets: [], deleting: false, deletedIds: new Set(),
  sharing: false,
  sharedCanEdit: false,
  previewUploads: new Set(),
  authRevision: 0,
  commentsModelId: null, disposeComments: null,
  motionLibrary: [], motionLibraryReady: false, motionLibraryLoading: false, motionLibraryError: null,
  meshEditingId: null, meshEntryPending: false, meshReturnView: null,
};

document.title = `${isPlayground ? 'Playground' : 'Генерация 3D-моделей'} · models.xedoc.ru`;
$('app').innerHTML = `
  <header class="site-header">
    <div class="header-inner">
      <a class="brand" href="/" aria-label="models.xedoc.ru — главная">${icon('cube')}<span>models<span class="brand-dot">.</span><span class="brand-domain">xedoc</span></span><span class="brand-tag">STUDIO</span></a>
      <nav class="main-nav" aria-label="Режимы студии">
        <a href="/">Анимация по тексту</a>
        <a href="/generate-model" ${!isPlayground ? 'aria-current="page"' : ''}>3D по картинке</a>
        <a href="/playground" ${isPlayground ? 'aria-current="page"' : ''}>Playground</a>
      </nav>
      <div class="connection-chip" id="connection-chip" role="status"><span class="status-dot pending"></span><span id="connection-label">Проверяем связь</span></div>
    </div>
  </header>
  <main class="page ${isPlayground ? 'playground-page' : ''}">
    <div class="page-heading">
      <div><div class="eyebrow">${isPlayground ? 'ДВИЖЕНИЕ · ФИЗИКА · WEBGL' : 'ИЗ ИЗОБРАЖЕНИЯ В ТРЕТЬЕ ИЗМЕРЕНИЕ'}</div>
      <h1>${isPlayground ? 'Проверь модель в действии' : 'Одна картинка. Целая 3D-модель.'}</h1>
      <p>${isPlayground ? 'Запускай анимацию, наноси удары и наблюдай, как персонаж переходит в ragdoll.' : 'Загрузи референс, создай объёмный объект и оживи персонажа — в одной студии.'}</p></div>
      <span class="local-badge">${icon('zap')}<span>Генерация на твоём ПК<span>Модели работают локально</span></span></span>
    </div>
    <div id="connection-notice" class="notice" role="status" hidden></div>
    <p class="shared-note" id="shared-note" ${isShared ? '' : 'hidden'}>Просмотр модели с сохранёнными настройками автора.</p>
    <div class="shared-owner-controls" id="shared-owner-controls" hidden><div><strong>Это твоя модель</strong><p>Открой редактор, чтобы настроить фон, землю, положение и скелет.</p></div><a class="button button-primary" id="edit-owned-model">${icon('image')}Настроить мою модель</a></div>
    <div id="shared-error" class="inline-error" role="alert" hidden></div>
    ${isPlayground ? playgroundMarkup() : generationMarkup()}
    ${!isPlayground && !isShared ? '<section id="community-gallery" class="community-gallery-section" aria-label="Галерея сообщества"></section>' : ''}
    <section class="library-section" aria-labelledby="library-title" ${isShared ? 'hidden' : ''}>
      <div class="section-heading"><div><h2 id="library-title">Твоя библиотека <span class="count" id="jobs-count">0</span></h2><p>Модели и движения сохраняются после завершения.</p></div><div class="library-actions"><button class="button button-quiet button-small delete-failed-button" id="delete-failed" hidden>${icon('trash')}Удалить с ошибками</button><button class="button button-quiet button-small" id="refresh-jobs">${icon('reset')}Обновить</button></div></div>
      <div id="library-error" class="inline-error" role="alert" hidden></div>
      <div id="jobs-list" class="jobs-list"><div class="library-empty"><span class="small-loader"></span> Загружаем библиотеку…</div></div>
    </section>
    <footer class="page-footer"><span>${icon('cube')} MODELS STUDIO</span><span>Изображение → 3D → движение → playground</span></footer>
  </main>
  <div class="toast" id="toast" role="status" hidden></div>
  <dialog id="delete-dialog" class="delete-dialog" aria-labelledby="delete-title" aria-describedby="delete-description">
    <h2 id="delete-title">Удалить генерацию?</h2>
    <p id="delete-description">Запись, исходное изображение, модель, скелет и движения будут удалены из библиотеки вместе с её файлами. Отменить удаление нельзя.</p>
    <ul id="delete-names" class="delete-names"></ul>
    <div id="delete-error" class="inline-error" role="alert" hidden></div>
    <div class="delete-dialog-actions"><button type="button" class="button button-quiet" id="delete-cancel" autofocus>Отмена</button><button type="button" class="button button-danger" id="delete-confirm">Удалить</button></div>
  </dialog>
  <dialog id="share-dialog" class="share-dialog" aria-labelledby="share-title" aria-describedby="share-description">
    <h2 id="share-title">Поделиться моделью</h2>
    <p id="share-description">По ссылке можно смотреть и скачивать эту модель, выбирать готовые движения и пробовать ragdoll. Библиотека и исходная картинка остаются приватными. Для открытия ссылки ваш ПК должен быть включён.</p>
    <label class="sr-only" for="share-url">Ссылка на модель</label><input id="share-url" type="text" readonly />
    <div id="share-error" class="inline-error" role="alert" hidden></div>
    <div class="share-dialog-actions"><button class="button button-quiet" id="share-revoke" type="button">Отключить ссылку</button><button class="button button-primary" id="share-copy" type="button">Копировать</button><button class="button button-quiet" id="share-close" type="button">Закрыть</button></div>
  </dialog>
  <dialog id="reference-dialog" class="reference-dialog" aria-labelledby="reference-title" aria-describedby="reference-description">
    <div class="reference-dialog-heading"><div><h2 id="reference-title">Исходный референс</h2><p id="reference-description"></p></div><button class="icon-button" id="reference-close" type="button" aria-label="Закрыть референс" autofocus>${icon('close')}</button></div>
    <div class="reference-image-frame" id="reference-image-frame" aria-busy="false">
      <div class="reference-loading" id="reference-loading" role="status"><span class="loader"></span><span>Загружаем исходное изображение…</span></div>
      <img id="reference-image" alt="" hidden />
      <div class="reference-load-error" id="reference-load-error" role="alert" hidden><p>Не удалось загрузить референс. Проверь подключение и попробуй ещё раз.</p><button class="button button-secondary button-small" id="reference-retry" type="button">Повторить загрузку</button></div>
    </div>
    <div class="reference-dialog-footer"><span id="reference-image-info"></span><a class="button button-quiet button-small" id="reference-original" target="_blank" rel="noopener noreferrer">${icon('image')}Открыть оригинал</a></div>
  </dialog>
`;

if (isPlayground) {
  const stage = document.querySelector('.playground-stage');
  // Let a tall sticky column scroll far enough to reach its comment form and replies.
  const stageObserver = new ResizeObserver(([entry]) => {
    stage.style.setProperty('--stage-height', `${Math.ceil(entry.target.getBoundingClientRect().height)}px`);
  });
  stageObserver.observe(stage);
}

const manualRigPanel = isPlayground && !isShared ? createManualRigPanel({
  getJob, getViewer: () => state.viewer, getRotation: (job) => placementDraft(job).rotation,
  request, repaint: renderRigPreparation,
  restoreRotation: (rotation) => {
    const job = getJob();
    if (!job || rigBusy(job)) return;
    const settings = placementDraft(job);
    settings.rotation = { ...rotation };
    settings.version++; settings.dirty = true; settings.error = null;
    rigDraft(job).rotation = { ...rotation };
    queuePlacementSave(job, settings);
    syncRotationControls(rotation);
    state.viewer?.setOrientation(rotation);
    renderRigPreparation();
  },
}) : null;

const meshEditPanel = isPlayground && !isShared ? createMeshEditPanel({
  element: $('mesh-edit-panel'), getJob, getViewer: () => state.viewer, request, toast,
  onEnter: enterMeshCleanup,
  onExit: exitMeshCleanup,
  onSaved: receiveCleanedModel,
}) : null;

function viewerMarkup() {
  return `<div class="viewer-frame" id="viewer-frame">
    <div id="viewer" class="viewer-canvas"></div>
    <div class="viewer-topline"><span class="viewer-live"><span class="status-dot"></span><span id="viewer-status">${isPlayground ? 'АРЕНА ГОТОВА' : 'ПРОСМОТР 3D'}</span></span><span class="viewer-format" id="viewer-format">GLB · PBR</span></div>
    <div class="viewer-empty" id="viewer-empty">
      <div class="cube-illustration" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><svg viewBox="0 0 220 220" fill="none"><path class="cube-shadow" d="m110 164 70-40v18l-70 40-70-40v-18l70 40Z"/><path class="cube-side" d="m110 36 70 40v72l-70 40-70-40V76l70-40Z"/><path class="cube-face" d="m110 36 70 40-70 40-70-40 70-40Z"/><path d="m40 76 70 40 70-40M110 116v72"/><path class="cube-inner" d="m110 64 45 26v44l-45 26-45-26V90l45-26Z"/><path class="cube-inner" d="m65 90 45 26 45-26M110 116v44"/><circle cx="110" cy="36" r="4"/><circle cx="40" cy="148" r="4"/><circle cx="180" cy="148" r="4"/></svg></div>
      <h3>${isPlayground ? 'Твоя следующая игровая модель' : 'Здесь появится твоя модель'}</h3>
      <p>${isPlayground ? 'Выбери персонажа из библиотеки или испытай демо Doom Slayer.' : 'Начни с изображения. Геометрия и текстуры<br>соберутся в готовый файл GLB.'}</p>
      <button class="button button-quiet" id="open-demo">${icon('play')}Попробовать Doom Slayer</button>
      <span class="demo-caption">Демо · ранее созданный персонаж</span>
    </div>
    <div class="viewer-loading" id="viewer-loading" role="status" hidden><span class="loader"></span><strong id="viewer-loading-text">Открываем модель</strong></div>
    <div class="viewer-error" id="viewer-error" role="alert" hidden><strong>Не удалось открыть модель</strong><p id="viewer-error-text"></p><button class="button button-secondary button-small" id="retry-viewer">Повторить просмотр</button></div>
    <div class="viewer-bottomline"><span id="viewer-hint">${icon('reset')}Потяни для вращения · колесо для масштаба</span><span id="viewer-stats"></span></div>
  </div>`;
}

function generationMarkup() {
  return `<div class="workbench">
    <section class="panel create-panel" aria-labelledby="create-title">
      <div class="panel-heading"><span class="step-number">01</span><h2 id="create-title">Создание модели</h2></div>
      <form id="generation-form">
        <label class="field-label" for="source-image">Изображение-референс</label>
        <label class="upload-zone" id="upload-zone" for="source-image" tabindex="0">
          <input type="file" id="source-image" name="image" accept="image/png,image/jpeg,image/webp" />
          <div id="upload-empty" class="upload-empty"><span class="upload-icon">${icon('upload')}</span><strong>Перетащи картинку сюда</strong><span>или <span class="accent">выбери файл</span> на компьютере</span><small>PNG, JPG или WebP · до 20 МБ</small></div>
          <img id="source-preview" alt="Выбранное изображение для генерации" hidden />
          <span class="replace-image" id="replace-image" hidden>${icon('image')}Заменить изображение</span>
        </label>
        <div class="file-info" id="file-info" hidden><span id="file-name"></span><button type="button" id="clear-file" class="icon-button" aria-label="Убрать изображение">${icon('close')}</button></div>
        <div class="field-group"><div class="field-label">Тип модели</div>
          <div class="segmented" role="group" aria-label="Тип модели"><button type="button" class="segment active" data-mode="object" aria-pressed="true">${icon('cube')}Объект</button><button type="button" class="segment" data-mode="humanoid" aria-pressed="false">${icon('person')}Персонаж</button></div>
          <p class="field-hint" id="mode-hint">Предмет, транспорт или скульптура — геометрия и текстуры без скелета.</p>
        </div>
        <div class="field-group"><div class="field-label">Качество</div>
          <div class="quality-options" role="group" aria-label="Качество модели"><button type="button" class="quality-option active" data-quality="standard" aria-pressed="true"><span>Стандарт</span><small>Текстуры 2K</small><span class="selection-dot"></span></button><button type="button" class="quality-option" data-quality="high" aria-pressed="false"><span>Высокое</span><small>Текстуры 4K</small><span class="selection-dot"></span></button></div>
        </div>
        <div class="field-group publication-choice"><label><input type="checkbox" id="publish-new-model" checked /> Публиковать в галерее</label><p class="field-hint">Готовая 3D-модель будет видна всем. Исходная картинка остаётся приватной. Сними галочку, чтобы сделать модель приватной.</p></div>
        <div id="form-error" class="inline-error" role="alert" hidden></div>
        <button class="button button-primary generate-button" id="generate-button" type="submit" disabled>${icon('zap')}<span>Создать 3D-модель</span>${icon('arrow')}</button>
        <p class="submit-note" id="submit-note">Загрузи изображение, чтобы начать.</p>
      </form>
    </section>
    <section class="result-column" aria-label="Результат генерации">
      <div class="panel model-panel">
        <div class="panel-heading"><span class="step-number">02</span><h2>Результат</h2><span class="result-name" id="result-name"></span></div>
        ${viewerMarkup()}
        <div class="job-progress" id="job-progress" hidden><div class="progress-top"><span class="small-loader"></span><strong id="job-stage"></strong><span id="job-percent"></span></div><div class="progress-track"><span id="job-progress-fill"></span></div><p id="job-progress-note">Можно закрыть страницу: задача продолжит выполняться на компьютере.</p></div>
        <div class="result-error" id="result-error" role="alert" hidden><strong>Не удалось создать модель</strong><p id="result-error-message"></p><button class="button button-secondary button-small" id="retry-generation">Попробовать с теми же настройками</button></div>
        <div class="result-actions" id="result-actions" hidden><a class="button button-secondary" id="download-model" download>${icon('download')}<span>Скачать GLB</span></a><a class="button button-primary" id="open-playground" href="/playground">${icon('play')}В playground</a><button class="button button-quiet reference-control" id="view-reference" type="button" hidden>${icon('image')}Посмотреть референс</button><button class="icon-button" id="share-model" title="Поделиться моделью" aria-label="Поделиться моделью" hidden>${icon('share')}</button><button class="icon-button" id="reset-camera" title="Вернуть камеру" aria-label="Вернуть камеру">${icon('reset')}</button></div>
        <div id="environment-panel" hidden></div>
        <div id="publication-panel" hidden></div>
      </div>
      <section class="panel animation-panel" id="animation-panel" aria-labelledby="animation-title">
        <div class="panel-heading"><span class="step-number">03</span><h2 id="animation-title">Добавь движение</h2><span class="small-tag">SMPL-X RP v1</span></div>
        <div class="animation-content"><p id="animation-hint" class="muted">Выбери тип «Персонаж» при создании модели — мы подготовим скелет для анимации.</p>
          <form id="animation-form"><label class="field-label" for="motion-prompt">Что делает персонаж?</label><textarea id="motion-prompt" name="prompt" rows="2" maxlength="1000" placeholder="Например: A person walks forward confidently, then raises their right hand." required></textarea>
            <div class="motion-examples"><button type="button" data-prompt="A person walks forward confidently at a natural pace.">Ходьба</button><button type="button" data-prompt="A person throws a strong punch with their right hand, then returns to a ready stance.">Удар</button><button type="button" data-prompt="A person dances energetically, moving their arms and stepping from side to side.">Танец</button></div>
            <div class="animation-bottom"><label class="duration-label" for="motion-duration">Длительность<select id="motion-duration"><option value="90">3 секунды</option><option value="150" selected>5 секунд</option><option value="240">8 секунд</option><option value="300">10 секунд</option></select></label><button class="button button-secondary" id="animate-button" type="submit" disabled>${icon('play')}Создать движение</button></div>
            <div id="animation-error" class="inline-error" role="alert" hidden></div>
          </form>
          <div id="motion-progress" class="motion-progress" role="status" hidden></div>
          <div id="motions-list" class="motions-list"></div>
          <p id="motion-license" class="motion-license" hidden></p>
        </div>
      </section>
    </section>
  </div>`;
}

function playgroundMarkup() {
  return `<div class="playground-layout">
    <div class="playground-stage">
    <section class="panel arena-panel" aria-label="Интерактивная арена">${viewerMarkup()}<div class="arena-statebar"><span id="arena-mode"><span class="status-dot"></span> Выбери модель для просмотра</span><span id="arena-fps">WEBGL</span></div></section>
    <section id="comments" class="community-comments playground-comments" aria-labelledby="community-comments-heading" hidden></section></div>
    <aside class="panel playground-controls">
      <div class="panel-heading"><span class="step-number">01</span><h2>Испытай персонажа</h2></div>
      <div class="playground-content"><div class="selected-model-name" id="playground-model-name">Модель не выбрана</div><p class="field-hint" id="playground-hint">Открой свою модель из библиотеки ниже или начни с демо.</p>
        <div id="mesh-edit-panel" hidden></div>
        ${rigPreparationMarkup()}
        ${placementMarkup()}
        <div id="environment-panel" hidden></div>
        <label class="field-label" for="playground-motion">Движение</label><select id="playground-motion" disabled><option value="">Исходная модель</option></select>
        <p id="motion-library-status" class="field-hint" role="status" hidden></p>
        <div class="arena-buttons"><button class="button button-primary" id="strike" disabled>${icon('zap')}Нанести удар<kbd>Space</kbd></button><button class="button button-secondary" id="reset" disabled>${icon('reset')}Восстановить<kbd>R</kbd></button></div>
        <label class="range-heading" for="power">Сила удара <output id="power-value">5 / 10</output></label><input id="power" type="range" min="1" max="10" value="5" disabled />
        <div class="toggle-controls"><button class="toggle-button" id="slow" aria-pressed="false" disabled><span>Замедление <kbd>T</kbd></span><span class="switch"></span></button><button class="toggle-button" id="physics" aria-pressed="false" disabled><span>Показать скелет</span><span class="switch"></span></button><button class="toggle-button" id="pause" aria-pressed="false" disabled><span>Пауза анимации</span><span class="switch"></span></button></div>
        <div class="arena-metrics"><div><strong id="hit-count">00</strong><span>попаданий</span></div><div><strong id="body-count">—</strong><span>физических тел</span></div><div><strong id="joint-count">—</strong><span>суставов</span></div></div>
        <p class="playground-note">Нажми на тело, чтобы приложить импульс в точке удара. Перетаскивание вращает камеру.</p>
        <a class="button button-secondary full-width" id="create-motion-link" href="/generate-model#animation-panel" hidden>${icon('play')}Создать движение по тексту</a>
        <a class="button button-quiet full-width" id="back-to-model" href="/generate-model">${icon('arrow')}К генерации модели</a>
        <a class="button button-secondary full-width" id="playground-download" download hidden>${icon('download')}Скачать GLB</a>
        <button class="button button-quiet full-width reference-control" id="view-reference" type="button" hidden>${icon('image')}Посмотреть референс</button>
        <button class="button button-secondary full-width share-control" id="share-model" type="button" hidden>${icon('share')}Поделиться моделью</button>
        <a class="button button-quiet full-width" id="public-model-discussion" hidden>Комментарии к модели</a>
        <div id="publication-panel" hidden></div>
      </div>
    </aside>
  </div>`;
}

function placementMarkup() {
  return `<section class="placement-panel" id="placement-panel" aria-labelledby="placement-title" hidden>
    <div class="placement-heading"><h3 id="placement-title">Положение модели</h3><span id="placement-save-status" role="status"></span></div>
    <p id="placement-hint">Сдвиг по сцене, в метрах. Y — высота над полом.</p>
    <fieldset id="placement-fields"><legend class="sr-only">Положение модели в метрах</legend>
      ${['x', 'y', 'z'].map((axis) => `<div class="placement-axis"><label for="position-${axis}">${axis.toUpperCase()}</label><input type="range" id="position-${axis}" data-position-range="${axis}" min="-5" max="5" step="0.01" value="0" aria-label="Сдвиг ${axis.toUpperCase()}, метры" /><input type="number" id="position-${axis}-number" data-position-number="${axis}" min="-5" max="5" step="0.01" value="0" aria-label="Положение ${axis.toUpperCase()}, метры" /></div>`).join('')}
      <div class="placement-actions"><button type="button" class="button button-quiet button-small" id="placement-reset">Сбросить сдвиг</button><button type="button" class="button button-secondary button-small" id="placement-ground">Поставить на пол</button></div>
    </fieldset>
    <button type="button" class="button button-secondary full-width" id="save-model-settings">Сохранить настройки</button>
    <div class="inline-error" id="placement-error" role="alert" hidden></div><button type="button" class="button button-quiet button-small" id="placement-retry" hidden>Повторить сохранение</button>
  </section>`;
}

function rigPreparationMarkup() {
  return `<section class="rig-preparation" id="rig-preparation" aria-labelledby="rig-preparation-title" hidden>
    <div class="rig-preparation-heading"><h3 id="rig-preparation-title">Подготовить персонажа</h3><span id="rig-status-label" class="small-tag"></span></div>
    <p class="field-hint" id="rig-preparation-hint">Поставь модель на ноги, лицом к виду «Спереди». Поворот меняет модель, а перетаскивание — камеру.</p>
    <button class="button button-quiet button-small full-width" id="edit-rig" type="button">${icon('reset')}Настроить заново</button>
    <form id="rig-form" hidden>
      ${manualRigMarkup()}
      <div class="rig-view-actions"><button class="button button-quiet button-small" id="rig-front-view" type="button">Вид спереди</button><button class="button button-quiet button-small" id="rig-reset-rotation" type="button">Сбросить углы</button></div>
      <fieldset id="rig-rotation-fields"><legend class="sr-only">Поворот модели в градусах</legend>
      ${['x', 'y', 'z'].map((axis) => `<div class="rig-axis-row"><label class="rig-axis-label" for="rotation-${axis}">${axis.toUpperCase()}</label><input id="rotation-${axis}" data-rotation-range="${axis}" type="range" min="-180" max="180" step="1" value="0" aria-label="Поворот ${axis.toUpperCase()}, градусы" /><input id="rotation-${axis}-number" data-rotation-number="${axis}" type="number" min="-180" max="180" step="1" value="0" aria-label="Угол ${axis.toUpperCase()}, градусы" required /><button type="button" class="rig-quarter-turn" data-rotation-step="${axis}" aria-label="Повернуть по ${axis.toUpperCase()} на 90 градусов">+90°</button></div>`).join('')}
      </fieldset>
      <button class="button button-primary full-width" id="create-rig" type="submit">${icon('person')}<span>Создать скелет</span></button>
      <button class="button button-quiet full-width" id="cancel-rig-edit" type="button" hidden>Вернуться к готовому персонажу</button>
    </form>
    <div class="rig-progress" id="rig-progress" role="status" hidden><div class="progress-top"><span class="small-loader"></span><strong id="rig-stage"></strong><span id="rig-percent"></span></div><div class="progress-track"><span id="rig-progress-fill"></span></div></div>
    <div id="rig-error" class="inline-error" role="alert" hidden></div>
  </section>`;
}

function getJob() { return state.jobs.find((job) => job.id === state.selectedId); }
function stageText(stage, fallback = '') { return stageLabels[stage] || stage || fallback; }
function artifactUrl(job) { return job?.artifacts?.riggedUrl || job?.artifacts?.modelUrl; }
function libraryMotions(job) {
  const prefix = job?.artifacts?.motionLibraryUrl;
  return prefix ? (state.motionLibrary || []).map((motion) => ({ ...motion, id: `library:${motion.id}`, status: 'complete', glbUrl: `${prefix}${encodeURIComponent(motion.id)}/animated.glb` })) : [];
}
function selectedMotion(job) { return [...(job?.motions || []), ...libraryMotions(job)].find((motion) => motion.id === state.selectedMotion && motion.status === 'complete' && motion.glbUrl); }
function selectedUrl(job) {
  if (sourceView(job)) return job?.artifacts?.modelUrl;
  const motion = selectedMotion(job);
  if (state.selectedMotion?.startsWith('library:')) return motion?.glbUrl;
  return motion?.glbUrl || artifactUrl(job);
}
function hasRig(job) { return Boolean(job?.artifacts?.riggedUrl && job?.rig?.available !== false); }
function rigBusy(job) {
  const draft = job && state.rigDrafts.get(job.id);
  return ['queued', 'running'].includes(job?.rig?.status) || Boolean(draft?.operationId && draft.operationId !== job?.rig?.operationId && ['queued', 'running'].includes(draft.status));
}
function canDeleteJob(job) {
  return !isShared && ['complete', 'failed'].includes(job.status) && !rigBusy(job) && state.rigSubmittingId !== job.id &&
    state.meshEditingId !== job.id &&
    !(state.animating && state.selectedId === job.id) &&
    !job.motions?.some((motion) => ['queued', 'running'].includes(motion.status));
}
function sourceView(job) {
  if (!job) return false;
  if (state.meshEditingId === job.id) return true;
  if (!hasRig(job)) return true;
  const rotation = placementDraft(job).rotation;
  const baked = normalizeModelRotation(job.rig?.appliedRotation);
  return ['x', 'y', 'z'].some((axis) => Math.abs(rotation[axis] - baked[axis]) > 0.001) ||
    (!isShared && isPlayground && state.rigEditingId === job.id);
}
function preparingRig(job = getJob()) { return Boolean(!isShared && isPlayground && !state.demo && state.meshEditingId !== job?.id && job?.status === 'complete' && job?.artifacts?.modelUrl && sourceView(job)); }
function editingMesh(job = getJob()) { return Boolean(job && state.meshEditingId === job.id); }
function rigDraft(job) {
  let draft = state.rigDrafts.get(job.id);
  if (!draft) {
    const rotation = placementDraft(job).rotation;
    draft = { rotation: Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, Number(rotation[axis]) || 0])), operationId: job.rig?.operationId, status: job.rig?.status, error: null };
    state.rigDrafts.set(job.id, draft);
  }
  draft.rotation = { ...placementDraft(job).rotation };
  return draft;
}
function setError(id, error) { const element = $(id); if (!element) return; element.textContent = error || ''; element.hidden = !error; }
function shortDate(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date); }
function jobTitle(job) { return job?.title || job?.name || job?.originalFilename || job?.sourceFilename || `Модель ${String(job?.id || '').slice(0, 6)}`; }
function jobProgress(job) { return Math.max(0, Math.min(100, Math.round(Number(job?.progress) || 0))); }
function rigErrorText(error) {
  const text = String(error || '');
  const translated = [
    [/Both legs must be visibly separated/i, 'На референсе обе ноги должны быть видны и отделены друг от друга.'],
    [/Both arms must hang apart|Both complete arms/i, 'Обе руки должны полностью попадать в модель и различаться на фоне туловища. Выровняй персонажа и повтори подготовку.'],
    [/Both complete feet/i, 'Обе ступни должны целиком попадать в изображение.'],
    [/single full-body humanoid|upright A-pose|no upright height/i, 'Нужен один персонаж в полный рост. Поставь модель на ноги и поверни лицом к виду «Спереди».'],
    [/too little geometry|cross-section is missing|place a joint|bind every limb/i, 'В этой геометрии не удалось уверенно выделить все конечности. Попробуй более чёткий референс с раздельными руками и ногами.'],
    [/contains no mesh/i, 'В файле не найдена геометрия для скелета.'],
    [/already has a skeleton/i, 'В этой модели уже есть скелет.'],
    [/Exported skeleton failed validation/i, 'Созданный скелет не прошёл проверку. Исходная 3D-модель сохранена.'],
  ].find(([pattern]) => pattern.test(text));
  return translated?.[1] || (/[а-яё]/i.test(text) ? text : 'Попробуй референс в полный рост, спереди, с раздельными руками и ногами.');
}
let toastTimeout;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimeout); toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 3500); }

async function request(path, options = {}) {
  const { timeoutMs, ...fetchOptions } = options;
  const response = await fetch(`${API}${path}`, { ...fetchOptions, signal: options.signal || AbortSignal.timeout(timeoutMs || (options.method ? 90000 : 20000)) });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('json') ? await response.json() : null;
  const plainError = !response.ok && contentType.includes('text/plain') ? (await response.text()).slice(0, 1500) : '';
  if (!response.ok) {
    const detail = data?.detail || data?.error || data?.message;
    const message = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : response.status === 502 || response.status === 503 ? 'Компьютер сейчас недоступен. Запусти start.bat на своём ПК.' : plainError || `Сервер вернул ошибку ${response.status}.`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (data === null) throw new Error('Неожиданный ответ сервиса. Обнови страницу и попробуй ещё раз.');
  return data;
}

function updateHealth() {
  const health = state.health;
  const online = health?.online && state.healthFailures < 3;
  const reconnecting = Boolean(state.healthError && online);
  const ready = online && health?.comfy?.online && health?.comfy?.modelsReady !== false;
  const busy = online && health?.gpu?.busy;
  const dot = $('connection-chip').querySelector('.status-dot');
  dot.className = `status-dot ${reconnecting ? 'pending' : online ? (busy ? 'busy' : 'online') : state.healthError ? 'offline' : 'pending'}`;
  $('connection-label').textContent = reconnecting ? 'Восстанавливаем связь' : online ? busy ? 'ПК занят · очередь работает' : 'Локальный ПК подключён' : state.healthError ? 'Локальный ПК не в сети' : 'Проверяем связь';
  const notice = $('connection-notice');
  if (reconnecting) {
    notice.hidden = false;
    notice.textContent = 'Связь с компьютером нестабильна. Повторяем подключение автоматически; текущая задача продолжает выполняться.';
  } else if (state.healthError || (health && !online)) {
    notice.hidden = false;
    notice.textContent = 'Генерация ждёт подключения компьютера. Запусти start.bat на своём ПК — страница подключится автоматически.';
  } else if (online && !ready) {
    notice.hidden = false;
    notice.textContent = 'Компьютер подключён. Подготавливаем сервис генерации и проверяем модели.';
  } else { notice.hidden = true; }
  if (!isPlayground) {
    $('motion-license').textContent = health?.motionLicense || '';
    $('motion-license').hidden = !health?.motionLicense;
    $('generate-button').disabled = !ready || !state.file || state.submitting;
    $('generate-button').querySelector('span:not(.icon)').textContent = state.submitting ? 'Отправляем изображение…' : 'Создать 3D-модель';
    $('submit-note').textContent = !state.file ? 'Загрузи изображение, чтобы начать.' : !ready ? 'Для генерации нужен подключённый компьютер.' : busy ? 'Задача встанет в очередь и начнётся автоматически.' : 'Генерация выполняется на видеокарте твоего компьютера.';
    updateAnimationAvailability();
  } else renderRigPreparation();
}

function normalizePlacement(position = {}) {
  return Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, Math.round(Math.max(-5, Math.min(5, Number(position[axis]) || 0)) * 100) / 100]));
}

function normalizeModelRotation(rotation = {}) {
  return Object.fromEntries(['x', 'y', 'z'].map((axis) => [axis, Math.max(-180, Math.min(180, Number(rotation?.[axis]) || 0))]));
}

function savedModelRotation(job) {
  return normalizeModelRotation(job?.modelRotation ?? job?.rig?.appliedRotation ?? job?.rig?.rotation);
}

function placementDraft(job) {
  if (!job) return null;
  let draft = state.placementDrafts.get(job.id);
  if (!draft) {
    draft = { position: normalizePlacement(job.placement), rotation: savedModelRotation(job), dirty: false, saving: false, error: null, version: 0, updatedAt: job.updatedAt || '', timer: null, pending: null };
    state.placementDrafts.set(job.id, draft);
  } else if (!draft.dirty && !draft.saving && String(job.updatedAt || '') >= draft.updatedAt) {
    draft.position = normalizePlacement(job.placement);
    draft.rotation = savedModelRotation(job);
    draft.updatedAt = job.updatedAt || '';
  }
  return draft;
}

function syncPlacementControls(position, preserveFocused = true) {
  for (const axis of ['x', 'y', 'z']) {
    $(`position-${axis}`).value = String(position[axis]);
    const number = $(`position-${axis}-number`);
    if (!preserveFocused || document.activeElement !== number) number.value = String(position[axis]);
  }
}

function renderPlacement() {
  if (!isPlayground) return;
  const job = getJob();
  const visible = !state.demo && !editingMesh(job) && job?.status === 'complete' && Boolean(artifactUrl(job));
  $('placement-panel').hidden = !visible;
  if (!visible) { if (!editingMesh(job)) manualRigPanel?.render(null); return; }
  const draft = placementDraft(job);
  $('placement-fields').disabled = isShared || !state.viewerState.ready;
  $('placement-hint').textContent = isShared ? 'Положение и поворот сохранены владельцем. Здесь доступен просмотр.' : 'Сдвиг по сцене, в метрах. Y — высота над полом. Положение и поворот сохраняются автоматически.';
  $('save-model-settings').hidden = isShared;
  $('save-model-settings').disabled = draft.saving;
  $('save-model-settings').textContent = draft.saving ? 'Сохраняем настройки…' : 'Сохранить настройки';
  $('placement-save-status').textContent = isShared ? 'Просмотр' : draft.saving ? 'Сохраняем…' : draft.error ? 'Не сохранено' : draft.dirty ? 'Изменено' : 'Сохранено';
  setError('placement-error', draft.error);
  $('placement-retry').hidden = isShared || !draft.error;
  $('placement-retry').disabled = draft.saving;
  const changedJob = $('placement-panel').dataset.jobId !== job.id;
  $('placement-panel').dataset.jobId = job.id;
  syncPlacementControls(draft.position, !changedJob);
  if (preparingRig(job)) syncRotationControls(draft.rotation, { preserveFocused: true });
}

function queuePlacementSave(job, draft) {
  clearTimeout(draft.timer);
  draft.timer = setTimeout(() => { void savePlacement(job.id); }, 650);
}

async function savePlacement(jobId, { keepalive = false } = {}) {
  const draft = state.placementDrafts.get(jobId);
  if (isShared || !draft || state.deletedIds?.has(jobId)) return;
  if (draft.saving) return draft.pending;
  if (!draft.dirty) return;
  clearTimeout(draft.timer);
  const version = draft.version;
  const position = { ...draft.position };
  const rotation = { ...draft.rotation };
  let resolvePending;
  draft.pending = new Promise((resolve) => { resolvePending = resolve; });
  draft.saving = true;
  draft.error = null;
  renderPlacement();
  try {
    const result = await request(`/jobs/${encodeURIComponent(jobId)}/placement`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position, rotation, write: { clientId: settingsClientId, revision: version } }), keepalive: true,
    });
    const updated = result.job || result;
    const job = state.jobs.find((item) => item.id === jobId);
    if (job) {
      job.placement = updated.placement || position;
      job.modelRotation = updated.modelRotation || rotation;
      if (String(updated.updatedAt || '') >= String(job.updatedAt || '')) job.updatedAt = updated.updatedAt || job.updatedAt;
    }
    draft.updatedAt = updated.updatedAt || new Date().toISOString();
    if (draft.version === version) {
      draft.position = normalizePlacement(updated.placement || position);
      draft.rotation = normalizeModelRotation(updated.modelRotation || rotation);
      draft.dirty = false;
    }
  } catch (error) { draft.error = error.message; }
  finally {
    draft.saving = false;
    resolvePending();
    draft.pending = null;
    if (draft.version !== version && draft.dirty && !keepalive) queuePlacementSave({ id: jobId }, draft);
    renderPlacement();
  }
}

async function flushModelSettings(jobId) {
  const draft = state.placementDrafts.get(jobId);
  if (!draft || isShared) return;
  while (draft.saving || draft.dirty) {
    await savePlacement(jobId);
    if (draft.error) throw new Error(`Настройки не сохранены: ${draft.error}`);
    if (state.deletedIds.has(jobId)) throw new Error('Модель удалена.');
  }
}

function persistSettingsOnExit() {
  if (isShared) return;
  for (const [id, draft] of state.placementDrafts) {
    if (!draft.dirty || state.deletedIds.has(id)) continue;
    clearTimeout(draft.timer);
    // A newer exit snapshot may arrive before an in-flight save. The server
    // ignores older revisions from this page so they cannot overwrite it.
    void request(`/jobs/${encodeURIComponent(id)}/placement`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ position: draft.position, rotation: draft.rotation,
        write: { clientId: settingsClientId, revision: draft.version } }),
    }).catch(() => {});
  }
}

function updatePlacement(position, { preserveFocused = true } = {}) {
  const job = getJob();
  if (isShared || !job || editingMesh(job) || job.status !== 'complete' || !state.viewerState.ready) return;
  const draft = placementDraft(job);
  draft.position = normalizePlacement(position);
  draft.version++;
  draft.dirty = true;
  draft.error = null;
  state.viewer?.setPosition(draft.position);
  syncPlacementControls(draft.position, preserveFocused);
  queuePlacementSave(job, draft);
  renderPlacement();
}

function updatePlacementAxis(axis, value, preserveFocused = true) {
  if (value === '' || !Number.isFinite(Number(value))) return;
  const draft = placementDraft(getJob());
  if (draft) updatePlacement({ ...draft.position, [axis]: Number(value) }, { preserveFocused });
}

function syncRotationControls(rotation, { preserveFocused = false } = {}) {
  for (const axis of ['x', 'y', 'z']) {
    const range = $(`rotation-${axis}`), number = $(`rotation-${axis}-number`);
    range.value = String(rotation[axis]);
    if (!preserveFocused || document.activeElement !== number) number.value = String(rotation[axis]);
  }
}

function renderMeshCleanup() {
  if (!isPlayground || !meshEditPanel) return;
  const job = getJob();
  const visible = !isShared && !state.demo && job?.status === 'complete' && Boolean(job?.artifacts?.modelUrl);
  const busy = Boolean(job && (rigBusy(job) || state.rigSubmittingId === job.id || state.animating || state.deleting || state.sharing || job.motions?.some((motion) => ['queued', 'running'].includes(motion.status))));
  meshEditPanel.render(job, { visible, busy, ready: Boolean(state.viewerState.ready) });
  const editing = editingMesh(job);
  document.querySelector('.playground-layout')?.classList.toggle('mesh-edit-active', editing);
  if (editing) {
    $('playground-hint').textContent = 'Выделяй лишние части и удаляй их из модели. Результат появится по общей ссылке после сохранения.';
    for (const id of ['strike', 'reset', 'power', 'slow', 'physics', 'pause', 'playground-motion', 'share-model']) $(id).disabled = true;
  } else $('share-model').disabled = state.sharing;
}

async function enterMeshCleanup() {
  const job = getJob(), authRevision = state.authRevision;
  if (!job || isShared || rigBusy(job)) throw new Error('Дождись готовности модели.');
  state.meshReturnView = { id: job.id, rigEditingId: state.rigEditingId, selectedMotion: state.selectedMotion };
  state.meshEditingId = job.id;
  state.meshEntryPending = true;
  state.selectionSignature = '';
  manualRigPanel?.render(null);
  renderMeshCleanup();
  renderRigPreparation();
  renderPlacement();
  renderJobs();
  try {
    await flushModelSettings(job.id);
    if (state.authRevision !== authRevision || getJob()?.id !== job.id || state.meshEditingId !== job.id) return;
    await manualRigPanel?.flush(job);
    if (state.authRevision !== authRevision || getJob()?.id !== job.id || state.meshEditingId !== job.id) return;
    state.viewer?.setManualRig?.({ enabled: false });
    await loadSelectedViewer(true);
    if (state.authRevision !== authRevision || getJob()?.id !== job.id || state.meshEditingId !== job.id) return;
    if (!state.viewerState.ready) throw new Error($('viewer-error-text').textContent || 'Не удалось открыть исходную модель для очистки.');
    state.viewer?.setManualRig?.({ enabled: false });
  } finally {
    if (state.authRevision === authRevision && getJob()?.id === job.id && state.meshEditingId === job.id) {
      state.meshEntryPending = false;
      renderMeshCleanup();
    }
  }
}

async function exitMeshCleanup({ reason } = {}) {
  // Successful persistence already loaded the fresh mesh. Do not reload twice.
  if (reason === 'saved') { renderMeshCleanup(); return; }
  const previous = state.meshReturnView;
  state.meshEditingId = null;
  state.meshEntryPending = false;
  state.meshReturnView = null;
  if (previous?.id === getJob()?.id) {
    state.rigEditingId = previous.rigEditingId;
    state.selectedMotion = previous.selectedMotion;
  }
  state.selectionSignature = '';
  renderSelection();
  renderJobs();
  await state.viewerLoadPromise;
}

async function receiveCleanedModel(updated) {
  const id = updated.id, authRevision = state.authRevision;
  if (getJob()?.id !== id || isShared) return;
  state.meshEditingId = null;
  state.meshReturnView = null;
  state.rigEditingId = null;
  state.selectedMotion = 'base';
  state.rigDrafts.delete(id);
  manualRigPanel?.forget(id);
  // Suppress automatic loading until the owner payload has been replaced.
  state.meshEntryPending = true;
  state.previewUploads.delete(id);
  try {
    receiveOwnerJob(updated);
    const query = new URLSearchParams({ job: id });
    history.replaceState(null, '', `/playground?${query}`);
    await loadSelectedViewer(true);
    if (state.authRevision !== authRevision || getJob()?.id !== id) return;
    if (!state.viewerState.ready) throw new Error('Не удалось открыть сохранённую модель.');
    // Saved landmarks remain useful after cleanup; keep them out of the card.
    state.viewer?.setManualRig?.({ enabled: false });
    await saveModelPreview(getJob(), state.viewerRequest);
  } finally {
    if (state.authRevision === authRevision && getJob()?.id === id) {
      state.meshEntryPending = false;
      renderMeshCleanup();
      renderRigPreparation();
    }
  }
}

function leaveMeshCleanup() {
  if (!meshEditPanel) return true;
  if (!meshEditPanel.canLeave()) return false;
  meshEditPanel.reset();
  state.meshEditingId = null;
  state.meshEntryPending = false;
  state.meshReturnView = null;
  return true;
}

function renderRigPreparation() {
  if (!isPlayground) return;
  const job = getJob();
  const visible = !isShared && !state.demo && !editingMesh(job) && job?.status === 'complete' && Boolean(job?.artifacts?.modelUrl);
  $('rig-preparation').hidden = !visible;
  if (!visible) { if (!editingMesh(job)) manualRigPanel?.render(null); return; }
  const draft = rigDraft(job);
  const editing = preparingRig(job);
  const busy = rigBusy(job) || state.rigSubmittingId === job.id;
  const failed = !busy && job.rig?.status === 'failed';
  const retainedRig = failed && hasRig(job);
  const motionBusy = job.motions?.some((motion) => ['queued', 'running'].includes(motion.status));
  const manual = manualRigPanel?.render(job, { editing, busy: busy || Boolean(motionBusy), ready: Boolean(state.viewerState.ready && state.viewerState.orientationPreview) });
  $('rig-status-label').textContent = busy ? 'Подготовка' : failed ? 'Ошибка подготовки' : hasRig(job) ? 'Скелет готов' : 'Без скелета';
  const preparationHint = editing ? 'Поставь модель на ноги, лицом к виду «Спереди». Поворот сохраняется вместе с положением; перетаскивание меняет камеру.' : 'Можно выровнять исходную модель и заново создать скелет. Сохранённые движения останутся в библиотеке.';
  $('rig-preparation-hint').textContent = retainedRig ? `Последняя попытка не удалась. Предыдущий скелет сохранён. ${preparationHint}` : preparationHint;
  if (manual?.manual) $('rig-preparation-hint').textContent = 'Расставь опорные точки внутри тела и проверь глубину сбоку. Поворот модели зафиксирован на время разметки.';
  $('edit-rig').hidden = editing;
  $('edit-rig').disabled = busy;
  $('rig-form').hidden = !editing;
  $('rig-rotation-fields').disabled = busy || Boolean(manual?.manual);
  $('rig-rotation-fields').hidden = Boolean(manual?.manual);
  $('rig-reset-rotation').disabled = busy || Boolean(manual?.manual);
  $('rig-front-view').parentElement.hidden = Boolean(manual?.manual);
  $('rig-front-view').disabled = !state.viewerState.ready || !state.viewerState.orientationPreview;
  $('cancel-rig-edit').hidden = !hasRig(job);
  $('cancel-rig-edit').disabled = busy;
  $('cancel-rig-edit').textContent = retainedRig ? 'Вернуться к прежнему скелету' : 'Вернуться к готовому персонажу';
  $('create-rig').disabled = busy || Boolean(motionBusy) || !state.health?.online || state.healthFailures >= 3 || !state.viewerState.ready || !state.viewerState.orientationPreview || Boolean(manual?.manual && !manual.complete);
  $('create-rig').querySelector('span:not(.icon)').textContent = state.rigSubmittingId === job.id ? 'Отправляем…' : busy ? 'Создаём скелет…' : manual?.manual ? 'Создать скелет по точкам' : 'Создать скелет';
  $('create-rig').title = motionBusy ? 'Дождись завершения текущего движения.' : '';
  $('rig-progress').hidden = !busy;
  if (busy) {
    $('rig-stage').textContent = stageText(job.rig?.stage, 'Подготавливаем скелет');
    $('rig-percent').textContent = `${jobProgress(job.rig)}%`;
    $('rig-progress-fill').style.width = `${jobProgress(job.rig)}%`;
  }
  setError('rig-error', draft.error || (job.rig?.status === 'failed' && (!manual?.manual || job.rig?.requestedMethod === 'manual') ? rigErrorText(job.rig.error) : null));
  // Polls update status only. Draft fields, selection and partially typed numbers
  // stay untouched while the user is choosing an orientation.
  if ($('rig-form').dataset.jobId !== job.id) {
    $('rig-form').dataset.jobId = job.id;
    syncRotationControls(draft.rotation);
  }
}

function observeRigResult(job) {
  if (!isPlayground || !job) return;
  const draft = rigDraft(job);
  // A GET started before the POST can return the previous complete operation.
  // Do not mistake that stale snapshot for completion of the just-submitted rig.
  if (draft.operationId && draft.operationId !== job.rig?.operationId && ['queued', 'running'].includes(draft.status)) return;
  const finished = ['queued', 'running'].includes(draft.status) && job.rig?.status === 'complete';
  if (finished) {
    draft.rotation = { ...draft.rotation, ...job.rig.appliedRotation };
    draft.error = null;
    if (state.rigEditingId === job.id) state.rigEditingId = null;
    state.selectedMotion = 'base';
    syncRotationControls(draft.rotation);
    toast('Скелет готов. Теперь можно проверить ходьбу и ragdoll.');
  }
  draft.status = job.rig?.status;
  draft.operationId = job.rig?.operationId;
}

function updateDraftRotation(axis, raw, { keepNumber = false } = {}) {
  const job = getJob();
  if (!preparingRig(job) || rigBusy(job) || state.rigSubmittingId === job.id) return;
  if (raw === '' || !Number.isFinite(Number(raw))) return;
  const draft = rigDraft(job);
  draft.rotation[axis] = Math.max(-180, Math.min(180, Number(raw)));
  const settings = placementDraft(job);
  settings.rotation = { ...draft.rotation };
  settings.version++;
  settings.dirty = true;
  settings.error = null;
  syncRotationControls(draft.rotation, { preserveFocused: keepNumber });
  draft.error = null;
  state.viewer?.setOrientation(draft.rotation);
  queuePlacementSave(job, settings);
  renderPlacement();
}

async function submitRig(event) {
  event.preventDefault();
  const job = getJob();
  if (!preparingRig(job) || rigBusy(job) || state.rigSubmittingId) return;
  const draft = rigDraft(job);
  state.rigSubmittingId = job.id;
  draft.error = null;
  renderRigPreparation();
  try {
    await flushModelSettings(job.id);
    if (manualRigPanel?.manual(job)) manualRigPanel.prepare(job);
    const manual = manualRigPanel?.manual(job) ? manualRigPanel.payload(job) : null;
    if (manual) await manualRigPanel.flush(job);
    const result = await request(`/jobs/${encodeURIComponent(job.id)}/rig`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rotation: draft.rotation, ...(manual ? { manual } : {}) }),
    });
    const updated = result.job || result;
    state.jobs = state.jobs.map((item) => item.id === job.id ? updated : item);
    draft.status = updated.rig?.status;
    draft.operationId = updated.rig?.operationId;
    state.selectionSignature = '';
    renderJobs(); renderSelection();
    toast('Подготовка скелета добавлена в очередь.');
    void poll(true);
  } catch (error) { draft.error = error.message; }
  finally { state.rigSubmittingId = null; renderRigPreparation(); }
}

function updateAnimationAvailability() {
  if (isPlayground) return;
  const job = getJob();
  const rigged = hasRig(job) && !sourceView(job);
  const activeMotion = job?.motions?.find((motion) => ['queued', 'running'].includes(motion.status));
  const available = state.health?.online && state.healthFailures < 3 && state.health?.kimodo?.online && state.health?.capabilities?.motionGeneration !== false;
  $('animate-button').disabled = !rigged || job?.status !== 'complete' || rigBusy(job) || !available || Boolean(activeMotion) || state.animating;
  $('motion-prompt').disabled = !rigged;
  $('motion-duration').disabled = !rigged;
  document.querySelectorAll('[data-prompt]').forEach((button) => { button.disabled = !rigged; });
  const hint = $('animation-hint');
  if (rigBusy(job)) hint.textContent = `Подготавливаем новый скелет: ${stageText(job.rig.stage)} · ${jobProgress(job.rig)}%.`;
  else if (job?.rig?.status === 'failed') hint.textContent = `Модель сохранена, но скелет подготовить не удалось. Открой playground, выровняй персонажа и повтори подготовку. ${rigErrorText(job.rig.error)}`;
  else if (job?.status === 'running' && (job?.mode === 'humanoid' || job?.rig)) hint.textContent = 'После создания геометрии подготовим скелет. Затем можно будет сгенерировать движение.';
  else if (rigged && !available) hint.textContent = 'Скелет готов. Генерация движения станет доступна, когда подключится сервис анимации на компьютере.';
  else if (rigged) hint.textContent = 'Опиши одно движение на английском. Оно будет перенесено на скелет твоего персонажа.';
  else hint.textContent = job?.status === 'complete' ? 'Открой модель в playground, выровняй персонажа и нажми «Создать скелет». Затем вернись сюда за движением.' : 'Выбери тип «Персонаж» при создании модели — мы подготовим скелет для анимации.';
  $('animation-panel').classList.toggle('animation-ready', rigged);
  $('motion-progress').hidden = !activeMotion;
  if (activeMotion) $('motion-progress').textContent = `${stageText(activeMotion.stage, 'Генерируем движение')} · ${jobProgress(activeMotion)}%`;
}

function renderJobs() {
  if (isShared) return;
  const failed = state.jobs.filter((job) => job.status === 'failed' && canDeleteJob(job));
  $('delete-failed').hidden = !failed.length;
  $('delete-failed').disabled = state.deleting;
  const signature = JSON.stringify([state.deleting, state.jobs.map((job) => [job.id, job.status, job.progress, job.sourceImageUrl, job.updatedAt, state.selectedId === job.id, canDeleteJob(job)])]);
  if (signature === state.listSignature) return;
  state.listSignature = signature;
  $('jobs-count').textContent = state.jobs.length;
  if (!state.jobs.length) {
    $('jobs-list').innerHTML = `<div class="library-empty">${icon('cube')}<div><strong>Здесь будут твои 3D-модели</strong><p>Создай первую модель — она останется в библиотеке вместе с анимациями.</p></div></div>`;
    return;
  }
  $('jobs-list').innerHTML = state.jobs.map((job) => `<div class="job-card ${job.id === state.selectedId ? 'selected' : ''}"><button class="job-select" data-job="${escape(job.id)}" aria-pressed="${job.id === state.selectedId}">
    <div class="job-thumbnail">${job.sourceImageUrl ? `<img src="${escape(job.sourceImageUrl)}" alt="" loading="lazy" />` : icon('cube')}</div>
    <div class="job-card-content"><strong>${escape(jobTitle(job))}</strong><span>${escape(shortDate(job.createdAt))}</span><div class="job-card-footer"><span class="job-badge status-${escape(job.status)}"><span class="status-dot"></span>${escape(statusLabels[job.status] || job.status)}${['running', 'queued'].includes(job.status) ? ` · ${jobProgress(job)}%` : ''}</span>${hasRig(job) ? `<span class="rig-badge">${icon('person')}Скелет</span>` : ''}</div></div>
    <span class="job-card-arrow">${icon('arrow')}</span>
  </button><button type="button" class="icon-button job-delete" data-delete-job="${escape(job.id)}" aria-label="Удалить ${escape(jobTitle(job))}" title="${canDeleteJob(job) ? 'Удалить генерацию и её файлы' : 'Дождись завершения модели, скелета и движений'}" ${!canDeleteJob(job) || state.deleting ? 'disabled' : ''}>${icon('trash')}</button></div>`).join('');
}

function openDeleteDialog(jobs) {
  if (state.deleting || $('delete-dialog').open) return;
  state.deleteTargets = jobs.filter(canDeleteJob).map((job) => ({ id: job.id, name: jobTitle(job) }));
  if (!state.deleteTargets.length) return;
  $('delete-title').textContent = state.deleteTargets.length === 1 ? 'Удалить генерацию?' : `Удалить генерации с ошибками (${state.deleteTargets.length})?`;
  $('delete-names').innerHTML = state.deleteTargets.map((job) => `<li>${escape(job.name)}</li>`).join('');
  setError('delete-error', null);
  $('delete-dialog').showModal();
}

function removeDeletedJob(id) {
  // A poll started before DELETE may still return the former library contents.
  state.deletedIds.add(id);
  state.jobs = state.jobs.filter((job) => job.id !== id);
  state.rigDrafts.delete(id);
  clearTimeout(state.placementDrafts.get(id)?.timer);
  state.placementDrafts.delete(id);
  if (state.rigEditingId === id) state.rigEditingId = null;
  if (state.selectedId === id) {
    state.selectedId = null;
    state.selectedMotion = null;
    localStorage.removeItem('model-studio-selected');
    history.replaceState(null, '', isPlayground ? '/playground' : '/generate-model');
    if (state.jobs.length) selectJob(state.jobs[0].id);
  }
  renderJobs();
  renderSelection();
}

async function deleteGenerations() {
  if (state.deleting || !state.deleteTargets.length) return;
  state.deleting = true;
  $('delete-cancel').disabled = $('delete-confirm').disabled = true;
  $('delete-confirm').textContent = 'Удаляем…';
  setError('delete-error', null);
  renderJobs();
  let deleted = 0;
  const failures = [];
  const remaining = [];
  for (const target of state.deleteTargets) {
    try {
      await request(`/jobs/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      removeDeletedJob(target.id);
      deleted++;
    } catch (error) {
      remaining.push(target);
      failures.push(`${target.name}: ${error.message}`);
    }
  }
  state.deleteTargets = remaining;
  state.deleting = false;
  $('delete-cancel').disabled = $('delete-confirm').disabled = false;
  $('delete-confirm').textContent = 'Удалить';
  renderJobs();
  if (failures.length) {
    $('delete-title').textContent = 'Не всё удалось удалить';
    $('delete-names').innerHTML = remaining.map((job) => `<li>${escape(job.name)}</li>`).join('');
    setError('delete-error', failures.join('\n'));
  } else {
    $('delete-dialog').close();
    $('refresh-jobs').focus();
  }
  if (deleted) toast(deleted === 1 ? 'Генерация и её файлы удалены.' : `Генерации и их файлы удалены: ${deleted}.`);
  void poll(true);
}

let referenceSource = null;
let referenceRequest = 0;

function canViewReference(job) {
  return !isShared && !state.demo && job?.status === 'complete' && Boolean(job.sourceImageUrl);
}

function loadReferenceImage() {
  if (isShared || !referenceSource || !$('reference-dialog').open) return;
  const requestId = ++referenceRequest;
  const image = $('reference-image');
  image.hidden = true;
  $('reference-loading').hidden = false;
  $('reference-load-error').hidden = true;
  $('reference-image-frame').setAttribute('aria-busy', 'true');
  $('reference-image-info').textContent = '';
  image.onload = () => {
    if (requestId !== referenceRequest || !$('reference-dialog').open) return;
    image.hidden = false;
    $('reference-loading').hidden = true;
    $('reference-image-frame').setAttribute('aria-busy', 'false');
    $('reference-image-info').textContent = `${image.naturalWidth} × ${image.naturalHeight} px`;
  };
  image.onerror = () => {
    if (requestId !== referenceRequest || !$('reference-dialog').open) return;
    $('reference-loading').hidden = true;
    $('reference-load-error').hidden = false;
    $('reference-image-frame').setAttribute('aria-busy', 'false');
  };
  image.src = referenceSource.url;
}

function viewReference() {
  const job = getJob();
  if (!canViewReference(job)) return;
  let url;
  try {
    url = new URL(job.sourceImageUrl, location.href);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported image URL');
  } catch { toast('Не удалось получить ссылку на исходное изображение.'); return; }
  referenceSource = { jobId: job.id, url: url.href };
  $('reference-description').textContent = jobTitle(job);
  $('reference-image').alt = `Исходный референс для модели «${jobTitle(job)}»`;
  $('reference-original').href = referenceSource.url;
  $('reference-dialog').showModal();
  loadReferenceImage();
}

let sharedJobId = null;
async function shareModel() {
  const job = getJob();
  if (isShared || state.sharing || state.meshEditingId === job?.id || job?.status !== 'complete' || !artifactUrl(job)) return;
  state.sharing = true;
  $('share-model').disabled = true;
  sharedJobId = job.id;
  setError('share-error', null);
  try {
    await saveEnvironmentPanel($('environment-panel'));
    await flushModelSettings(job.id);
    const result = await request(`/jobs/${encodeURIComponent(job.id)}/share`, { method: 'POST' });
    const link = new URL(result.url, location.origin);
    if (!sourceView(job) && state.selectedMotion && state.selectedMotion !== 'base') link.searchParams.set('motion', state.selectedMotion);
    $('share-url').value = link.href;
    $('share-dialog').showModal();
  } catch (error) { toast(error.message); }
  finally { state.sharing = false; $('share-model').disabled = false; }
}

async function revokeShare() {
  if (!sharedJobId || state.sharing) return;
  state.sharing = true;
  $('share-revoke').disabled = $('share-copy').disabled = true;
  try {
    await request(`/jobs/${encodeURIComponent(sharedJobId)}/share`, { method: 'DELETE' });
    $('share-dialog').close();
    toast('Ссылка отключена. В следующий раз будет создана новая.');
  } catch (error) { setError('share-error', error.message); }
  finally { state.sharing = false; $('share-revoke').disabled = $('share-copy').disabled = false; }
}

function renderMotions(job) {
  const motions = job?.motions || [];
  const library = libraryMotions(job);
  const signature = JSON.stringify([motions, library, state.selectedMotion, sourceView(job), hasRig(job), state.motionLibraryReady, state.motionLibraryError]);
  if (signature === state.motionSignature) return;
  state.motionSignature = signature;
  if (isPlayground) {
    const select = $('playground-motion');
    const options = (items) => items.map((motion) => `<option value="${escape(motion.id)}">${escape(motion.prompt || 'Движение')} · ${Math.round(motion.frames / (motion.fps || 30))} с</option>`).join('');
    const own = motions.filter((motion) => motion.status === 'complete' && motion.glbUrl);
    const unavailable = state.motionLibraryReady && state.selectedMotion?.startsWith('library:') && !library.some((motion) => motion.id === state.selectedMotion);
    select.innerHTML = `<option value="">${hasRig(job) || state.demo ? 'Ходьба по кругу' : 'Исходная модель'}</option>` +
      (unavailable ? `<option value="${escape(state.selectedMotion)}" disabled>Движение недоступно</option>` : '') +
      (library.length ? `<optgroup label="Готовые движения">${options(library)}</optgroup>` : '') +
      (own.length ? `<optgroup label="Движения этой модели">${options(own)}</optgroup>` : '');
    select.value = state.selectedMotion === 'base' ? '' : state.selectedMotion || '';
    select.disabled = editingMesh(job) || sourceView(job) || !hasRig(job) || !(own.length || library.length);
    const notice = $('motion-library-status');
    notice.textContent = state.motionLibraryError || (!state.motionLibraryReady ? 'Загружаем готовые движения…' : library.length ? 'Первое открытие подготавливает движение для этой модели. Затем используется сохранённая версия.' : 'Готовых движений пока нет.');
    notice.hidden = !hasRig(job) || editingMesh(job);
  } else {
    $('motions-list').innerHTML = motions.map((motion) => `<div class="motion-row ${state.selectedMotion === motion.id ? 'selected' : ''}"><div class="motion-icon">${icon(motion.status === 'complete' ? 'play' : motion.status === 'failed' ? 'close' : 'reset')}</div><div class="motion-info"><strong>${escape(motion.prompt || 'Движение')}</strong><span>${motion.status === 'complete' ? `${Math.round((motion.frames || 150) / (motion.fps || 30))} с · готово` : escape(motion.status === 'failed' ? motion.error || 'Ошибка генерации' : stageText(motion.stage, 'В очереди'))}</span></div>${motion.status === 'complete' && motion.glbUrl ? `<button class="icon-button ${state.selectedMotion === motion.id ? 'active' : ''}" data-motion="${escape(motion.id)}" title="Посмотреть анимацию" aria-label="Посмотреть анимацию">${icon('play')}</button><a class="icon-button" href="${escape(motion.glbUrl)}" download title="Скачать GLB с анимацией" aria-label="Скачать GLB с анимацией">${icon('download')}</a>` : ''}</div>`).join('');
  }
}

async function refreshMotionLibrary() {
  if (!isPlayground || state.motionLibraryLoading) return;
  const authRevision = state.authRevision;
  state.motionLibraryLoading = true;
  try {
    const result = await request('/motion-library');
    if (authRevision !== state.authRevision) return;
    state.motionLibrary = result.motions || [];
    state.motionLibraryError = null;
  } catch (error) {
    if (authRevision === state.authRevision) state.motionLibraryError = 'Не удалось обновить готовые движения. Проверь подключение к компьютеру.';
  } finally {
    state.motionLibraryLoading = false;
    if (authRevision === state.authRevision) {
      state.motionLibraryReady = true;
      state.selectionSignature = '';
      renderMotions(getJob());
      renderSelection();
    } else void refreshMotionLibrary();
  }
}

async function ensureViewer() {
  if (state.viewer) return state.viewer;
  const { createViewer } = await import('./viewer.js');
  state.viewer ??= createViewer({ container: $('viewer'), playground: isPlayground, onState: onViewerState });
  return state.viewer;
}

function onViewerState(value) {
  state.viewerState = value;
  $('viewer-empty').hidden = value.ready || Boolean(value.loading) || Boolean(value.error);
  if (Object.hasOwn(value, 'loading')) $('viewer-loading').hidden = !value.loading;
  if (value.loading) $('viewer-loading-text').textContent = value.phase === 'checking' ? 'Проверяем сохранённую модель…'
    : value.phase === 'cached' ? 'Открываем модель из кеша…'
    : value.phase === 'parsing' ? 'Подготавливаем 3D-сцену…'
    : value.loadedPercent ? `Скачиваем модель · ${value.loadedPercent}%`
    : state.selectedMotion?.startsWith('library:') ? 'Подготавливаем выбранное движение…' : 'Открываем модель…';
  if (Object.hasOwn(value, 'error')) {
    $('viewer-error').hidden = !value.error;
    $('viewer-error-text').textContent = value.error || '';
  }
  $('viewer-stats').textContent = value.ready ? `${Math.round(value.triangles).toLocaleString('ru')} треугольников` : '';
  $('viewer-status').textContent = state.demo ? 'ДЕМО · DOOM SLAYER' : value.ready ? value.mode === 'ragdoll' ? 'RAGDOLL АКТИВЕН' : value.clipName ? 'АНИМАЦИЯ' : 'ПРОСМОТР 3D' : 'ПРОСМОТР 3D';
  if (!isPlayground) return;
  $('arena-mode').innerHTML = `<span class="status-dot ${value.ready ? 'online' : ''}"></span> ${value.ready ? editingMesh() ? 'Очистка модели' : value.orientationPreview ? 'Выравнивание исходной модели' : value.mode === 'ragdoll' ? 'Физика активна' : value.clipName ? 'Анимация воспроизводится' : 'Статичная модель' : 'Выбери модель для просмотра'}`;
  $('arena-fps').textContent = value.ready ? `${value.fps} FPS` : 'WEBGL';
  $('hit-count').textContent = String(value.hitCount).padStart(2, '0');
  $('body-count').textContent = value.bodyCount || '—';
  $('joint-count').textContent = value.jointCount || '—';
  $('strike').disabled = !value.ready || !value.rigAvailable;
  $('reset').disabled = !value.ready;
  $('power').disabled = !value.ready || !value.rigAvailable;
  $('slow').disabled = !value.ready;
  $('physics').disabled = !value.ready || !value.rigAvailable;
  $('pause').disabled = !value.ready || !value.clipName || value.mode === 'ragdoll';
  renderRigPreparation();
  renderPlacement();
  renderMeshCleanup();
}

async function loadSelectedViewer(force = false) {
  const job = getJob();
  // Reapplying normalization or loading a newer revision would invalidate the
  // face IDs currently selected by the author. Keep that snapshot until exit.
  if (!force && (state.meshEntryPending || editingMesh(job))) return state.viewerLoadPromise?.catch(() => {});
  const prepare = preparingRig(job) || editingMesh(job);
  const url = state.demo ? `${API}/demo/glb` : prepare ? job.artifacts.modelUrl : selectedUrl(job);
  if (!url) {
    if (job && state.motionLibraryReady && state.selectedMotion?.startsWith('library:')) {
      $('viewer-empty').hidden = $('viewer-loading').hidden = true;
      $('viewer-error').hidden = false;
      $('viewer-error-text').textContent = 'Движение недоступно. Выбери другое в списке «Движение».';
    }
    return;
  }
  const key = `${url}:${state.demo || hasRig(job)}:${prepare}:${job?.meshEdit?.revision || 0}`;
  const position = placementDraft(job)?.position || { x: 0, y: 0, z: 0 };
  const rotation = sourceView(job) ? placementDraft(job).rotation : {};
  const environment = getEnvironmentPreview($('environment-panel'), job?.id) || job?.environment || {};
  if (!force && state.viewerKey === key) {
    state.viewer?.setPosition(position);
    state.viewer?.setOrientation(rotation);
    void state.viewer?.setEnvironment(environment).catch((error) => toast(error.message));
    return state.viewerLoadPromise?.catch(() => {});
  }
  const requestId = ++state.viewerRequest;
  state.viewerKey = key;
  $('viewer-error').hidden = true;
  $('viewer-empty').hidden = true;
  $('viewer-loading').hidden = false;
  $('viewer-loading-text').textContent = state.selectedMotion?.startsWith('library:') ? 'Подготавливаем выбранное движение…' : 'Подготавливаем просмотр…';
  try {
    const viewer = await ensureViewer();
    if (requestId !== state.viewerRequest) return;
    const latestEnvironment = getEnvironmentPreview($('environment-panel'), job?.id) || job?.environment || {};
    state.viewerLoadPromise = viewer.load(url, { allowRagdoll: !prepare && !sourceView(job) && (state.demo || hasRig(job)), prepare, rotation, position, environment: latestEnvironment });
    await state.viewerLoadPromise;
    if (requestId !== state.viewerRequest) return;
    state.slow = false;
    state.debug = false;
    state.playing = true;
    viewer.setSlow(false);
    viewer.setDebug(false);
    viewer.setPosition(placementDraft(job)?.position || { x: 0, y: 0, z: 0 });
    viewer.setOrientation(sourceView(job) ? placementDraft(job).rotation : {});
    // Source models open with the same camera on owner and shared playgrounds.
    if (isPlayground && sourceView(job)) viewer.frontView();
    renderRigPreparation();
    if (isPlayground) ['slow', 'physics', 'pause'].forEach((id) => $(id).setAttribute('aria-pressed', 'false'));
    if (!isShared && !state.demo && !editingMesh(job) && !state.meshEntryPending && job?.status === 'complete' && !job.previewUrl) void saveModelPreview(job, requestId);
  } catch (error) {
    if (requestId !== state.viewerRequest) return;
    $('viewer-loading').hidden = true;
    $('viewer-error').hidden = false;
    $('viewer-error-text').textContent = error.message;
  }
}

function receiveOwnerJob(updated) {
  if (!updated?.id) return;
  const index = state.jobs.findIndex((job) => job.id === updated.id);
  if (index >= 0 && String(updated.updatedAt || '') < String(state.jobs[index].updatedAt || '')) return;
  if (index >= 0) state.jobs[index] = updated;
  state.selectionSignature = '';
  renderJobs();
  renderSelection();
  window.dispatchEvent(new CustomEvent('community:models-changed'));
}

async function saveModelPreview(job, requestId) {
  if (state.previewUploads.has(job.id) || requestId !== state.viewerRequest) return;
  state.previewUploads.add(job.id);
  try {
    const image = state.viewer?.capturePreview();
    if (!image || requestId !== state.viewerRequest) return;
    const response = await request(`/jobs/${encodeURIComponent(job.id)}/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }),
    });
    receiveOwnerJob(response.job || response);
  } catch {
    // The gallery can show its fallback until the owner retries or reloads.
  }
}

function renderSharedOwnerAccess() {
  const job = getJob();
  const visible = Boolean(isShared && state.sharedCanEdit && job);
  $('shared-owner-controls').hidden = !visible;
  $('shared-note').hidden = !isShared || visible;
  const link = $('edit-owned-model');
  if (!visible) { link.removeAttribute('href'); return; }
  const query = new URLSearchParams({ job: job.id });
  if (state.selectedMotion) query.set('motion', state.selectedMotion);
  link.href = `/playground?${query}`;
}

function renderPlaygroundComments(job) {
  const element = $('comments');
  if (!element) return;
  const modelId = !state.demo && job?.status === 'complete' && (!isShared || publicModelId || job.visibility === 'public') ? job.id : null;
  element.hidden = !modelId;
  if (state.commentsModelId === modelId) return;
  state.disposeComments?.();
  state.disposeComments = null;
  state.commentsModelId = modelId;
  if (modelId) state.disposeComments = mountComments(element, modelId);
}

function renderSelection() {
  const job = getJob();
  if (state.meshEditingId && !job) {
    meshEditPanel?.reset();
    state.meshEditingId = null;
    state.meshEntryPending = false;
    state.meshReturnView = null;
  }
  observeRigResult(job);
  if (job && state.selectedMotion === null) {
    if (isPlayground) state.selectedMotion = 'base';
    else {
      const latest = [...(job.motions || [])].reverse().find((motion) => motion.status === 'complete' && motion.glbUrl);
      if (latest) state.selectedMotion = latest.id;
    }
  }
  const signature = JSON.stringify([job, state.selectedMotion, state.demo, state.rigEditingId, state.meshEditingId, state.sharedCanEdit]);
  if (signature === state.selectionSignature) return;
  state.selectionSignature = signature;
  renderSharedOwnerAccess();
  renderPlaygroundComments(job);
  $('view-reference').hidden = !canViewReference(job);
  $('share-model').hidden = isShared || state.demo || job?.status !== 'complete' || !artifactUrl(job);
  renderEnvironmentPanel($('environment-panel'), !isShared && !state.demo ? job : null, {
    onPreview: async (environment) => {
      if (getJob()?.id === job?.id) await state.viewer?.setEnvironment(environment);
    },
    onSaved: receiveOwnerJob,
    capturePreview: async () => {
      await state.viewerLoadPromise?.catch(() => {});
      return getJob()?.id === job?.id ? state.viewer?.capturePreview() : null;
    },
  });
  renderPublicationPanel($('publication-panel'), !isShared && !state.demo ? job : null, {
    onUpdated: receiveOwnerJob, capturePreview: async () => state.viewer?.capturePreview() || null,
  });
  if (isPlayground) {
    $('public-model-discussion').hidden = !state.commentsModelId;
    $('public-model-discussion').href = '#comments';
    $('playground-model-name').textContent = state.demo ? 'Doom Slayer · демо' : job ? jobTitle(job) : 'Модель не выбрана';
    $('playground-hint').textContent = state.demo ? 'Скелетный персонаж из предыдущей генерации. Анимация переключается на физику при ударе.' : job ? preparingRig(job) ? 'Выровняй персонажа, затем создай скелет для движения и ragdoll.' : hasRig(job) ? 'Скелет готов. Испытай движение и реакцию на удар.' : 'После создания модели здесь можно подготовить персонажа к анимации.' : 'Открой свою модель из библиотеки ниже или начни с демо.';
    $('back-to-model').href = job ? `/generate-model?job=${encodeURIComponent(job.id)}` : '/generate-model';
    $('playground-download').hidden = !selectedUrl(job) && !state.demo;
    $('playground-download').href = state.demo ? `${API}/demo/glb` : preparingRig(job) ? job.artifacts.modelUrl : selectedUrl(job) || '#';
    $('create-motion-link').hidden = isShared || !hasRig(job) || preparingRig(job) || rigBusy(job) || state.demo;
    $('back-to-model').hidden = isShared;
    if (isShared) $('playground-hint').textContent = hasRig(job) && !sourceView(job) ? 'Выбирай движение и проверяй реакцию на удар. Изменять модель может только владелец.' : 'Просмотр модели с сохранённым положением и поворотом. Для анимации владелец может подготовить скелет.';
    $('create-motion-link').href = job ? `/generate-model?job=${encodeURIComponent(job.id)}#animation-panel` : '/generate-model';
    renderRigPreparation();
    renderPlacement();
    renderMotions(job);
    renderMeshCleanup();
  } else {
    $('result-name').textContent = job ? jobTitle(job) : 'Предпросмотр';
    const active = job && ['queued', 'running'].includes(job.status);
    $('job-progress').hidden = !active;
    if (active) {
      $('job-stage').textContent = stageText(job.stage, statusLabels[job.status]);
      $('job-percent').textContent = `${jobProgress(job)}%`;
      $('job-progress-fill').style.width = `${jobProgress(job)}%`;
    }
    $('result-error').hidden = job?.status !== 'failed';
    $('result-error-message').textContent = job?.error || 'Генерация прервалась. Проверь подключение компьютера и попробуй ещё раз.';
    $('retry-generation').hidden = !job?.sourceImageUrl;
    $('result-actions').hidden = !artifactUrl(job);
    $('download-model').href = selectedUrl(job) || '#';
    $('download-model').querySelector('span:not(.icon)').textContent = selectedMotion(job) ? 'GLB с анимацией' : hasRig(job) ? 'GLB со скелетом' : 'Скачать GLB';
    $('open-playground').href = job ? `/playground?job=${encodeURIComponent(job.id)}${state.selectedMotion ? `&motion=${encodeURIComponent(state.selectedMotion)}` : ''}` : '/playground';
    renderMotions(job);
    updateAnimationAvailability();
  }
  // A humanoid briefly exposes its static GLB while the rig is still being
  // fitted. Wait for the final artifact to avoid two large competing downloads.
  if (state.demo || (artifactUrl(job) && ['complete', 'failed'].includes(job.status))) void loadSelectedViewer();
  else if (state.viewerKey) {
    state.viewerRequest++;
    state.viewer?.dispose();
    state.viewer = null;
    state.viewerKey = '';
    state.viewerState = {};
    $('viewer-loading').hidden = true;
    $('viewer-error').hidden = true;
    $('viewer-empty').hidden = false;
    $('viewer-stats').textContent = '';
    if (isPlayground) onViewerState({ ready: false, hitCount: 0 });
  }
}

function selectJob(id, { retainMotion = false } = {}) {
  if (meshEditPanel?.isActive && id === state.selectedId && !retainMotion) return true;
  if (!leaveMeshCleanup()) return false;
  state.selectedId = id;
  if (!retainMotion) state.selectedMotion = null;
  state.demo = false;
  if (!isShared) localStorage.setItem('model-studio-selected', id);
  const query = new URLSearchParams(publicModelId ? { model: publicModelId } : isShared ? { share: shareToken } : { job: id });
  if (state.selectedMotion) query.set('motion', state.selectedMotion);
  history.replaceState(null, '', `${isPlayground ? '/playground' : '/generate-model'}?${query}`);
  renderJobs();
  renderSelection();
  return true;
}

function refreshHealth(force = false) {
  if (state.healthPolling || (!force && state.health && performance.now() - state.healthTime <= 8000)) return;
  state.healthPolling = true;
  state.healthTime = performance.now();
  // This heartbeat has its own lifecycle: a slow GLB transfer or heartbeat must
  // never hold the job polling lock or delay enabling controls for a final job.
  void request('/health', { timeoutMs: 30000 }).then((result) => {
    state.health = result;
    state.healthError = null;
    state.healthFailures = 0;
  }).catch((error) => {
    state.healthError = error.message;
    state.healthFailures++;
  }).finally(() => { state.healthPolling = false; updateHealth(); });
}

function preserveNewerJob(incoming) {
  const current = state.jobs.find((job) => job.id === incoming?.id);
  if (!current) return incoming;
  const currentRevision = current.meshEdit?.revision || 0;
  const incomingRevision = incoming.meshEdit?.revision || 0;
  // A library GET begun before cleanup can finish after its POST. Mesh face
  // IDs, source URL and rig availability must advance as one saved revision.
  if (currentRevision !== incomingRevision) return currentRevision > incomingRevision ? current : incoming;
  return String(current.updatedAt || '') > String(incoming.updatedAt || '') ? current : incoming;
}

async function poll(force = false) {
  const active = state.jobs.some((job) => ['queued', 'running'].includes(job.status) || rigBusy(job) || job.motions?.some((motion) => ['queued', 'running'].includes(motion.status)));
  if (state.polling || (document.hidden && !force && !active && performance.now() - state.jobsTime < 15000)) return;
  state.polling = true;
  const authRevision = state.authRevision;
  state.jobsTime = performance.now();
  refreshHealth(force);
  if (isShared) {
    try {
      const result = await request(publicModelId ? `/models/${encodeURIComponent(publicModelId)}` : `/shares/${encodeURIComponent(shareToken)}`);
      if (authRevision !== state.authRevision) return;
      state.sharedCanEdit = result.canEdit === true;
      state.jobs = [result.job];
      state.selectedId = result.job.id;
      setError('shared-error', null);
      renderSelection();
    } catch (error) {
      if (authRevision !== state.authRevision) return;
      state.sharedCanEdit = false;
      state.jobs = [];
      state.selectedId = null;
      renderSelection();
      setError('shared-error', error.message);
    } finally {
      state.polling = false;
      if (authRevision !== state.authRevision) void poll(true);
    }
    return;
  }
  try {
    const tasks = [request('/jobs').then(async (result) => {
      if (authRevision !== state.authRevision) return;
      state.jobs = (Array.isArray(result) ? result : result.jobs || []).filter((job) => !state.deletedIds.has(job.id)).map(preserveNewerJob).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      state.jobsError = null;
      if (state.selectedId && !getJob()) {
        const selectedId = state.selectedId;
        try {
          const selected = await request(`/jobs/${encodeURIComponent(selectedId)}`);
          if (authRevision !== state.authRevision) return;
          if (state.selectedId === selectedId && !state.deletedIds.has(selectedId)) state.jobs.unshift(preserveNewerJob(selected.job || selected));
        }
        catch { if (!state.jobs.length && !params.get('job')) state.selectedId = null; }
      }
      if (authRevision !== state.authRevision) return;
      if (!state.selectedId && state.jobs.length && !state.demo) state.selectedId = state.jobs[0].id;
      setError('library-error', null);
      renderJobs();
      renderSelection();
    }).catch((error) => {
      if (authRevision !== state.authRevision) return;
      state.jobsError = error.message;
      setError('library-error', error.message);
      if (!state.jobs.length) $('jobs-list').innerHTML = '<div class="library-empty">Библиотека появится, когда компьютер подключится.</div>';
    })];
    await Promise.allSettled(tasks);
  } finally { state.polling = false; }
}

function chooseFile(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setError('form-error', 'Поддерживаются PNG, JPG и WebP. Выбери изображение в одном из этих форматов.'); return; }
  if (file.size > 20 * 1024 * 1024) { setError('form-error', 'Изображение больше 20 МБ. Уменьши его размер и загрузи снова.'); return; }
  if (state.filePreview) URL.revokeObjectURL(state.filePreview);
  state.file = file;
  state.filePreview = URL.createObjectURL(file);
  $('source-preview').src = state.filePreview;
  $('source-preview').hidden = false;
  $('upload-empty').hidden = true;
  $('replace-image').hidden = false;
  $('file-info').hidden = false;
  $('file-name').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} МБ`;
  $('upload-zone').classList.add('has-image');
  setError('form-error', null);
  updateHealth();
}

function chooseMode(mode) {
  state.mode = mode;
  document.querySelectorAll('[data-mode]').forEach((button) => { const selected = button.dataset.mode === mode; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
  $('mode-hint').textContent = mode === 'humanoid' ? 'Человек в полный рост, спереди. Руки и ноги отдельно от тела: так скелет и ragdoll получатся лучше.' : 'Предмет, транспорт или скульптура — геометрия и текстуры без скелета.';
}

function chooseQuality(quality) {
  state.quality = quality;
  document.querySelectorAll('[data-quality]').forEach((button) => { const selected = button.dataset.quality === quality; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
}

async function submitGeneration(event) {
  event?.preventDefault();
  if (!state.file || state.submitting) return;
  state.submitting = true;
  setError('form-error', null);
  updateHealth();
  try {
    const form = new FormData();
    form.set('image', state.file);
    form.set('mode', state.mode);
    form.set('quality', state.quality);
    form.set('seed', String(crypto.getRandomValues(new Uint32Array(1))[0]));
    form.set('visibility', $('publish-new-model').checked ? 'public' : 'private');
    const result = await request('/jobs', { method: 'POST', body: form });
    const job = result.job || result;
    state.jobs = [job, ...state.jobs.filter((item) => item.id !== job.id)];
    selectJob(job.id);
    toast('Изображение принято. Создаём 3D-модель.');
    void poll(true);
  } catch (error) { setError('form-error', error.message); }
  finally { state.submitting = false; updateHealth(); }
}

async function submitAnimation(event) {
  event.preventDefault();
  const job = getJob();
  const prompt = $('motion-prompt').value.trim();
  if (!job || !prompt || state.animating) return;
  state.animating = true;
  setError('animation-error', null);
  updateAnimationAvailability();
  try {
    const result = await request(`/jobs/${encodeURIComponent(job.id)}/animate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, frames: Number($('motion-duration').value), steps: 50, seed: crypto.getRandomValues(new Uint32Array(1))[0], model: 'smplx-rp-v1' }),
    });
    const motion = result.motion || result;
    job.motions = [motion, ...(job.motions || []).filter((item) => item.id !== motion.id)];
    state.selectedMotion = motion.id;
    state.selectionSignature = '';
    renderSelection();
    toast('Движение добавлено в очередь.');
    void poll(true);
  } catch (error) { setError('animation-error', error.message); }
  finally { state.animating = false; updateAnimationAvailability(); }
}

$('refresh-jobs').addEventListener('click', () => { void poll(true); });
$('view-reference').addEventListener('click', viewReference);
$('reference-close').addEventListener('click', () => $('reference-dialog').close());
$('reference-retry').addEventListener('click', loadReferenceImage);
$('reference-dialog').addEventListener('close', () => {
  referenceRequest++;
  referenceSource = null;
  const image = $('reference-image');
  image.onload = image.onerror = null;
  image.removeAttribute('src');
  image.hidden = true;
  $('reference-original').removeAttribute('href');
});
$('reference-dialog').addEventListener('click', (event) => {
  if (event.target !== $('reference-dialog')) return;
  const rect = $('reference-dialog').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('reference-dialog').close();
});
$('share-model').addEventListener('click', () => { void shareModel(); });
$('share-close').addEventListener('click', () => $('share-dialog').close());
$('share-revoke').addEventListener('click', () => { void revokeShare(); });
$('share-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('share-url').value); toast('Ссылка скопирована.'); }
  catch { $('share-url').focus(); $('share-url').select(); setError('share-error', 'Скопируй выделенную ссылку вручную: Ctrl+C.'); }
});
$('delete-failed').addEventListener('click', () => openDeleteDialog(state.jobs.filter((job) => job.status === 'failed')));
$('delete-cancel').addEventListener('click', () => $('delete-dialog').close());
$('delete-confirm').addEventListener('click', () => { void deleteGenerations(); });
$('delete-dialog').addEventListener('cancel', (event) => { if (state.deleting) event.preventDefault(); });
$('jobs-list').addEventListener('click', (event) => {
  const remove = event.target.closest('[data-delete-job]');
  if (remove) { const job = state.jobs.find((item) => item.id === remove.dataset.deleteJob); if (job && !remove.disabled) openDeleteDialog([job]); return; }
  const button = event.target.closest('[data-job]');
  if (button) { selectJob(button.dataset.job); $('viewer-frame').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
});
$('retry-viewer').addEventListener('click', () => { if (!meshEditPanel?.isActive) void loadSelectedViewer(true); });
$('open-demo').addEventListener('click', () => {
  if (!isPlayground) { location.href = '/playground?demo=1'; return; }
  if (!leaveMeshCleanup()) return;
  state.demo = true;
  state.selectedId = null;
  state.selectedMotion = null;
  history.replaceState(null, '', '/playground?demo=1');
  renderJobs();
  renderSelection();
});

if (!isPlayground) {
  $('source-image').addEventListener('change', (event) => chooseFile(event.target.files[0]));
  $('upload-zone').addEventListener('keydown', (event) => { if (event.code === 'Enter' || event.code === 'Space') { event.preventDefault(); $('source-image').click(); } });
  for (const name of ['dragenter', 'dragover']) $('upload-zone').addEventListener(name, (event) => { event.preventDefault(); $('upload-zone').classList.add('dragging'); });
  for (const name of ['dragleave', 'drop']) $('upload-zone').addEventListener(name, (event) => { event.preventDefault(); $('upload-zone').classList.remove('dragging'); if (name === 'drop') chooseFile(event.dataTransfer.files[0]); });
  $('clear-file').addEventListener('click', () => {
    if (state.filePreview) URL.revokeObjectURL(state.filePreview);
    state.file = state.filePreview = null;
    $('source-image').value = '';
    $('source-preview').hidden = true;
    $('source-preview').removeAttribute('src');
    $('upload-empty').hidden = false;
    $('replace-image').hidden = true;
    $('file-info').hidden = true;
    $('upload-zone').classList.remove('has-image');
    updateHealth();
  });
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => chooseMode(button.dataset.mode)));
  document.querySelectorAll('[data-quality]').forEach((button) => button.addEventListener('click', () => chooseQuality(button.dataset.quality)));
  document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => { $('motion-prompt').value = button.dataset.prompt; $('motion-prompt').focus(); }));
  $('generation-form').addEventListener('submit', submitGeneration);
  $('animation-form').addEventListener('submit', submitAnimation);
  $('reset-camera').addEventListener('click', () => state.viewer?.resetCamera());
  $('motions-list').addEventListener('click', (event) => { const button = event.target.closest('[data-motion]'); if (button) { state.selectedMotion = button.dataset.motion; selectJob(state.selectedId, { retainMotion: true }); } });
  $('retry-generation').addEventListener('click', async () => {
    const job = getJob();
    if (!job?.sourceImageUrl) return;
    $('retry-generation').disabled = true;
    try {
      const response = await fetch(job.sourceImageUrl, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('Не удалось получить исходное изображение. Выбери файл на компьютере.');
      const blob = await response.blob();
      chooseFile(new File([blob], job.sourceFilename || 'reference.png', { type: blob.type || 'image/png' }));
      chooseMode(job.mode || 'object');
      chooseQuality(job.quality || 'standard');
      await submitGeneration();
    } catch (error) { setError('form-error', error.message); }
    finally { $('retry-generation').disabled = false; }
  });
} else {
  document.querySelectorAll('[data-position-range]').forEach((input) => input.addEventListener('input', () => updatePlacementAxis(input.dataset.positionRange, input.value, false)));
  document.querySelectorAll('[data-position-number]').forEach((input) => {
    input.addEventListener('input', () => updatePlacementAxis(input.dataset.positionNumber, input.value));
    input.addEventListener('change', () => updatePlacementAxis(input.dataset.positionNumber, input.value, false));
  });
  $('placement-reset').addEventListener('click', () => updatePlacement({ x: 0, y: 0, z: 0 }, { preserveFocused: false }));
  $('placement-ground').addEventListener('click', () => {
    if (isShared || editingMesh()) return;
    const position = state.viewer?.placeOnFloor();
    if (position) updatePlacement(position, { preserveFocused: false });
  });
  $('placement-retry').addEventListener('click', () => { const job = getJob(); if (job) void savePlacement(job.id); });
  $('save-model-settings').addEventListener('click', async () => {
    const job = getJob();
    if (!job) return;
    try { await flushModelSettings(job.id); toast('Положение и поворот сохранены.'); }
    catch (error) { toast(error.message); }
  });
  $('rig-form').addEventListener('submit', submitRig);
  $('edit-rig').addEventListener('click', () => {
    const job = getJob();
    if (!job || editingMesh(job) || rigBusy(job)) return;
    state.rigEditingId = job.id;
    const draft = rigDraft(job);
    draft.error = null;
    syncRotationControls(draft.rotation);
    renderSelection();
  });
  $('cancel-rig-edit').addEventListener('click', () => {
    const job = getJob();
    if (!job || editingMesh(job) || rigBusy(job)) return;
    const settings = placementDraft(job);
    settings.rotation = normalizeModelRotation(job.rig?.appliedRotation);
    settings.version++;
    settings.dirty = true;
    settings.error = null;
    queuePlacementSave(job, settings);
    state.rigEditingId = null;
    renderSelection();
  });
  $('rig-front-view').addEventListener('click', () => state.viewer?.frontView());
  $('rig-reset-rotation').addEventListener('click', () => {
    for (const axis of ['x', 'y', 'z']) updateDraftRotation(axis, 0);
  });
  document.querySelectorAll('[data-rotation-range]').forEach((input) => input.addEventListener('input', () => updateDraftRotation(input.dataset.rotationRange, input.value)));
  document.querySelectorAll('[data-rotation-number]').forEach((input) => {
    input.addEventListener('input', () => updateDraftRotation(input.dataset.rotationNumber, input.value, { keepNumber: true }));
    input.addEventListener('change', () => {
      if (input.value !== '' && Number.isFinite(Number(input.value))) updateDraftRotation(input.dataset.rotationNumber, input.value);
    });
  });
  document.querySelectorAll('[data-rotation-step]').forEach((button) => button.addEventListener('click', () => {
    const job = getJob();
    if (!job) return;
    const axis = button.dataset.rotationStep;
    const next = rigDraft(job).rotation[axis] + 90;
    updateDraftRotation(axis, next > 180 ? next - 360 : next);
  }));
  $('strike').addEventListener('click', () => { if (state.viewer?.hit()) toast('Попадание! Физика активна.'); });
  $('reset').addEventListener('click', () => { state.viewer?.reset(); state.playing = true; $('pause').setAttribute('aria-pressed', 'false'); });
  $('power').addEventListener('input', () => { $('power-value').value = `${$('power').value} / 10`; state.viewer?.setPower($('power').value); });
  $('slow').addEventListener('click', () => { state.slow = !state.slow; $('slow').setAttribute('aria-pressed', String(state.slow)); state.viewer?.setSlow(state.slow); });
  $('physics').addEventListener('click', () => { state.debug = !state.debug; $('physics').setAttribute('aria-pressed', String(state.debug)); state.viewer?.setDebug(state.debug); });
  $('pause').addEventListener('click', () => { state.playing = !state.playing; $('pause').setAttribute('aria-pressed', String(!state.playing)); state.viewer?.setPlaying(state.playing); });
  $('playground-motion').addEventListener('change', () => { if (editingMesh()) return; state.selectedMotion = $('playground-motion').value || 'base'; selectJob(state.selectedId, { retainMotion: true }); });
  window.addEventListener('keydown', (event) => {
    if (editingMesh()) return;
    if (event.repeat || document.querySelector('dialog[open]') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (event.code === 'Space' && document.activeElement?.tagName === 'BUTTON') return;
    if (event.code === 'Space') { event.preventDefault(); $('strike').click(); }
    if (event.code === 'KeyR') $('reset').click();
    if (event.code === 'KeyT') $('slow').click();
  });
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(true); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistSettingsOnExit(); });
window.addEventListener('pagehide', persistSettingsOnExit);
window.addEventListener('pagehide', () => { meshEditPanel?.reset(); state.meshEditingId = null; state.meshEntryPending = false; state.meshReturnView = null; state.viewer?.dispose(); if (state.filePreview) URL.revokeObjectURL(state.filePreview); });
window.addEventListener('community:auth-changed', () => {
  state.authRevision++;
  state.motionLibrary = [];
  state.motionLibraryReady = false;
  void refreshMotionLibrary();
  if (isShared) {
    state.sharedCanEdit = false;
    renderSharedOwnerAccess();
    void poll(true);
    return;
  }
  meshEditPanel?.reset();
  state.meshEditingId = null;
  state.meshEntryPending = false;
  state.meshReturnView = null;
  manualRigPanel?.reset();
  for (const draft of state.placementDrafts.values()) clearTimeout(draft.timer);
  state.placementDrafts.clear();
  state.rigDrafts.clear();
  state.jobs = [];
  state.selectedId = state.selectedMotion = state.rigEditingId = null;
  state.selectionSignature = '';
  state.demo = false;
  localStorage.removeItem('model-studio-selected');
  history.replaceState(null, '', isPlayground ? '/playground' : '/generate-model');
  renderJobs();
  renderSelection();
  void poll(true);
});
mountCommunityHeader();
if ($('community-gallery')) mountGallerySection($('community-gallery'), { limit: 8 });
renderSelection();
updateHealth();
void poll(true);
void refreshMotionLibrary();
setInterval(() => { void refreshMotionLibrary(); }, 30000);
setInterval(() => { void poll(); }, 2500);
