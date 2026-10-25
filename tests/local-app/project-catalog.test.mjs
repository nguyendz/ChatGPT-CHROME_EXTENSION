import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../local-app/host/db.ts';
import { handleRequest } from '../../local-app/host/handlers.ts';
import { Archive } from '../../local-app/viewer/archive.ts';
import {
  MAX_PROJECT_BYTES, MAX_PROJECT_CATALOG_BYTES, ProjectCatalogError, checkProjectCatalogSize,
  projectItemJson, projectMetadata, projectSidebarPage,
} from '../../lib/project-catalog.ts';
import { collectProjectCatalog } from '../../lib/sync/projects.ts';
import { syncAllConversations } from '../../lib/sync/all-chat.ts';
import { isResponsePayload, isProjectSyncOutcome } from '../../lib/sync/protocol.ts';
import { projectCaptureShape, projectRaw, projectItem } from '../fixtures/project-catalog.mjs';
import { simpleRaw } from '../fixtures/viewer-archive.mjs';

const account = { userId: 'catalog-user', workspaceId: 'catalog-workspace' };
const accountId = JSON.stringify([account.userId, account.workspaceId]);
const complete = count => ({ status: 'completed', count });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-projects-'));
  const db = openDatabase(directory);
  const reader = new DatabaseSync(join(directory, 'sync.db'));
  let closed = false;
  const closeOwner = () => { if (!closed) { db.close(); closed = true; } };
  t.after(() => { reader.close(); closeOwner(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, db, reader, closeOwner };
}

test('sidebar contract accepts the captured shape without importing nested previews', async t => {
  const { db, reader } = fixture(t);
  const page = projectCaptureShape();
  assert.equal(page.items.flatMap(item => item.conversations.items).length, 31);
  assert.equal(page.items.filter(item => item.conversations.cursor !== null).length, 5);
  let calls = 0;
  const events = [];
  const items = await collectProjectCatalog('run-capture', account, async cursor => {
    assert.equal(cursor, null);
    calls++;
    return page;
  }, async event => { events.push(event); });
  db.beginRun('run-capture', 'incremental', account, true);
  assert.deepEqual(db.commitProjectCatalog('run-capture', items), { count: 7 });
  assert.equal(db.endRun('run-capture', false, [], complete(7)).status, 'completed');
  assert.equal(calls, 1);
  assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 7);
  for (const table of ['conversations', 'messages']) {
    assert.equal(reader.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
  assert.equal(JSON.stringify(events).includes('Synthetic'), false);
  assert.equal(JSON.stringify(events).includes('opaque'), false);
});

test('root paging handles short/empty pages with opaque cursors and does not follow nested cursors', async () => {
  const calls = [];
  const pages = [
    { items: [projectRaw('g-p-one')], cursor: 'next' },
    { items: [], cursor: 'last' },
    { items: [projectRaw('g-p-two')], cursor: null },
  ];
  const result = await collectProjectCatalog('pages', account, async cursor => {
    calls.push(cursor); return pages[calls.length - 1];
  }, async () => {});
  assert.deepEqual(calls, [null, 'next', 'last']);
  assert.equal(result.length, 2);
});

test('duplicate IDs and cursor loops restart once, then fail rather than commit incomplete data', async () => {
  for (const variant of ['id', 'cursor']) {
    let starts = 0;
    await assert.rejects(collectProjectCatalog('duplicate', account, async cursor => {
      if (cursor === null) starts++;
      return { items: [projectRaw(variant === 'id' || cursor === null ? 'g-p-one' : 'g-p-two')], cursor: 'repeat' };
    }, async () => {}), error => error.category === 'unstable-pagination');
    assert.equal(starts, 2);
  }
});

test('enumeration rejects workspace mismatch, cancellation, page limits and logging failures', async () => {
  await assert.rejects(collectProjectCatalog('scope', account, async () => ({
    items: [projectRaw('g-p-one', 'Other', { workspace_id: 'other-workspace' })], cursor: null,
  }), async () => {}), error => error.category === 'account-mismatch');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collectProjectCatalog('cancel', account, async () => assert.fail(), async () => {}, controller.signal),
    error => error.name === 'AbortError');
  let calls = 0;
  await assert.rejects(collectProjectCatalog('limit', account, async () => ({ items: [], cursor: `page-${++calls}` }),
    async () => {}), error => error.category === 'size-limit');
  assert.equal(calls, 100);
  await assert.rejects(collectProjectCatalog('log', account, async () => ({ items: [], cursor: null }),
    async () => { throw new Error('log failure'); }), /log failure/);
});

test('contract rejects malformed fields but preserves unknown optional metadata', () => {
  const raw = projectRaw();
  raw.unknown = { future: [1, 2] };
  assert.equal(projectSidebarPage({ items: [raw], cursor: null }).items[0], raw);
  for (const value of [
    {}, { items: [] }, { items: [], cursor: 0 }, { items: [], cursor: '' },
    { items: Array.from({ length: 21 }, () => raw), cursor: null },
    { items: [projectRaw('g-p-one', '')], cursor: null },
    { items: [projectRaw('g-p-one', 'Name', { updated_at: 'not-a-time' })], cursor: null },
    { items: [projectRaw('g-one')], cursor: null },
    { items: [projectRaw('g-p-one', 'Name', { is_archived: 'false' })], cursor: null },
  ]) assert.throws(() => projectSidebarPage(value), ProjectCatalogError);
  const bad = projectRaw();
  bad.conversations.items = [{ id: 'chat-one', gizmo_id: 'g-p-other' }];
  assert.throws(() => projectMetadata(bad), ProjectCatalogError);
});

test('UTF-8 item and complete request bounds include envelope overhead and reject immediately above limits', () => {
  const raw = { filler: '' };
  raw.filler = 'x'.repeat(MAX_PROJECT_BYTES - Buffer.byteLength(JSON.stringify(raw)));
  assert.equal(Buffer.byteLength(projectItemJson(raw)), MAX_PROJECT_BYTES);
  raw.filler += 'x';
  assert.throws(() => projectItemJson(raw), error => error.category === 'size-limit');
  const unicode = { filler: 'é'.repeat(MAX_PROJECT_BYTES / 2) };
  assert.throws(() => projectItemJson(unicode), error => error.category === 'size-limit');
  const items = [{ raw: { filler: '' }, sha256: 'a'.repeat(64) }];
  const envelope = () => JSON.stringify({ v: 1, id: 'x'.repeat(128), type: 'commitProjectCatalog', payload: { runId: 'bound', items } });
  items[0].raw.filler = 'x'.repeat(MAX_PROJECT_CATALOG_BYTES - Buffer.byteLength(envelope()));
  checkProjectCatalogSize('bound', items);
  items[0].raw.filler += 'x';
  assert.throws(() => checkProjectCatalogSize('bound', items), error => error.category === 'size-limit');
});

test('catalog writes are atomic, hashed, run-owned and account scoped; failures do not inflate chat counts', t => {
  const { db, reader, directory } = fixture(t);
  const first = projectItem(projectRaw());
  db.beginRun('first', 'incremental', account, true);
  assert.throws(() => db.commitProjectCatalog('first', [first, first]), /duplicated/);
  assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
  assert.throws(() => db.commitProjectCatalog('first', [{ ...first, sha256: '0'.repeat(64) }]), /SHA-256/);
  const foreignHost = openDatabase(directory);
  try { assert.throws(() => foreignHost.commitProjectCatalog('first', [first]), /owned/); }
  finally { foreignHost.close(); }
  assert.equal(db.commitProjectCatalog('first', [first]).count, 1);
  assert.throws(() => db.endRun('first', false, [], complete(2)), /does not match/);
  db.endRun('first', false, [], complete(1));

  db.beginRun('other-account', 'incremental', { userId: 'other', workspaceId: account.workspaceId }, true);
  db.commitProjectCatalog('other-account', [projectItem(projectRaw(undefined, 'Other account name'))]);
  db.endRun('other-account', false, [], complete(1));
  assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 2);

  db.beginRun('failed', 'incremental', account, true);
  const failed = db.endRun('failed', false, [], { status: 'failed', category: 'pagination-unverified' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.counts.failed, 0);
  const state = reader.prepare('SELECT * FROM project_catalog_state WHERE account_id = ?').get(accountId);
  assert.equal(state.last_successful_run_id, 'first');
  assert.equal(state.status, 'failed');
  assert.equal(state.error_category, 'pagination-unverified');
  assert.equal(reader.prepare('SELECT name FROM projects WHERE account_id = ?').get(accountId).name, 'Research project');
});

test('catalog refresh, rename, empty result and reappearance retain older metadata without touching chats', t => {
  const { db, reader } = fixture(t);
  for (const [runId, items] of [
    ['initial', [projectItem(projectRaw())]],
    ['identical', [projectItem(projectRaw())]],
    ['rename', [projectItem(projectRaw(undefined, 'Renamed project'))]],
    ['empty', []],
    ['reappear', [projectItem(projectRaw(undefined, 'Back again'))]],
  ]) {
    db.beginRun(runId, 'incremental', account, true);
    db.commitProjectCatalog(runId, items);
    db.endRun(runId, false, [], complete(items.length));
    const saved = reader.prepare('SELECT * FROM projects').get();
    assert.equal(saved.last_seen_run_id, runId === 'empty' ? 'rename' : runId);
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
  }
});

test('interrupted project attempt is marked failed on owner close, but committed metadata survives cancellation', t => {
  const { db, reader, closeOwner } = fixture(t);
  db.beginRun('saved', 'incremental', account, true);
  db.commitProjectCatalog('saved', [projectItem(projectRaw())]);
  db.endRun('saved', true, [], complete(1));
  db.beginRun('interrupted', 'incremental', account, true);
  closeOwner();
  assert.equal(reader.prepare('SELECT status FROM project_catalog_state').get().status, 'failed');
  assert.equal(reader.prepare('SELECT last_successful_run_id FROM project_catalog_state').get().last_successful_run_id, 'saved');
});

test('host protocol validates catalog/outcomes and returns structured failures', t => {
  const { db } = fixture(t);
  const request = (type, payload) => handleRequest({ v: 1, id: 'request', type, payload }, () => db, () => {});
  request('beginRun', { runId: 'protocol', mode: 'incremental', account, projectCatalog: true });
  assert.equal(request('commitProjectCatalog', { runId: 'protocol', items: [{ raw: {}, sha256: 'bad' }] }).payload.code, 'INVALID_PAYLOAD');
  assert.equal(request('commitProjectCatalog', { runId: 'protocol', items: [], accountId: 'other' }).payload.code, 'INVALID_PAYLOAD');
  assert.equal(request('endRun', { runId: 'protocol', cancelled: false, failures: [], projects: { status: 'failed', category: 'private arbitrary text' } }).payload.code, 'INVALID_PAYLOAD');
  assert.equal(request('commitProjectCatalog', { runId: 'protocol', items: [projectItem(projectRaw())] }).type, 'commitProjectCatalog.ok');
  assert.equal(request('endRun', { runId: 'protocol', cancelled: false, failures: [], projects: complete(1) }).type, 'endRun.ok');
  assert.equal(isProjectSyncOutcome({ status: 'completed', count: -1 }), false);
  assert.equal(isResponsePayload('commitProjectCatalog', { count: 1 }), true);
  assert.equal(isResponsePayload('commitProjectCatalog', { count: 1.5 }), false);
});

test('schema 3 upgrade preserves existing archive data; viewer remains compatible with schema 3', t => {
  const { db, reader, directory } = fixture(t);
  db.beginRun('old-run', 'single', account);
  const raw = simpleRaw('old-chat', 3);
  raw.gizmo_type = 'snorlax';
  raw.gizmo_id = 'g-p-fixture-a';
  db.upsertConversation('old-run', raw.conversation_id, raw, projectItem(raw).sha256, 'n:100');
  db.endRun('old-run', false, []);
  reader.exec(`DROP TABLE projects; DROP TABLE project_catalog_state; DROP TABLE asset_refs; DROP TABLE assets;
    ALTER TABLE sync_runs DROP COLUMN assets_json; DELETE FROM schema_migrations WHERE version IN (4, 5);`);
  const tables = {
    accounts: '*', conversations: '*', messages: '*',
    sync_runs: 'id, account_id, owner_id, mode, started_at, ended_at, status, listed, new, updated, unchanged, failed, cancelled',
  };
  const snapshot = () => JSON.stringify(Object.entries(tables).map(([table, columns]) => reader.prepare(`SELECT ${columns} FROM ${table}`).all()));
  const before = snapshot();
  const old = new Archive(directory);
  assert.equal(old.status().schemaVersion, 3);
  assert.equal(old.groups(accountId).find(group => group.kind === 'project').label, 'Unnamed project 1');
  old.close();
  const migrated = openDatabase(directory);
  try {
    assert.equal(migrated.status().schemaVersion, 5);
    assert.equal(snapshot(), before);
  } finally { migrated.close(); }
});

test('catalog transaction rolls back every row and successful freshness after a database write failure', t => {
  const { db, reader } = fixture(t);
  db.beginRun('rollback', 'incremental', account, true);
  reader.exec(`CREATE TRIGGER project_failure BEFORE INSERT ON projects WHEN NEW.id = 'g-p-fail'
    BEGIN SELECT RAISE(ABORT, 'synthetic project write failure'); END;`);
  assert.throws(() => db.commitProjectCatalog('rollback', [
    projectItem(projectRaw('g-p-success')), projectItem(projectRaw('g-p-fail')),
  ]), /synthetic project write failure/);
  assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
  const state = reader.prepare('SELECT * FROM project_catalog_state').get();
  assert.equal(state.status, 'running');
  assert.equal(state.last_successful_run_id, null);
  db.endRun('rollback', false, [], { status: 'failed', category: 'local-host' });
});

test('incremental engine, host handlers and archive integrate without preview imports or message rewrites', async t => {
  const { db, reader, directory } = fixture(t);
  const client = {
    retain: () => () => {},
    request: async (type, payload) => {
      const result = handleRequest({ v: 1, id: 'integrated', type, payload }, () => db, () => {});
      if (result.type === 'error') throw new Error(result.payload.message);
      return result.payload;
    },
  };
  let name = 'Initial label';
  let details = 0;
  const options = {
    client, verifyScope: async () => {},
    fetchProjects: async () => ({ items: [projectRaw(undefined, name)], cursor: null }),
    fetchPage: async offset => ({ items: offset ? [] : [{ id: 'saved-chat', updateTimeToken: 'n:100' }], total: 1 }),
    fetchRaw: async () => {
      details++;
      const raw = simpleRaw('saved-chat', 3);
      raw.gizmo_id = 'g-p-fixture-a'; raw.gizmo_type = 'snorlax';
      return raw;
    },
  };
  assert.equal((await syncAllConversations(account, 'secret', options)).status, 'completed');
  const before = JSON.stringify(reader.prepare('SELECT * FROM messages').all());
  name = 'New label, same chats';
  const result = await syncAllConversations(account, 'secret', options);
  assert.equal(result.counts.unchanged, 1);
  assert.equal(result.projects.count, 1);
  assert.equal(details, 1);
  assert.equal(JSON.stringify(reader.prepare('SELECT * FROM messages').all()), before);
  const archive = new Archive(directory);
  try {
    const group = archive.groups(accountId).find(group => group.kind === 'project');
    assert.equal(group.label, name);
    assert.equal(group.conversationCount, 1);
  } finally { archive.close(); }
});

test('viewer joins metadata by account, supports empty folders, and retains older catalog labels', t => {
  const { db, reader, directory } = fixture(t);
  db.beginRun('viewer', 'incremental', account, true);
  db.commitProjectCatalog('viewer', [projectItem(projectRaw(undefined, '<img src=x> Saved name'))]);
  db.endRun('viewer', false, [], complete(1));
  const archive = new Archive(directory);
  try {
    const before = JSON.stringify(reader.prepare('SELECT * FROM projects').all());
    const group = archive.groups(accountId).find(group => group.kind === 'project');
    assert.equal(group.label, '<img src=x> Saved name');
    assert.equal(group.conversationCount, 0);
    assert.equal(group.project.older, false);
    assert.equal(group.project.description, 'Saved project description');
    assert.deepEqual(archive.list(accountId, 50, null, group.id), { items: [], nextCursor: null });
    db.beginRun('empty-viewer', 'incremental', account, true);
    db.commitProjectCatalog('empty-viewer', []);
    db.endRun('empty-viewer', false, [], complete(0));
    assert.equal(archive.groups(accountId).find(g => g.id === group.id).project.older, true);
    assert.equal(JSON.stringify(reader.prepare('SELECT * FROM projects').all()), before);
  } finally { archive.close(); }
});
