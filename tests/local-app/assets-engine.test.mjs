import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AssetDownloadError, fetchAssetFile } from '../../lib/chatgpt-client.ts';
import { HostConnectionError } from '../../lib/sync/host-client.ts';
import { syncAssets, toBase64 } from '../../lib/sync/assets.ts';
import { syncAllConversations } from '../../lib/sync/all-chat.ts';
import { syncCurrentConversation } from '../../lib/sync/single-chat.ts';
import { openDatabase } from '../../local-app/host/db.ts';
import { handleRequest } from '../../local-app/host/handlers.ts';
import { assetBlobPath } from '../../local-app/host/assets.ts';
import { assetRaw, ids } from '../fixtures/asset-chat.mjs';
import { digest, scopeA } from '../fixtures/viewer-archive.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const direct = work => work();

function host(t) {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-asset-engine-'));
  const db = openDatabase(directory);
  const reader = new DatabaseSync(join(directory, 'sync.db'));
  t.after(() => { reader.close(); try { db.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const log = [];
  const client = {
    log, retain: () => () => {},
    async request(type, payload) {
      log.push(type);
      const response = handleRequest(JSON.parse(JSON.stringify({ v: 1, id: 'x', type, payload })), () => db, () => {});
      if (response.type === 'error') throw new HostConnectionError('host-exited', response.payload.message);
      return response.payload;
    },
  };
  return { directory, db, reader, client };
}

function saveChat(db, raw = assetRaw()) {
  db.beginRun('seed', 'single', scopeA);
  db.upsertConversation('seed', raw.conversation_id, raw, digest(raw));
  db.endRun('seed', false, []);
}

const bytesOf = (size, fill = 7) => new Uint8Array(size).fill(fill);
const contentFor = (fileId, size) => new Uint8Array(Buffer.from(fileId.padEnd(size, '.')));
const state = (reader, fileId) => reader.prepare('SELECT state, attempts, sha256 FROM asset_refs WHERE file_id = ?').get(fileId);
const events = () => { const list = []; return { list, logApi: async event => { list.push(event); } }; };

async function run(t, options) {
  const { db, client } = host(t);
  saveChat(db);
  db.beginRun('dl', 'incremental', scopeA);
  const { logApi } = events();
  const summary = await syncAssets({
    client, runId: 'dl', token: 'secret-token', conversationIds: [], includeOthers: true, logApi, ...options,
  });
  return { summary, db };
}

test('base64 helper matches Buffer for every remainder and large inputs', () => {
  for (const size of [1, 2, 3, 4, 24_575, 24_576, 24_577, 100_000]) {
    const bytes = Uint8Array.from({ length: size }, (_, index) => index * 31 % 256);
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
  }
});

test('asset phase stores files, honors the per-run byte budget, and resumes deferred files next run', async t => {
  const { db, reader, client, directory } = host(t);
  saveChat(db);
  const sizes = { [ids.lonely]: 40, [ids.codeJupyter]: 100, [ids.codeSediment]: 100, [ids.doc]: 300, [ids.generated]: 900, [ids.upload]: 1200 };
  const fetched = [];
  const fetchAsset = async (token, fileId, conversationId, options) => {
    fetched.push({ token, fileId, conversationId, options });
    return { bytes: contentFor(fileId, sizes[fileId] ?? 50), mime: fileId === ids.upload ? 'Image/PNG; charset=x' : null };
  };
  const limits = { assetBytes: 2000, runBytes: 2500, assets: 50 };
  db.beginRun('dl1', 'incremental', scopeA);
  const progress = [];
  const first = await syncAssets({
    client, runId: 'dl1', token: 'secret-token', conversationIds: ['asset-chat'], includeOthers: true,
    logApi: events().logApi, fetchAsset, limits, onProgress: item => progress.push(item),
  });
  assert.deepEqual(first, { stored: 5, deduplicated: 0, skippedTooLarge: 0, unavailable: 0, failed: 0, deferred: 2, bytes: 1440 });
  assert.ok(fetched.every(item => item.token === 'secret-token' && item.conversationId === 'asset-chat'));
  assert.equal(fetched.find(item => item.fileId === ids.lonely).options.downloadIntent, true);
  assert.equal(fetched.find(item => item.fileId === ids.generated).options.downloadIntent, false);
  assert.equal(progress.at(-1).processed, 7);
  assert.equal(state(reader, ids.generated).state, 'stored');
  assert.equal(state(reader, ids.upload).state, 'pending');
  assert.equal(reader.prepare('SELECT mime FROM assets LIMIT 1').get().mime.includes('/'), true);
  assert.equal(existsSync(assetBlobPath(directory, state(reader, ids.generated).sha256)), true);
  db.endRun('dl1', false, [], undefined, first);

  db.beginRun('dl2', 'incremental', scopeA);
  const second = await syncAssets({
    client, runId: 'dl2', token: 'secret-token', conversationIds: [], includeOthers: true,
    logApi: events().logApi, fetchAsset, limits,
  });
  assert.equal(second.stored, 1);
  assert.equal(second.deferred, 1, 'an unknown-size file only starts when a full per-file allowance remains');
  db.endRun('dl2', false, [], undefined, second);

  db.beginRun('dl3', 'incremental', scopeA);
  const third = await syncAssets({
    client, runId: 'dl3', token: 'secret-token', conversationIds: [], includeOthers: true,
    logApi: events().logApi, fetchAsset, limits,
  });
  assert.equal(third.stored, 1);
  assert.equal(third.deferred, 0);
  assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM asset_refs WHERE state = 'stored'").get().n, 7);
  assert.equal(db.status().counts.assetsPending, 0);
});

test('declared and actual oversize files are skipped; unavailable files use the library alias', async t => {
  const calls = [];
  const { summary, db } = await run(t, {
    limits: { assetBytes: 5000, runBytes: 100_000 },
    fetchAsset: async (token, fileId) => {
      calls.push(fileId);
      if (fileId === ids.upload) throw new AssetDownloadError('unavailable', 'HTTP 404');
      if (fileId === ids.library) return { bytes: contentFor(fileId, 25), mime: 'image/png' };
      if (fileId === ids.doc) throw new AssetDownloadError('too-large', 'big');
      if (fileId === ids.generated) throw new AssetDownloadError('unavailable', 'HTTP 410');
      if (fileId === ids.lonely) throw new TypeError('network down');
      return { bytes: contentFor(fileId, 20), mime: null };
    },
  });
  assert.equal(calls.includes(ids.library), true, 'attachment retried through its library alias');
  assert.equal(calls.filter(id => id === ids.generated).length, 1, 'only attachments use the alias');
  assert.deepEqual(summary, { stored: 4, deduplicated: 0, skippedTooLarge: 1, unavailable: 1, failed: 1, deferred: 0, bytes: 85 });
  const reader = new DatabaseSync(join(db.status().dbPath));
  try {
    assert.equal(state(reader, ids.upload).state, 'stored');
    assert.equal(state(reader, ids.doc).state, 'too-large');
    assert.equal(state(reader, ids.generated).state, 'unavailable');
    assert.equal(state(reader, ids.lonely).state, 'failed');
  } finally { reader.close(); }
});

test('rate limits and sign-in expiry stop the phase without failing the rest', async t => {
  let calls = 0;
  const limited = await run(t, {
    fetchAsset: async () => { calls++; throw new AssetDownloadError('rate-limited', 'HTTP 429'); },
  });
  assert.equal(calls, 1);
  assert.equal(limited.summary.stopped, 'rate-limited');
  assert.equal(limited.summary.failed, 1);
  assert.equal(limited.summary.deferred, 6);

  calls = 0;
  const expired = await run(t, {
    fetchAsset: async () => { calls++; throw new AssetDownloadError('unauthorized', 'HTTP 401'); },
  });
  assert.equal(calls, 1);
  assert.equal(expired.summary.stopped, 'unauthorized');
  assert.equal(expired.summary.failed, 0);
  assert.equal(expired.summary.deferred, 7);
  assert.equal(expired.db.status().counts.assetsPending, 7, 'nothing is marked failed when sign-in expires');
});

test('cancellation and host failures stop cleanly with a truthful summary', async t => {
  const controller = new AbortController();
  const cancelled = await run(t, {
    signal: controller.signal,
    fetchAsset: async () => { controller.abort(); return { bytes: bytesOf(10), mime: 'image/png' }; },
  });
  assert.equal(cancelled.summary.stopped, 'cancelled');
  assert.equal(cancelled.summary.stored, 1);
  assert.equal(cancelled.summary.deferred, 6);

  const aborting = new AbortController();
  const aborted = await run(t, {
    signal: aborting.signal,
    fetchAsset: async () => { aborting.abort(); throw Object.assign(new Error('x'), { name: 'AbortError' }); },
  });
  assert.equal(aborted.summary.stopped, 'cancelled');
  assert.equal(aborted.summary.failed, 0);

  const failing = await syncAssets({
    client: { async request() { throw new HostConnectionError('host-exited', 'gone'); } },
    runId: 'r', token: 't', conversationIds: [], includeOthers: true, logApi: async () => {},
  });
  assert.equal(failing.stopped, 'local-host');
  const { client, db } = host(t);
  saveChat(db);
  db.beginRun('dl', 'incremental', scopeA);
  const broken = await syncAssets({
    client: { request: (type, payload) => type === 'assetCommit' ? Promise.reject(new HostConnectionError('host-exited', 'x')) : client.request(type, payload) },
    runId: 'dl', token: 't', conversationIds: [], includeOthers: true, logApi: async () => {},
    fetchAsset: async () => ({ bytes: bytesOf(5), mime: null }),
  });
  assert.equal(broken.stopped, 'local-host');
  assert.equal(broken.stored, 0);
  assert.equal(db.status().counts.assets, 0);
});

test('the ordering hint is capped so large first syncs still list pending files', async t => {
  const { db, client } = host(t);
  saveChat(db);
  db.beginRun('dl', 'incremental', scopeA);
  const hints = Array.from({ length: 1500 }, (_, index) => `chat-${index}`);
  const summary = await syncAssets({
    client, runId: 'dl', token: 't', conversationIds: hints, includeOthers: true, logApi: async () => {},
    fetchAsset: async (token, fileId) => ({ bytes: contentFor(fileId, 24), mime: 'image/png' }),
  });
  assert.equal(summary.stopped, undefined);
  assert.equal(summary.stored, 7);
});

test('large files upload in multiple chunks with a matching hash', async t => {
  const { db, client, directory } = host(t);
  const raw = assetRaw();
  raw.mapping.user.message.metadata.attachments = [{ id: ids.lonely, name: 'big.bin', size: 4 * 1024 * 1024 }];
  raw.mapping.user.message.content.parts = ['text only'];
  saveChat(db, raw);
  db.beginRun('dl', 'incremental', scopeA);
  const big = Uint8Array.from({ length: 4 * 1024 * 1024 }, (_, index) => index % 251);
  const sent = [];
  const summary = await syncAssets({
    client: { request: (type, payload) => { sent.push(type); return client.request(type, payload); } },
    runId: 'dl', token: 't', conversationIds: ['asset-chat'], includeOthers: false, logApi: async () => {},
    fetchAsset: async fileId => ({ bytes: big, mime: 'application/octet-stream' }),
    limits: { assetBytes: 5 * 1024 * 1024, runBytes: 5 * 1024 * 1024 },
  });
  assert.equal(summary.stored >= 1, true);
  assert.equal(sent.filter(type => type === 'assetChunk').length >= 2, true);
  assert.equal(existsSync(assetBlobPath(directory, sha(big))), true);
});

test('all-chat sync downloads files after chats and reports the summary to the host', async t => {
  const { db, client, reader } = host(t);
  const raw = assetRaw('chat-with-files');
  const fetched = [];
  const progress = [];
  const result = await syncAllConversations(scopeA, 'secret-token', {
    client, includeAssets: true, maxConversations: 10,
    fetchProjects: async () => ({ items: [], cursor: null }), verifyScope: async () => {},
    fetchPage: async () => ({ total: 1, items: [{ id: 'chat-with-files', updateTimeToken: 'n:1' }] }),
    fetchRaw: async () => raw,
    fetchAsset: async (token, fileId) => { fetched.push(fileId); return { bytes: contentFor(fileId, 24), mime: 'image/png' }; },
    onProgress: item => progress.push(item.phase),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.assets.stored, 7);
  assert.equal(fetched.length, 7);
  assert.equal(progress.includes('assets'), true);
  assert.equal(JSON.parse(reader.prepare("SELECT assets_json FROM sync_runs WHERE mode = 'incremental'").get().assets_json).stored, 7);

  const again = await syncAllConversations(scopeA, 'secret-token', {
    client, includeAssets: true, maxConversations: 10,
    fetchProjects: async () => ({ items: [], cursor: null }), verifyScope: async () => {},
    fetchPage: async () => ({ total: 1, items: [{ id: 'chat-with-files', updateTimeToken: 'n:1' }] }),
    fetchRaw: async () => { throw new Error('unchanged chats are not refetched'); },
    fetchAsset: async () => { throw new Error('nothing is pending'); },
  });
  assert.equal(again.assets.stored, 0);
  assert.equal(again.counts.unchanged, 1);

  const off = await syncAllConversations(scopeA, 'secret-token', {
    client, maxConversations: 10,
    fetchProjects: async () => ({ items: [], cursor: null }), verifyScope: async () => {},
    fetchPage: async () => ({ total: 1, items: [{ id: 'chat-with-files', updateTimeToken: 'n:1' }] }),
    fetchRaw: async () => raw,
  });
  assert.equal(off.assets, undefined);
});

test('asset sync is refused when the host lacks the capability and chats keep working without it', async t => {
  const old = { retain: () => () => {}, request: async type => ({ schemaVersion: 4, capabilities: ['all-chat-sync', 'message-change-counts', 'project-catalog'] }) };
  await assert.rejects(syncAllConversations(scopeA, 't', {
    client: old, includeAssets: true, fetchProjects: async () => ({ items: [], cursor: null }), verifyScope: async () => {},
  }), /asset-sync/);
  await assert.rejects(syncCurrentConversation('c', scopeA, async () => ({}), old, { token: 't' }), /asset-sync/);
});

test('single-chat sync downloads only that chat’s files', async t => {
  const { db, client, reader } = host(t);
  const other = assetRaw('other-chat');
  other.mapping.user.message.metadata.attachments = [{ id: 'file-otherchat0001', name: 'o.txt' }];
  other.mapping.user.message.content.parts = ['x'];
  saveChat(db, other);
  const fetched = [];
  const result = await syncCurrentConversation('asset-chat', scopeA, async () => assetRaw(), client, {
    token: 'tok', fetchAsset: async (token, fileId) => { fetched.push(fileId); return { bytes: contentFor(fileId, 24), mime: 'image/png' }; },
  });
  assert.equal(result.assets.stored, 7);
  assert.equal(fetched.includes('file-otherchat0001'), false);
  assert.equal(reader.prepare("SELECT state FROM asset_refs WHERE file_id = 'file-otherchat0001'").get().state, 'pending');
});

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), headers: init?.headers ?? {} }); return handler(String(url), requests.length); };
  t.after(() => { globalThis.fetch = original; });
  return requests;
}
const lookup = url => new Response(JSON.stringify({ status: 'success', download_url: url }));

test('file download is two-step, same-origin only, size-limited, and never logs signed URLs or bytes', async t => {
  const signed = 'https://chatgpt.com/backend-api/estuary/content?id=file-abc&sig=SECRETSIG';
  const requests = stubFetch(t, (url, count) => count === 1 ? lookup(signed) :
    new Response(Uint8Array.from([1, 2, 3]), { headers: { 'content-type': 'Image/PNG; foo=bar' } }));
  const { list, logApi } = events();
  const file = await fetchAssetFile('tok', 'file-abc123', 'conv-1', { maxBytes: 10, fileKind: 'attachment', downloadIntent: true, logApi, request: direct });
  assert.deepEqual([...file.bytes], [1, 2, 3]);
  assert.equal(file.mime, 'image/png');
  assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/files/download/file-abc123?conversation_id=conv-1&inline=false&download_intent=true');
  assert.equal(requests[1].url, signed);
  assert.ok(requests.every(request => request.headers.authorization === 'Bearer tok'));
  const logged = JSON.stringify(list);
  assert.equal(logged.includes('SECRETSIG'), false);
  assert.equal(logged.includes('tok'), false);
  assert.deepEqual(list.map(event => [event.stage, event.status]), [['url', 200], ['download', 200]]);
  assert.equal(list[1].bytes, 3);
});

test('foreign download origins never receive the token and are reported as unverified', async t => {
  const requests = stubFetch(t, () => lookup('https://files.example.test/blob?sig=SECRETSIG'));
  const { list, logApi } = events();
  await assert.rejects(fetchAssetFile('tok', 'file-abc123', 'conv-1', { maxBytes: 10, fileKind: 'image-upload', logApi, request: direct }),
    error => error instanceof AssetDownloadError && error.failure === 'unavailable' && /unverified-origin/.test(error.message));
  assert.equal(requests.length, 1, 'the foreign URL is never requested');
  assert.deepEqual(list.at(-1), { kind: 'asset', fileKind: 'image-upload', stage: 'rejected', host: 'files.example.test', reason: 'unverified-origin' });
  assert.equal(JSON.stringify(list).includes('SECRETSIG'), false);
  for (const url of ['http://chatgpt.com/x', 'https://chatgpt.com.evil.test/x', 'https://user@evil.test/x', 'not a url']) {
    stubFetch(t, () => lookup(url));
    await assert.rejects(fetchAssetFile('tok', 'file-abc123', 'conv-1', { maxBytes: 10, fileKind: 'x', request: direct }), AssetDownloadError);
  }
});

test('file download enforces the size limit from headers and while streaming', async t => {
  const signed = 'https://chatgpt.com/backend-api/estuary/content?id=x';
  stubFetch(t, (url, count) => count % 2 === 1 ? lookup(signed) : new Response(new Uint8Array(100), { headers: { 'content-length': '100' } }));
  await assert.rejects(fetchAssetFile('tok', 'file-abc123', 'c', { maxBytes: 50, fileKind: 'x', request: direct }),
    error => error.failure === 'too-large');
  let cancelled = false;
  stubFetch(t, (url, count) => count % 2 === 1 ? lookup(signed) : new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(30)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(fetchAssetFile('tok', 'file-abc123', 'c', { maxBytes: 50, fileKind: 'x', request: direct }),
    error => error.failure === 'too-large');
  assert.equal(cancelled, true, 'the stream is cancelled once the limit is exceeded');
});

test('file download classifies HTTP and response failures', async t => {
  const outcomes = [[401, 'unauthorized'], [403, 'unavailable'], [404, 'unavailable'], [410, 'unavailable'], [429, 'rate-limited'], [500, 'failed'], [418, 'failed']];
  for (const [status, failure] of outcomes) {
    stubFetch(t, () => new Response('nope', { status }));
    await assert.rejects(fetchAssetFile('tok', 'file-abc123', 'c', { maxBytes: 50, fileKind: 'x', request: direct }),
      error => error instanceof AssetDownloadError && error.failure === failure, `lookup ${status}`);
  }
  stubFetch(t, (url, count) => count === 1 ? lookup('https://chatgpt.com/d') : new Response('x', { status: 404 }));
  await assert.rejects(fetchAssetFile('tok', 'file-abc123', 'c', { maxBytes: 50, fileKind: 'x', request: direct }), error => error.failure === 'unavailable');
  stubFetch(t, () => new Response(JSON.stringify({ status: 'error' })));
  await assert.rejects(fetchAssetFile('tok', 'file-abc123', 'c', { maxBytes: 50, fileKind: 'x', request: direct }), error => error.failure === 'unavailable');
  stubFetch(t, () => new Response('<html>'));
  await assert.rejects(fetchAssetFile('tok', 'file-abc123', 'c', { maxBytes: 50, fileKind: 'x', request: direct }), error => error.failure === 'failed');
  stubFetch(t, (url, count) => count === 1 ? lookup('https://chatgpt.com/d') : new Response(new Uint8Array(0)));
  await assert.rejects(fetchAssetFile('tok', 'file-abc123', 'c', { maxBytes: 50, fileKind: 'x', request: direct }), error => /empty/.test(error.message));
  for (const [file, conversation] of [['../x', 'c'], ['file-a/b', 'c'], ['file-abc123', 'bad id'], ['file-abc123', '../x']]) {
    const requests = stubFetch(t, () => { throw new Error('must not fetch'); });
    await assert.rejects(fetchAssetFile('tok', file, conversation, { maxBytes: 5, fileKind: 'x', request: direct }), AssetDownloadError);
    assert.equal(requests.length, 0);
  }
});
