import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearTokenCache, conversationListUpdateToken, createChatGptRequestPacer, fetchConversation,
  fetchConversationListPage, loadChatGptAccount, loadToken,
} from '../../lib/chatgpt-client.ts';

function withFetch(t, fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  clearTokenCache();
  t.after(() => {
    clearTokenCache();
    globalThis.fetch = original;
  });
}

test('ChatGPT request pacer waits at least two seconds after each completed request', async () => {
  let now = 0;
  const startTimes = [];
  const requestChatGpt = createChatGptRequestPacer(
    2000,
    () => now,
    async ms => { now += ms; },
  );
  const request = async () => {
      startTimes.push(now);
      now += 125;
  };

  await Promise.all([requestChatGpt(request), requestChatGpt(request), requestChatGpt(request)]);
  assert.deepEqual(startTimes, [0, 2125, 4250]);
});

test('client shares session fetches and never logs session fields', async t => {
  const requests = [];
  withFetch(t, async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({
      accessToken: 'synthetic-access-token',
      user: { id: 'user-1', email: 'user@example.test' },
      account: { id: 'workspace-1' },
    }), { status: 200 });
  });

  const [token, account] = await Promise.all([loadToken(), loadChatGptAccount()]);
  assert.equal(token, 'synthetic-access-token');
  assert.deepEqual(account, { userId: 'user-1', workspaceId: 'workspace-1', email: 'user@example.test' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://chatgpt.com/api/auth/session');
  assert.equal(requests.some(request => JSON.stringify(request).includes('synthetic-access-token')), false);
});

test('client validates conversation responses', async t => {
  const requests = [];
  withFetch(t, async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ conversation_id: 'chat/1', mapping: {} }), { status: 200 });
  });

  const conversation = await fetchConversation('synthetic-token', 'chat/1');
  assert.equal(conversation.conversation_id, 'chat/1');
  assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/conversation/chat%2F1');
  assert.equal(requests[0].options.headers.authorization, 'Bearer synthetic-token');
});

test('conversation list adapter validates pages and preserves update token types', async t => {
  const requests = [];
  withFetch(t, async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({
      total: 3,
      items: [
        { id: 'chat-1', update_time: '2026-10-20T00:00:00Z' },
        { id: 'chat-2', update_time: 42 },
        { id: 'chat-3' },
      ],
    }), { status: 200 });
  });

  const page = await fetchConversationListPage('synthetic-token', 50);
  assert.deepEqual(page, {
    total: 3,
    items: [
      { id: 'chat-1', updateTimeToken: 's:2026-10-20T00:00:00Z' },
      { id: 'chat-2', updateTimeToken: 'n:42' },
      { id: 'chat-3', updateTimeToken: null },
    ],
  });
  const requestUrl = new URL(requests[0].url);
  assert.equal(requestUrl.pathname, '/backend-api/conversations');
  assert.equal(requestUrl.searchParams.get('offset'), '50');
  assert.equal(requestUrl.searchParams.get('limit'), '50');
  assert.equal(requests[0].options.headers.authorization, 'Bearer synthetic-token');
  assert.equal(conversationListUpdateToken({ value: 1 }), null);
});

test('conversation list adapter rejects invalid shape and invalid IDs', async t => {
  withFetch(t, async () => new Response(JSON.stringify({ total: 1, items: [{ id: 'bad/id' }] }), { status: 200 }));
  await assert.rejects(fetchConversationListPage('token', 0), /invalid conversation list item/);

  globalThis.fetch = async () => new Response(JSON.stringify({ total: 'one', items: [] }), { status: 200 });
  await assert.rejects(fetchConversationListPage('token', 0), /invalid conversation list response/);
});

test('conversation list retry backoff responds to cancellation', async t => {
  let requests = 0;
  withFetch(t, async () => {
    requests++;
    return new Response('{}', { status: 429 });
  });
  const controller = new AbortController();
  const pending = fetchConversationListPage('token', 0, 50, controller.signal);
  while (requests === 0) await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(requests, 1);
});

test('client reports malformed or failed API responses explicitly', async t => {
  withFetch(t, async () => new Response(JSON.stringify({ mapping: null }), { status: 200 }));
  await assert.rejects(fetchConversation('token', 'chat-1'), /invalid conversation response/);

  clearTokenCache();
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  await assert.rejects(loadToken(), /ChatGPT session \(503\)/);
});
