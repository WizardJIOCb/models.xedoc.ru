import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../apps/studio-web/src/main.js', import.meta.url), 'utf8');
const functions = ['normalizePlacement', 'normalizeModelRotation', 'savedModelRotation', 'placementDraft',
  'queuePlacementSave', 'savePlacement', 'flushModelSettings', 'persistSettingsOnExit', 'getJob', 'artifactUrl', 'hasRig', 'sourceView', 'shareModel'];
const code = functions.map((name) => {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert(match, `Missing production function: ${name}`);
  return match[0];
}).join('\n');
const zero = () => ({ x: 0, y: 0, z: 0 });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const clone = (value) => JSON.parse(JSON.stringify(value));
const settingsClientId = '6f5f05eb-59ad-4a5e-a7a6-39cb112fa1d7';

function harness() {
  const job = { id: 'job-a', status: 'complete', placement: zero(), modelRotation: zero(),
    rig: { available: true, appliedRotation: zero() }, artifacts: { modelUrl: '/a.glb', riggedUrl: '/rig-a.glb' },
    updatedAt: '2026-09-07T01:00:00Z' };
  const state = { jobs: [job], selectedId: job.id, selectedMotion: 'base', rigEditingId: null,
    placementDrafts: new Map(), deletedIds: new Set(), sharing: false };
  const requests = [], notices = [], elements = new Map(), timers = new Map();
  let timerId = 0;
  const context = vm.createContext({ state, isShared: false, isPlayground: true, sharedJobId: null, settingsClientId, URL,
    location: { origin: 'https://example.test' },
    $: (id) => { if (!elements.has(id)) elements.set(id, { shown: false, showModal() { this.shown = true; } }); return elements.get(id); },
    request(url, options = {}) { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
      requests.push({ url, options, resolve, reject }); return promise; },
    renderPlacement() {}, setError() {}, async saveEnvironmentPanel() {}, toast(message) { notices.push(message); },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(code, context);
  const draft = context.placementDraft(job);
  const edit = (rotation, x = 0) => { draft.rotation = { ...zero(), ...rotation }; draft.position = { x, y: 0, z: 0 };
    draft.version++; draft.dirty = true; draft.error = null; };
  const respond = (index, timestamp = '2026-09-07T01:01:00Z') => {
    const { position, rotation } = JSON.parse(requests[index].options.body);
    requests[index].resolve({ placement: position, modelRotation: rotation, updatedAt: timestamp });
  };
  return { context, job, state, requests, notices, elements, timers, draft, edit, respond };
}

const tests = [];
{
  const h = harness();
  let finishEnvironment;
  h.context.saveEnvironmentPanel = () => new Promise((resolve) => { finishEnvironment = resolve; });
  const sharing = h.context.shareModel();
  await tick();
  assert.equal(h.requests.length, 0, 'Share must wait until uploaded environment settings are saved');
  finishEnvironment();
  await tick();
  assert.equal(h.requests.length, 1);
  assert(h.requests[0].url.endsWith('/share'));
  h.requests[0].resolve({ url: '/playground?share=opaque' });
  await sharing;
  assert.equal(h.elements.get('share-dialog').shown, true);
  tests.push({ case: 'share_waits_for_environment_save', passed: true });
}
{
  const h = harness();
  h.context.saveEnvironmentPanel = async () => { throw new Error('Environment conflict'); };
  await h.context.shareModel();
  assert.equal(h.requests.length, 0, 'An unsaved environment must not produce a share link');
  assert(h.notices.includes('Environment conflict'));
  assert.equal(h.state.sharing, false);
  assert.notEqual(h.elements.get('share-dialog')?.shown, true);
  tests.push({ case: 'environment_save_failure_blocks_share', passed: true });
}
{
  const h = harness();
  h.edit({ x: -17 }, .2);
  const first = h.context.savePlacement(h.job.id);
  h.edit({ x: -22 }, .7);
  const sharing = h.context.shareModel();
  await tick();
  assert.equal(h.requests.length, 1, 'Share must wait for in-flight save');
  h.respond(0);
  await first; await tick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(h.requests[1].options.body), { position: { x: .7, y: 0, z: 0 }, rotation: { x: -22, y: 0, z: 0 },
    write: { clientId: settingsClientId, revision: 2 } });
  assert.equal(h.requests[0].options.keepalive, true);
  assert.equal(h.requests[1].options.keepalive, true);
  h.respond(1, '2026-09-07T01:02:00Z');
  await tick();
  assert.equal(h.requests.length, 3);
  assert(h.requests[2].url.endsWith('/share'));
  h.requests[2].resolve({ url: '/playground?share=opaque' });
  await sharing;
  assert.equal(h.draft.dirty, false);
  assert.equal(h.elements.get('share-dialog').shown, true);
  assert.equal(h.draft.pending, null);
  assert.equal(h.timers.size, 0, 'Flush clears the deferred second-save timer');
  tests.push({ case: 'share_waits_for_inflight_and_newer_edits', passed: true });
}
{
  const h = harness();
  h.edit({ y: 25 });
  const sharing = h.context.shareModel();
  await tick();
  h.requests[0].reject(new Error('Disk full'));
  await sharing;
  assert.equal(h.requests.length, 1, 'Failed save must not create a share');
  assert.equal(h.draft.dirty, true);
  assert.equal(h.draft.saving, false);
  assert.equal(h.draft.pending, null);
  assert(h.notices.some((message) => message.includes('Disk full')));
  assert.notEqual(h.elements.get('share-dialog')?.shown, true);
  const retry = h.context.flushModelSettings(h.job.id);
  h.respond(1);
  await retry;
  assert.equal(h.draft.dirty, false);
  tests.push({ case: 'failed_save_blocks_share_and_retry_recovers', passed: true });
}
{
  const h = harness();
  h.edit({ z: 45 });
  const saving = h.context.savePlacement(h.job.id);
  h.respond(0);
  await saving;
  const stale = { ...h.job, updatedAt: '2026-09-07T01:00:00Z', placement: zero(), modelRotation: zero() };
  assert.equal(h.context.placementDraft(stale).rotation.z, 45);
  assert.equal(h.context.sourceView(stale), true);
  const baked = { ...h.job, rig: { available: true, appliedRotation: { x: 0, y: 0, z: 45 } } };
  assert.equal(h.context.sourceView(baked), false);
  tests.push({ case: 'stale_poll_does_not_reset_draft_and_baked_rotation_is_not_doubled', passed: true });
}
{
  const h = harness();
  h.edit({ x: 10 });
  const first = h.context.savePlacement(h.job.id);
  h.edit({ x: 20 });
  h.context.persistSettingsOnExit();
  await tick();
  assert.equal(h.requests.length, 2, 'Exit must send the latest snapshot independently of an in-flight save');
  const firstBody = JSON.parse(h.requests[0].options.body);
  const exitBody = JSON.parse(h.requests[1].options.body);
  assert.equal(h.requests[0].options.keepalive, true);
  assert.equal(h.requests[1].options.keepalive, true);
  assert.deepEqual(firstBody.write, { clientId: settingsClientId, revision: 1 });
  assert.deepEqual(exitBody.write, { clientId: settingsClientId, revision: 2 });
  assert.equal(exitBody.rotation.x, 20);
  assert.equal(h.draft.saving, true, 'Exit transport must not change the active save state');
  assert.equal(h.draft.dirty, true);
  assert(h.draft.pending, 'Existing save promise must remain intact');

  // Model the independently API-tested server contract: per-client high-water
  // marks reject older/equal revisions. Deliver the exit request first.
  let acceptedRevision = -1, persisted;
  const deliver = (index) => {
    const body = JSON.parse(h.requests[index].options.body);
    if (body.write.revision > acceptedRevision) {
      acceptedRevision = body.write.revision;
      persisted = { placement: body.position, modelRotation: body.rotation, updatedAt: '2026-09-07T01:02:00Z' };
    }
    h.requests[index].resolve(clone(persisted));
  };
  deliver(1); deliver(0);
  await first;
  assert.equal(persisted.modelRotation.x, 20, 'Late autosave cannot replace exit snapshot');
  assert.equal(acceptedRevision, 2);
  assert.equal(h.draft.rotation.x, 20, 'Late response must not reset current local edits');
  tests.push({ case: 'pagehide_sends_latest_keepalive_revision_and_out_of_order_contract_preserves_it', passed: true });
}
{
  const h = harness();
  h.context.persistSettingsOnExit();
  assert.equal(h.requests.length, 0, 'Clean settings must not produce exit writes');
  h.edit({ y: 15 });
  h.state.deletedIds.add(h.job.id);
  h.context.persistSettingsOnExit();
  assert.equal(h.requests.length, 0, 'Deleted jobs must not be resurrected on exit');
  h.state.deletedIds.clear();
  h.context.isShared = true;
  h.context.persistSettingsOnExit();
  assert.equal(h.requests.length, 0, 'Shared view must stay read-only');
  tests.push({ case: 'exit_skips_clean_deleted_and_shared_settings', passed: true });
}
const report = { passed: tests.every((test) => test.passed), tests };
console.log(JSON.stringify(report, null, 2));
