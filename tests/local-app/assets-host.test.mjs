import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../local-app/host/db.ts';
import { handleRequest } from '../../local-app/host/handlers.ts';
import { assetBlobPath } from '../../local-app/host/assets.ts';
import { isAssetRunSummary, isResponsePayload } from '../../lib/sync/protocol.ts';
import { assetRaw, ids } from '../fixtures/asset-chat.mjs';
import { digest, scopeA, scopeB, simpleRaw } from '../fixtures/viewer-archive.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const accountA = JSON.stringify([scopeA.userId, scopeA.workspaceId]);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-assets-'));
  const db = openDatabase(directory);
  const reader = new DatabaseSync(join(directory, 'sync.db'));
  t.after(() => { reader.close(); try { db.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { directory, db, reader };
}

function save(db, raw, scope = scopeA, runId = `save-${raw.conversation_id}-${Math.random()}`) {
  db.beginRun(runId, 'single', scope);
  db.upsertConversation(runId, raw.conversation_id, raw, digest(raw));
  db.endRun(runId, false, []);
}

function upload(db, runId, conversationId, fileId, bytes, { chunkSize = 3, uploadId = `up-${fileId}` } = {}) {
  let seq = 0;
  for (let offset = 0; offset < bytes.length; offset += chunkSize, seq++) {
    db.assetChunk(runId, uploadId, conversationId, fileId, seq, bytes.subarray(offset, offset + chunkSize).toString('base64'));
  }
  return db.assetCommit(runId, uploadId, conversationId, fileId, sha(bytes), bytes.length, 'image/png');
}

const row = (reader, fileId, conversationId = 'asset-chat') =>
  reader.prepare('SELECT * FROM asset_refs WHERE file_id = ? AND conversation_id = ?').get(fileId, conversationId);

test('saving a conversation derives asset references and replaces them on change', t => {
  const { db, reader } = fixture(t);
  save(db, assetRaw());
  const rows = reader.prepare('SELECT file_id, kind, state, message_ids, name FROM asset_refs ORDER BY file_id').all();
  assert.equal(rows.length, 7);
  assert.ok(rows.every(item => item.state === 'pending'));
  assert.deepEqual(JSON.parse(row(reader, ids.upload).message_ids), ['asset-chat-user']);
  assert.equal(row(reader, ids.upload).name, 'photo.png');
  assert.equal(row(reader, ids.upload).library_file_id, ids.library);

  const changed = assetRaw();
  delete changed.mapping.assistant.message.content.parts;
  changed.mapping.assistant.message.content.parts = ['plain text now'];
  changed.update_time = 600;
  save(db, changed);
  assert.equal(row(reader, ids.generated), undefined);
  assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM asset_refs').get().n, 6);
});

test('declared sizes above the limit are skipped without a download', t => {
  const { db, reader } = fixture(t);
  const raw = assetRaw();
  raw.mapping.user.message.content.parts[0].size_bytes = 6 * 1024 * 1024;
  raw.mapping.user.message.metadata.attachments[0].size = 6 * 1024 * 1024;
  save(db, raw);
  assert.equal(row(reader, ids.upload).state, 'too-large');
  db.beginRun('list', 'incremental', scopeA);
  const pending = db.listPendingAssets('list', [], true, 50).map(item => item.fileId);
  assert.equal(pending.includes(ids.upload), false);
  assert.equal(pending.length, 6);
});

test('schema 5 migration backfills references for conversations already saved', t => {
  const { db, reader, directory } = fixture(t);
  save(db, assetRaw());
  save(db, simpleRaw('plain-chat', 2));
  db.close();
  reader.exec(`DROP TABLE asset_refs; DROP TABLE assets; ALTER TABLE sync_runs DROP COLUMN assets_json;
    DELETE FROM schema_migrations WHERE version = 5;`);
  const migrated = openDatabase(directory);
  try {
    assert.equal(migrated.status().schemaVersion, 5);
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM asset_refs').get().n, 7);
    assert.equal(migrated.status().counts.assetsPending, 7);
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 2);
  } finally { migrated.close(); }
});

test('chunked upload verifies the hash, stores the blob once, and shares it across references', t => {
  const { db, reader, directory } = fixture(t);
  save(db, assetRaw());
  const forked = assetRaw('fork-chat');
  save(db, forked);
  const bytes = Buffer.from('PNG-BYTES-1234567890');
  db.beginRun('dl', 'incremental', scopeA);
  const first = upload(db, 'dl', 'asset-chat', ids.upload, bytes);
  assert.equal(first.status, 'stored');
  const stored = row(reader, ids.upload);
  assert.equal(stored.state, 'stored');
  assert.equal(stored.sha256, sha(bytes));
  assert.deepEqual(readFileSync(assetBlobPath(directory, sha(bytes))), bytes);
  // The same remote file in another chat of this account is marked stored without a second download.
  assert.equal(row(reader, ids.upload, 'fork-chat').state, 'stored');
  assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
  assert.equal(db.status().counts.assets, 1);
  assert.equal(db.status().counts.assetBytes, bytes.length);

  // Different file ID, identical bytes: one blob, deduplicated.
  const second = upload(db, 'dl', 'asset-chat', ids.generated, bytes);
  assert.equal(second.status, 'deduplicated');
  assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
  assert.deepEqual(readdirSync(join(directory, 'assets', 'tmp')), []);
  db.endRun('dl', false, [], undefined, {
    stored: 1, deduplicated: 1, skippedTooLarge: 0, unavailable: 0, failed: 0, deferred: 0, bytes: bytes.length * 2,
  });
  assert.equal(JSON.parse(reader.prepare("SELECT assets_json FROM sync_runs WHERE id = 'dl'").get().assets_json).stored, 1);

  // A stored reference survives re-saving the conversation.
  const updated = assetRaw();
  updated.update_time = 900;
  save(db, updated);
  assert.equal(row(reader, ids.upload).state, 'stored');
});

test('hash mismatch, size mismatch, and out-of-order chunks never store a file or flip state', t => {
  const { db, reader, directory } = fixture(t);
  save(db, assetRaw());
  db.beginRun('bad', 'incremental', scopeA);
  const bytes = Buffer.from('abcdef');
  db.assetChunk('bad', 'u1', 'asset-chat', ids.upload, 0, bytes.toString('base64'));
  assert.throws(() => db.assetCommit('bad', 'u1', 'asset-chat', ids.upload, sha(Buffer.from('other')), bytes.length, 'image/png'),
    /SHA-256 did not match/);
  db.assetChunk('bad', 'u2', 'asset-chat', ids.upload, 0, bytes.toString('base64'));
  assert.throws(() => db.assetCommit('bad', 'u2', 'asset-chat', ids.upload, sha(bytes), bytes.length + 1, 'image/png'), /does not match/);
  assert.throws(() => db.assetChunk('bad', 'u3', 'asset-chat', ids.upload, 1, bytes.toString('base64')), /out of order/);
  db.assetChunk('bad', 'u4', 'asset-chat', ids.upload, 0, bytes.toString('base64'));
  assert.throws(() => db.assetChunk('bad', 'u4', 'asset-chat', ids.upload, 2, bytes.toString('base64')), /out of order/);
  assert.throws(() => db.assetCommit('bad', 'u4', 'asset-chat', ids.upload, sha(bytes), bytes.length, 'image/png'), /does not match/);
  assert.equal(row(reader, ids.upload).state, 'pending');
  assert.equal(existsSync(join(directory, 'assets', sha(bytes).slice(0, 2), sha(bytes))), false);
  assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
  for (const data of ['', '***', 'abc', Buffer.from('x').toString('base64') + '=']) {
    assert.throws(() => db.assetChunk('bad', 'u5', 'asset-chat', ids.upload, 0, data), /malformed/);
  }
});

test('assets above 5 MB are rejected while receiving', t => {
  const { db } = fixture(t);
  save(db, assetRaw());
  db.beginRun('big', 'incremental', scopeA);
  const chunk = Buffer.alloc(3 * 1024 * 1024, 1).toString('base64');
  db.assetChunk('big', 'u', 'asset-chat', ids.upload, 0, chunk);
  assert.throws(() => db.assetChunk('big', 'u', 'asset-chat', ids.upload, 1, chunk), /5 MB/);
  assert.throws(() => db.assetChunk('big', 'u', 'asset-chat', ids.upload, 2, 'AAAA'), /out of order/);
});

test('uploads are bound to an active run and the owning account', t => {
  const { db, reader } = fixture(t);
  save(db, assetRaw());
  save(db, assetRaw('other-chat'), scopeB);
  assert.throws(() => db.listPendingAssets('missing-run', [], true, 5), /not active/);
  db.beginRun('a', 'incremental', scopeA);
  const data = Buffer.from('abc').toString('base64');
  assert.throws(() => db.assetChunk('a', 'u', 'other-chat', ids.upload, 0, data), /not referenced/);
  assert.throws(() => db.assetChunk('a', 'u', 'asset-chat', 'file-unknown00000', 0, data), /not referenced/);
  assert.throws(() => db.assetChunk('a', 'u', 'asset-chat', '../file-x', 0, data), /malformed/);
  assert.deepEqual(db.listPendingAssets('a', [], true, 50).map(item => item.conversationId), Array(7).fill('asset-chat'));
  db.assetChunk('a', 'u-end', 'asset-chat', ids.upload, 0, data);
  db.endRun('a', true, []);
  assert.throws(() => db.assetCommit('a', 'u-end', 'asset-chat', ids.upload, sha(Buffer.from('abc')), 3, 'image/png'), /not active/);
  assert.equal(row(reader, ids.upload).state, 'pending');
});

test('pending list prefers this run, honors limits, and retries by attempt count', t => {
  const { db, reader } = fixture(t);
  save(db, assetRaw('old-chat'));
  const newer = assetRaw('new-chat');
  newer.update_time = 50;
  save(db, newer);
  db.beginRun('p', 'incremental', scopeA);
  const only = db.listPendingAssets('p', ['new-chat'], false, 50);
  assert.equal(only.length, 7);
  assert.ok(only.every(item => item.conversationId === 'new-chat'));
  const all = db.listPendingAssets('p', ['new-chat'], true, 50);
  assert.deepEqual(all.slice(0, 7).map(item => item.conversationId), Array(7).fill('new-chat'));
  assert.equal(all.length, 14);
  assert.equal(db.listPendingAssets('p', [], true, 3).length, 3);
  assert.throws(() => db.listPendingAssets('p', [], true, 51), /invalid/);
  assert.throws(() => db.listPendingAssets('p', ['bad id!'], true, 5), /invalid/);

  assert.deepEqual(db.assetOutcome('p', 'old-chat', ids.upload, 'unavailable', 'HTTP 404'), { state: 'unavailable', attempts: 1 });
  assert.deepEqual(db.assetOutcome('p', 'old-chat', ids.doc, 'failed', 'network'), { state: 'failed', attempts: 1 });
  // Items attempted in this run are not offered again in the same run.
  assert.equal(db.listPendingAssets('p', [], true, 50).some(item => item.conversationId === 'old-chat' && item.fileId === ids.upload), false);
  db.endRun('p', false, []);
  db.beginRun('p2', 'incremental', scopeA);
  const next = db.listPendingAssets('p2', [], true, 50).filter(item => item.conversationId === 'old-chat').map(item => item.fileId);
  assert.deepEqual(next.slice(-2).sort(), [ids.doc, ids.upload].sort(), 'retried items come after fresh ones');
  assert.equal(row(reader, ids.upload, 'old-chat').last_error, 'HTTP 404');
});

test('unavailable assets are retried at most three times while failed ones keep retrying', t => {
  const { db } = fixture(t);
  save(db, assetRaw());
  for (let run = 1; run <= 3; run++) {
    db.beginRun(`r${run}`, 'incremental', scopeA);
    const pending = db.listPendingAssets(`r${run}`, [], true, 50).map(item => item.fileId);
    assert.equal(pending.includes(ids.upload), true);
    assert.equal(pending.includes(ids.doc), true);
    db.assetOutcome(`r${run}`, 'asset-chat', ids.upload, 'unavailable');
    db.assetOutcome(`r${run}`, 'asset-chat', ids.doc, 'failed');
    db.endRun(`r${run}`, false, []);
  }
  db.beginRun('r4', 'incremental', scopeA);
  const pending = db.listPendingAssets('r4', [], true, 50).map(item => item.fileId);
  assert.equal(pending.includes(ids.upload), false);
  assert.equal(pending.includes(ids.doc), true);
  assert.throws(() => db.assetOutcome('r4', 'asset-chat', ids.upload, 'stored'), /Unsupported/);
  assert.equal(db.status().counts.assetsPending, 6);
});

test('host protocol validates asset requests and run summaries', t => {
  const { db } = fixture(t);
  save(db, assetRaw());
  let counter = 0;
  const call = (type, payload) => handleRequest({ v: 1, id: `r${++counter}`, type, payload }, () => db, () => {});
  const begin = call('beginRun', { runId: 'proto', mode: 'incremental', account: scopeA });
  assert.equal(begin.type, 'beginRun.ok');
  const list = call('listPendingAssets', { runId: 'proto', conversationIds: [], includeOthers: true, limit: 50 });
  assert.equal(list.type, 'listPendingAssets.ok');
  assert.equal(isResponsePayload('listPendingAssets', list.payload), true);
  assert.equal(call('listPendingAssets', { runId: 'proto', conversationIds: [], includeOthers: 1, limit: 5 }).payload.code, 'INVALID_PAYLOAD');
  assert.equal(call('listPendingAssets', { runId: 'proto', conversationIds: [], includeOthers: true, limit: 5, extra: 1 }).payload.code, 'INVALID_PAYLOAD');
  const data = Buffer.from('hello').toString('base64');
  const chunk = call('assetChunk', { runId: 'proto', uploadId: 'u1', conversationId: 'asset-chat', fileId: ids.upload, seq: 0, data });
  assert.deepEqual(chunk.payload, { received: 5 });
  assert.equal(call('assetChunk', { runId: 'proto', uploadId: 'u1', conversationId: 'asset-chat', fileId: ids.upload, seq: 0, data: 5 }).payload.code, 'INVALID_PAYLOAD');
  assert.equal(call('assetCommit', { runId: 'proto', uploadId: 'u1', conversationId: 'asset-chat', fileId: ids.upload, sha256: sha(Buffer.from('hello')), size: 5, mime: 'text/plain' }).payload.status, 'stored');
  assert.equal(call('assetOutcome', { runId: 'proto', conversationId: 'asset-chat', fileId: ids.doc, state: 'stored' }).payload.code, 'INVALID_PAYLOAD');
  assert.deepEqual(call('assetOutcome', { runId: 'proto', conversationId: 'asset-chat', fileId: ids.doc, state: 'unavailable', error: 'HTTP 404' }).payload, { state: 'unavailable', attempts: 1 });
  const summary = { stored: 1, deduplicated: 0, skippedTooLarge: 0, unavailable: 1, failed: 0, deferred: 0, bytes: 5 };
  assert.equal(isAssetRunSummary(summary), true);
  assert.equal(isAssetRunSummary({ ...summary, stopped: 'rate-limited' }), true);
  assert.equal(isAssetRunSummary({ ...summary, stopped: 'bored' }), false);
  assert.equal(isAssetRunSummary({ ...summary, bytes: -1 }), false);
  assert.equal(isAssetRunSummary({ ...summary, extra: 1 }), false);
  assert.equal(call('endRun', { runId: 'proto', cancelled: false, failures: [], assets: { stored: 'x' } }).payload.code, 'INVALID_PAYLOAD');
  assert.equal(call('endRun', { runId: 'proto', cancelled: false, failures: [], assets: summary }).type, 'endRun.ok');
  assert.equal(isResponsePayload('assetChunk', { received: 1 }), true);
  assert.equal(isResponsePayload('assetChunk', { received: -1 }), false);
  assert.equal(isResponsePayload('assetCommit', { status: 'weird' }), false);
  assert.equal(isResponsePayload('assetOutcome', { state: 'pending', attempts: 0 }), true);
  assert.equal(isResponsePayload('listPendingAssets', { items: [{ conversationId: 'c' }] }), false);
});
