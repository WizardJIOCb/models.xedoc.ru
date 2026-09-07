import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../apps/studio-web/src/main.js', import.meta.url), 'utf8');
const names = ['loadSelectedViewer', 'enterMeshCleanup', 'receiveCleanedModel', 'leaveMeshCleanup', 'selectJob', 'preserveNewerJob', 'request'];
const extracted = names.map((name) => {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert(match, `Missing production function ${name}`);
  return match[0];
}).join('\n');
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const pending = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const zero = { x: 0, y: 0, z: 0 };
const jobFixture = (revision = 0) => ({ id: 'job-a', status: 'complete', previewUrl: '/preview.webp', placement: { ...zero }, modelRotation: { x: -10, y: 0, z: 0 },
  artifacts: { modelUrl: `/model.glb?r=${revision}`, riggedUrl: '/rigged.glb' }, rig: { available: true }, meshEdit: { revision } });

function harness() {
  const state = { jobs: [jobFixture()], selectedId: 'job-a', selectedMotion: 'walk', rigEditingId: null, authRevision: 0,
    meshEditingId: null, meshEntryPending: false, meshReturnView: null, viewerState: { ready: true }, viewerRequest: 0, viewerKey: '',
    previewUploads: new Set(), rigDrafts: new Map(), demo: false };
  const elements = new Map(), events = [], loads = [], previews = [], storage = [], history = [];
  const settings = pending(), manual = pending();
  let manualEnabled = true;
  const viewer = {
    async load(url, options) { loads.push({ url, options }); state.viewerState = { ready: true }; },
    setPosition(value) { events.push(['position', value]); },
    setOrientation(value) { events.push(['rotation', value]); },
    setEnvironment(value) { events.push(['environment', value]); return Promise.resolve(); },
    setManualRig(value) { manualEnabled = value.enabled; events.push(['manual', manualEnabled]); },
    setSlow() {}, setDebug() {}, frontView() {},
  };
  state.viewer = viewer;
  const getJob = () => state.jobs.find((job) => job.id === state.selectedId);
  const editingMesh = (job = getJob()) => Boolean(job && state.meshEditingId === job.id);
  const panel = { isActive: false, leaveAllowed: true, canLeave() { return this.leaveAllowed; }, reset() { events.push(['panel-reset']); this.isActive = false; } };
  const context = vm.createContext({ state, API: '/api/model-studio', URLSearchParams, AbortSignal, isShared: false, isPlayground: true,
    publicModelId: null, shareToken: null, meshEditPanel: panel, getJob, editingMesh,
    localStorage: { setItem(...args) { storage.push(args); } }, history: { replaceState(...args) { history.push(args); } },
    $: (id) => { if (!elements.has(id)) elements.set(id, { hidden: false, textContent: '', setAttribute() {} }); return elements.get(id); },
    getEnvironmentPreview: () => null, rigBusy: () => false,
    sourceView: (job) => editingMesh(job) || !job?.artifacts?.riggedUrl,
    preparingRig: (job) => !editingMesh(job) && Boolean(job && !job.artifacts.riggedUrl),
    placementDraft: (job) => job ? { position: job.placement, rotation: job.modelRotation } : null,
    selectedUrl: (job) => editingMesh(job) ? job.artifacts.modelUrl : job?.artifacts?.riggedUrl || job?.artifacts?.modelUrl,
    hasRig: (job) => Boolean(job?.artifacts?.riggedUrl), ensureViewer: async () => viewer,
    flushModelSettings: async () => { events.push(['settings']); await settings.promise; },
    manualRigPanel: { async flush() { events.push(['manual-save']); await manual.promise; }, render(value) { events.push(['manual-render', value]); }, forget(id) { events.push(['manual-forget', id]); } },
    renderMeshCleanup() {}, renderPlacement() {}, renderJobs() {}, toast() {},
    renderRigPreparation() { if (!editingMesh()) { manualEnabled = true; events.push(['manual-reopen']); } },
    async saveModelPreview(job) { previews.push({ id: job.id, manualEnabled }); },
    fetch: async () => ({ ok: false, status: 409, headers: { get: () => 'application/json' }, json: async () => ({ error: 'Revision conflict' }) }),
  });
  vm.runInContext(extracted, context);
  context.renderSelection = () => { void context.loadSelectedViewer(); };
  context.receiveOwnerJob = (job) => { state.jobs = [job]; context.renderSelection(); };
  return { state, context, loads, events, previews, storage, history, settings, manual, panel, getJob };
}

const passed = [];
{
  const h = harness();
  const current = { ...jobFixture(3), updatedAt: '2026-09-07T11:00:00Z' };
  h.state.jobs = [current];
  assert.equal(h.context.preserveNewerJob({ ...jobFixture(2), updatedAt: '2026-09-07T12:00:00Z' }), current);
  const newer = { ...jobFixture(4), updatedAt: '2026-09-07T10:00:00Z' };
  assert.equal(h.context.preserveNewerJob(newer), newer, 'Mesh revision wins over timestamp ordering.');
  assert.equal(h.context.preserveNewerJob({ ...jobFixture(3), updatedAt: '2026-09-07T10:00:00Z' }), current);
  passed.push('A late library response cannot revive old mesh, rig or motion artifacts after cleanup.');
}
{
  const h = harness();
  h.state.meshEditingId = 'job-a';
  h.state.jobs = [jobFixture(9)];
  await h.context.loadSelectedViewer();
  assert.equal(h.loads.length, 0);
  assert.equal(h.events.length, 0, 'Polling cannot reapply orientation, position or the new mesh during cleanup.');
  passed.push('Polling preserves the exact mesh and transform being edited.');
}
{
  const h = harness();
  const entry = h.context.enterMeshCleanup(); await tick();
  assert.equal(h.state.meshEditingId, 'job-a');
  assert.equal(h.loads.length, 0);
  assert.equal(h.events.some(([name]) => name === 'manual-save'), false);
  h.settings.resolve(); await tick();
  assert.equal(h.events.some(([name]) => name === 'manual-save'), true);
  assert.equal(h.loads.length, 0);
  h.manual.resolve(); await entry;
  assert.equal(h.loads.length, 1);
  assert.equal(h.loads[0].url, '/model.glb?r=0');
  assert.equal(h.loads[0].options.prepare, true);
  assert.equal(h.loads[0].options.allowRagdoll, false);
  assert.equal(h.state.meshEntryPending, false);
  assert.equal(h.previews.length, 0);
  passed.push('Entry flushes transforms and landmarks before one static, physics-free source load.');
}
{
  const h = harness();
  const entry = h.context.enterMeshCleanup(); await tick();
  h.state.authRevision++;
  h.state.selectedId = null;
  h.settings.resolve(); await entry;
  assert.equal(h.loads.length, 0);
  assert.equal(h.events.some(([name]) => name === 'manual-save'), false);
  passed.push('Authentication changes invalidate entry before any later save or source load.');
}
{
  const h = harness();
  h.state.meshEditingId = 'job-a';
  const saved = jobFixture(1); delete saved.artifacts.riggedUrl;
  await h.context.receiveCleanedModel(saved);
  assert.equal(h.loads.length, 1, 'Payload repaint must not race a second load with the explicit saved-model load.');
  assert.equal(h.loads[0].url, '/model.glb?r=1');
  assert.equal(h.state.selectedMotion, 'base');
  assert.equal(h.state.meshEditingId, null);
  assert.equal(h.state.meshEntryPending, false);
  assert.deepEqual(h.previews, [{ id: 'job-a', manualEnabled: false }]);
  assert.equal(h.events.some(([name, id]) => name === 'manual-forget' && id === 'job-a'), true);
  assert.equal(h.history[0][2], '/playground?job=job-a');
  passed.push('Save reloads the revised source once and captures its card without skeleton landmarks.');
}
{
  const h = harness();
  h.panel.isActive = true; h.panel.leaveAllowed = false;
  h.state.meshEditingId = 'job-a';
  assert.equal(h.context.selectJob('job-b'), false);
  assert.equal(h.state.selectedId, 'job-a');
  assert.equal(h.storage.length, 0);
  assert.equal(h.history.length, 0);
  h.panel.leaveAllowed = true;
  assert.equal(h.context.selectJob('job-b'), true);
  assert.equal(h.state.meshEditingId, null);
  assert.equal(h.state.selectedId, 'job-b');
  passed.push('Rejected unsaved-draft navigation leaves selection and URL untouched.');
}
{
  const h = harness();
  await assert.rejects(h.context.request('/jobs/job-a/mesh-edit', { method: 'POST' }), (error) => error.status === 409);
  passed.push('HTTP errors retain status for revision conflict recovery.');
}
for (const name of passed) console.log(`PASS ${name}`);
console.log(`${passed.length} mesh editor integration regressions passed.`);
