import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelFileLoader } from '../apps/studio-web/src/model-file-cache.js';

const origin = 'https://models.example';
const url = `${origin}/api/model-studio/files/model-a/model.glb`;
function glb(mark = 0) {
  const buffer = new ArrayBuffer(24), view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, 24, true);
  view.setUint32(20, mark, true); return buffer;
}
function fixture(options = {}) {
  const entries = new Map(), calls = [];
  const cache = {
    async match(key) { return entries.get(typeof key === 'string' ? key : key.url)?.clone(); },
    async put(key, response) { entries.set(key, response.clone()); },
    async keys() { return [...entries.keys()].map(key => new Request(key)); },
    async delete(key) { return entries.delete(typeof key === 'string' ? key : key.url); },
  };
  const data = { version: 1, status: 200, fail: false, policy: 'private, no-cache' };
  const fetchImpl = async (key, init) => {
    calls.push({ key, init });
    if (data.fail) throw new TypeError('offline');
    if (data.status !== 200) return new Response(null, { status: data.status });
    const etag = `"v${data.version}"`;
    if (init.headers?.['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    return new Response(glb(data.version), { headers: { 'ETag': etag, 'Content-Length': '24', 'Cache-Control': data.policy } });
  };
  const config = { origin, storage: { async open() { return cache; } }, fetchImpl, ...options };
  return { entries, calls, data, cache, loader: createModelFileLoader(config), reopen: () => createModelFileLoader(config) };
}

test('page reload reuses binary after authenticated ETag check, without redownloading it', async () => {
  const f = fixture();
  const first = await f.loader.load(url), phases = [];
  const second = await f.reopen().load(url, p => phases.push(p.phase));
  assert.deepEqual(first, second);
  assert.equal(f.calls[1].init.headers['If-None-Match'], '"v1"');
  assert.equal(f.calls[1].init.credentials, 'same-origin');
  assert.deepEqual(phases, ['checking', 'cached']);
});
test('new model version replaces cached geometry', async () => {
  const f = fixture(); await f.loader.load(url); f.data.version = 2;
  assert.equal(new DataView(await f.loader.load(url)).getUint32(20, true), 2);
  assert.equal(f.entries.get(url).headers.get('ETag'), '"v2"');
});
test('logout, revoked share and private model cannot fall back to cached contents', async () => {
  for (const status of [401, 403, 404, 410]) {
    const f = fixture(); await f.loader.load(url); f.data.status = status;
    await assert.rejects(f.loader.load(url), /Модель недоступна/);
    assert.equal(f.entries.size, 0);
  }
});
test('offline or server failure never bypasses revalidation', async () => {
  const f = fixture(); await f.loader.load(url); f.data.fail = true;
  await assert.rejects(f.loader.load(url), /offline/);
  f.data.fail = false; f.data.status = 503;
  await assert.rejects(f.loader.load(url), /503/);
});
test('cache quota and blocked storage degrade to ordinary downloads', async () => {
  const f = fixture(); f.cache.put = async () => { throw new Error('QuotaExceeded'); };
  assert.equal((await f.loader.load(url)).byteLength, 24);
  const blocked = fixture({ storage: { async open() { throw new Error('SecurityError'); } } });
  assert.equal((await blocked.loader.load(url)).byteLength, 24);
});
test('bounded cache evicts least recently used entries and expired data', async () => {
  let clock = Date.now(); const f = fixture({ maxBytes: 48, maxEntries: 2, now: () => clock++ });
  await f.loader.load(url); await f.loader.load(url + '?b'); await f.loader.load(url);
  await f.loader.load(url + '?c');
  assert.deepEqual([...f.entries.keys()].sort(), [url, url + '?c'].sort());
  clock += 8 * 86400000;
  await f.loader.load(url);
  assert.deepEqual(f.calls.at(-1).init.headers, {});
  assert.equal(f.entries.size, 1);
});
test('source images, other origins, no-store and different access routes do not share cached data', async () => {
  const f = fixture();
  for (const path of [url.replace('model.glb', 'input.png'), url.replace('models.example', 'other.example')]) await f.loader.load(path);
  assert.equal(f.entries.size, 0);
  f.data.policy = 'no-store'; await f.loader.load(url); assert.equal(f.entries.size, 0);
  f.data.policy = 'private, no-cache'; await f.loader.load(url);
  await f.loader.load(url.replace('/files/', '/shares/token/files/'));
  assert.deepEqual(f.calls.at(-1).init.headers, {});
});
