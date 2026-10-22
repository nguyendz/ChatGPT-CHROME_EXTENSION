import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import { Archive, ViewerError, pageLimit } from '../../local-app/viewer/archive.ts';
import { startViewer } from '../../local-app/viewer/server.ts';
import { seedViewer, writeConversation, simpleRaw, scopeA, digest } from '../fixtures/viewer-archive.mjs';
import { openDatabase } from '../../local-app/host/db.ts';

const resources = new Map();
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'chatgpt-viewer-'));
  const closers = [];
  resources.set(path, closers);
  t.after(async () => {
    try { for (const close of closers.reverse()) await close(); }
    finally {
      resources.delete(path);
      rmSync(path, { recursive: true, force: true });
    }
  });
  return path;
}
function fixture(t, extras = 0) {
  const path = directory(t);
  const seeded = seedViewer(path, extras);
  const archive = new Archive(path);
  resources.get(path).push(() => archive.close());
  return { path, archive, ...seeded };
}
function unchanged(path) {
  const db = new DatabaseSync(join(path, 'sync.db'), { readOnly: true });
  try {
    return JSON.stringify(['schema_migrations', 'meta', 'accounts', 'conversations', 'messages', 'sync_runs', 'sync_failures']
      .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  } finally { db.close(); }
}

test('viewer opens the existing archive read-only, without startup maintenance or schema changes', t => {
  const { path, archive, accountA } = fixture(t);
  const before = unchanged(path);
  const status = archive.status();
  assert.equal(status.conversations, 3);
  assert.equal(typeof status.lastSyncAt, 'string');
  assert.equal(archive.accounts().length, 2);
  assert.equal(archive.accounts().find(account => account.id === accountA).conversationCount, 2);
  const detail = archive.detail(accountA, 'branch-chat');
  archive.messages(accountA, 'branch-chat', detail.revision, 100, null);
  archive.list(accountA, 50, null);
  for (const group of archive.groups(accountA)) archive.list(accountA, 50, null, group.id);
  assert.equal(unchanged(path), before);
});

test('missing and incompatible archives fail explicitly without creating a DB', t => {
  const path = directory(t);
  assert.throws(() => new Archive(path));
  assert.equal(existsSync(join(path, 'sync.db')), false);
  seedViewer(path);
  const db = new DatabaseSync(join(path, 'sync.db'));
  db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(5, 'synthetic');
  db.close();
  assert.throws(() => new Archive(path), error => error instanceof ViewerError && error.code === 'INCOMPATIBLE_SCHEMA');
});

test('list cursors retain stable timestamp/id ordering including null dates and enforce account scope', t => {
  const { archive, accountA, accountB } = fixture(t, 55);
  const rows = [];
  let cursor = null;
  do {
    const page = archive.list(accountA, 7, cursor);
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(rows.length, 57);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.equal(rows[0].id, 'long-chat');
  const expected = [...rows].sort((a, b) => {
    if (a.updateTime === null && b.updateTime !== null) return 1;
    if (b.updateTime === null && a.updateTime !== null) return -1;
    return (b.updateTime ?? 0) - (a.updateTime ?? 0) || a.id.localeCompare(b.id);
  });
  assert.deepEqual(rows, expected);
  assert.equal(rows.find(row => row.id === 'extra-000').title, null);
  const foreignCursor = archive.list(accountA, 1, null).nextCursor;
  assert.throws(() => archive.list(accountB, 1, foreignCursor), /cursor.*account/);
  assert.throws(() => archive.detail(accountB, 'branch-chat'), /not found/);
  assert.throws(() => archive.list("a' OR 1=1 --", 1, null), /not found/);
  assert.throws(() => archive.list(accountA, 5, 'not-json'), /Invalid page cursor/);
  for (const invalid of ['0', '-1', '101', '1.5', 'hello', '']) assert.throws(() => pageLimit(invalid, 50, 100));
  assert.equal(pageLimit('200', 100, 200), 200);
  assert.throws(() => pageLimit('201', 100, 200));
});

test('an existing empty archive is distinct from a missing or failed archive', t => {
  const path = directory(t);
  const writer = openDatabase(path);
  writer.close();
  const archive = new Archive(path);
  try {
    assert.deepEqual(archive.status(), { schemaVersion: 4, accounts: 0, conversations: 0, messages: 0, lastSyncAt: null });
    assert.deepEqual(archive.accounts(), []);
  } finally { archive.close(); }
});

test('project folders classify saved root metadata and keep custom GPTs and unknown markers separate', t => {
  const { archive, path, accountA, accountB } = fixture(t, 55);
  const before = unchanged(path);
  const groups = archive.groups(accountA);
  assert.deepEqual(groups, [
    { id: 'all', kind: 'all', label: 'All conversations', conversationCount: 57 },
    { id: 'project:g-p-fixture-a', kind: 'project', label: 'Unnamed project 1', conversationCount: 2 },
    { id: 'project:g-p-fixture-b', kind: 'project', label: 'Unnamed project 2', conversationCount: 1 },
    { id: 'gpt:g-fixture-assistant', kind: 'gpt', label: 'Unnamed custom GPT 1', conversationCount: 1 },
    { id: 'unmarked', kind: 'unmarked', label: 'No project marker', conversationCount: 52 },
    { id: 'other', kind: 'other', label: 'Other marked chats', conversationCount: 1 },
  ]);
  assert.equal(groups.slice(1).reduce((sum, group) => sum + group.conversationCount, 0), groups[0].conversationCount);
  assert.deepEqual(archive.list(accountA, 50, null, 'gpt:g-fixture-assistant').items.map(chat => chat.id), ['extra-000']);
  assert.deepEqual(archive.list(accountA, 50, null, 'other').items.map(chat => chat.id), ['extra-001']);
  assert.equal(archive.groups(accountB).find(group => group.kind === 'project').conversationCount, 1);
  assert.deepEqual(archive.list(accountB, 50, null, 'project:g-p-fixture-a').items.map(chat => chat.id), ['other-account-chat']);
  assert.throws(() => archive.list(accountB, 50, null, 'project:g-p-fixture-b'), /folder not found/);
  assert.throws(() => archive.groups('missing-account'), /account not found/);
  assert.throws(() => archive.list(accountA, 50, null, "project:' OR 1=1 --"), /folder not found/);
  assert.equal(unchanged(path), before);
});

test('folder cursors are scoped to both folder and account, including null timestamp boundaries', t => {
  const { archive, accountA, accountB } = fixture(t, 55);
  const first = archive.list(accountA, 1, null, 'project:g-p-fixture-a');
  assert.ok(first.nextCursor);
  const next = archive.list(accountA, 1, first.nextCursor, 'project:g-p-fixture-a');
  assert.deepEqual([...first.items, ...next.items].map(chat => chat.id), ['branch-chat', 'extra-003']);
  assert.equal(next.nextCursor, null);
  assert.throws(() => archive.list(accountA, 1, first.nextCursor), /cursor.*folder/);
  assert.throws(() => archive.list(accountA, 1, first.nextCursor, 'unmarked'), /cursor.*folder/);
  assert.throws(() => archive.list(accountB, 1, first.nextCursor, 'project:g-p-fixture-a'), /cursor.*account/);
  const allCursor = archive.list(accountA, 1, null).nextCursor;
  assert.throws(() => archive.list(accountA, 1, allCursor, 'project:g-p-fixture-a'), /cursor.*folder/);
});

test('historical per-message markers are not treated as current project membership', t => {
  const path = directory(t);
  const raw = simpleRaw('historical-only');
  raw.mapping['node-0'].message.metadata = { gizmo_id: 'g-p-old-project' };
  const account = writeConversation(path, raw);
  const explicit = simpleRaw('explicit-unclassified');
  explicit.project_id = 'not-yet-classified';
  writeConversation(path, explicit);
  const archive = new Archive(path);
  try {
    const groups = archive.groups(account);
    assert.equal(groups.some(group => group.kind === 'project'), false);
    assert.deepEqual(archive.list(account, 50, null, 'unmarked').items.map(chat => chat.id), ['historical-only']);
    assert.deepEqual(archive.list(account, 50, null, 'other').items.map(chat => chat.id), ['explicit-unclassified']);
  } finally { archive.close(); }
});

test('active transcript uses mapping ancestry, not message IDs, timestamps, or inactive branches', t => {
  const { archive, accountA, revision } = fixture(t);
  const detail = archive.detail(accountA, 'branch-chat');
  assert.equal(detail.activeMessageCount, 3);
  assert.equal(detail.otherMessageCount, 1);
  assert.deepEqual(detail.warnings, []);
  const page = archive.messages(accountA, 'branch-chat', revision, 100, null);
  assert.deepEqual(page.items.map(item => item.id), ['branch-chat-message-0', 'branch-chat-message-1', 'branch-tool']);
  assert.deepEqual(page.items.map(item => item.role), ['user', 'assistant', 'tool']);
  assert.equal(page.items[2].unsupportedContent, true);
  assert.equal(page.items.some(item => item.text.includes('INACTIVE BRANCH')), false);
  assert.ok(page.items[0].text.includes('<script>'));
});

test('message pagination is lossless and detects a changed revision after concurrent host sync', t => {
  const { path, archive, accountA } = fixture(t);
  const detail = archive.detail(accountA, 'long-chat');
  let cursor = null;
  const ids = [];
  do {
    const page = archive.messages(accountA, 'long-chat', detail.revision, 100, cursor);
    ids.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 205);
  assert.equal(new Set(ids).size, 205);
  const page = archive.messages(accountA, 'long-chat', detail.revision, 1, null);
  assert.throws(() => archive.messages(accountA, 'branch-chat', archive.detail(accountA, 'branch-chat').revision, 100, page.nextCursor), /message cursor/);
  writeConversation(path, simpleRaw('long-chat', 206), scopeA, 'concurrent-sync');
  assert.throws(() => archive.messages(accountA, 'long-chat', detail.revision, 100, page.nextCursor),
    error => error instanceof ViewerError && error.code === 'STALE_REVISION');
  assert.equal(archive.detail(accountA, 'long-chat').activeMessageCount, 206);
});

test('invalid active paths have visible warnings instead of timestamp or partial-path fallbacks', t => {
  const path = directory(t);
  for (const [index, change] of [
    raw => { raw.current_node = null; },
    raw => { raw.current_node = 'missing'; },
    raw => { raw.mapping['node-0'].parent = 'node-1'; },
    raw => { raw.mapping['node-0'].parent = 'missing-parent'; },
  ].entries()) {
    const raw = simpleRaw(`invalid-${index}`, 2);
    change(raw);
    const accountId = writeConversation(path, raw);
    const archive = new Archive(path);
    try {
      const detail = archive.detail(accountId, raw.conversation_id);
      assert.equal(detail.activeMessageCount, 0);
      assert.equal(detail.warnings.length, 1);
      assert.deepEqual(archive.messages(accountId, raw.conversation_id, digest(raw), 100, null).items, []);
    } finally { archive.close(); }
  }
});

async function serverFixture(t) {
  const path = directory(t);
  const seed = seedViewer(path);
  const ui = join(path, 'ui');
  mkdirSync(ui);
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>Synthetic viewer</title>');
  const viewer = await startViewer({ directory: path, uiDirectory: ui });
  resources.get(path).push(() => viewer.close());
  return { path, ...seed, ...viewer };
}
function requestHeaders(viewer) { return { Authorization: `Bearer ${viewer.token}` }; }

test('loopback server serves only authenticated scoped reads with private-response headers', async t => {
  const viewer = await serverFixture(t);
  assert.ok(viewer.origin.startsWith('http://127.0.0.1:'));
  assert.match(viewer.url, /#token=[a-f0-9]{64}$/);
  const unauthenticated = await fetch(`${viewer.origin}/api/status`);
  assert.equal(unauthenticated.status, 401);
  assert.equal((await fetch(`${viewer.origin}/api/groups?accountId=${encodeURIComponent(viewer.accountA)}`)).status, 401);
  const folders = await fetch(`${viewer.origin}/api/groups?accountId=${encodeURIComponent(viewer.accountA)}`, { headers: requestHeaders(viewer) });
  assert.equal(folders.status, 200);
  assert.ok((await folders.json()).some(group => group.id === 'project:g-p-fixture-a'));
  const grouped = await fetch(`${viewer.origin}/api/conversations?accountId=${encodeURIComponent(viewer.accountA)}&group=project%3Ag-p-fixture-a`, { headers: requestHeaders(viewer) });
  assert.equal(grouped.status, 200);
  assert.deepEqual((await grouped.json()).items.map(chat => chat.id), ['branch-chat']);
  const response = await fetch(`${viewer.origin}/api/status`, { headers: requestHeaders(viewer) });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.conversations, 3);
  assert.equal(typeof status.lastSyncAt, 'string');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(viewer.origin)).status, 200);
  for (const [path, status] of [
    ['/api/conversations', 400],
    ['/api/groups', 400],
    ['/api/groups?accountId=missing', 404],
    [`/api/conversations?accountId=${encodeURIComponent(viewer.accountA)}&group=`, 400],
    [`/api/conversations?accountId=${encodeURIComponent(viewer.accountA)}&group=project%3Ag-p-missing`, 404],
    [`/api/conversations?accountId=${encodeURIComponent(viewer.accountA)}&limit=101`, 400],
    [`/api/conversations?accountId=${encodeURIComponent(viewer.accountA)}&limit=1&limit=2`, 400],
    [`/api/conversations/branch-chat?accountId=${encodeURIComponent(viewer.accountB)}`, 404],
    [`/api/conversations/branch-chat/messages?accountId=${encodeURIComponent(viewer.accountA)}&revision=wrong`, 400],
    ['/api/unknown', 404],
    ['/server.ts', 404],
    ['/%2e%2e%5cserver.ts', 404],
  ]) assert.equal((await fetch(viewer.origin + path, { headers: requestHeaders(viewer) })).status, status, path);
  assert.equal((await fetch(`${viewer.origin}/api/status`, { method: 'POST', headers: requestHeaders(viewer) })).status, 405);
  assert.equal((await fetch(`${viewer.origin}/api/status`, { headers: { ...requestHeaders(viewer), Origin: 'https://foreign.test' } })).status, 403);
  assert.equal((await fetch(`${viewer.origin}/api/status`, { headers: { ...requestHeaders(viewer), 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const badHost = await new Promise((accept, reject) => {
    const request = http.get(`${viewer.origin}/api/status`, { headers: { ...requestHeaders(viewer), Host: 'foreign.test' } }, response => {
      response.resume(); accept(response.statusCode);
    });
    request.once('error', reject);
  });
  assert.equal(badHost, 403);
});

test('server read errors and size limits are explicit, never empty success or truncated content', async t => {
  const viewer = await serverFixture(t);
  const raw = simpleRaw('large-message');
  raw.mapping['node-0'].message.content.parts = ['x'.repeat(9 * 1024 * 1024)];
  writeConversation(viewer.path, raw);
  const url = `${viewer.origin}/api/conversations/large-message/messages?accountId=${encodeURIComponent(viewer.accountA)}&revision=${digest(raw)}`;
  const response = await fetch(url, { headers: requestHeaders(viewer) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'TOO_LARGE');
});

test('missing UI build fails with a runnable build instruction', async t => {
  const path = directory(t);
  seedViewer(path);
  await assert.rejects(startViewer({ directory: path, uiDirectory: join(path, 'missing') }), /viewer:build/);
});

test('viewer reads do not finalize another host active run', t => {
  const { path, archive } = fixture(t);
  const host = openDatabase(path);
  try {
    host.beginRun('still-running', 'incremental', scopeA);
    archive.status();
    archive.accounts();
    const db = new DatabaseSync(join(path, 'sync.db'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT status FROM sync_runs WHERE id = ?').get('still-running').status, 'running'); }
    finally { db.close(); }
    host.endRun('still-running', false, []);
  } finally { host.close(); }
});

test('fixture target: 1,000 chats and 50,000 messages have bounded first-page reads', t => {
  const path = directory(t);
  const host = openDatabase(path);
  let account;
  try {
    account = host.beginRun('performance', 'incremental', scopeA).accountId;
    for (let index = 0; index < 1000; index++) {
      const raw = simpleRaw(`perf-${index}`, 50);
      host.upsertConversation('performance', raw.conversation_id, raw, digest(raw));
    }
    host.endRun('performance', false, []);
  } finally { host.close(); }
  const archive = new Archive(path);
  try {
    const started = performance.now();
    const page = archive.list(account, 50, null);
    const listMs = performance.now() - started;
    const detail = archive.detail(account, page.items[0].id);
    const messageStart = performance.now();
    const messages = archive.messages(account, detail.id, detail.revision, 100, null);
    const messageMs = performance.now() - messageStart;
    assert.equal(archive.status().conversations, 1000);
    assert.equal(archive.status().messages, 50000);
    assert.equal(page.items.length, 50);
    assert.equal(messages.items.length, 50);
    assert.ok(listMs < 1000, `List took ${listMs.toFixed(1)} ms`);
    assert.ok(messageMs < 1000, `Messages took ${messageMs.toFixed(1)} ms`);
    t.diagnostic(`1,000 chats / 50,000 messages: list ${listMs.toFixed(1)} ms; message page ${messageMs.toFixed(1)} ms`);
  } finally { archive.close(); }
});
