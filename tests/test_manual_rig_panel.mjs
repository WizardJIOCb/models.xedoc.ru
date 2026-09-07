import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

// Execute the complete production controller. CSS has no behavior in these
// request/state tests; a small DOM supplies only its controls and event targets.
const source = (await readFile(new URL('../apps/studio-web/src/manual-rig-panel.js', import.meta.url), 'utf8'))
  .replace(/^import '\.\/manual-rig\.css';\r?\n/m, '').replace(/^export /gm, '');
const copy = (value) => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.listeners = new Map();
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.validity = { valid: true };
    this.options = Array.from({ length: 18 }, () => ({ textContent: '' }));
    this.attributes = new Map();
    this.classList = { toggle() {} };
  }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(handler);
  }
  fire(name) { for (const handler of this.listeners.get(name) || []) handler({ target: this }); }
  setAttribute(name, value) { this.attributes.set(name, value); }
}

function harness(initialJob) {
  let job = initialJob || { id: 'model-a', modelRotation: { x: -10, y: 0, z: 0 }, rig: {} };
  const elements = new Map(), timers = new Map(), requests = [], stored = new Map(), watermarks = new Map();
  let timerId = 0, panel, viewerState;
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const methods = ['auto', 'manual'].map((rigMethod) => new Element({ rigMethod }));
  const views = ['front', 'left', 'right', 'back'].map((manualView) => new Element({ manualView }));
  const coordinates = ['x', 'y', 'z'].map((axis) => {
    const field = element(`manual-${axis}`); field.dataset.manualCoordinate = axis; return field;
  });
  const jointButtons = new Map();
  const doc = new Element();
  doc.activeElement = null;
  doc.visibilityState = 'visible';
  doc.getElementById = element;
  doc.querySelector = (selector) => selector === '.playground-layout' ? element('layout')
    : jointButtons.get(selector.match(/data-manual-joint="([^"]+)"/)?.[1]);
  doc.querySelectorAll = (selector) => ({ '[data-rig-method]': methods, '[data-manual-view]': views,
    '[data-manual-coordinate]': coordinates, '[data-manual-joint]': [...jointButtons.values()] })[selector] || [];
  const win = new Element();
  const context = vm.createContext({ document: doc, window: win, structuredClone, performance,
    crypto: { randomUUID }, setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(source + '\nthis.createPanel = createManualRigPanel; this.joints = MANUAL_JOINTS;', context);
  for (const [id] of context.joints) jointButtons.set(id, new Element({ manualJoint: id }));
  function render() { panel?.render(job, { editing: true, ready: true, busy: false }); }
  panel = context.createPanel({ getJob: () => job, getRotation: (current) => current.modelRotation,
    getViewer: () => ({ setManualRig(value) { viewerState = value; }, manualView() {} }),
    repaint: render, restoreRotation(rotation) { job.modelRotation = rotation; render(); },
    request(url, options) {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      requests.push({ url, options, body: JSON.parse(options.body), done: false,
        respond() {
          if (this.done) return;
          this.done = true;
          const id = url.match(/\/jobs\/([^/]+)\//)[1], { rotation, manual, write } = this.body;
          const key = `${id}:${write.clientId}`;
          // Same observable stale-write behavior as the backend API.
          if (write.revision > (watermarks.get(key) ?? -1)) {
            watermarks.set(key, write.revision);
            stored.set(id, { rotation: copy(rotation), manual: copy(manual) });
          }
          resolve({ manualRigDraft: copy(stored.get(id)) });
        } });
      return promise;
    },
  });
  render();
  return { panel, requests, stored, doc, win, elements, timers, element,
    get job() { return job; },
    selectJob(value) { job = value; render(); },
    mode(value) { methods.find((button) => button.dataset.rigMethod === value).fire('click'); },
    place(points) { viewerState.onChange(copy(points)); },
    async settle() { for (let i = 0; i < 5; i++) { requests.filter((row) => !row.done).forEach((row) => row.respond()); await tick(); } },
  };
}

const passed = [];
function mirroredFixture() {
  const points = { head: [0, 1.85, .03], neck: [0, 1.67, 0] };
  for (const [side, sign] of [['l', -1], ['r', 1]]) {
    for (const [part, position] of Object.entries({ shoulder: [.24, 1.58, 0], elbow: [.43, 1.27, .02],
      wrist: [-.08, 1.08, .12], hand: [-.12, 1.04, .13], hip: [.14, .99, 0], knee: [.2, .56, .02],
      ankle: [.22, .14, 0], toe: [.23, .06, .18] })) points[`${part}_${side}`] = [position[0] * sign, position[1], position[2] + (side === 'l' ? .015 : 0)];
  }
  return { version: 1, points };
}
{
  const manual = mirroredFixture(), original = copy(manual);
  const job = { id: 'mirrored', modelRotation: { x: -11, y: 0, z: 0 }, rig: {},
    manualRigDraft: { manual, rotation: { x: -11, y: 0, z: 0 } } };
  const h = harness(job);
  h.element('manual-joint').value = 'toe_r'; h.element('manual-joint').fire('change');
  h.element('manual-reviewed').checked = true; h.element('manual-reviewed').fire('change');
  const corrected = copy(h.panel.payload(job));
  for (const part of ['shoulder', 'elbow', 'wrist', 'hand', 'hip', 'knee', 'ankle', 'toe']) {
    assert.deepEqual(corrected.points[`${part}_l`], original.points[`${part}_r`]);
    assert.deepEqual(corrected.points[`${part}_r`], original.points[`${part}_l`]);
  }
  assert.deepEqual(corrected.points.head, original.points.head);
  assert.deepEqual(corrected.points.neck, original.points.neck);
  assert.deepEqual(manual, original, 'saved job input must not mutate');
  assert.equal(h.element('manual-joint').value, 'toe_l', 'selected marker stays at the same physical foot');
  assert.equal(h.element('manual-reviewed').checked, true, 'coordinate review remains valid');
  assert.equal(h.element('manual-side-correction').hidden, false);
  const saving = h.panel.flush(job); await h.settle(); await saving;
  assert.deepEqual(h.stored.get(job.id).manual, corrected);
  assert.equal(h.panel.prepare(job), false, 'pre-submit normalization must be idempotent');
  const reopened = harness({ ...job, manualRigDraft: copy(h.stored.get(job.id)) });
  assert.deepEqual(copy(reopened.panel.payload(job)), corrected);
  h.element('manual-undo').fire('click');
  assert.deepEqual(copy(h.panel.payload(job)), original);
  assert.equal(h.element('manual-joint').value, 'toe_r');
  assert.equal(h.element('manual-reviewed').checked, false);
  assert.equal(h.element('manual-side-correction').hidden, true);
  passed.push('review corrects whole mirrored chains, saves, reopens and undoes without moving points');
}
{
  const cases = [];
  const mixed = mirroredFixture(); [mixed.points.hip_l, mixed.points.hip_r] = [mixed.points.hip_r, mixed.points.hip_l]; cases.push(mixed);
  const partial = mirroredFixture(); delete partial.points.hand_r; cases.push(partial);
  const ambiguous = mirroredFixture(); ambiguous.points.shoulder_l[0] = ambiguous.points.shoulder_r[0] - .01; cases.push(ambiguous);
  for (const manual of cases) {
    const h = harness({ id: 'unchanged', modelRotation: { x: 0, y: 0, z: 0 }, rig: {}, manualRigDraft: { manual, rotation: { x: 0, y: 0, z: 0 } } });
    assert.equal(h.panel.prepare(h.job), false);
    assert.deepEqual(copy(h.panel.payload(h.job)), manual);
    assert.equal(h.requests.length, 0);
  }
  const manual = mirroredFixture();
  const h = harness({ id: 'stale', modelRotation: { x: 10, y: 0, z: 0 }, rig: {}, manualRigDraft: { manual, rotation: { x: 0, y: 0, z: 0 } } });
  assert.equal(h.panel.prepare(h.job), false);
  assert.deepEqual(copy(h.panel.payload(h.job)), manual);
  passed.push('partial, mixed, ambiguous and rotated drafts are not silently relabelled');
}
{
  const manual = mirroredFixture();
  const h = harness(); h.mode('manual'); h.place(manual.points);
  const oldSave = h.panel.flush(h.job);
  assert.equal(h.requests.length, 1);
  h.panel.prepare(h.job);
  const corrected = copy(h.panel.payload(h.job));
  const finalSave = h.panel.flush(h.job);
  await h.settle(); await Promise.all([oldSave, finalSave]);
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests[1].body.write.revision > h.requests[0].body.write.revision);
  assert.deepEqual(h.stored.get(h.job.id).manual, corrected);
  assert.deepEqual(h.requests[1].body.manual, corrected, 'final PUT matches the rig payload');
  passed.push('pre-submit flush waits for old draft then persists corrected revision');
}
{
  const h = harness();
  h.mode('manual');
  h.place({ head: [0, 1.85, 0] });
  h.place({ head: [0, 1.85, 0], neck: [0, 1.65, 0] });
  let saving = h.panel.flush(h.job);
  await h.settle(); await saving;
  const previousClient = h.requests[0].body.write.clientId;
  // An auth transition in the same page recreates the draft but the server
  // retains its write watermark. The first new edit must actually persist.
  h.panel.reset();
  h.selectJob({ ...h.job, manualRigDraft: copy(h.stored.get(h.job.id)) });
  h.place({ head: [.1, 1.9, .02], neck: [0, 1.65, 0] });
  saving = h.panel.flush(h.job);
  await h.settle(); await saving;
  assert.notEqual(h.requests.at(-1).body.write.clientId, previousClient);
  assert.deepEqual(h.stored.get(h.job.id).manual.points.head, [.1, 1.9, .02]);
  assert.equal(h.element('manual-save-status').textContent, 'Черновик сохранён');
  passed.push('first edit after auth reset persists despite earlier revision watermark');
}
{
  const h = harness();
  h.mode('manual');
  h.place({ head: [0, 1.85, 0] });
  const olderSave = h.panel.flush(h.job);
  assert.equal(h.requests.length, 1);
  h.place({ head: [.02, 1.87, 0], neck: [0, 1.65, .01] });
  h.win.fire('pagehide');
  assert.equal(h.requests.length, 2, 'newest snapshot must leave before the older request resolves');
  const [older, newest] = h.requests;
  assert.equal(newest.options.keepalive, true);
  assert.equal(newest.options.method, 'PUT');
  assert.equal(newest.body.write.clientId, older.body.write.clientId);
  assert.ok(newest.body.write.revision > older.body.write.revision);
  assert.deepEqual(newest.body.manual.points.neck, [0, 1.65, .01]);
  // A slow first PUT must not overwrite the exit snapshot if it arrives last.
  newest.respond(); older.respond();
  await h.settle(); await olderSave;
  assert.deepEqual(h.stored.get(h.job.id).manual.points, newest.body.manual.points);
  passed.push('unload dispatches newest snapshot independently and reordered writes preserve it');
}
{
  const h = harness();
  h.mode('manual');
  h.place({ head: [0, 1.85, 0] });
  h.element('manual-joint').value = 'head';
  h.element('manual-joint').fire('change');
  assert.equal(h.element('manual-coordinates').hidden, false);
  const input = h.element('manual-x');
  input.value = '4'; input.validity.valid = false;
  h.doc.activeElement = input;
  input.fire('input');
  assert.equal(h.element('manual-point-fields').disabled, false);
  h.mode('auto');
  assert.equal(h.element('manual-rig-panel').hidden, true);
  assert.equal(h.element('manual-point-fields').disabled, true,
    'hidden invalid manual inputs must be excluded from automatic form validation');
  h.mode('manual');
  assert.equal(h.element('manual-point-fields').disabled, false, 'returning to manual restores editing');
  passed.push('hidden manual fields cannot block automatic form submission');
}
{
  const h = harness();
  h.mode('manual');
  h.place({ head: [0, 1.85, 0] });
  const first = h.job;
  h.selectJob({ id: 'model-b', modelRotation: { x: 20, y: 0, z: 0 }, rig: {} });
  h.mode('manual');
  h.place({ head: [.2, 1.8, .1] });
  h.doc.visibilityState = 'hidden';
  h.doc.fire('visibilitychange');
  assert.equal(h.requests.length, 2);
  await h.settle();
  assert.deepEqual(h.stored.get(first.id).manual.points.head, [0, 1.85, 0]);
  assert.deepEqual(h.stored.get('model-b').manual.points.head, [.2, 1.8, .1]);
  assert.equal(h.stored.get(first.id).rotation.x, -10);
  assert.equal(h.stored.get('model-b').rotation.x, 20);
  const reopened = harness({ ...first, manualRigDraft: copy(h.stored.get(first.id)) });
  assert.equal(reopened.panel.manual(reopened.job), true);
  assert.deepEqual(copy(reopened.panel.payload(reopened.job).points), h.stored.get(first.id).manual.points);
  passed.push('model switching keeps pending drafts isolated and saved points reopen');
}

console.log(JSON.stringify({ passed: passed.length, cases: passed }, null, 2));
