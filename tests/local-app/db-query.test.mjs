import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../local-app/host/db.ts';

const script = fileURLToPath(new URL('../../local-app/scripts/db-query.mjs', import.meta.url));

function seed(directory) {
  const db = openDatabase(directory);
  const raw = {
    conversation_id: 'chat-1', title: 'Private title', current_node: 'message',
    mapping: {
      message: { parent: null, message: { id: 'message', author: { role: 'assistant' }, content: { parts: ['Private message'] } } },
    },
  };
  const runId = 'query-test';
  db.beginRun(runId, 'single', { userId: 'user-1', workspaceId: 'workspace-1' });
  db.upsertConversation(runId, 'chat-1', raw, createHash('sha256').update(JSON.stringify(raw)).digest('hex'));
  db.endRun(runId, false, []);
  db.close();
}

function query(directory, ...args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CHATGPT_SYNC_DATA_DIR: directory },
  });
}

test('read-only DB CLI reports counts, compact list, recent runs, and one selected conversation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-db-query-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  seed(directory);

  const counts = query(directory, 'counts');
  assert.equal(counts.status, 0, counts.stderr);
  assert.equal(JSON.parse(counts.stdout).conversations, 1);
  assert.equal(JSON.parse(counts.stdout).messages, 1);

  const list = query(directory, 'list');
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout)[0].message_count, 1);
  assert.equal(list.stdout.includes('Private title'), false);
  assert.equal(list.stdout.includes('Private message'), false);

  const runs = query(directory, 'runs');
  assert.equal(runs.status, 0, runs.stderr);
  const runRows = JSON.parse(runs.stdout);
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0].status, 'completed');
  assert.equal(runRows[0].new, 1);
  assert.equal(runRows[0].updated, 0);
  assert.equal(runRows[0].unchanged, 0);
  assert.equal(runRows[0].failed, 0);
  assert.equal(runs.stdout.includes('query-test'), false);
  assert.equal(runs.stdout.includes('Private title'), false);
  assert.equal(runs.stdout.includes('Private message'), false);

  const show = query(directory, 'show', 'chat-1');
  assert.equal(show.status, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).messageCount, 1);
  assert.equal(JSON.parse(show.stdout).messages[0].text, 'Private message');

  const after = query(directory, 'counts');
  assert.deepEqual(JSON.parse(after.stdout), JSON.parse(counts.stdout));
});

test('read-only DB CLI rejects unknown commands and missing conversations', t => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-db-query-invalid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  seed(directory);

  const unknown = query(directory, 'delete');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Usage:/);
  const extraRunArg = query(directory, 'runs', 'unexpected');
  assert.equal(extraRunArg.status, 1);
  assert.match(extraRunArg.stderr, /Usage:/);
  const missing = query(directory, 'show', 'absent');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Conversation not found/);
});
