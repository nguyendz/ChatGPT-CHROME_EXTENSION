import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { accountFromSession } from '../../lib/chatgpt-client.ts';
import { isResponsePayload } from '../../lib/sync/protocol.ts';
import { conversationIdFromUrl, syncCurrentConversation } from '../../lib/sync/single-chat.ts';

const account = { userId: 'user-1', workspaceId: 'workspace-1', email: 'user@example.test' };
const conversation = {
  conversation_id: 'chat-1',
  current_node: 'assistant',
  mapping: { assistant: { parent: null, message: { id: 'assistant', author: { role: 'assistant' }, content: { parts: ['Hello'] } } } },
};

function fakeHost(failType, upsertStatus = 'inserted', changeKind) {
  const sent = [];
  return {
    sent,
    retain() { return () => {}; },
    async request(type, payload) {
      sent.push({ type, payload });
      if (type === failType) throw new Error(`synthetic ${type} failure`);
      if (type === 'upsertConversation') {
        return {
          conversationId: payload.conversationId, status: upsertStatus, messageCount: 1,
          newMessageCount: upsertStatus === 'noop' || changeKind === 'metadata-only' ? 0 : 1,
          changeKind,
        };
      }
      if (type === 'endRun') return { runId: payload.runId, status: payload.failures.length ? 'failed' : 'completed', counts: { new: 1, updated: 0, unchanged: 0, failed: payload.failures.length } };
      if (type === 'beginRun') return { runId: payload.runId, accountId: 'account-1' };
      throw new Error(`unexpected request ${type}`);
    },
  };
}

test('session account adapter requires both user and workspace identifiers', () => {
  assert.deepEqual(accountFromSession({
    accessToken: 'must-not-leak',
    user: { id: 'user-1', email: 'user@example.test' },
    account: { id: 'workspace-1' },
  }), account);
  assert.throws(() => accountFromSession({ accessToken: 'secret', user: { id: 'user-1' } }), /stable user and workspace ID/);
});

test('upsert response accepts only the metadata-only change kind', () => {
  assert.equal(isResponsePayload('upsertConversation', {
    conversationId: 'chat-1', status: 'updated', messageCount: 1,
    newMessageCount: 0, changeKind: 'metadata-only',
  }), true);
  assert.equal(isResponsePayload('upsertConversation', {
    conversationId: 'chat-1', status: 'updated', messageCount: 1,
  }), true);
  assert.equal(isResponsePayload('upsertConversation', {
    conversationId: 'chat-1', status: 'updated', messageCount: 1, changeKind: 'unexpected',
  }), false);
  assert.equal(isResponsePayload('upsertConversation', {
    conversationId: 'chat-1', status: 'updated', messageCount: 1, newMessageCount: -1,
  }), false);
});

test('active tab parser accepts only a saved ChatGPT conversation route', () => {
  assert.equal(conversationIdFromUrl('https://chatgpt.com/c/chat-1'), 'chat-1');
  assert.equal(conversationIdFromUrl('https://chatgpt.com/g/project-slug/c/chat-2'), 'chat-2');
  assert.throws(() => conversationIdFromUrl('https://example.com/c/chat-1'), /saved ChatGPT conversation/);
  assert.throws(() => conversationIdFromUrl('https://chatgpt.com/'), /saved ChatGPT conversation/);
  assert.throws(() => conversationIdFromUrl('https://chatgpt.com/c/'), /saved ChatGPT conversation/);
});

test('single-chat flow sends only scoped chat data and finalizes the run', async () => {
  const host = fakeHost();
  const accessToken = 'eyJhbGciOiJIUzI1NiJ9.synthetic-token';
  const result = await syncCurrentConversation('chat-1', account, async () => {
    assert.ok(accessToken);
    return conversation;
  }, host);
  const upsert = host.sent.find(request => request.type === 'upsertConversation').payload;
  assert.deepEqual(host.sent.map(request => request.type), ['beginRun', 'upsertConversation', 'endRun']);
  assert.equal(upsert.sha256, createHash('sha256').update(JSON.stringify(conversation)).digest('hex'));
  assert.deepEqual(host.sent[0].payload.account, account);
  assert.equal(JSON.stringify(host.sent).includes(accessToken), false);
  assert.equal(JSON.stringify(host.sent).includes('Bearer '), false);
  assert.deepEqual(result, {
    conversationId: 'chat-1', status: 'inserted', messageCount: 1, newMessageCount: 1,
  });
});

test('single-chat flow records fetch failures and surfaces the original error', async () => {
  const host = fakeHost();
  await assert.rejects(
    syncCurrentConversation('chat-1', account, async () => { throw new Error('fetch failed'); }, host),
    /fetch failed/,
  );
  assert.deepEqual(host.sent.map(request => request.type), ['beginRun', 'endRun']);
  assert.equal(host.sent[1].payload.failures[0].error, 'Single-chat fetch or persistence failed.');
});

test('single-chat flow reports all upsert statuses and finalizes persistence failures', async () => {
  for (const [upsertStatus, expected, changeKind] of [
    ['updated', 'updated', undefined],
    ['noop', 'unchanged', undefined],
    ['updated', 'updated', 'metadata-only'],
  ]) {
    const host = fakeHost(undefined, upsertStatus, changeKind);
    const result = await syncCurrentConversation('chat-1', account, async () => conversation, host);
    assert.equal(result.status, expected);
    assert.equal(result.changeKind, changeKind);
  }

  const failedHost = fakeHost('upsertConversation');
  await assert.rejects(
    syncCurrentConversation('chat-1', account, async () => conversation, failedHost),
    /synthetic upsertConversation failure/,
  );
  assert.deepEqual(failedHost.sent.map(request => request.type), ['beginRun', 'upsertConversation', 'endRun']);
  assert.equal(failedHost.sent[2].payload.failures.length, 1);
});

test('single-chat flow rejects a mismatched conversation id before upsert', async () => {
  const host = fakeHost();
  await assert.rejects(
    syncCurrentConversation('chat-1', account, async () => ({ ...conversation, conversation_id: 'other-chat' }), host),
    /different conversation/,
  );
  assert.equal(host.sent.some(request => request.type === 'upsertConversation'), false);
});
