import './environment-panel.css';

const API = '/api/model-studio';
const defaults = { background: 'studio', backgroundProjection: 'panorama', backgroundRotation: 0, ground: 'grid', groundShape: 'plane', groundScale: 2, showGrid: true };
const fields = Object.keys(defaults);
const backgrounds = [['studio', 'Студия'], ['dawn', 'Горное утро'], ['sunset', 'Закат'], ['night', 'Звёздная ночь'], ['custom', 'Свой фон']];
const grounds = [['grid', 'Студия'], ['stone', 'Камень'], ['sand', 'Песок'], ['grass', 'Трава'], ['custom', 'Своя текстура']];
const states = new WeakMap();
const icon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m3 18 6-9 4 6 3-4 5 7H3Z"/><circle cx="17" cy="6" r="2"/></svg>';

function fromJob(job) {
  return { ...defaults, ...job?.environment, revision: job?.environment?.revision || 0 };
}
function current(element, state) { return element.isConnected && states.get(element) === state && !state.disposed; }
function release(state) {
  state.disposed = true;
  state.uploadSequence++;
  Object.values(state.urls).forEach((url) => URL.revokeObjectURL(url));
}
function changed(state) {
  const saved = fromJob(state.job);
  return fields.some((field) => state.draft[field] !== saved[field]) || Object.keys(state.files).length > 0;
}
function draftEnvironment(state) {
  return { ...state.draft,
    backgroundUrl: state.urls.backgroundImage || state.draft.backgroundUrl || null,
    groundUrl: state.urls.groundImage || state.draft.groundUrl || null };
}
function errorText(element, message = '') {
  const error = element.querySelector('[data-environment-error]');
  error.textContent = message;
  error.hidden = !message;
}
function status(element, state, text) {
  element.querySelector('[data-environment-status]').textContent = text || (state.dirty ? 'Есть изменения' : 'Сохранено');
  element.querySelector('[data-environment-save]').disabled = Boolean(state.saving || state.uploading || !state.dirty);
  element.querySelector('[data-environment-reset]').disabled = Boolean(state.saving || state.uploading);
}
function syncControls(element, state) {
  const draft = state.draft;
  element.querySelectorAll('[data-env-background]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.envBackground === draft.background)));
  element.querySelectorAll('[data-env-ground]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.envGround === draft.ground)));
  element.querySelector('[data-background-upload]').hidden = draft.background !== 'custom';
  element.querySelector('[data-ground-upload]').hidden = draft.ground !== 'custom';
  for (const field of ['backgroundProjection', 'backgroundRotation', 'groundShape', 'groundScale']) {
    const input = element.querySelector(`[name="${field}"]`);
    if (document.activeElement !== input) input.value = draft[field];
  }
  element.querySelector('[name=showGrid]').checked = draft.showGrid;
  element.querySelector('[data-background-rotation]').hidden = draft.background === 'studio' || (draft.background === 'custom' && draft.backgroundProjection === 'image');
  element.querySelector('[data-ground-scale]').hidden = draft.ground === 'grid';
  element.querySelector('[data-rotation-value]').textContent = `${draft.backgroundRotation}°`;
  element.querySelector('[data-scale-value]').textContent = `${Number(draft.groundScale).toLocaleString('ru-RU')} м`;
  for (const kind of ['background', 'ground']) {
    const url = draftEnvironment(state)[`${kind}Url`];
    const image = element.querySelector(`[data-${kind}-preview]`);
    if (url && image.getAttribute('src') !== url) image.src = url;
    if (!url) image.removeAttribute('src');
    image.hidden = !url;
    element.querySelector(`[data-${kind}-filename]`).textContent = state.files[`${kind}Image`]?.name || (url ? 'Сохранённая текстура' : 'Изображение ещё не выбрано');
  }
  status(element, state);
}
function preview(element, state) {
  const sequence = ++state.previewSequence;
  state.previewPromise = Promise.resolve().then(() => {
    if (!current(element, state)) return;
    const environment = draftEnvironment(state);
    // A custom swatch first reveals the upload field. Keep the last valid view
    // until an image is supplied instead of reporting a rendering failure.
    if ((environment.background === 'custom' && !environment.backgroundUrl) || (environment.ground === 'custom' && !environment.groundUrl)) return;
    return state.options.onPreview?.(environment);
  }).catch((error) => {
    if (current(element, state) && sequence === state.previewSequence) errorText(element, error.message || 'Не удалось открыть текстуру. Выбери другое изображение.');
  });
  return state.previewPromise;
}
function edit(element, state, patch) {
  if (state.saving || state.uploading) return;
  Object.assign(state.draft, patch);
  state.dirty = changed(state);
  errorText(element);
  syncControls(element, state);
  void preview(element, state);
}

async function request(path, options) {
  const response = await fetch(`${API}${path}`, { credentials: 'same-origin', cache: 'no-store', ...options, signal: AbortSignal.timeout(90000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(response.status === 409 ? 'Окружение уже изменилось в другой вкладке. Нажми «Вернуть сохранённое» и повтори изменения.' : result.error || 'Не удалось сохранить окружение. Попробуй ещё раз.');
    error.status = response.status;
    throw error;
  }
  return result;
}

export function getEnvironmentPreview(element, jobId) {
  const state = element && states.get(element);
  return state && !state.disposed && state.job.id === jobId ? draftEnvironment(state) : null;
}

export async function saveEnvironmentPanel(element) {
  const state = element && states.get(element);
  if (!state || state.disposed) return null;
  if (state.saving) return state.saving;
  if (!state.dirty) return null;
  if (state.uploading) throw new Error('Дождись открытия выбранной текстуры.');
  const environment = draftEnvironment(state);
  if (environment.background === 'custom' && !environment.backgroundUrl) throw new Error('Добавь изображение для своего фона.');
  if (environment.ground === 'custom' && !environment.groundUrl) throw new Error('Добавь изображение текстуры земли.');
  const data = new FormData();
  data.set('settings', JSON.stringify({ ...Object.fromEntries(fields.map((field) => [field, environment[field]])), expectedRevision: state.baseRevision }));
  for (const [field, file] of Object.entries(state.files)) data.set(field, file);
  const id = state.job.id;
  errorText(element);
  element.querySelectorAll('button,input,select').forEach((control) => { control.disabled = true; });
  state.saving = (async () => {
    try {
      const { job } = await request(`/jobs/${encodeURIComponent(id)}/environment`, { method: 'PUT', body: data });
      state.job = job;
      state.baseRevision = job.environment.revision;
      state.draft = fromJob(job);
      state.dirty = false;
      let previewError;
      if (current(element, state)) {
        // Persistence succeeded even if a later texture request fails.
        try { await state.options.onPreview?.(state.draft); }
        catch (error) { previewError = error; }
      }
      Object.values(state.urls).forEach((url) => URL.revokeObjectURL(url));
      state.urls = {};
      state.files = {};
      state.options.onSaved?.(job);
      if (current(element, state)) {
        element.querySelectorAll('input[type=file]').forEach((input) => { input.value = ''; });
        syncControls(element, state);
        status(element, state, 'Сохранено');
        if (previewError) errorText(element, 'Окружение сохранено, но текстура не загрузилась. Обнови страницу.');
        try {
          const image = !previewError && await state.options.capturePreview?.();
          if (image && current(element, state)) {
            const result = await request(`/jobs/${encodeURIComponent(id)}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) });
            state.options.onSaved?.(result.job);
          }
        } catch {
          if (current(element, state)) status(element, state, 'Сохранено · превью обновится позже');
        }
      }
      return job;
    } catch (error) {
      if (error.status === 409) {
        try {
          const latest = await request(`/jobs/${encodeURIComponent(id)}`);
          state.job = latest.job || latest;
          state.options.onSaved?.(state.job);
        } catch { /* Preserve the draft; polling can still refresh the saved job. */ }
      }
      if (current(element, state)) { errorText(element, error.message); status(element, state, 'Не сохранено'); }
      throw error;
    } finally {
      state.saving = null;
      if (current(element, state)) {
        element.querySelectorAll('button,input,select').forEach((control) => { control.disabled = false; });
        element.querySelector('[data-environment-save]').disabled = !state.dirty;
      }
    }
  })();
  status(element, state, 'Сохраняем…');
  return state.saving;
}

export function renderEnvironmentPanel(element, job, options = {}) {
  if (!element) return;
  let state = states.get(element);
  if (!job || job.status !== 'complete' || !job.artifacts?.modelUrl) {
    if (state) { release(state); states.delete(element); }
    element.hidden = true;
    return;
  }
  element.hidden = false;
  if (!state || state.job.id !== job.id) {
    if (state) release(state);
    state = { job, draft: fromJob(job), baseRevision: job.environment?.revision || 0, options, files: {}, urls: {}, dirty: false, saving: null, uploading: false, uploadSequence: 0, previewSequence: 0 };
    states.set(element, state);
    const swatches = (items, kind) => items.map(([value, label]) => `<button type="button" class="environment-swatch env-${kind}-${value}" data-env-${kind}="${value}" aria-pressed="false"><span class="environment-swatch-art" aria-hidden="true">${value === 'custom' ? '+' : ''}</span><span>${label}</span></button>`).join('');
    element.innerHTML = `<details class="environment-panel" open><summary><span>${icon}Окружение модели</span><small data-environment-status role="status">Сохранено</small></summary><div class="environment-body"><p class="environment-intro">Фон и земля сохраняются с моделью и видны по её ссылке.</p><form class="environment-form">
      <fieldset><legend>Задний фон</legend><div class="environment-swatches" role="group" aria-label="Варианты фона">${swatches(backgrounds, 'background')}</div></fieldset>
      <div class="environment-upload" data-background-upload hidden><label>Изображение фона<input type="file" name="backgroundImage" accept="image/png,image/jpeg,image/webp" /></label><img data-background-preview alt="Текстура фона" hidden/><span data-background-filename></span><label>Отображение фона<select name="backgroundProjection"><option value="panorama">Панорама 360°</option><option value="image">Обычная картинка</option></select></label><p>Для панорамы лучше изображение 2:1. Обычная картинка заполняет кадр без сферического растяжения.</p></div>
      <label class="environment-range" data-background-rotation><span>Поворот фона <output data-rotation-value>0°</output></span><input type="range" name="backgroundRotation" min="-180" max="180" step="1" aria-label="Поворот фона" /></label>
      <fieldset><legend>Земля</legend><div class="environment-swatches" role="group" aria-label="Варианты земли">${swatches(grounds, 'ground')}</div></fieldset>
      <div class="environment-upload" data-ground-upload hidden><label>Изображение земли<input type="file" name="groundImage" accept="image/png,image/jpeg,image/webp" /></label><img data-ground-preview alt="Текстура земли" hidden/><span data-ground-filename></span><p>Бесшовная текстура повторяется по поверхности земли.</p></div>
      <label class="environment-field">Форма земли<select name="groundShape"><option value="plane">Плоскость</option><option value="disc">Круглая площадка</option></select></label>
      <label class="environment-range" data-ground-scale hidden><span>Размер плитки <output data-scale-value>2 м</output></span><input type="range" name="groundScale" min="0.25" max="10" step="0.25" aria-label="Размер плитки земли" /></label>
      <label class="environment-checkbox"><input type="checkbox" name="showGrid"/>Показывать сетку</label>
      <p class="environment-note">Свои текстуры: PNG, JPG или WebP, до 8 МБ каждая. Они будут доступны вместе с моделью по общей ссылке.</p>
      <p class="environment-error" role="alert" data-environment-error hidden></p><div class="environment-actions"><button type="submit" class="button button-primary" data-environment-save>Сохранить окружение</button><button type="button" class="button button-quiet" data-environment-reset>Вернуть сохранённое</button></div>
    </form></div></details>`;
    element.querySelectorAll('[data-env-background]').forEach((button) => button.addEventListener('click', () => edit(element, state, { background: button.dataset.envBackground })));
    element.querySelectorAll('[data-env-ground]').forEach((button) => button.addEventListener('click', () => edit(element, state, { ground: button.dataset.envGround })));
    for (const field of ['backgroundProjection', 'groundShape']) element.querySelector(`[name=${field}]`).addEventListener('change', (event) => edit(element, state, { [field]: event.target.value }));
    for (const field of ['backgroundRotation', 'groundScale']) element.querySelector(`[name=${field}]`).addEventListener('input', (event) => edit(element, state, { [field]: Number(event.target.value) }));
    element.querySelector('[name=showGrid]').addEventListener('change', (event) => edit(element, state, { showGrid: event.target.checked }));
    for (const kind of ['background', 'ground']) element.querySelector(`[name=${kind}Image]`).addEventListener('change', async (event) => {
      if (state.saving || state.uploading) return;
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        errorText(element, 'Выбери PNG, JPG или WebP размером до 8 МБ.'); event.target.value = ''; return;
      }
      const sequence = ++state.uploadSequence;
      state.uploading = true;
      element.querySelectorAll('input[type=file]').forEach((input) => { input.disabled = true; });
      status(element, state, 'Открываем текстуру…');
      try {
        const bitmap = await createImageBitmap(file);
        const ratio = bitmap.width / bitmap.height;
        const pixels = bitmap.width * bitmap.height;
        bitmap.close();
        if (!current(element, state) || sequence !== state.uploadSequence) return;
        if (pixels > 32_000_000) throw new Error('Выбери текстуру до 32 мегапикселей.');
        const field = `${kind}Image`;
        if (state.urls[field]) URL.revokeObjectURL(state.urls[field]);
        state.files[field] = file;
        state.urls[field] = URL.createObjectURL(file);
        state.draft[kind] = 'custom';
        if (kind === 'background') state.draft.backgroundProjection = Math.abs(ratio - 2) < 0.15 ? 'panorama' : 'image';
        state.dirty = true;
        errorText(element);
        syncControls(element, state);
        await preview(element, state);
      } catch (error) {
        if (current(element, state)) { errorText(element, error.message || 'Не удалось открыть изображение.'); event.target.value = ''; }
      } finally {
        if (current(element, state) && sequence === state.uploadSequence) {
          state.uploading = false;
          element.querySelectorAll('input[type=file]').forEach((input) => { input.disabled = false; });
          status(element, state);
        }
      }
    });
    element.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); void saveEnvironmentPanel(element).catch((error) => { if (current(element, state)) errorText(element, error.message); }); });
    element.querySelector('[data-environment-reset]').addEventListener('click', async () => {
      state.draft = fromJob(state.job);
      state.baseRevision = state.draft.revision;
      state.dirty = false;
      state.files = {};
      const previousUrls = state.urls;
      state.urls = {};
      errorText(element);
      syncControls(element, state);
      element.querySelectorAll('input[type=file]').forEach((input) => { input.value = ''; });
      await preview(element, state);
      Object.values(previousUrls).forEach((url) => URL.revokeObjectURL(url));
    });
  }
  state.job = job;
  state.options = options;
  if (!state.dirty && !state.saving && !state.uploading) {
    state.draft = fromJob(job);
    state.baseRevision = state.draft.revision;
    syncControls(element, state);
  }
}
