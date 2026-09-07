import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../apps/studio-web/src/main.js', import.meta.url), 'utf8');
const declaration = (name) => {
  const first = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*`, 'm'));
  assert(first, `Missing production function: ${name}`);
  if (first[0].endsWith('}')) return first[0];
  const block = source.slice(first.index).match(/^[^]*?^}/m);
  assert(block, `Unterminated production function: ${name}`);
  return block[0];
};
const authHandler = source.match(/^window\.addEventListener\('community:auth-changed', \(\) => \{[^]*?^\}\);/m);
assert(authHandler, 'Missing production authentication change handler');
const code = ['getJob', 'renderSharedOwnerAccess', 'poll'].map(declaration).join('\n') + '\n' + authHandler[0];
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function harness({ shared = true, token = false, motion = null } = {}) {
  const job = { id: 'model-a', status: 'complete', motions: [] };
  const state = { jobs: [], selectedId: null, selectedMotion: motion, sharedCanEdit: false,
    authRevision: 0, polling: false, jobsTime: 0 };
  const elements = new Map(), requests = [], errors = new Map(), events = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: true, removeAttribute(name) { delete this[name]; } });
    return elements.get(id);
  };
  const context = vm.createContext({ state, URLSearchParams, isShared: shared,
    publicModelId: token ? null : job.id, shareToken: token ? 'opaque-token' : null,
    document: { hidden: false }, performance: { now: () => 100 }, $: element,
    rigBusy: () => false, refreshHealth() {}, refreshMotionLibrary() {},
    setError(id, message) { errors.set(id, message); },
    renderSelection() { context.renderSharedOwnerAccess(); },
    window: { addEventListener(name, callback) { events.set(name, callback); } },
    request(url) {
      let resolve, reject;
      const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ url, resolve, reject });
      return pending;
    },
  });
  vm.runInContext(code, context);
  context.renderSharedOwnerAccess();
  const assertHidden = () => {
    assert.equal(element('shared-owner-controls').hidden, true);
    assert.equal(element('edit-owned-model').href, undefined, 'Hidden owner entry must lose its old href');
  };
  const respond = (index, canEdit, responseJob = job) => requests[index].resolve({ job: responseJob, canEdit });
  return { context, state, job, requests, errors, element, assertHidden, respond,
    authChanged: () => events.get('community:auth-changed')() };
}

const tests = [];
{
  for (const permission of [undefined, null, false, 0, 1, 'true', {}, []]) {
    const h = harness();
    const polling = h.context.poll(true);
    h.respond(0, permission);
    await polling;
    h.assertHidden();
    assert.equal(h.element('shared-note').hidden, false);
  }
  const h = harness();
  const polling = h.context.poll(true);
  h.respond(0, true);
  await polling;
  assert.equal(h.element('shared-owner-controls').hidden, false);
  assert.equal(h.element('shared-note').hidden, true);
  assert.equal(h.element('edit-owned-model').href, '/playground?job=model-a');
  h.state.jobs = [];
  h.context.renderSharedOwnerAccess();
  h.assertHidden();
  tests.push({ case: 'only_explicit_server_permission_and_loaded_model_show_edit_entry', passed: true });
}
{
  for (const motion of ['motion & special=1', 'base']) {
    const h = harness({ token: true, motion });
    const polling = h.context.poll(true);
    assert.equal(h.requests[0].url, '/shares/opaque-token');
    h.respond(0, true);
    await polling;
    const href = new URL(h.element('edit-owned-model').href, 'https://example.test');
    assert.equal(href.pathname, '/playground');
    assert.equal(href.searchParams.get('job'), h.job.id);
    assert.equal(href.searchParams.get('motion'), motion);
    assert.equal(href.searchParams.has('share'), false);
    assert.equal(href.searchParams.has('model'), false);
  }
  tests.push({ case: 'shared_links_enter_owner_editor_and_preserve_selected_motion_including_base', passed: true });
}
{
  const h = harness();
  const first = h.context.poll(true);
  h.respond(0, true);
  await first;
  const second = h.context.poll(true);
  h.requests[1].reject(new Error('Model no longer available'));
  await second;
  h.assertHidden();
  assert.equal(h.state.sharedCanEdit, false);
  assert.equal(h.state.jobs.length, 0);
  assert.equal(h.errors.get('shared-error'), 'Model no longer available');
  tests.push({ case: 'failed_refresh_removes_previous_owner_entry', passed: true });
}
{
  const h = harness();
  const stale = h.context.poll(true);
  h.authChanged();
  assert.equal(h.state.authRevision, 1);
  h.assertHidden();
  assert.equal(h.requests.length, 1, 'Auth event must not duplicate an in-flight request');
  h.respond(0, true);
  await stale;
  await tick();
  h.assertHidden();
  assert.equal(h.state.jobs.length, 0, 'Stale authenticated payload must be ignored');
  assert.equal(h.requests.length, 2, 'Stale response must trigger a new request for current authentication');
  h.respond(1, false);
  await tick();
  h.assertHidden();
  assert.equal(h.state.polling, false);
  tests.push({ case: 'late_owner_response_after_logout_cannot_restore_edit_entry', passed: true });
}
{
  const h = harness();
  const stale = h.context.poll(true);
  h.authChanged();
  h.requests[0].reject(new Error('Stale visitor error'));
  await stale;
  await tick();
  assert.equal(h.errors.has('shared-error'), false, 'Stale failure must not replace the current page state');
  assert.equal(h.requests.length, 2);
  h.respond(1, true);
  await tick();
  assert.equal(h.element('shared-owner-controls').hidden, false);
  h.authChanged();
  h.assertHidden();
  assert.equal(h.requests.length, 3);
  h.respond(2, false);
  await tick();
  h.assertHidden();
  tests.push({ case: 'login_refreshes_entry_and_logout_hides_it_immediately', passed: true });
}
console.log(JSON.stringify({ tests }, null, 2));
