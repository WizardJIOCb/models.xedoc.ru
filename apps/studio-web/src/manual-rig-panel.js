import './manual-rig.css';

export const MANUAL_JOINTS = [
  ['head', 'Центр головы', 'Поставь точку внутри головы, примерно на уровне глаз.'],
  ['neck', 'Основание шеи', 'Место, где шея соединяется с туловищем.'],
  ['shoulder_l', 'Левое плечо', 'Центр плечевого сустава под бронёй, а не край наплечника.'],
  ['elbow_l', 'Левый локоть', 'Центр сгиба левой руки.'],
  ['wrist_l', 'Левое запястье', 'Место соединения кисти и предплечья.'],
  ['hand_l', 'Левая кисть', 'Центр ладони или сжатого кулака.'],
  ['shoulder_r', 'Правое плечо', 'Центр плечевого сустава под бронёй, а не край наплечника.'],
  ['elbow_r', 'Правый локоть', 'Центр сгиба правой руки.'],
  ['wrist_r', 'Правое запястье', 'Место соединения кисти и предплечья.'],
  ['hand_r', 'Правая кисть', 'Центр ладони или сжатого кулака.'],
  ['hip_l', 'Левое бедро', 'Тазобедренный сустав, где нога соединяется с тазом.'],
  ['knee_l', 'Левое колено', 'Центр коленного сустава, под наколенником.'],
  ['ankle_l', 'Левая щиколотка', 'Сустав между голенью и стопой.'],
  ['toe_l', 'Носок левой стопы', 'Передняя часть стопы, внутри обуви.'],
  ['hip_r', 'Правое бедро', 'Тазобедренный сустав, где нога соединяется с тазом.'],
  ['knee_r', 'Правое колено', 'Центр коленного сустава, под наколенником.'],
  ['ankle_r', 'Правая щиколотка', 'Сустав между голенью и стопой.'],
  ['toe_r', 'Носок правой стопы', 'Передняя часть стопы, внутри обуви.'],
];
const IDS = MANUAL_JOINTS.map(([id]) => id);
const SIDE_PARTS = ['shoulder', 'elbow', 'wrist', 'hand', 'hip', 'knee', 'ankle', 'toe'];
const oppositeSide = (id) => id.endsWith('_l') ? `${id.slice(0, -2)}_r` : id.endsWith('_r') ? `${id.slice(0, -2)}_l` : id;
const $ = (id) => document.getElementById(id);
const clone = (value) => structuredClone(value);
const sameRotation = (a, b) => ['x', 'y', 'z'].every((axis) => Math.abs((a?.[axis] || 0) - (b?.[axis] || 0)) < 0.001);

export function manualRigMarkup() {
  return `<div class="rig-methods" role="group" aria-label="Способ создания скелета">
    <button type="button" data-rig-method="auto" aria-pressed="true">Автоматически</button>
    <button type="button" data-rig-method="manual" aria-pressed="false">Вручную</button>
  </div><section id="manual-rig-panel" aria-label="Ручная расстановка суставов" hidden>
    <div class="manual-progress"><strong id="manual-count">0 / 18 точек</strong><span id="manual-save-status" role="status"></span></div>
    <p class="manual-help">Лево и право — со стороны персонажа. Клик по телу ставит точку; перетаскивай точку для уточнения. Пустое место вращает камеру.</p>
    <div id="manual-stale" class="inline-error" hidden>Поворот модели изменился после разметки. Верни прежний поворот или начни разметку заново.<button type="button" class="button button-quiet button-small" id="manual-restore-rotation">Вернуть поворот разметки</button></div>
    <fieldset id="manual-point-fields">
      <div class="manual-views" role="group" aria-label="Ракурс для расстановки точек">${[['front', 'Спереди'], ['left', 'Слева'], ['right', 'Справа'], ['back', 'Сзади']].map(([id, name]) => `<button class="button button-quiet button-small" type="button" data-manual-view="${id}">${name}</button>`).join('')}</div>
      <label class="field-label" for="manual-joint">Опорная точка</label>
      <select id="manual-joint">${MANUAL_JOINTS.map(([id, label], i) => `<option value="${id}">${i + 1}. ${label}</option>`).join('')}</select>
      <p id="manual-joint-hint" class="manual-joint-hint"></p>
      <div class="manual-navigation"><button type="button" class="button button-quiet button-small" id="manual-prev">← Назад</button><button type="button" class="button button-secondary button-small" id="manual-next">Следующая →</button></div>
      <p id="manual-feedback" class="manual-feedback" role="status"></p>
      <details id="manual-coordinates"><summary>Точное положение точки</summary><p class="manual-help">X — влево/вправо, Y — высота, Z — глубина. Масштаб разметки: рост 2 м.</p><div class="manual-coordinate-fields">${['x', 'y', 'z'].map((axis) => `<label>${axis.toUpperCase()}<input id="manual-${axis}" data-manual-coordinate="${axis}" type="number" min="-3" max="3" step="any" aria-label="Точка ${axis.toUpperCase()}" /></label>`).join('')}</div></details>
      <div class="manual-edit-actions"><button type="button" class="button button-quiet button-small" id="manual-undo">Отменить</button><button type="button" class="button button-quiet button-small" id="manual-remove">Удалить точку</button></div>
      <details class="manual-all-points"><summary>Все точки</summary><div>${MANUAL_JOINTS.map(([id, name]) => `<button type="button" data-manual-joint="${id}" aria-pressed="false">${name}</button>`).join('')}</div></details>
      <label class="manual-review"><input type="checkbox" id="manual-reviewed" />Проверил точки спереди и сбоку: они внутри нужных частей тела</label>
      <p id="manual-side-correction" class="manual-feedback" role="status" hidden>Левая и правая стороны исправлены автоматически. Положение точек сохранено.</p>
    </fieldset>
    <button type="button" class="button button-quiet button-small" id="manual-clear">Начать заново</button>
    <div id="manual-save-error" class="inline-error" role="alert" hidden></div><button type="button" class="button button-quiet button-small" id="manual-save-retry" hidden>Повторить сохранение</button>
  </section>`;
}

export function createManualRigPanel({ getJob, getViewer, getRotation, request, repaint, restoreRotation }) {
  const drafts = new Map();
  let clientId = crypto.randomUUID();
  let active = false, locked = true;
  function draftFor(job) {
    if (!job) return null;
    if (!drafts.has(job.id)) {
      const saved = job.manualRigDraft || (job.rig?.manual ? { manual: job.rig.manual, rotation: job.rig.manualRotation || job.rig.appliedRotation } : null);
      const points = clone(saved?.manual?.points || {});
      drafts.set(job.id, { points, rotation: clone(saved?.rotation || getRotation(job)), mode: saved ? 'manual' : 'auto',
        selected: IDS.find((id) => !points[id]) || 'head', reviewed: false, undo: [], dirty: false,
        version: 0, pending: null, timer: null, error: null, saved: Boolean(saved), hint: '', sidesCorrected: false });
    }
    return drafts.get(job.id);
  }
  const stale = (job, draft) => Object.keys(draft.points).length > 0 && !sameRotation(draft.rotation, getRotation(job));
  const changedUI = () => repaint();
  function queueSave(job, draft) {
    clearTimeout(draft.timer);
    draft.timer = setTimeout(() => { void flush(job).catch(() => {}); }, 450);
  }
  function markChanged(job, draft) {
    draft.version++;
    draft.dirty = true;
    draft.error = null;
    draft.reviewed = false;
    queueSave(job, draft);
    changedUI();
  }
  async function flush(job = getJob()) {
    const draft = job && drafts.get(job.id);
    if (!draft) return;
    clearTimeout(draft.timer);
    if (draft.pending) { await draft.pending; if (draft.dirty) return flush(job); return; }
    if (!draft.dirty) return;
    const revision = draft.version;
    const body = { rotation: clone(draft.rotation), manual: { version: 1, points: clone(draft.points) }, write: { clientId, revision } };
    draft.pending = request(`/jobs/${encodeURIComponent(job.id)}/rig-draft`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true,
    }).then(() => {
      if (draft.version === revision) draft.dirty = false;
      draft.saved = true;
      draft.error = null;
    }).catch((error) => { draft.error = error.message; throw error; }).finally(() => { draft.pending = null; changedUI(); });
    changedUI();
    await draft.pending;
    if (draft.dirty) return flush(job);
  }
  function edit(points, { hint = '', next = false } = {}) {
    const job = getJob(), draft = draftFor(job);
    if (!active || locked || !draft || stale(job, draft)) return;
    const previous = clone(draft.points);
    if (JSON.stringify(points) === JSON.stringify(previous)) return;
    // Drag updates are grouped into one undo action within a short gesture.
    const now = performance.now();
    if (!draft.lastEdit || now - draft.lastEdit > 350 || Object.keys(points).length !== Object.keys(previous).length) {
      draft.undo.push({ points: previous, rotation: clone(draft.rotation) });
      if (draft.undo.length > 50) draft.undo.shift();
    }
    draft.lastEdit = now;
    draft.points = clone(points);
    draft.sidesCorrected = false;
    draft.rotation = clone(getRotation(job));
    draft.hint = hint;
    if (next) draft.selected = IDS.find((id) => !draft.points[id]) || draft.selected;
    markChanged(job, draft);
  }
  function select(id) { const draft = draftFor(getJob()); if (draft && IDS.includes(id)) { draft.selected = id; draft.hint = ''; changedUI(); } }
  function prepare(job) {
    const draft = draftFor(job);
    if (!draft || draft.mode !== 'manual' || stale(job, draft)) return false;
    const points = draft.points;
    if (!IDS.every((id) => Array.isArray(points[id]) && points[id].length === 3 && points[id].every(Number.isFinite))) return false;
    // Torso anchors identify a globally reversed naming convention. Exchange
    // whole limb chains, including crossed hands/feet; never reflect positions.
    if (!['shoulder', 'hip'].every((part) => points[`${part}_l`][0] < points[`${part}_r`][0] - 0.02)) return false;
    const reviewed = draft.reviewed;
    draft.undo.push({ points: clone(points), rotation: clone(draft.rotation), selected: draft.selected });
    if (draft.undo.length > 50) draft.undo.shift();
    draft.points = clone(points);
    for (const part of SIDE_PARTS) {
      draft.points[`${part}_l`] = clone(points[`${part}_r`]);
      draft.points[`${part}_r`] = clone(points[`${part}_l`]);
    }
    draft.selected = oppositeSide(draft.selected);
    draft.lastEdit = 0;
    draft.sidesCorrected = true;
    markChanged(job, draft);
    draft.reviewed = reviewed;
    changedUI();
    return true;
  }
  function render(job, { editing = false, busy = false, ready = false } = {}) {
    const draft = draftFor(job);
    active = Boolean(editing && draft?.mode === 'manual');
    locked = Boolean(busy || !ready);
    const outOfDate = draft ? stale(job, draft) : false;
    const count = draft ? IDS.filter((id) => draft.points[id]).length : 0;
    const complete = count === IDS.length && !outOfDate && draft?.reviewed;
    $('manual-rig-panel').hidden = !active;
    $('manual-point-fields').disabled = !active || locked || outOfDate;
    document.querySelector('.playground-layout')?.classList.toggle('manual-rig-active', active);
    for (const button of document.querySelectorAll('[data-rig-method]')) {
      button.setAttribute('aria-pressed', String(button.dataset.rigMethod === draft?.mode));
      button.disabled = busy;
    }
    if (active) {
      $('manual-count').textContent = `${count} / ${IDS.length} точек`;
      $('manual-save-status').textContent = draft.error ? 'Не сохранено' : draft.pending ? 'Сохраняем…' : draft.dirty ? 'Есть изменения' : draft.saved ? 'Черновик сохранён' : '';
      $('manual-stale').hidden = !outOfDate;
      $('manual-restore-rotation').disabled = locked;
      $('manual-point-fields').disabled = locked || outOfDate;
      $('manual-clear').disabled = locked || !count;
      $('manual-undo').disabled = locked || !draft.undo.length;
      $('manual-remove').disabled = locked || !draft.points[draft.selected];
      $('manual-coordinates').hidden = !draft.points[draft.selected];
      $('manual-reviewed').disabled = count !== IDS.length || locked || outOfDate;
      $('manual-reviewed').checked = draft.reviewed;
      $('manual-side-correction').hidden = !draft.sidesCorrected;
      $('manual-save-error').hidden = !draft.error;
      $('manual-save-error').textContent = draft.error || '';
      $('manual-save-retry').hidden = !draft.error;
      $('manual-save-retry').disabled = Boolean(draft.pending);
      $('manual-joint').value = draft.selected;
      const selectedIndex = IDS.indexOf(draft.selected);
      $('manual-joint-hint').textContent = MANUAL_JOINTS[selectedIndex][2];
      $('manual-feedback').textContent = draft.hint || (draft.points[draft.selected] ? 'Точка поставлена. Проверь глубину на виде сбоку.' : 'Нажми на нужное место на модели.');
      $('manual-prev').disabled = selectedIndex === 0 || locked;
      $('manual-next').disabled = selectedIndex === IDS.length - 1 || locked;
      for (const [i, id] of IDS.entries()) {
        $('manual-joint').options[i].textContent = `${draft.points[id] ? '✓' : '○'} ${i + 1}. ${MANUAL_JOINTS[i][1]}`;
        const button = document.querySelector(`[data-manual-joint="${id}"]`);
        button.classList.toggle('is-placed', Boolean(draft.points[id]));
        button.setAttribute('aria-pressed', String(id === draft.selected));
      }
      for (const [index, axis] of ['x', 'y', 'z'].entries()) {
        const field = $(`manual-${axis}`);
        if (document.activeElement !== field) field.value = draft.points[draft.selected] ? String(Number(draft.points[draft.selected][index].toFixed(3))) : '';
      }
    }
    getViewer()?.setManualRig?.({ enabled: active && !outOfDate, locked, points: draft?.points || {}, selected: draft?.selected || 'head',
      onSelect: select,
      onHint: (hint) => { if (draft && active) { draft.hint = hint; changedUI(); } },
      onChange: (points) => {
        const added = Object.keys(points).length > Object.keys(draft.points).length;
        edit(points, { next: added, hint: added && Object.keys(points).length === IDS.length ? 'Все точки поставлены. Проверь скелет с разных сторон.' : '' });
      },
    });
    return { manual: active, complete, count, stale: outOfDate };
  }
  for (const button of document.querySelectorAll('[data-rig-method]')) button.addEventListener('click', () => {
    const job = getJob(), draft = draftFor(job);
    if (!draft || locked) return;
    draft.mode = button.dataset.rigMethod;
    if (draft.mode === 'manual' && !Object.keys(draft.points).length) {
      draft.rotation = clone(getRotation(job));
      markChanged(job, draft);
    }
    changedUI();
    if (draft.mode === 'manual') getViewer()?.manualView?.('front');
  });
  $('manual-joint').addEventListener('change', (event) => select(event.target.value));
  for (const button of document.querySelectorAll('[data-manual-joint]')) button.addEventListener('click', () => select(button.dataset.manualJoint));
  for (const [id, step] of [['manual-prev', -1], ['manual-next', 1]]) $(id).addEventListener('click', () => select(IDS[IDS.indexOf(draftFor(getJob()).selected) + step]));
  for (const button of document.querySelectorAll('[data-manual-view]')) button.addEventListener('click', () => getViewer()?.manualView?.(button.dataset.manualView));
  for (const field of document.querySelectorAll('[data-manual-coordinate]')) field.addEventListener('input', () => {
    if (field.value === '' || !Number.isFinite(Number(field.value)) || !field.validity.valid) return;
    const draft = draftFor(getJob()), points = clone(draft.points);
    if (!points[draft.selected]) return;
    points[draft.selected]['xyz'.indexOf(field.dataset.manualCoordinate)] = Number(field.value);
    edit(points);
  });
  $('manual-remove').addEventListener('click', () => { const draft = draftFor(getJob()), points = clone(draft.points); delete points[draft.selected]; edit(points); });
  $('manual-clear').addEventListener('click', () => {
    const job = getJob(), draft = draftFor(job);
    if (locked) return;
    draft.undo.push({ points: clone(draft.points), rotation: clone(draft.rotation) });
    draft.points = {}; draft.rotation = clone(getRotation(job)); draft.selected = 'head'; draft.hint = 'Точки очищены. Действие можно отменить.';
    draft.sidesCorrected = false;
    markChanged(job, draft);
  });
  $('manual-undo').addEventListener('click', () => {
    const job = getJob(), draft = draftFor(job), previous = draft.undo.pop();
    if (!previous || locked) return;
    draft.points = previous.points; draft.rotation = previous.rotation; draft.lastEdit = 0;
    draft.selected = previous.selected || draft.selected;
    draft.sidesCorrected = false;
    markChanged(job, draft);
  });
  $('manual-reviewed').addEventListener('change', () => {
    const job = getJob(), reviewed = $('manual-reviewed').checked;
    if (reviewed) prepare(job);
    draftFor(job).reviewed = reviewed;
    changedUI();
  });
  $('manual-restore-rotation').addEventListener('click', () => restoreRotation(clone(draftFor(getJob()).rotation)));
  $('manual-save-retry').addEventListener('click', () => { void flush().catch(() => {}); });
  function persistOnExit() {
    for (const [id, draft] of drafts) {
      if (!draft.dirty) continue;
      clearTimeout(draft.timer);
      // Send the newest snapshot now, even when an older PUT is in flight.
      // The server revision watermark makes either arrival order safe; waiting
      // for the old promise could lose the latest edit when this page unloads.
      const body = { rotation: clone(draft.rotation), manual: { version: 1, points: clone(draft.points) },
        write: { clientId, revision: draft.version } };
      void request(`/jobs/${encodeURIComponent(id)}/rig-draft`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true,
      }).catch(() => {});
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistOnExit(); });
  window.addEventListener('pagehide', persistOnExit);
  return { render, flush, prepare,
    manual: (job) => draftFor(job)?.mode === 'manual',
    payload: (job) => ({ version: 1, points: clone(draftFor(job).points) }),
    reset() { for (const draft of drafts.values()) clearTimeout(draft.timer); drafts.clear(); clientId = crypto.randomUUID(); getViewer()?.setManualRig?.({ enabled: false }); },
  };
}
