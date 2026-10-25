import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Archive, ViewerError } from '../../local-app/viewer/archive.ts';
import { startViewer } from '../../local-app/viewer/server.ts';
import { assetFileName } from '../../local-app/viewer/markdown.ts';
import { isMarkdownExport, isMessage } from '../../local-app/viewer/types.ts';
import { openDatabase } from '../../local-app/host/db.ts';
import { assetBlobPath } from '../../local-app/host/assets.ts';
import { assetRaw, ids } from '../fixtures/asset-chat.mjs';
import { scopeA, scopeB, writeConversation } from '../fixtures/viewer-archive.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const notes = Buffer.from('# my notes');

function seed(path) {
  const accountId = writeConversation(path, assetRaw());
  writeConversation(path, assetRaw('foreign-chat'), scopeB);
  const db = openDatabase(path);
  try {
    db.beginRun('assets', 'incremental', scopeA);
    const store = (fileId, bytes, mime, conversation = 'asset-chat') => {
      db.assetChunk('assets', `u-${fileId}`, conversation, fileId, 0, bytes.toString('base64'));
      db.assetCommit('assets', `u-${fileId}`, conversation, fileId, sha(bytes), bytes.length, mime);
    };
    store(ids.upload, png, 'image/png');
    store(ids.doc, svg, 'image/svg+xml');
    store(ids.lonely, notes, 'text/markdown');
    db.assetOutcome('assets', 'asset-chat', ids.codeJupyter, 'unavailable', 'HTTP 404');
    db.endRun('assets', false, []);
  } finally { db.close(); }
  return accountId;
}

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), 'chatgpt-viewer-assets-'));
  const accountA = seed(path);
  const archive = new Archive(path);
  t.after(() => { archive.close(); rmSync(path, { recursive: true, force: true }); });
  return { path, archive, accountA };
}

const revisionOf = (archive, accountId) => archive.detail(accountId, 'asset-chat').revision;
const allMessages = (archive, accountId) => archive.messages(accountId, 'asset-chat', revisionOf(archive, accountId), 50, null).items;

test('messages list saved files with their state, type, and size, and report missing downloads', t => {
  const { archive, accountA } = fixture(t);
  const messages = allMessages(archive, accountA);
  assert.ok(messages.every(isMessage));
  const user = messages.find(message => message.role === 'user');
  assert.deepEqual(user.assets.map(asset => [asset.fileId, asset.state, asset.mime, asset.size]), [
    [ids.upload, 'stored', 'image/png', png.length],
    [ids.doc, 'stored', 'image/svg+xml', svg.length],
    [ids.lonely, 'stored', 'text/markdown', notes.length],
  ]);
  assert.equal(user.assets[0].name, 'photo.png');
  assert.equal(user.assets[0].kind, 'attachment');
  const assistant = messages.find(message => message.role === 'assistant');
  assert.deepEqual(assistant.assets.map(asset => [asset.fileId, asset.state, asset.mime, asset.size]), [[ids.generated, 'pending', null, 900]]);
  const tool = messages.find(message => message.role === 'tool');
  assert.deepEqual(tool.assets.map(asset => asset.state).sort(), ['pending', 'pending', 'unavailable']);
  assert.equal(JSON.stringify(messages).includes(`"sha256"`), false, 'hashes and paths are never exposed');
  assert.equal(JSON.stringify(messages).includes('assets\\\\'), false);
});

test('a stored file that vanished from disk reads as unavailable', t => {
  const { path, archive, accountA } = fixture(t);
  rmSync(assetBlobPath(path, sha(png)));
  const user = allMessages(archive, accountA).find(message => message.role === 'user');
  assert.equal(user.assets[0].state, 'unavailable');
  assert.throws(() => archive.assetFile(accountA, 'asset-chat', ids.upload), error => error instanceof ViewerError && error.status === 404);
});

test('Markdown export links stored files and notes the rest', t => {
  const { archive, accountA } = fixture(t);
  const result = archive.exportMarkdown(accountA, 'asset-chat');
  assert.equal(isMarkdownExport(result), true);
  assert.deepEqual(result.assets.map(asset => [asset.fileId, asset.fileName, asset.mime, asset.size]), [
    [ids.upload, `${ids.upload}.png`, 'image/png', png.length],
    [ids.doc, `${ids.doc}.bin`, 'image/svg+xml', svg.length],
    [ids.lonely, `${ids.lonely}.md`, 'text/markdown', notes.length],
  ]);
  assert.ok(result.markdown.includes(`![photo.png](assets/${ids.upload}.png)`));
  assert.ok(result.markdown.includes(`[${ids.doc}.bin](assets/${ids.doc}.bin)`) || result.markdown.includes(`assets/${ids.doc}.bin`));
  assert.equal(result.markdown.includes(`![${ids.doc}`), false, 'SVG is linked, never embedded');
  assert.ok(result.markdown.includes('[notes.md](assets/' + ids.lonely + '.md)'));
  assert.ok(result.markdown.includes('*[File not included: ' + ids.generated + ' (not downloaded yet)]*'));
  assert.ok(result.markdown.includes('(no longer available)'));
  assert.equal(assetFileName('file-x', 'application/x-weird'), 'file-x.bin');
  assert.equal(assetFileName('file-x', null), 'file-x.bin');
});

test('user-only export keeps just the user messages, their files, and says so', t => {
  const { archive, accountA } = fixture(t);
  const all = archive.exportMarkdown(accountA, 'asset-chat');
  const only = archive.exportMarkdown(accountA, 'asset-chat', true);
  assert.equal(only.fileName, all.fileName.replace(/\.md$/, ' - user messages.md'));
  assert.equal(isMarkdownExport(only), true);
  assert.deepEqual([...only.markdown.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['User']);
  assert.ok(only.markdown.includes('included_roles: "user"'));
  assert.ok(only.markdown.includes('active_messages: 1\n'));
  assert.ok(only.markdown.includes('omitted_active_messages: 2'));
  assert.ok(only.markdown.includes('> User messages only. 2 other messages on the active branch are not included.'));
  assert.ok(only.markdown.includes('Describe these files'));
  assert.equal(only.markdown.includes('done'), false, 'tool output is omitted');
  assert.equal(only.markdown.includes(ids.generated), false, 'assistant-generated files are omitted');
  assert.deepEqual(only.assets.map(asset => asset.fileId), [ids.upload, ids.doc, ids.lonely]);
  assert.deepEqual(all.assets.map(asset => asset.fileId), only.assets.map(asset => asset.fileId));
  assert.equal(all.markdown.includes('included_roles'), false, 'default export is unchanged');
});

test('user-only export of a chat without user messages says so', t => {
  const path = mkdtempSync(join(tmpdir(), 'chatgpt-viewer-assistant-only-'));
  const raw = assetRaw('assistant-only');
  delete raw.mapping.user;
  raw.mapping.assistant.parent = 'root';
  const account = writeConversation(path, raw);
  const archive = new Archive(path);
  t.after(() => { archive.close(); rmSync(path, { recursive: true, force: true }); });
  const only = archive.exportMarkdown(account, 'assistant-only', true);
  assert.ok(only.markdown.includes('*No user messages on the saved active branch.*'));
  assert.deepEqual(only.assets, []);
});

test('export route accepts roles=user and rejects other values', async t => {
  const path = mkdtempSync(join(tmpdir(), 'chatgpt-viewer-roles-'));
  const accountA = seed(path);
  const ui = join(path, 'ui');
  mkdirSync(ui);
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>Synthetic viewer</title>');
  const viewer = await startViewer({ directory: path, uiDirectory: ui });
  t.after(async () => { await viewer.close(); rmSync(path, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${viewer.token}` };
  const url = roles => `${viewer.origin}/api/conversations/asset-chat/markdown?accountId=${encodeURIComponent(accountA)}${roles}`;
  const body = await (await fetch(url('&roles=user'), { headers })).json();
  assert.match(body.fileName, / - user messages\.md$/);
  assert.equal((await fetch(url('&roles=all'), { headers })).status, 200);
  assert.equal((await fetch(url('&roles=assistant'), { headers })).status, 400);
  assert.equal((await fetch(url('&roles=user&roles=all'), { headers })).status, 400);
});

test('conversations without stored files export exactly as before', t => {
  const path = mkdtempSync(join(tmpdir(), 'chatgpt-viewer-noassets-'));
  const account = writeConversation(path, assetRaw('plain-assets'));
  const reader = new Archive(path);
  t.after(() => { reader.close(); rmSync(path, { recursive: true, force: true }); });
  const result = reader.exportMarkdown(account, 'plain-assets');
  assert.deepEqual(result.assets, []);
  assert.ok(!result.markdown.includes('](assets/'));
  assert.ok(result.markdown.includes('(not downloaded yet)'));
});

test('archives older than schema 5 still open without files', t => {
  const path = mkdtempSync(join(tmpdir(), 'chatgpt-viewer-schema4-'));
  const accountId = writeConversation(path, assetRaw());
  const db = new DatabaseSync(join(path, 'sync.db'));
  db.exec('DROP TABLE asset_refs; DROP TABLE assets; ALTER TABLE sync_runs DROP COLUMN assets_json; DELETE FROM schema_migrations WHERE version = 5;');
  db.close();
  const archive = new Archive(path);
  t.after(() => { archive.close(); rmSync(path, { recursive: true, force: true }); });
  assert.equal(archive.status().schemaVersion, 4);
  assert.ok(allMessages(archive, accountId).every(message => message.assets.length === 0));
  assert.deepEqual(archive.exportMarkdown(accountId, 'asset-chat').assets, []);
  assert.throws(() => archive.assetFile(accountId, 'asset-chat', ids.upload), /not found/);
});

test('file route is authorized, scoped, and serves only safe inline types', async t => {
  const path = mkdtempSync(join(tmpdir(), 'chatgpt-viewer-assets-server-'));
  const accountA = seed(path);
  const accountB = JSON.stringify([scopeB.userId, scopeB.workspaceId]);
  const ui = join(path, 'ui');
  mkdirSync(ui);
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>Synthetic viewer</title>');
  const viewer = await startViewer({ directory: path, uiDirectory: ui });
  t.after(async () => { await viewer.close(); rmSync(path, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${viewer.token}` };
  const url = (file, account = accountA, conversation = 'asset-chat') =>
    `${viewer.origin}/api/assets/${file}?accountId=${encodeURIComponent(account)}&conversationId=${conversation}`;

  assert.equal((await fetch(url(ids.upload))).status, 401);
  const image = await fetch(url(ids.upload), { headers });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('content-disposition'), 'inline');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.match(image.headers.get('content-security-policy'), /img-src 'self' blob:/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);

  const vector = await fetch(url(ids.doc), { headers });
  assert.equal(vector.headers.get('content-type'), 'application/octet-stream');
  assert.match(vector.headers.get('content-disposition'), /^attachment; filename="file-document001"/);
  assert.deepEqual(Buffer.from(await vector.arrayBuffer()), svg);
  const text = await fetch(url(ids.lonely), { headers });
  assert.equal(text.headers.get('content-type'), 'application/octet-stream');
  assert.match(text.headers.get('content-disposition'), /filename="notes.md"/);

  for (const [target, expected] of [
    [url(ids.generated), 404],
    [url(ids.codeJupyter), 404],
    [url(ids.upload, accountB), 404],
    [url(ids.upload, accountA, 'foreign-chat'), 404],
    [url(ids.upload, accountA, 'missing-chat'), 404],
    [url('file-unknown00000'), 404],
    [url('..%2Fsync.db'), 400],
    [url('file-a%2Fb'), 400],
    [url('%E0%A4%A'), 400],
    [url(ids.upload, accountA, 'bad%20id'), 400],
    [`${viewer.origin}/api/assets/${ids.upload}`, 400],
    [`${viewer.origin}/api/assets/${ids.upload}?accountId=${encodeURIComponent(accountA)}&conversationId=asset-chat&conversationId=other`, 400],
  ]) assert.equal((await fetch(target, { headers })).status, expected, target);
  assert.equal((await fetch(url(ids.upload), { method: 'POST', headers })).status, 405);
  assert.equal((await fetch(url(ids.upload), { headers: { ...headers, Origin: 'http://evil.test' } })).status, 403);

  rmSync(assetBlobPath(path, sha(png)));
  assert.equal((await fetch(url(ids.upload), { headers })).status, 404);
});

test('viewing and exporting files never changes the archive', async t => {
  const { path, archive, accountA } = fixture(t);
  const tables = () => {
    const db = new DatabaseSync(join(path, 'sync.db'), { readOnly: true });
    try { return JSON.stringify(['assets', 'asset_refs', 'conversations', 'sync_runs'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())); }
    finally { db.close(); }
  };
  const before = tables();
  allMessages(archive, accountA);
  archive.exportMarkdown(accountA, 'asset-chat');
  archive.assetFile(accountA, 'asset-chat', ids.upload);
  assert.equal(tables(), before);
});
