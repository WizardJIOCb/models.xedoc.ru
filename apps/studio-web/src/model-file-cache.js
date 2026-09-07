// Large GLBs are not reliably retained by the browser's ordinary HTTP cache.
// Store only binary model files; revalidate access and ETag before every reuse.
const CACHE_NAME = 'model-studio-glb-v1';
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 6;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export function createModelFileLoader({ fetchImpl = (...args) => fetch(...args), storage, origin, now = Date.now, maxBytes = MAX_BYTES, maxEntries = MAX_ENTRIES } = {}) {
  let writes = Promise.resolve();
  const address = (url) => new URL(url, origin || globalThis.location?.href || 'http://localhost/');
  const quietly = async (action) => { try { return await action(); } catch { return undefined; } };
  const open = () => quietly(() => (storage || globalThis.caches)?.open(CACHE_NAME));
  const eligible = (url) => url.origin === (origin ? new URL(origin).origin : globalThis.location?.origin)
    && url.pathname.startsWith('/api/model-studio/') && (/\.glb$/.test(url.pathname) || url.pathname.endsWith('/demo/glb'));

  async function prune(cache, incoming, keep) {
    const entries = [];
    for (const key of await cache.keys()) {
      const response = await cache.match(key);
      const used = Number(response?.headers.get('X-Studio-Used')) || 0;
      const size = Number(response?.headers.get('Content-Length')) || 0;
      if (key.url === keep || now() - used > MAX_AGE || !size) await cache.delete(key);
      else entries.push({ key, used, size });
    }
    entries.sort((a, b) => a.used - b.used);
    let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    while (entries.length && (entries.length >= maxEntries || bytes + incoming > maxBytes)) {
      const oldest = entries.shift();
      await cache.delete(oldest.key); bytes -= oldest.size;
    }
  }

  async function persist(cache, key, buffer, etag, modified) {
    if (!cache || !etag || buffer.byteLength > Math.min(MAX_FILE_BYTES, maxBytes)) return;
    // Serialize eviction and writes so concurrent viewers cannot exceed the cap.
    writes = writes.catch(() => {}).then(async () => {
      await prune(cache, buffer.byteLength, key);
      const headers = { 'Content-Type': 'model/gltf-binary', 'Content-Length': String(buffer.byteLength),
        'ETag': etag, 'X-Studio-Used': String(now()) };
      if (modified) headers['Last-Modified'] = modified;
      await cache.put(key, new Response(buffer, { headers }));
    });
    await quietly(() => writes);
  }

  async function load(url, onProgress = () => {}) {
    const target = address(url), key = target.href;
    const cache = eligible(target) ? await open() : undefined;
    let stored = cache && await quietly(() => cache.match(key));
    if (stored && (now() - Number(stored.headers.get('X-Studio-Used')) > MAX_AGE || !stored.headers.get('ETag'))) {
      await quietly(() => cache.delete(key)); stored = undefined;
    }
    const headers = stored ? { 'If-None-Match': stored.headers.get('ETag') } : {};
    onProgress({ phase: stored ? 'checking' : 'downloading', loadedPercent: 0 });
    // no-store here controls the ordinary HTTP cache. Our bounded cache is
    // consulted only after the server confirms access with 304 or fresh data.
    let response = await fetchImpl(key, { credentials: 'same-origin', cache: 'no-store', headers });
    if (response.status === 304 && stored) {
      const buffer = await quietly(() => stored.arrayBuffer());
      if (buffer) {
        onProgress({ phase: 'cached', loadedPercent: 100 });
        await persist(cache, key, buffer, stored.headers.get('ETag'), stored.headers.get('Last-Modified'));
        return buffer;
      }
      await quietly(() => cache.delete(key));
      response = await fetchImpl(key, { credentials: 'same-origin', cache: 'no-store' });
    }
    if (!response.ok) {
      if ([401, 403, 404, 410].includes(response.status)) await quietly(() => cache?.delete(key));
      throw new Error([401, 403, 404, 410].includes(response.status) ? 'Модель недоступна. Проверь вход в аккаунт и ссылку.' : `Не удалось загрузить модель (${response.status}). Попробуй ещё раз.`);
    }
    const total = Number(response.headers.get('Content-Length')) || 0;
    const reader = response.body?.getReader();
    let buffer;
    if (!reader) buffer = await response.arrayBuffer();
    else {
      const chunks = []; let loaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); loaded += value.byteLength;
        onProgress({ phase: 'downloading', loadedPercent: total ? Math.min(100, Math.round(loaded / total * 100)) : 0 });
      }
      const bytes = new Uint8Array(loaded); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      buffer = bytes.buffer;
    }
    const glb = buffer.byteLength >= 20 && new DataView(buffer).getUint32(0, true) === 0x46546c67
      && new DataView(buffer).getUint32(8, true) === buffer.byteLength;
    if (glb && !/no-store/i.test(response.headers.get('Cache-Control') || ''))
      await persist(cache, key, buffer, response.headers.get('ETag'), response.headers.get('Last-Modified'));
    else await quietly(() => cache?.delete(key));
    return buffer;
  }
  return { load };
}

export const modelFiles = createModelFileLoader();
