import './mesh-edit-panel.css';

const emptyStatus = () => ({ isReady: false, dirty: false, selectedTriangles: 0, deletedTriangles: 0, totalTriangles: 0, canUndo: false, error: '' });
const count = (value) => Math.max(0, Number(value) || 0).toLocaleString('ru-RU');

export function createMeshEditPanel({ element, getJob, getViewer, request, onEnter, onExit, onSaved, toast }) {
  if (!element) throw new Error('Не найден блок очистки модели.');
  let job = null, epoch = 0, active = false, entering = false, saving = false, editor = null;
  let state = emptyStatus(), revision = 0, tool = 'part', brushSize = 28;
  let flags = { visible: false, busy: false, ready: false };
  let error = '', recoveryJob = null, pendingAbort = null, disposed = false;
  let editorConfig = '';

  element.innerHTML = `<section class="mesh-edit-panel" aria-label="Очистка модели">
    <div class="mesh-edit-heading"><h3>Очистка модели</h3><span data-mesh-status role="status"></span></div>
    <p class="mesh-edit-help" data-mesh-intro>Убери лишние верёвки, парящие фрагменты и мелкие детали. Исходную модель можно будет вернуть.</p>
    <div data-mesh-inactive class="mesh-edit-actions">
      <button type="button" class="button button-secondary" data-mesh-enter>Редактировать части</button>
      <button type="button" class="button button-quiet button-small" data-mesh-restore hidden>Вернуть исходную модель</button>
    </div>
    <div data-mesh-active hidden>
      <div class="mesh-edit-tools" role="group" aria-label="Способ выделения частей">
        <button type="button" data-mesh-tool="part" aria-pressed="true">Отдельная часть</button>
        <button type="button" data-mesh-tool="brush" aria-pressed="false">Кисть</button>
      </div>
      <p class="mesh-edit-help" data-mesh-tool-hint></p>
      <label class="mesh-edit-range" data-mesh-brush hidden><span>Размер кисти <output data-mesh-brush-value>28 px</output></span><input type="range" min="6" max="100" step="1" value="28" data-mesh-brush-size aria-label="Размер кисти" /></label>
      <div class="mesh-edit-counts" aria-live="polite"><span><strong data-mesh-selected>0</strong> выделено</span><span><strong data-mesh-deleted>0</strong> удалено</span></div>
      <p class="mesh-edit-caption">Количество треугольников</p>
      <div class="mesh-edit-actions mesh-edit-selection">
        <button type="button" class="button mesh-edit-delete" data-mesh-delete>Удалить выделенное</button>
        <div class="mesh-edit-action-pair"><button type="button" class="button button-quiet button-small" data-mesh-clear>Снять выделение</button><button type="button" class="button button-quiet button-small" data-mesh-undo>Отменить шаг</button></div>
      </div>
      <details class="mesh-edit-fragments"><summary>Найти мелкие фрагменты</summary><p class="mesh-edit-help">Выделяет отдельные кусочки меньше заданного размера. Проверь выделение перед удалением: среди них могут быть нужные детали.</p><label>До треугольников<input type="number" min="1" max="10000" step="1" value="3000" data-mesh-fragment-limit aria-label="Максимальный размер мелкого фрагмента" /></label><button type="button" class="button button-quiet button-small" data-mesh-small>Выделить мелкие фрагменты</button></details>
      <p class="mesh-edit-warning">После очистки понадобится заново создать скелет и применить движение. Положение модели и окружение сохранятся.</p>
      <div class="mesh-edit-actions"><button type="button" class="button button-primary" data-mesh-save>Сохранить очищенную модель</button><button type="button" class="button button-quiet button-small" data-mesh-cancel>Выйти без сохранения</button></div>
    </div>
    <p class="mesh-edit-error" role="alert" data-mesh-error hidden></p>
    <button type="button" class="button button-quiet button-small" data-mesh-retry hidden>Повторить открытие модели</button>
  </section>`;
  const find = (name) => element.querySelector(`[data-mesh-${name}]`);
  const controls = [...element.querySelectorAll('button,input')];
  const toolButtons = [...element.querySelectorAll('[data-mesh-tool]')];
  const isCurrent = (token, id) => !disposed && epoch === token && job?.id === id && getJob()?.id === id;
  const dirty = () => active && Boolean(state.dirty || state.deletedTriangles > 0);
  const locked = () => entering || saving || flags.busy || !flags.ready;

  function paint() {
    element.hidden = !flags.visible || !job;
    find('inactive').hidden = active;
    find('active').hidden = !active;
    find('intro').hidden = active;
    find('restore').hidden = !job?.meshEdit?.edited;
    find('status').textContent = saving ? 'Сохраняем…' : entering ? 'Открываем редактор…' : active ? (dirty() ? 'Есть изменения' : 'Режим выделения') : job?.meshEdit?.edited ? 'Очищена' : '';
    find('selected').textContent = count(state.selectedTriangles);
    find('deleted').textContent = count(state.deletedTriangles);
    find('brush').hidden = tool !== 'brush';
    find('brush-value').textContent = `${brushSize} px`;
    find('tool-hint').textContent = tool === 'part'
      ? 'Клик выделяет отдельную деталь, перетаскивание вращает камеру. Если верёвка соединена с телом, используй кисть. Shift убирает выделение.'
      : 'Кисть выделяет только видимую поверхность. Вращай камеру правой кнопкой мыши; на телефоне переключись на «Отдельная часть». Shift убирает выделение.';
    toolButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.meshTool === tool)));
    const blocked = locked();
    controls.forEach((control) => { control.disabled = blocked; });
    const meshBlocked = blocked || !state.isReady;
    toolButtons.forEach((button) => { button.disabled = meshBlocked; });
    for (const name of ['brush-size', 'fragment-limit', 'small']) find(name).disabled = meshBlocked;
    find('delete').disabled = meshBlocked || !state.selectedTriangles;
    find('clear').disabled = meshBlocked || !state.selectedTriangles;
    find('undo').disabled = meshBlocked || !state.canUndo;
    find('save').disabled = meshBlocked || !dirty();
    // Exiting a failed mesh load must stay possible once the request has ended.
    find('cancel').disabled = entering || saving;
    const message = error || state.error || '';
    find('error').textContent = message;
    find('error').hidden = !message;
    find('retry').hidden = !recoveryJob;
    find('retry').disabled = saving;
    find('enter').disabled = blocked || Boolean(recoveryJob);
    find('restore').disabled = blocked || Boolean(recoveryJob);
  }

  function updateEditor() {
    if (!editor || !active) return;
    const token = epoch, id = job.id;
    const configuration = JSON.stringify([token, id, !locked(), tool, brushSize]);
    // Viewer status updates arrive while a brush stroke is in progress. A
    // redundant setState would end that stroke and release pointer capture.
    if (configuration !== editorConfig) {
      editorConfig = configuration;
      editor.setState({ enabled: !locked(), tool, brushSize, onChange(value) {
        if (!isCurrent(token, id) || !active) return;
        state = { ...state, ...value };
        paint();
      } });
    }
    state = { ...state, ...editor.getStatus() };
    paint();
  }
  function disableEditor({ restore = false } = {}) {
    const captured = editor;
    editor = null;
    editorConfig = '';
    if (!captured) return;
    // The callback is invalidated before restore, which can synchronously emit.
    try { captured.setState({ enabled: false, onChange: null }); } catch { /* Viewer may already be disposed. */ }
    if (restore) { try { captured.restore(); } catch { /* Leaving a disposed viewer needs no geometry cleanup. */ } }
  }
  function reset() {
    epoch++;
    pendingAbort?.abort();
    pendingAbort = null;
    disableEditor({ restore: true });
    active = entering = saving = false;
    state = emptyStatus();
    error = '';
    recoveryJob = null;
    paint();
  }
  async function enter() {
    if (active || locked() || !job || !flags.visible || recoveryJob) return;
    const token = ++epoch, id = job.id;
    revision = job.meshEdit?.revision || 0;
    active = entering = true;
    error = '';
    state = emptyStatus();
    paint();
    try {
      await onEnter?.();
      if (!isCurrent(token, id)) return;
      editor = getViewer()?.meshEditor;
      if (!editor) throw new Error('Редактор частей пока не готов. Дождись загрузки модели и повтори.');
      entering = false;
      updateEditor();
    } catch (failure) {
      if (!isCurrent(token, id)) return;
      active = entering = false;
      disableEditor({ restore: true });
      error = failure.message || 'Не удалось открыть редактор частей.';
      try { await onExit?.({ reason: 'error' }); } catch { /* Keep the useful editor error. */ }
    } finally { if (isCurrent(token, id)) { entering = false; paint(); } }
  }
  function canLeave() {
    if (entering || saving) { toast?.('Дождись завершения операции с моделью.'); return false; }
    return !dirty() || window.confirm('Выйти без сохранения очистки? Удалённые в редакторе части вернутся.');
  }
  async function cancel() {
    if (!active || !canLeave()) return;
    const token = ++epoch, id = job.id;
    disableEditor({ restore: true });
    active = false;
    state = emptyStatus();
    error = '';
    paint();
    try { await onExit?.({ reason: 'cancelled' }); }
    catch (failure) { if (isCurrent(token, id)) { error = failure.message || 'Не удалось открыть модель. Обнови страницу.'; paint(); } }
  }
  function operate(method, ...args) {
    if (!active || locked() || !state.isReady || !editor) return;
    error = '';
    try {
      editor[method](...args);
      state = { ...state, ...editor.getStatus() };
    } catch (failure) { error = failure.message || 'Не удалось изменить выделение.'; }
    paint();
  }

  async function showSaved(savedJob, token, id) {
    if (!isCurrent(token, id)) return;
    recoveryJob = savedJob;
    try {
      await onSaved?.(savedJob);
      if (!isCurrent(token, id)) return;
      await onExit?.({ reason: 'saved' });
      if (!isCurrent(token, id)) return;
      recoveryJob = null;
      error = '';
      toast?.('Модель сохранена.');
    } catch {
      // A renderer failure cannot undo a successful server commit. Never send
      // the old triangle IDs again against the newly saved revision.
      if (isCurrent(token, id)) error = 'Изменения сохранены, но модель не удалось открыть. Повтори открытие или обнови страницу.';
    }
  }
  async function persist(restore = false) {
    if (locked() || !job || !flags.visible || recoveryJob) return;
    if (!restore && (!active || !state.isReady || !dirty())) return;
    if (restore && !window.confirm('Вернуть исходную модель целиком? Очистка будет отменена, вернутся исходный скелет и движения, если они были.')) return;
    const token = epoch, id = job.id;
    let remove;
    try { if (!restore) remove = editor.getEdits(); }
    catch (failure) { error = failure.message || 'Не удалось подготовить изменения.'; paint(); return; }
    if (!restore && (!remove?.length || !remove.some((entry) => entry.faces?.length))) return;
    saving = true;
    error = '';
    pendingAbort = new AbortController();
    const controller = pendingAbort;
    updateEditor();
    paint();
    try {
      const result = await request(`/jobs/${encodeURIComponent(id)}/${restore ? 'mesh-restore' : 'mesh-edit'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
        body: JSON.stringify({ expectedRevision: restore ? job.meshEdit?.revision || 0 : revision, ...(!restore && { remove }) }),
      });
      if (!isCurrent(token, id)) return;
      if (!result?.job || result.job.id !== id) throw new Error('Сервер вернул неверную модель. Обнови страницу перед следующей попыткой.');
      job = result.job;
      active = false;
      disableEditor();
      state = emptyStatus();
      await showSaved(result.job, token, id);
    } catch (failure) {
      if (!isCurrent(token, id)) return;
      error = failure.status === 409
        ? 'Модель уже изменилась в другой вкладке. Твоя очистка осталась в редакторе; выйди без сохранения и открой свежую модель перед повторной правкой.'
        : failure.message || 'Не удалось сохранить очистку. Выделение и удаления остались в редакторе.';
    } finally {
      if (isCurrent(token, id)) {
        saving = false;
        if (pendingAbort === controller) pendingAbort = null;
        updateEditor();
        paint();
      }
    }
  }

  find('enter').addEventListener('click', () => { void enter(); });
  find('cancel').addEventListener('click', () => { void cancel(); });
  find('save').addEventListener('click', () => { void persist(); });
  find('restore').addEventListener('click', () => { void persist(true); });
  find('delete').addEventListener('click', () => operate('deleteSelection'));
  find('clear').addEventListener('click', () => operate('clearSelection'));
  find('undo').addEventListener('click', () => operate('undo'));
  find('small').addEventListener('click', () => {
    const limit = Number(find('fragment-limit').value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
      error = 'Укажи размер фрагмента от 1 до 10 000 треугольников.';
      paint();
      return;
    }
    operate('selectSmallParts', limit);
  });
  toolButtons.forEach((button) => button.addEventListener('click', () => {
    if (locked() || !active || !state.isReady) return;
    tool = button.dataset.meshTool;
    updateEditor();
  }));
  find('brush-size').addEventListener('input', (event) => {
    if (locked() || !active || !state.isReady) return;
    brushSize = Math.max(6, Math.min(100, Number(event.target.value) || 28));
    updateEditor();
  });
  find('retry').addEventListener('click', async () => {
    if (!recoveryJob || saving || !job) return;
    const token = epoch, id = job.id;
    saving = true;
    paint();
    await showSaved(recoveryJob, token, id);
    if (isCurrent(token, id)) { saving = false; paint(); }
  });
  const beforeUnload = (event) => {
    if (dirty() || saving) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('beforeunload', beforeUnload);
  paint();

  return {
    get isActive() { return active; },
    canLeave,
    reset,
    render(value, options = {}) {
      if (disposed) return;
      const previousFlags = flags;
      flags = { ...flags, ...options };
      if (job?.id !== value?.id || (previousFlags.visible && !flags.visible)) reset();
      job = value;
      if (active && editor && !entering && !saving) updateEditor();
      paint();
    },
    dispose() { reset(); disposed = true; window.removeEventListener('beforeunload', beforeUnload); },
  };
}
