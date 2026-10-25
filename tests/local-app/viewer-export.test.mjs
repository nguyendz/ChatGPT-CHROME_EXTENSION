import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Archive, ViewerError } from '../../local-app/viewer/archive.ts';
import { startViewer } from '../../local-app/viewer/server.ts';
import { conversationMarkdown, markdownFileName, safeFileName } from '../../local-app/viewer/markdown.ts';
import { isMarkdownExport } from '../../local-app/viewer/types.ts';
import { createZip, crc32 } from '../../local-app/viewer/zip.ts';
import { seedViewer } from '../fixtures/viewer-archive.mjs';

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), 'chatgpt-viewer-export-'));
  const seeded = seedViewer(path, 5);
  const archive = new Archive(path);
  t.after(() => { archive.close(); rmSync(path, { recursive: true, force: true }); });
  return { path, archive, ...seeded };
}

function snapshot(path) {
  const db = new DatabaseSync(join(path, 'sync.db'), { readOnly: true });
  try {
    return JSON.stringify(['accounts', 'conversations', 'messages', 'sync_runs']
      .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  } finally { db.close(); }
}

test('Markdown export contains the full active branch in mapping order and leaves the DB unchanged', t => {
  const { path, archive, accountA, accountB } = fixture(t);
  const before = snapshot(path);
  const result = archive.exportMarkdown(accountA, 'branch-chat');
  assert.equal(isMarkdownExport(result), true);
  assert.equal(result.id, 'branch-chat');
  assert.equal(result.fileName, 'Branch img src=x onerror=alert(1) (branch-c).md');
  const { markdown } = result;
  assert.match(markdown, /^---\ntitle: "Branch <img src=x onerror=alert\(1\)>"\nconversation_id: "branch-chat"\n/);
  assert.match(markdown, /\nactive_messages: 3\nother_stored_messages: 1\n---\n/);
  assert.ok(markdown.includes('\n# Branch \\<img src=x onerror=alert(1)\\>\n'), 'title heading is escaped');
  assert.ok(markdown.includes('> Active branch only. 1 other stored message is not included.'));
  const headings = [...markdown.matchAll(/^## (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(headings, ['User', 'Assistant', 'Tool']);
  assert.ok(markdown.indexOf('User first') < markdown.indexOf('# Rendered Markdown heading'));
  assert.ok(markdown.includes('| Markdown cell | Other cell |'), 'message Markdown is exported verbatim');
  assert.ok(markdown.includes('Saved tool text'));
  assert.ok(markdown.includes('> Contains unsupported content or attachment references'));
  assert.equal(markdown.includes('INACTIVE BRANCH ONLY'), false);
  assert.ok(markdown.includes(`*${new Date(200_000).toISOString()}*`));
  assert.throws(() => archive.exportMarkdown(accountB, 'branch-chat'), error => error instanceof ViewerError && error.code === 'NOT_FOUND');
  assert.throws(() => archive.exportMarkdown('missing', 'branch-chat'), /account not found/);
  assert.equal(snapshot(path), before);
});

test('Markdown export is not paginated and keeps stored code literal inside a safe fence', t => {
  const { archive, accountA } = fixture(t);
  const { markdown, fileName } = archive.exportMarkdown(accountA, 'long-chat');
  assert.equal(fileName, 'Conversation long-chat (long-cha).md');
  assert.equal([...markdown.matchAll(/^## /gm)].length, 205);
  assert.ok(markdown.includes('Saved long-chat message 204'));
  assert.ok(markdown.includes('```\n**Stored code stays literal**\n<table><tr><td>Not rendered as a table</td></tr></table>\n```'));
});

test('serializer handles fences, empty transcripts, warnings, and model labels', () => {
  const detail = { id: 'chat-1', title: null, updateTime: null, lastSyncedAt: '2024-01-02T03:04:05.000Z', messageCount: 2,
    revision: 'a'.repeat(64), activeMessageCount: 2, otherMessageCount: 0, warnings: [] };
  const markdown = conversationMarkdown(detail, [
    { id: 'm1', role: 'assistant', model: 'gpt-4o', contentType: 'code', text: 'a ```` b', createTime: null, unsupportedContent: false, assets: [] },
    { id: 'm2', role: 'critic', model: null, contentType: 'text', text: '   ', createTime: null, unsupportedContent: false, assets: [] },
  ]);
  assert.ok(markdown.includes('title: "Untitled conversation"'));
  assert.ok(markdown.includes('updated: null'));
  assert.ok(markdown.includes('## Assistant · gpt-4o'));
  assert.ok(markdown.includes('`````\na ```` b\n`````'));
  assert.ok(markdown.includes('## Critic\n\n*[No saved text in this message]*'));
  assert.equal(markdown.includes('Active branch only'), false);
  const empty = conversationMarkdown({ ...detail, activeMessageCount: 0, warnings: ['No valid current_node.'] }, []);
  assert.ok(empty.includes('> **Warning:** No valid current\\_node.'));
  assert.ok(empty.includes('*No messages on a valid saved active branch.*'));
});

test('export file names are portable and bounded', () => {
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j\u0001k'), 'a b c d e f g h i j k');
  assert.equal(safeFileName('  ..hidden.. '), 'hidden');
  assert.equal(safeFileName('CON'), '_CON');
  assert.equal(safeFileName('nul.txt'), '_nul.txt');
  assert.equal(safeFileName('   '), 'Untitled conversation');
  assert.equal(safeFileName(null, 'Fallback'), 'Fallback');
  assert.equal([...safeFileName('😀'.repeat(200))].length, 80);
  assert.equal(markdownFileName('Plan: v2?', '0123456789abcdef'), 'Plan v2 (01234567).md');
  assert.equal(isMarkdownExport({ id: 'x', fileName: '../evil.md', markdown: '', assets: [] }), false);
  assert.equal(isMarkdownExport({ id: 'x', fileName: 'ok.md', markdown: '', assets: [] }), true);
});

test('ZIP fallback writes valid store-only entries with UTF-8 names', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const files = [
    { name: 'Folder/Ünïcode chat (abc).md', data: new TextEncoder().encode('# Hello\n') },
    { name: 'Folder/Empty.md', data: new Uint8Array() },
  ];
  const zip = createZip(files, new Date(2024, 0, 2, 3, 4, 6));
  const view = new DataView(zip.buffer);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);
  let offset = view.getUint32(end + 16, true);
  for (const file of files) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    assert.equal(view.getUint16(offset + 8, true) & 0x0800, 0x0800);
    const nameLength = view.getUint16(offset + 28, true);
    const local = view.getUint32(offset + 42, true);
    assert.equal(new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength)), file.name);
    assert.equal(view.getUint32(local, true), 0x04034b50);
    assert.equal(view.getUint32(local + 14, true), crc32(file.data));
    const dataStart = local + 30 + view.getUint16(local + 26, true);
    assert.deepEqual(zip.subarray(dataStart, dataStart + file.data.length), file.data);
    offset += 46 + nameLength;
  }
});

test('Markdown export route requires the token and validates account and conversation scope', async t => {
  const path = mkdtempSync(join(tmpdir(), 'chatgpt-viewer-export-server-'));
  const { accountA, accountB } = seedViewer(path);
  const ui = join(path, 'ui');
  mkdirSync(ui);
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>Synthetic viewer</title>');
  const viewer = await startViewer({ directory: path, uiDirectory: ui });
  t.after(async () => { await viewer.close(); rmSync(path, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${viewer.token}` };
  const url = (id, account = accountA) => `${viewer.origin}/api/conversations/${id}/markdown?accountId=${encodeURIComponent(account)}`;
  assert.equal((await fetch(url('branch-chat'))).status, 401);
  const response = await fetch(url('branch-chat'), { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(isMarkdownExport(body), true);
  assert.ok(body.markdown.includes('## Tool'));
  assert.equal((await fetch(url('branch-chat', accountB), { headers })).status, 404);
  assert.equal((await fetch(url('bad%2Fid'), { headers })).status, 400);
  assert.equal((await fetch(`${viewer.origin}/api/conversations/branch-chat/markdown`, { headers })).status, 400);
  assert.equal((await fetch(url('branch-chat'), { method: 'POST', headers })).status, 405);
});
