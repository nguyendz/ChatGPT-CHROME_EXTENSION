import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiDebugLogError, createApiDebugLogger } from '../../lib/sync/api-debug.ts';
import { API_DEBUG_CHUNK_CHARS, isApiDebugChunk, isResponsePayload } from '../../lib/sync/protocol.ts';

test('API debug logger preserves large bodies in bounded, acknowledged chunks', async () => {
  const chunks = [];
  const logger = createApiDebugLogger({
    async request(type, chunk) {
      assert.equal(type, 'recordApiDebug');
      assert.equal(isApiDebugChunk(chunk), true);
      chunks.push(chunk);
      return { entryId: chunk.entryId, part: chunk.part, logged: true };
    },
  }, 'run-1');
  const event = {
    kind: 'response', url: 'https://chatgpt.com/backend-api/conversation/chat-1',
    status: 200, attempt: 1, body: 'private chat \u{1f600}\n'.repeat(20000),
  };
  await logger(event);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.runId === 'run-1' &&
    chunk.entryId === chunks[0].entryId && chunk.parts === chunks.length &&
    chunk.data.length <= API_DEBUG_CHUNK_CHARS));
  assert.deepEqual(chunks.map(chunk => chunk.part), chunks.map((_, index) => index));
  const { timestamp, ...restored } = JSON.parse(chunks.map(chunk => chunk.data).join(''));
  assert.ok(Number.isFinite(Date.parse(timestamp)));
  assert.deepEqual(restored, event);
});

test('API debug logger rejects failed or mismatched acknowledgements', async () => {
  const event = { kind: 'pagination', scan: 1, offset: 0, reason: 'start' };
  await assert.rejects(createApiDebugLogger({
    async request() { throw new Error('disk full'); },
  }, 'run-1')(event), error => error instanceof ApiDebugLogError && error.cause.message === 'disk full');
  await assert.rejects(createApiDebugLogger({
    async request() { return { entryId: 'wrong', part: 0, logged: true }; },
  }, 'run-1')(event), ApiDebugLogError);
});

test('debug protocol rejects malformed chunks and acknowledgements', () => {
  const chunk = { runId: 'run-1', entryId: 'entry-1', part: 0, parts: 1, data: '{}' };
  assert.equal(isApiDebugChunk(chunk), true);
  for (const patch of [
    { part: -1 }, { part: 1 }, { parts: 1.5 }, { data: '' },
    { data: 'x'.repeat(API_DEBUG_CHUNK_CHARS + 1) }, { runId: '../escape' },
    { extra: 'not allowed' },
  ]) assert.equal(isApiDebugChunk({ ...chunk, ...patch }), false);
  assert.equal(isResponsePayload('recordApiDebug', { entryId: 'entry-1', part: 0, logged: true }), true);
  assert.equal(isResponsePayload('recordApiDebug', { entryId: 'entry-1', part: -1, logged: true }), false);
  assert.equal(isResponsePayload('recordApiDebug', { entryId: 'entry-1', part: 0, logged: false }), false);
});
