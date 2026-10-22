import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearTokenCache, conversationListUpdateToken, createChatGptRequestPacer, fetchConversation,
  fetchConversationListPage, fetchProjectSidebarPage, loadChatGptAccount, loadToken, verifyChatGptScope,
} from '../../lib/chatgpt-client.ts';
import { projectCaptureShape } from '../fixtures/project-catalog.mjs';

function withFetch(t, fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  clearTokenCache();
  t.after(() => {
    clearTokenCache();
    globalThis.fetch = original;
  });
}

test('sidebar adapter uses observed URL, logs raw data before parsing and refuses unverified continuation', async t => {
  const requests = [];
  const events = [];
  const raw = JSON.stringify(projectCaptureShape());
  withFetch(t, async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(raw);
  });
  const page = await fetchProjectSidebarPage('synthetic-token', null, undefined, async event => { events.push(event); });
  assert.equal(page.items.length, 7);
  assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=5&limit=20&owned_only=false');
  assert.equal(events[0].body, raw);
  await assert.rejects(fetchProjectSidebarPage('synthetic-token', 'opaque'), error => error.category === 'pagination-unverified');
  assert.equal(requests.length, 1);
  globalThis.fetch = async () => new Response('bad JSON synthetic-token');
  await assert.rejects(fetchProjectSidebarPage('synthetic-token', null, undefined, async event => { events.push(event); }), SyntaxError);
  assert.equal(events[1].body, 'bad JSON [REDACTED]');
});

test('scope verification uses an uncached session and never accepts a changed user, workspace or token', async t => {
  let body = { accessToken: 'secret', user: { id: 'user' }, account: { id: 'workspace' } };
  withFetch(t, async () => new Response(JSON.stringify(body)));
  const scope = { userId: 'user', workspaceId: 'workspace' };
  await verifyChatGptScope(scope, 'secret');
  for (const changed of [
    { ...body, user: { id: 'other' } },
    { ...body, account: { id: 'other' } },
    { ...body, accessToken: 'different' },
  ]) {
    const original = body;
    body = changed;
    await assert.rejects(verifyChatGptScope(scope, 'secret'), error => error.category === 'account-mismatch');
    body = original;
  }
});

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

test('debug captures complete list and detail bodies before validation without request credentials', async t => {
  const events = [];
  const token = 'synthetic-debug-secret';
  const logApi = async event => { events.push(event); };
  const listBody = JSON.stringify({ items: [{ id: 'chat-1', title: 'Private title' }], unknown: 'preserved' });
  withFetch(t, async () => new Response(listBody, { status: 200 }));
  await assert.rejects(fetchConversationListPage(token, 50, 50, undefined, logApi), /invalid conversation list response/);
  assert.deepEqual(events[0], {
    kind: 'response', url: 'https://chatgpt.com/backend-api/conversations?offset=50&limit=50',
    attempt: 1, status: 200, body: listBody,
  });

  const detailBody = JSON.stringify({ conversation_id: 'chat-1', mapping: {}, title: 'Private title' });
  globalThis.fetch = async () => new Response(detailBody);
  assert.equal((await fetchConversation(token, 'chat-1', 1, 1, undefined, logApi)).conversation_id, 'chat-1');
  assert.equal(events[1].body, detailBody);

  globalThis.fetch = async () => new Response(`<html>bad JSON ${token}</html>`);
  await assert.rejects(fetchConversationListPage(token, 0, 50, undefined, logApi), SyntaxError);
  assert.equal(events[2].body, '<html>bad JSON [REDACTED]</html>');

  globalThis.fetch = async () => new Response(`denied ${token}`, { status: 403 });
  await assert.rejects(fetchConversation(token, 'chat-1', 1, 1, undefined, logApi), /403/);
  assert.equal(events[3].status, 403);
  assert.equal(events[3].body, 'denied [REDACTED]');
  assert.equal(JSON.stringify(events).includes(token), false);
  assert.equal(JSON.stringify(events).includes('authorization'), false);
});

test('debug records network errors and cannot silently fail', async t => {
  const events = [];
  withFetch(t, async () => { throw new TypeError('network failed'); });
  await assert.rejects(fetchConversation('secret', 'chat-1', 1, 1, undefined, async event => {
    events.push(event);
  }), /network failed/);
  assert.deepEqual(events, [{
    kind: 'network-error', url: 'https://chatgpt.com/backend-api/conversation/chat-1',
    attempt: 1, error: 'network failed',
  }]);
  globalThis.fetch = async () => new Response('{"mapping":{}}');
  await assert.rejects(fetchConversation('secret', 'chat-1', 1, 1, undefined, async () => {
    throw new Error('debug write failed');
  }), /debug write failed/);
});

test('debug captures every HTTP retry attempt before returning the successful response', async t => {
  const events = [];
  let calls = 0;
  withFetch(t, async () => {
    calls++;
    return calls === 1
      ? new Response('temporary service error', { status: 503 })
      : new Response('{"mapping":{}}');
  });
  await fetchConversation('secret', 'chat-1', 2, 1, undefined, async event => { events.push(event); });
  assert.deepEqual(events.map(event => ({ attempt: event.attempt, status: event.status, body: event.body })), [
    { attempt: 1, status: 503, body: 'temporary service error' },
    { attempt: 2, status: 200, body: '{"mapping":{}}' },
  ]);
});
