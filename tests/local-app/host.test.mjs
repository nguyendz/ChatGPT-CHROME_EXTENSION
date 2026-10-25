import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFrames, writeFrame } from '../../local-app/host/framing.ts';
import { API_DEBUG_CHUNK_CHARS, ECHO_BYTES, MAX_EXT_TO_HOST_BYTES, MAX_HOST_TO_EXT_BYTES } from '../../lib/sync/protocol.ts';

const origin = `chrome-extension://${'a'.repeat(32)}/`;
const main = fileURLToPath(new URL('../../local-app/host/main.ts', import.meta.url));
function frame(value) {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function request(type, payload = {}, id = type) {
  return { v: 1, id, type, payload };
}
async function run(t, frames, options = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'chatgpt-host-test-'));
  if (!options.directory) t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', main, options.origin ?? origin], {
    env: { ...process.env, CHATGPT_SYNC_DATA_DIR: directory, CHATGPT_SYNC_ALLOWED_ORIGIN: origin },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const closed = once(child, 'close');
  const timer = setTimeout(() => child.kill(), 10_000);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const replies = (async () => {
    const values = [];
    for await (const body of readFrames(child.stdout)) values.push(JSON.parse(body.toString('utf8')));
    return values;
  })();
  child.stdin.on('error', error => {
    if (error.code !== 'EPIPE' && error.code !== 'EOF') throw error;
  });
  for (const bytes of frames) child.stdin.write(bytes);
  child.stdin.end();
  try {
    const values = await replies;
    const [code] = await closed;
    assert.equal(stderr, '');
    return { values, code, directory };
  } finally {
    clearTimeout(timer);
  }
}

test('ping + 10 MB echo; stdout contains only correctly framed replies', async t => {
  const data = 'x'.repeat(ECHO_BYTES);
  const { values, code } = await run(t, [frame(request('ping')), frame(request('echo', { data }))]);
  assert.equal(code, 0);
  assert.equal(values[0].type, 'ping.ok');
  assert.equal(values[0].payload.protocolVersion, 1);
  assert.deepEqual(values[1].payload, {
    bytes: ECHO_BYTES, sha256: createHash('sha256').update(data).digest('hex'),
  });
});

test('API probe writes only a validated sanitized report to host.log', async t => {
  const report = {
    schemaVersion: 1,
    probeId: '123e4567-e89b-12d3-a456-426614174000',
    routeKind: 'conversation',
    session: {
      status: 'ok', errorCategory: 'none', httpStatuses: [200],
      fields: [{ path: 'session.user.id', type: 'string' }],
    },
    defaultList: { status: 'skipped', errorCategory: 'skipped', httpStatuses: [], fields: [] },
    orderedList: { status: 'skipped', errorCategory: 'skipped', httpStatuses: [], fields: [] },
    archivedList: { status: 'skipped', errorCategory: 'skipped', httpStatuses: [], fields: [] },
    defaultOrder: 'inconclusive',
    orderedOrder: 'inconclusive',
    orderSequenceChanged: 'inconclusive',
    archiveRelation: 'inconclusive',
    projectListMembership: 'not-tested',
  };
  const invalidWithSecret = { ...report, raw: 'private response body' };
  const invalidOversized = {
    ...report,
    session: {
      ...report.session,
      fields: Array.from({ length: 33 }, (_, index) => ({ path: `session.field_${index}`, type: 'string' })),
    },
  };
  const { values, directory, code } = await run(t, [
    frame(request('recordApiProbe', report)),
    frame(request('recordApiProbe', invalidWithSecret, 'probe-extra')),
    frame(request('recordApiProbe', invalidOversized, 'probe-large')),
  ]);

  assert.equal(code, 0);
  assert.deepEqual(values[0], {
    v: 1, id: 'recordApiProbe', type: 'recordApiProbe.ok',
    payload: { probeId: report.probeId, logged: true },
  });
  assert.deepEqual(values.slice(1).map(value => value.payload.code), ['INVALID_PAYLOAD', 'INVALID_PAYLOAD']);
  const log = readFileSync(join(directory, 'logs', 'host.log'), 'utf8');
  assert.equal((log.match(/API_PROBE/g) ?? []).length, 1);
  assert.match(log, /session\.user\.id/);
  assert.equal(log.includes('private response body'), false);
  assert.throws(() => readFileSync(join(directory, 'sync.db')), { code: 'ENOENT' });
});

test('failed sync runs log aggregate categories without chat IDs or error text', async t => {
  const privateConversationId = 'private-chat-identifier';
  const privateError = 'Could not read a complete conversation list. private response body';
  const unstableError = 'Both consistency scans returned duplicate conversation IDs. Retry when the list is stable.';
  const { values, directory, code } = await run(t, [
    frame(request('beginRun', {
      runId: 'failed-run', mode: 'incremental',
      account: { userId: 'user-1', workspaceId: 'workspace-1' },
    })),
    frame(request('endRun', {
      runId: 'failed-run', cancelled: false,
      failures: [
        { conversationId: privateConversationId, error: privateError, retryable: true },
        { conversationId: 'another-private-chat', error: unstableError, retryable: true },
      ],
    })),
  ]);
  assert.equal(code, 0);
  assert.equal(values[1].payload.status, 'failed');
  const log = readFileSync(join(directory, 'logs', 'host.log'), 'utf8');
  const failureEntry = log.split(/\r?\n/).find(line => line.includes('SYNC_RUN_FAILURE'));
  assert.ok(failureEntry);
  assert.match(failureEntry, /"failureCount":2/);
  assert.match(failureEntry, /"retryableCount":2/);
  assert.match(failureEntry, /"list-fetch":1/);
  assert.match(failureEntry, /"list-unstable":1/);
  assert.equal(failureEntry.includes(privateConversationId), false);
  assert.equal(failureEntry.includes('another-private-chat'), false);
  assert.equal(failureEntry.includes(privateError), false);
  assert.equal(failureEntry.includes(unstableError), false);
});

test('API debug chunks persist separately without leaking bodies to host.log or stdout', async t => {
  const event = JSON.stringify({ kind: 'response', body: 'private chat\n'.repeat(3000) });
  const parts = Math.ceil(event.length / API_DEBUG_CHUNK_CHARS);
  const chunks = Array.from({ length: parts }, (_, part) => ({
    runId: 'debug-run', entryId: 'entry-1', part, parts,
    data: event.slice(part * API_DEBUG_CHUNK_CHARS, (part + 1) * API_DEBUG_CHUNK_CHARS),
  }));
  const { values, directory, code } = await run(t, [
    ...chunks.map(chunk => frame(request('recordApiDebug', chunk, `part-${chunk.part}`))),
    frame(request('recordApiDebug', { ...chunks[0], data: 'x'.repeat(API_DEBUG_CHUNK_CHARS + 1) }, 'too-large')),
  ]);
  assert.equal(code, 0);
  assert.deepEqual(values.slice(0, parts).map(value => value.payload),
    chunks.map(chunk => ({ entryId: chunk.entryId, part: chunk.part, logged: true })));
  assert.equal(values.at(-1).payload.code, 'INVALID_PAYLOAD');
  const entries = readFileSync(join(directory, 'logs', 'api-debug.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, parts);
  assert.equal(entries.map(entry => entry.data).join(''), event);
  assert.ok(entries.every(entry => entry.runId === 'debug-run' && Number.isFinite(Date.parse(entry.timestamp))));
  assert.equal(readFileSync(join(directory, 'logs', 'host.log'), 'utf8').includes('private chat'), false);
  assert.equal(JSON.stringify(values).includes('private chat'), false);
  assert.throws(() => readFileSync(join(directory, 'sync.db')), { code: 'ENOENT' });
});

test('API debug disk failures return LOG_ERROR rather than a successful acknowledgement', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-debug-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'logs', 'api-debug.jsonl'), { recursive: true });
  const { values, code } = await run(t, [frame(request('recordApiDebug', {
    runId: 'run-1', entryId: 'entry-1', part: 0, parts: 1, data: '{}',
  }))], { directory });
  assert.equal(code, 0);
  assert.equal(values[0].type, 'error');
  assert.equal(values[0].payload.code, 'LOG_ERROR');
});

test('split header, split body, multiple frames per chunk', async () => {
  const first = frame(request('ping'));
  const second = frame(request('getStatus'));
  const values = [];
  for await (const body of readFrames(Readable.from([
    first.subarray(0, 2), first.subarray(2, 7),
    Buffer.concat([first.subarray(7), second]),
  ]))) values.push(JSON.parse(body.toString()));
  assert.deepEqual(values.map(value => value.type), ['ping', 'getStatus']);
});

test('invalid JSON, malformed envelopes and unknown types return errors without stopping host', async t => {
  const { values, code } = await run(t, [Buffer.concat([
    frame('{'), frame(null), frame(request('bogus')), frame(request('echo', { data: 3 })),
    frame({ ...request('ping'), v: 2 }), frame(request('ping')),
  ])]);
  assert.equal(code, 0);
  assert.deepEqual(values.slice(0, 5).map(value => value.payload.code),
    ['INVALID_PAYLOAD', 'INVALID_PAYLOAD', 'UNKNOWN_TYPE', 'INVALID_PAYLOAD', 'PROTOCOL_MISMATCH']);
  assert.equal(values[5].type, 'ping.ok');
});

test('invalid UTF-8 is rejected and host continues', async t => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(1);
  const { values } = await run(t, [Buffer.concat([header, Buffer.from([255]), frame(request('ping'))])]);
  assert.equal(values[0].payload.code, 'INVALID_PAYLOAD');
  assert.equal(values[1].type, 'ping.ok');
});

test('wrong origin is refused before DB creation', async t => {
  const { values, code, directory } = await run(t, [], { origin: `chrome-extension://${'b'.repeat(32)}/` });
  assert.equal(code, 1);
  assert.equal(values[0].payload.code, 'FORBIDDEN_ORIGIN');
  assert.throws(() => readFileSync(join(directory, 'sync.db')), { code: 'ENOENT' });
});

test('hello bootstraps persistent WAL database; reconnect does not repeat migration', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-db-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const hello = frame(request('hello', { protocolVersion: 1, extVersion: 'test' }));
  const first = await run(t, [hello], { directory });
  const second = await run(t, [hello, frame(request('getStatus'))], { directory });
  assert.equal(first.code, 0);
  assert.equal(second.values[1].payload.schemaVersion, 5);
  assert.equal(first.values[0].payload.installId, second.values[0].payload.installId);
  const db = new DatabaseSync(join(directory, 'sync.db'));
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 5);
    assert.equal(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version).join(','), '1,2,3,4,5');
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'host_version'").get().value, '0.7.0');
  } finally { db.close(); }
});

test('schema migrations upgrade a version 1 database without replacing metadata', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-v1-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'sync.db');
  const oldDb = new DatabaseSync(dbPath);
  oldDb.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1, '2026-01-01T00:00:00.000Z');
    INSERT INTO meta VALUES ('install_id', 'preserved-install');
    INSERT INTO meta VALUES ('host_version', '0.1.0');
    INSERT INTO meta VALUES ('created_at', '2026-01-01T00:00:00.000Z');
  `);
  oldDb.close();

  const { values, code } = await run(t, [frame(request('hello', { protocolVersion: 1, extVersion: 'test' }))], { directory });
  assert.equal(code, 0);
  assert.equal(values[0].payload.schemaVersion, 5);
  const migrated = new DatabaseSync(dbPath);
  try {
    assert.equal(migrated.prepare("SELECT value FROM meta WHERE key = 'install_id'").get().value, 'preserved-install');
    assert.equal(migrated.prepare("SELECT value FROM meta WHERE key = 'host_version'").get().value, '0.7.0');
    assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 5);
    assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
    assert.equal(
      migrated.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'list_update_token'),
      true,
    );
  } finally { migrated.close(); }
});

test('single-chat protocol inserts, no-ops, updates, and preserves every branch', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-single-sync-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const account = { userId: 'user-1', workspaceId: 'workspace-1', email: 'user@example.test' };
  const raw = {
    conversation_id: 'chat-1', title: 'Initial title', create_time: 1, update_time: 2,
    current_node: 'assistant-new',
    mapping: {
      root: { parent: null, message: { id: 'root', author: { role: 'system' }, content: { parts: [] } } },
      user: { parent: 'root', message: { id: 'user', author: { role: 'user' }, content: { parts: ['Question'] } } },
      'assistant-old': { parent: 'user', message: { id: 'assistant-old', author: { role: 'assistant' }, content: { parts: ['Old answer'] } } },
      'assistant-new': { parent: 'user', message: { id: 'assistant-new', author: { role: 'assistant' }, content: { parts: ['New answer'] } } },
    },
  };
  const changed = structuredClone(raw);
  changed.title = 'Updated title';
  changed.mapping['assistant-new'].message.content.parts[0] = 'Updated answer';
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const messages = [
    request('beginRun', { runId: 'run-1', mode: 'single', account }),
    request('upsertConversation', { runId: 'run-1', conversationId: 'chat-1', raw, sha256: hash(raw) }),
    request('upsertConversation', { runId: 'run-1', conversationId: 'chat-1', raw, sha256: hash(raw) }),
    request('upsertConversation', { runId: 'run-1', conversationId: 'chat-1', raw: changed, sha256: hash(changed) }),
    request('endRun', { runId: 'run-1', cancelled: false, failures: [] }),
    request('getStatus'),
  ];
  const { values, code } = await run(t, messages.map(frame), { directory });
  assert.equal(code, 0);
  assert.deepEqual(values.slice(1, 4).map(value => value.payload.status), ['inserted', 'noop', 'updated']);
  assert.deepEqual(values[4].payload.counts, { listed: 1, new: 1, updated: 1, unchanged: 1, failed: 0 });
  assert.deepEqual(values[5].payload.counts, { conversations: 1, messages: 4, assets: 0, assetBytes: 0, assetsPending: 0 });
  const syncDiffLine = readFileSync(join(directory, 'logs', 'host.log'), 'utf8')
    .split(/\r?\n/).find(line => line.includes(' info SYNC_DIFF '));
  assert.ok(syncDiffLine);
  const syncDiff = JSON.parse(syncDiffLine.slice(syncDiffLine.indexOf('SYNC_DIFF ') + 'SYNC_DIFF '.length));
  assert.deepEqual(syncDiff, {
    schemaVersion: 1,
    changedPaths: [
      { path: 'mapping.*.message.content.parts[]', change: 'value-changed' },
      { path: 'title', change: 'value-changed' },
    ],
    truncated: false,
    noSemanticChanges: false,
    classification: 'full-update',
  });
  for (const privateValue of ['chat-1', 'assistant-new', 'Updated title', 'Updated answer', 'New answer']) {
    assert.equal(syncDiffLine.includes(privateValue), false);
  }

  const db = new DatabaseSync(join(directory, 'sync.db'));
  try {
    const branchRows = db.prepare('SELECT id, parent_id, is_on_active_branch FROM messages WHERE conversation_id = ? ORDER BY id')
      .all('chat-1').map(row => ({ ...row }));
    assert.deepEqual(branchRows, [
      { id: 'assistant-new', parent_id: 'user', is_on_active_branch: 1 },
      { id: 'assistant-old', parent_id: 'user', is_on_active_branch: 0 },
      { id: 'root', parent_id: null, is_on_active_branch: 1 },
      { id: 'user', parent_id: 'root', is_on_active_branch: 1 },
    ]);
    assert.equal(db.prepare('SELECT title FROM conversations WHERE id = ?').get('chat-1').title, 'Updated title');
  } finally { db.close(); }
});

test('safe_urls-only changes refresh raw data without rewriting message rows', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-safe-urls-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const account = { userId: 'user-1', workspaceId: 'workspace-1' };
  const raw = {
    conversation_id: 'chat-safe', title: 'Private title', update_time: 2,
    safe_urls: ['https://private.example/old'],
    mapping: {
      message: { parent: null, message: { id: 'message', author: { role: 'user' }, content: { parts: ['Private message'] } } },
    },
  };
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const inserted = await run(t, [
    frame(request('beginRun', { runId: 'run-insert', mode: 'single', account })),
    frame(request('upsertConversation', { runId: 'run-insert', conversationId: raw.conversation_id, raw, sha256: hash(raw) })),
    frame(request('endRun', { runId: 'run-insert', cancelled: false, failures: [] })),
  ], { directory });
  assert.equal(inserted.code, 0);

  const db = new DatabaseSync(join(directory, 'sync.db'));
  const originalRows = db.prepare('SELECT rowid, id, text FROM messages ORDER BY id').all().map(row => ({ ...row }));
  db.exec(`
    CREATE TRIGGER prevent_message_delete BEFORE DELETE ON messages
    BEGIN SELECT RAISE(ABORT, 'message row rewrite attempted'); END;
    CREATE TRIGGER prevent_message_insert BEFORE INSERT ON messages
    BEGIN SELECT RAISE(ABORT, 'message row rewrite attempted'); END;
  `);
  db.close();

  const metadataRaw = structuredClone(raw);
  metadataRaw.safe_urls = ['https://private.example/new'];
  const metadataUpdate = await run(t, [
    frame(request('beginRun', { runId: 'run-metadata', mode: 'single', account })),
    frame(request('upsertConversation', { runId: 'run-metadata', conversationId: raw.conversation_id, raw: metadataRaw, sha256: hash(metadataRaw) })),
    frame(request('endRun', { runId: 'run-metadata', cancelled: false, failures: [] })),
  ], { directory });
  assert.equal(metadataUpdate.code, 0);
  assert.deepEqual(metadataUpdate.values[1].payload, {
    conversationId: raw.conversation_id, status: 'updated', changeKind: 'metadata-only',
    messageCount: 1, newMessageCount: 0,
  });
  assert.deepEqual(metadataUpdate.values[2].payload.counts, {
    listed: 1, new: 0, updated: 1, unchanged: 0, failed: 0,
  });

  const unchanged = await run(t, [
    frame(request('beginRun', { runId: 'run-noop', mode: 'single', account })),
    frame(request('upsertConversation', { runId: 'run-noop', conversationId: raw.conversation_id, raw: metadataRaw, sha256: hash(metadataRaw) })),
    frame(request('endRun', { runId: 'run-noop', cancelled: false, failures: [] })),
  ], { directory });
  assert.equal(unchanged.code, 0);
  assert.deepEqual(unchanged.values[1].payload, {
    conversationId: raw.conversation_id, status: 'noop', messageCount: 1, newMessageCount: 0,
  });
  assert.deepEqual(unchanged.values[2].payload.counts, {
    listed: 1, new: 0, updated: 0, unchanged: 1, failed: 0,
  });

  const verifyDb = new DatabaseSync(join(directory, 'sync.db'));
  try {
    const stored = verifyDb.prepare('SELECT raw_json, raw_sha256 FROM conversations WHERE id = ?')
      .get(raw.conversation_id);
    assert.deepEqual(JSON.parse(stored.raw_json).safe_urls, metadataRaw.safe_urls);
    assert.equal(stored.raw_sha256, hash(metadataRaw));
    assert.deepEqual(
      verifyDb.prepare('SELECT rowid, id, text FROM messages ORDER BY id').all().map(row => ({ ...row })),
      originalRows,
    );
  } finally { verifyDb.close(); }

  const log = readFileSync(join(directory, 'logs', 'host.log'), 'utf8');
  const diffLine = log.split(/\r?\n/).find(line => line.includes(' info SYNC_DIFF '));
  assert.ok(diffLine);
  const diff = JSON.parse(diffLine.slice(diffLine.indexOf('SYNC_DIFF ') + 'SYNC_DIFF '.length));
  assert.deepEqual(diff.changedPaths, [{ path: 'safe_urls[]', change: 'value-changed' }]);
  assert.equal(diff.classification, 'metadata-only');
  for (const privateValue of ['chat-safe', 'Private title', 'Private message', ...raw.safe_urls, ...metadataRaw.safe_urls]) {
    assert.equal(diffLine.includes(privateValue), false);
  }
});

test('upsert reports newly inserted message IDs rather than total message count', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-new-message-count-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const account = { userId: 'user-1', workspaceId: 'workspace-1' };
  const raw = {
    conversation_id: 'chat-count',
    mapping: {
      messageOne: {
        parent: null,
        message: { id: 'message-one', author: { role: 'user' }, content: { parts: ['one'] } },
      },
    },
  };
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const initial = await run(t, [
    frame(request('beginRun', { runId: 'new-chat', mode: 'single', account })),
    frame(request('upsertConversation', {
      runId: 'new-chat', conversationId: raw.conversation_id, raw, sha256: hash(raw),
    })),
    frame(request('endRun', { runId: 'new-chat', cancelled: false, failures: [] })),
  ], { directory });
  assert.equal(initial.values[1].payload.newMessageCount, 1);
  assert.equal(initial.values[1].payload.messageCount, 1);

  const updatedRaw = structuredClone(raw);
  updatedRaw.mapping.messageTwo = {
    parent: 'message-one',
    message: { id: 'message-two', author: { role: 'assistant' }, content: { parts: ['two'] } },
  };
  const updated = await run(t, [
    frame(request('beginRun', { runId: 'new-message', mode: 'single', account })),
    frame(request('upsertConversation', {
      runId: 'new-message', conversationId: raw.conversation_id,
      raw: updatedRaw, sha256: hash(updatedRaw),
    })),
    frame(request('endRun', { runId: 'new-message', cancelled: false, failures: [] })),
  ], { directory });
  assert.equal(updated.values[1].payload.newMessageCount, 1);
  assert.equal(updated.values[1].payload.messageCount, 2);
});

test('incremental manifest compares list tokens and advances them only after successful upsert', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-manifest-sync-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const account = { userId: 'user-1', workspaceId: 'workspace-1' };
  const raw = { conversation_id: 'chat-1', mapping: {} };
  const sha256 = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
  await run(t, [
    frame(request('beginRun', { runId: 'seed', mode: 'single', account })),
    frame(request('upsertConversation', { runId: 'seed', conversationId: 'chat-1', raw, sha256 })),
    frame(request('endRun', { runId: 'seed', cancelled: false, failures: [] })),
  ], { directory });

  const first = await run(t, [
    frame(request('beginRun', { runId: 'first', mode: 'incremental', account })),
    frame(request('diffManifest', {
      runId: 'first', items: [{ conversationId: 'chat-1', updateTimeToken: 's:updated' }],
    })),
    frame(request('upsertConversation', {
      runId: 'first', conversationId: 'chat-1', raw, sha256, manifestUpdateToken: 's:updated',
    })),
    frame(request('endRun', { runId: 'first', cancelled: false, failures: [] })),
  ], { directory });
  assert.equal(first.values[1].type, 'diffManifest.ok');
  assert.deepEqual(first.values[1].payload, {
    listed: 1, unchanged: 0,
    changed: [{ conversationId: 'chat-1', updateTimeToken: 's:updated' }],
  });
  assert.equal(first.values[2].payload.status, 'noop');
  assert.deepEqual(first.values[3].payload.counts, {
    listed: 1, new: 0, updated: 0, unchanged: 1, failed: 0,
  });

  const unchanged = await run(t, [
    frame(request('beginRun', { runId: 'same-token', mode: 'incremental', account })),
    frame(request('diffManifest', {
      runId: 'same-token', items: [{ conversationId: 'chat-1', updateTimeToken: 's:updated' }],
    })),
    frame(request('endRun', { runId: 'same-token', cancelled: false, failures: [] })),
  ], { directory });
  assert.deepEqual(unchanged.values[1].payload, { listed: 1, unchanged: 1, changed: [] });
  assert.deepEqual(unchanged.values[2].payload.counts, {
    listed: 1, new: 0, updated: 0, unchanged: 1, failed: 0,
  });

  const failed = await run(t, [
    frame(request('beginRun', { runId: 'failed-fetch', mode: 'incremental', account })),
    frame(request('diffManifest', {
      runId: 'failed-fetch', items: [{ conversationId: 'chat-1', updateTimeToken: 's:retry' }],
    })),
    frame(request('endRun', {
      runId: 'failed-fetch', cancelled: false,
      failures: [{ conversationId: 'chat-1', error: 'fetch failed', retryable: true }],
    })),
    frame(request('beginRun', { runId: 'retry', mode: 'incremental', account })),
    frame(request('diffManifest', {
      runId: 'retry', items: [{ conversationId: 'chat-1', updateTimeToken: 's:retry' }],
    })),
    frame(request('endRun', { runId: 'retry', cancelled: false, failures: [] })),
  ], { directory });
  assert.deepEqual(failed.values[4].payload, {
    listed: 1, unchanged: 0,
    changed: [{ conversationId: 'chat-1', updateTimeToken: 's:retry' }],
  });
  const db = new DatabaseSync(join(directory, 'sync.db'));
  try {
    assert.equal(db.prepare('SELECT list_update_token FROM conversations WHERE id = ?').get('chat-1').list_update_token, 's:updated');
  } finally { db.close(); }
});

test('single and incremental runs share the account writer lock; manifest payloads are bounded', async t => {
  const { values } = await run(t, [
    frame(request('beginRun', {
      runId: 'single-active', mode: 'single', account: { userId: 'user-1', workspaceId: 'workspace-1' },
    })),
    frame(request('beginRun', {
      runId: 'incremental-blocked', mode: 'incremental',
      account: { userId: 'user-1', workspaceId: 'workspace-1' },
    })),
    frame(request('endRun', { runId: 'single-active', cancelled: false, failures: [] })),
    frame(request('beginRun', {
      runId: 'incremental-active', mode: 'incremental',
      account: { userId: 'user-1', workspaceId: 'workspace-1' },
    })),
    frame(request('diffManifest', {
      runId: 'incremental-active',
      items: [
        { conversationId: 'chat-1', updateTimeToken: 's:one' },
        { conversationId: 'chat-1', updateTimeToken: 's:two' },
      ],
    })),
    frame(request('endRun', { runId: 'incremental-active', cancelled: false, failures: [] })),
  ]);
  assert.equal(values[1].payload.code, 'BUSY');
  assert.equal(values[3].type, 'beginRun.ok');
  assert.equal(values[4].payload.code, 'INVALID_PAYLOAD');
});

test('single-chat protocol rejects hash mismatch and concurrent account runs', async t => {
  const account = { userId: 'user-1', workspaceId: 'workspace-1' };
  const { values, code } = await run(t, [
    frame(request('beginRun', { runId: 'run-1', mode: 'single', account })),
    frame(request('beginRun', { runId: 'run-2', mode: 'single', account })),
    frame(request('upsertConversation', {
      runId: 'run-1', conversationId: 'chat-1',
      raw: { conversation_id: 'chat-1', mapping: {} }, sha256: '0'.repeat(64),
    })),
    frame(request('endRun', { runId: 'run-1', cancelled: false, failures: [] })),
  ]);
  assert.equal(code, 0);
  assert.equal(values[1].payload.code, 'BUSY');
  assert.equal(values[2].payload.code, 'INVALID_PAYLOAD');
  assert.equal(values[3].type, 'endRun.ok');
});

test('a conversation cannot be reassigned to another account', async t => {
  const accountA = { userId: 'user-1', workspaceId: 'workspace-1' };
  const accountB = { userId: 'user-2', workspaceId: 'workspace-2' };
  const raw = { conversation_id: 'chat-1', mapping: {} };
  const sha256 = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
  const { values, code } = await run(t, [
    frame(request('beginRun', { runId: 'run-a', mode: 'single', account: accountA })),
    frame(request('upsertConversation', { runId: 'run-a', conversationId: 'chat-1', raw, sha256 })),
    frame(request('endRun', { runId: 'run-a', cancelled: false, failures: [] })),
    frame(request('beginRun', { runId: 'run-b', mode: 'single', account: accountB })),
    frame(request('upsertConversation', { runId: 'run-b', conversationId: 'chat-1', raw, sha256 })),
    frame(request('endRun', { runId: 'run-b', cancelled: false, failures: [{ conversationId: 'chat-1', error: 'Scope mismatch', retryable: false }] })),
  ]);
  assert.equal(code, 0);
  assert.equal(values[4].payload.code, 'ACCOUNT_MISMATCH');
  assert.equal(values[5].payload.status, 'failed');
});

test('conversation and message writes roll back together on a constraint failure', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-rollback-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const account = { userId: 'user-1', workspaceId: 'workspace-1' };
  const raw = {
    conversation_id: 'chat-1',
    mapping: {
      first: { parent: null, message: { id: 'duplicate', author: { role: 'user' }, content: { parts: ['One'] } } },
      second: { parent: 'first', message: { id: 'duplicate', author: { role: 'assistant' }, content: { parts: ['Two'] } } },
    },
  };
  const sha256 = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
  const { values, code } = await run(t, [
    frame(request('beginRun', { runId: 'run-1', mode: 'single', account })),
    frame(request('upsertConversation', { runId: 'run-1', conversationId: 'chat-1', raw, sha256 })),
    frame(request('endRun', { runId: 'run-1', cancelled: false, failures: [{ conversationId: 'chat-1', error: 'Storage failed', retryable: false }] })),
  ], { directory });
  assert.equal(code, 0);
  assert.equal(values[1].payload.code, 'DB_ERROR');
  assert.match(readFileSync(join(directory, 'logs', 'host.log'), 'utf8'), /Database request failed/);
  const db = new DatabaseSync(join(directory, 'sync.db'));
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  } finally { db.close(); }
});

test('host shutdown marks its interrupted run failed and releases the account lock', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-interrupted-run-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const account = { userId: 'user-1', workspaceId: 'workspace-1' };
  const first = await run(t, [
    frame(request('beginRun', { runId: 'run-abandoned', mode: 'single', account })),
  ], { directory });
  assert.equal(first.code, 0);

  const second = await run(t, [
    frame(request('beginRun', { runId: 'run-retry', mode: 'single', account })),
    frame(request('endRun', { runId: 'run-retry', cancelled: false, failures: [] })),
  ], { directory });
  assert.equal(second.values[0].type, 'beginRun.ok');
  const db = new DatabaseSync(join(directory, 'sync.db'));
  try {
    assert.equal(db.prepare("SELECT status FROM sync_runs WHERE id = 'run-abandoned'").get().status, 'failed');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sync_failures WHERE run_id = 'run-abandoned'").get().n, 1);
  } finally { db.close(); }
});

test('ping still works with a broken DB; hello returns explicit DB_ERROR', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-bad-db-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'sync.db'), 'not a database');
  const { values, code } = await run(t, [
    frame(request('ping')), frame(request('hello', { protocolVersion: 1, extVersion: 'test' })),
  ], { directory });
  assert.equal(code, 0);
  assert.equal(values[0].type, 'ping.ok');
  assert.equal(values[1].payload.code, 'DB_ERROR');
  assert.match(readFileSync(join(directory, 'logs', 'host.log'), 'utf8'), /Database request failed/);
});

test('framing enforces limits and detects truncated streams', async () => {
  for (const size of [0, MAX_EXT_TO_HOST_BYTES + 1]) {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(size);
    await assert.rejects(async () => { for await (const _ of readFrames(Readable.from([header]))) {} }, /frame size/);
  }
  await assert.rejects(async () => {
    for await (const _ of readFrames(Readable.from([frame(request('ping')).subarray(0, 6)]))) {}
  }, /Truncated/);
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  assert.throws(() => writeFrame(sink, 'x'.repeat(MAX_HOST_TO_EXT_BYTES)), /exceeds/);
});

test('console output is redirected to file, not stdout', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-log-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'logs'));
  const logger = new URL('../../local-app/host/log.ts', import.meta.url).href;
  const script = `import { configureLogging } from ${JSON.stringify(logger)}; configureLogging(${JSON.stringify(directory)}); console.log('test noise');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
  let stdout = '';
  child.stdout.on('data', data => { stdout += data; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.equal(stdout, '');
  assert.match(readFileSync(join(directory, 'logs', 'host.log'), 'utf8'), /test noise/);
});
