import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run the production controller with observable DOM, viewer and HTTP boundaries.
const source = (await readFile(new URL('../apps/studio-web/src/mesh-edit-panel.js', import.meta.url), 'utf8'))
  .replace(/^import '\.\/mesh-edit-panel\.css';\r?\n/m, '').replace(/^export /gm, '');
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const freshJob = (id = 'model-a', revision = 0) => ({ id, status: 'complete', meshEdit: { revision, edited: revision > 0 } });

class Element {
  constructor(dataset = {}) { this.dataset = dataset; this.listeners = new Map(); this.hidden = false; this.disabled = false; this.value = ''; this.attributes = new Map(); this.textContent = ''; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name) { this.listeners.delete(name); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  fire(name = 'click') { if (!this.disabled) return this.listeners.get(name)?.({ target: this }); }
}
function harness(options = {}) {
  let job = freshJob(), currentOptions = options, enterPending = options.enterPending;
  const elements = new Map(), requests = [], saved = [], exits = [], toasts = [], confirms = [];
  const names = ['status', 'intro', 'inactive', 'active', 'enter', 'restore', 'tool-hint', 'brush', 'brush-value', 'brush-size', 'selected', 'deleted', 'delete', 'clear', 'undo', 'fragment-limit', 'small', 'save', 'cancel', 'error', 'retry'];
  names.forEach((name) => elements.set(name, new Element()));
  elements.get('fragment-limit').value = '3000';
  const toolButtons = ['part', 'brush'].map((meshTool) => new Element({ meshTool }));
  const controls = ['enter', 'restore', 'brush-size', 'delete', 'clear', 'undo', 'fragment-limit', 'small', 'save', 'cancel', 'retry'].map((name) => elements.get(name)).concat(toolButtons);
  const root = new Element();
  root.querySelector = (selector) => elements.get(selector.match(/data-mesh-([a-z-]+)/)[1]);
  root.querySelectorAll = (selector) => selector === '[data-mesh-tool]' ? toolButtons : controls;
  const win = new Element();
  win.confirm = (question) => { confirms.push(question); return currentOptions.confirm !== false; };
  let change = null, enabled = false, restores = 0;
  const status = { isReady: true, dirty: false, deletedTriangles: 0, selectedTriangles: 0, totalTriangles: 1000, canUndo: false };
  let edits = [], configurations = [];
  const emit = () => change?.({ ...status, enabled });
  const engine = {
    setState(value) { enabled = value.enabled; change = value.onChange; configurations.push(value); emit(); },
    getStatus: () => ({ ...status, enabled }),
    getEdits: () => edits,
    deleteSelection() { status.deletedTriangles += status.selectedTriangles; status.selectedTriangles = 0; status.dirty = true; status.canUndo = true; edits = [{ mesh: 0, primitive: 0, faces: [7, 8, 9] }]; emit(); },
    clearSelection() { status.selectedTriangles = 0; emit(); },
    selectSmallParts(limit) { status.selectedTriangles = limit; emit(); },
    undo() { status.dirty = false; status.deletedTriangles = 0; status.canUndo = false; edits = []; emit(); },
    restore() { restores++; status.dirty = false; status.deletedTriangles = status.selectedTriangles = 0; status.canUndo = false; edits = []; emit(); },
  };
  const context = vm.createContext({ window: win, AbortController, AbortSignal });
  vm.runInContext(source + '\nthis.createPanel = createMeshEditPanel;', context);
  const panel = context.createPanel({ element: root, getJob: () => job, getViewer: () => ({ meshEditor: engine }),
    request(url, options) { const p = pending(); requests.push({ url, options, body: JSON.parse(options.body), ...p }); return p.promise; },
    async onEnter() { await enterPending?.promise; },
    async onSaved(value) { saved.push(value); if (currentOptions.failDisplay) throw new Error('Texture unavailable'); job = value; panel.render(job, { visible: true, ready: true, busy: false }); },
    async onExit(value) { exits.push(value); }, toast(value) { toasts.push(value); },
  });
  const render = () => panel.render(job, { visible: true, ready: true, busy: false });
  render();
  return { panel, requests, saved, exits, toasts, confirms, configurations, root, win, engine,
    element: (name) => elements.get(name), get enabled() { return enabled; }, get restores() { return restores; },
    get job() { return job; },
    setOptions(value) { currentOptions = { ...currentOptions, ...value }; },
    selectJob(value) { job = value; render(); },
    hide() { panel.render(job, { visible: false, busy: false, ready: true }); },
    async enter() { elements.get('enter').fire(); await tick(); },
    remove() { status.selectedTriangles = 3; emit(); elements.get('delete').fire(); },
  };
}

const passed = [];
{
  const h = harness();
  await h.enter();
  const calls = h.configurations.length;
  for (let i = 0; i < 5; i++) h.selectJob(h.job);
  assert.equal(h.configurations.length, calls, 'Viewer status polling must not call setState and terminate a brush gesture.');
  passed.push('Unchanged viewer status preserves an ongoing brush stroke.');
}
{
  const h = harness();
  await h.enter(); h.remove();
  h.selectJob(freshJob('model-a', 4));
  h.element('save').fire(); await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.expectedRevision, 0, 'Polling cannot rebase old face IDs to a new mesh revision.');
  assert.deepEqual(h.requests[0].body.remove, [{ mesh: 0, primitive: 0, faces: [7, 8, 9] }]);
  h.requests[0].reject(Object.assign(new Error('Conflict'), { status: 409 })); await tick();
  assert.equal(h.panel.isActive, true);
  assert.equal(h.element('deleted').textContent, '3');
  assert.equal(h.element('save').disabled, false);
  assert.match(h.element('error').textContent, /другой вкладке/);
  passed.push('Polling preserves the starting revision, and conflicts preserve the local removal draft.');
}
{
  const wait = pending(), h = harness({ enterPending: wait });
  await h.enter(); assert.equal(h.panel.isActive, true);
  h.selectJob(freshJob('model-b'));
  wait.resolve(); await tick();
  assert.equal(h.panel.isActive, false);
  assert.equal(h.enabled, false);
  assert.equal(h.configurations.length, 0, 'A late source load cannot enable an editor on the next model.');
  passed.push('A pending entry is invalidated on model navigation.');
}
{
  const h = harness();
  await h.enter(); h.remove(); h.element('save').fire(); await tick();
  assert.equal(h.panel.canLeave(), false);
  assert.equal(h.element('delete').disabled, true);
  h.hide();
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.requests[0].resolve({ job: freshJob('model-a', 1) }); await tick();
  assert.equal(h.saved.length, 0, 'Logout or owner visibility loss must invalidate saved-job callbacks.');
  assert.equal(h.panel.isActive, false);
  assert.equal(h.enabled, false);
  passed.push('Auth reset aborts pending requests and ignores late mutation responses.');
}
{
  const h = harness({ failDisplay: true });
  await h.enter(); h.remove(); h.element('save').fire(); await tick();
  h.requests[0].resolve({ job: freshJob('model-a', 1) }); await tick();
  assert.equal(h.panel.isActive, false);
  assert.equal(h.element('retry').hidden, false);
  assert.match(h.element('error').textContent, /Изменения сохранены/);
  assert.equal(h.element('enter').disabled, true);
  h.element('save').fire(); await tick();
  assert.equal(h.requests.length, 1, 'A committed edit cannot be resubmitted after a viewer failure.');
  h.setOptions({ failDisplay: false });
  await h.element('retry').fire(); await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.saved.length, 2);
  assert.equal(h.job.meshEdit.revision, 1);
  assert.equal(h.element('retry').hidden, true);
  passed.push('Saved edits survive renderer failure; retry reopens the result without another write.');
}
{
  const h = harness({ confirm: false });
  await h.enter(); h.remove();
  assert.equal(h.panel.canLeave(), false);
  h.element('cancel').fire(); await tick();
  assert.equal(h.panel.isActive, true);
  assert.equal(h.restores, 0);
  h.setOptions({ confirm: true });
  h.element('cancel').fire(); await tick();
  assert.equal(h.panel.isActive, false);
  assert.equal(h.restores, 1);
  assert.equal(h.requests.length, 0);
  assert.equal(h.exits[0].reason, 'cancelled');
  passed.push('Cancelling restores only the local preview and respects unsaved-edit confirmation.');
}
{
  const h = harness();
  h.selectJob(freshJob('model-a', 3));
  h.element('restore').fire(); await tick();
  assert.equal(h.requests[0].url, '/jobs/model-a/mesh-restore');
  assert.deepEqual(h.requests[0].body, { expectedRevision: 3 });
  h.requests[0].resolve({ job: { ...freshJob('model-a', 4), meshEdit: { edited: false, revision: 4 } } }); await tick();
  assert.equal(h.element('restore').hidden, true);
  assert.equal(h.saved.length, 1);
  passed.push('Restoring the original uses the current revision and removes the restore action.');
}
{
  const h = harness();
  await h.enter();
  h.element('fragment-limit').value = '10001'; h.element('small').fire();
  assert.equal(h.element('selected').textContent, '0');
  assert.match(h.element('error').textContent, /10 000/);
  h.element('fragment-limit').value = '2702'; h.element('small').fire();
  assert.equal(h.element('selected').textContent.replace(/\s/g, ''), '2702');
  h.panel.dispose();
  assert.equal(h.win.listeners.has('beforeunload'), false);
  assert.equal(h.enabled, false);
  passed.push('Fragment input validates bounds; disposal removes navigation hooks and disables interaction.');
}
for (const name of passed) console.log(`PASS ${name}`);
console.log(`${passed.length} mesh editor panel regressions passed.`);
