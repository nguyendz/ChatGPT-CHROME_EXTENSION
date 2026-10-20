import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyApiProbeRoute, collectChatGptApiProbe } from '../../lib/chatgpt-api-probe.ts';
import { isApiProbeReport } from '../../lib/sync/protocol.ts';

function withFetch(t, fetcher) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  t.after(() => { globalThis.fetch = original; });
}

function conversation(index, overrides = {}) {
  return {
    id: index === 17 ? 'private-active-chat-id' : `private-chat-id-${index}`,
    title: `private conversation title ${index}`,
    update_time: new Date(1_700_000_000_000 - index * 1_000).toISOString(),
    is_archived: false,
    gizmo_id: index % 2 ? 'private-project-id' : null,
    workspace_id: null,
    ...overrides,
  };
}

test('probe reports only sanitized shapes and aggregate API behavior', async t => {
  const requests = [];
  withFetch(t, async (input, options) => {
    const url = new URL(String(input));
    requests.push({ url, options });
    if (url.pathname === '/api/auth/session') {
      return new Response(JSON.stringify({
        accessToken: 'private-access-token',
        sessionToken: 'private-session-token',
        email: 'private@example.test',
        user: { id: 'private-user-id', email: 'private@example.test' },
        account: { id: 'private-workspace-id' },
      }), { status: 200 });
    }

    if (url.searchParams.get('is_archived') === 'true') {
      return new Response(JSON.stringify({
        total: 1,
        items: [conversation(200, { id: 'private-archived-chat-id', is_archived: true })],
      }), { status: 200 });
    }
    const offset = Number(url.searchParams.get('offset'));
    const items = Array.from({ length: 50 }, (_, index) => conversation(offset + index));
    return new Response(JSON.stringify({ total: 100, items }), { status: 200 });
  });

  const route = classifyApiProbeRoute('https://chatgpt.com/g/g-p-private-project/c/private-active-chat-id');
  const report = await collectChatGptApiProbe(route);
  const serialized = JSON.stringify(report);

  assert.equal(requests.length, 6);
  assert.equal(requests[0].url.pathname, '/api/auth/session');
  assert.deepEqual(requests.slice(1).map(request => request.url.searchParams.get('offset')), ['0', '50', '0', '50', '0']);
  assert.equal(requests[3].url.searchParams.get('order'), 'updated');
  assert.equal(requests[5].url.searchParams.get('is_archived'), 'true');
  assert.equal(requests.slice(1).every(request =>
    request.options.headers.authorization === 'Bearer private-access-token'), true);

  assert.equal(report.routeKind, 'project-conversation');
  assert.equal(report.projectListMembership, 'found');
  assert.equal(report.defaultOrder, 'descending');
  assert.equal(report.orderedOrder, 'descending');
  assert.equal(report.orderSequenceChanged, 'same');
  assert.equal(report.archiveRelation, 'disjoint');
  assert.equal(report.session.fields.some(field => field.path === 'session.user.id' && field.type === 'string'), true);
  assert.equal(report.session.fields.some(field => field.path === 'session.account.id'), true);
  assert.equal(report.defaultList.fields.some(field => field.path === 'list.items[].update_time'), true);
  assert.equal(isApiProbeReport(report), true);
  for (const privateValue of [
    'private-access-token', 'private-session-token', 'private@example.test', 'private-user-id',
    'private-workspace-id', 'private-active-chat-id', 'private-chat-id-17',
    'private conversation title', 'private-project-id', 'private-archived-chat-id',
  ]) assert.equal(serialized.includes(privateValue), false, `report leaked ${privateValue}`);
});

test('probe records a failed session without requesting or logging private data', async t => {
  const requests = [];
  withFetch(t, async input => {
    requests.push(String(input));
    return new Response(JSON.stringify({
      accessToken: '',
      user: { id: 'private-user-id' },
      account: { workspace_id: 'private-workspace-id' },
    }), { status: 200 });
  });

  const report = await collectChatGptApiProbe({ routeKind: 'conversation', conversationId: 'private-chat-id' });
  assert.equal(requests.length, 1);
  assert.equal(report.session.status, 'invalid-response');
  assert.equal(report.session.errorCategory, 'invalid-shape');
  assert.equal(report.defaultList.status, 'skipped');
  assert.equal(isApiProbeReport(report), true);
  assert.equal(JSON.stringify(report).includes('private-user-id'), false);
});

test('probe distinguishes unsorted lists and inconclusive archive results', async t => {
  withFetch(t, async input => {
    const url = new URL(String(input));
    if (url.pathname === '/api/auth/session') {
      return new Response(JSON.stringify({ accessToken: 'synthetic-token' }), { status: 200 });
    }
    if (url.searchParams.has('is_archived')) {
      return new Response(JSON.stringify({ total: 0, items: [] }), { status: 200 });
    }
    const ordered = url.searchParams.get('order') === 'updated';
    const entries = ordered
      ? [{ id: 'chat-c', update_time: 3 }, { id: 'chat-b', update_time: 2 }, { id: 'chat-a', update_time: 1 }]
      : [{ id: 'chat-a', update_time: 1 }, { id: 'chat-b', update_time: 2 }, { id: 'chat-c', update_time: 3 }];
    return new Response(JSON.stringify({ total: 3, items: entries }), { status: 200 });
  });

  const report = await collectChatGptApiProbe({ routeKind: 'other' });
  assert.equal(report.defaultOrder, 'not-descending');
  assert.equal(report.orderedOrder, 'descending');
  assert.equal(report.orderSequenceChanged, 'changed');
  assert.equal(report.archiveRelation, 'inconclusive');
  assert.equal(report.projectListMembership, 'not-tested');
});

test('probe captures an unauthenticated session failure and stops further requests', async t => {
  const requests = [];
  withFetch(t, async input => {
    requests.push(String(input));
    return new Response('private error response', { status: 401 });
  });

  const report = await collectChatGptApiProbe({ routeKind: 'conversation', conversationId: 'private-chat-id' });
  assert.equal(requests.length, 1);
  assert.equal(report.session.status, 'http-error');
  assert.equal(report.session.errorCategory, 'unauthorized');
  assert.deepEqual(report.session.httpStatuses, [401]);
  assert.equal(JSON.stringify(report).includes('private error response'), false);
  assert.equal(isApiProbeReport(report), true);
});

test('probe avoids ordering claims when update_time types are mixed', async t => {
  withFetch(t, async input => {
    const url = new URL(String(input));
    if (url.pathname === '/api/auth/session') {
      return new Response(JSON.stringify({ accessToken: 'synthetic-token' }), { status: 200 });
    }
    if (url.searchParams.has('is_archived')) {
      return new Response(JSON.stringify({ total: 0, items: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      total: 2,
      items: [
        { id: 'chat-a', update_time: 1 },
        { id: 'chat-b', update_time: '1970-01-01T00:00:02.000Z' },
      ],
    }), { status: 200 });
  });

  const report = await collectChatGptApiProbe({ routeKind: 'other' });
  assert.equal(report.defaultOrder, 'inconclusive');
  assert.equal(report.orderedOrder, 'inconclusive');
});

test('probe classifies route safely and rejects non-ChatGPT tabs', () => {
  assert.deepEqual(classifyApiProbeRoute('https://chatgpt.com/c/chat-123'), {
    routeKind: 'conversation', conversationId: 'chat-123',
  });
  assert.deepEqual(classifyApiProbeRoute('https://chatgpt.com/'), { routeKind: 'other' });
  assert.throws(() => classifyApiProbeRoute('https://example.test/c/chat-123'), /signed-in ChatGPT tab/);
});

test('report validator rejects extra fields and oversized reports', () => {
  const summary = { status: 'skipped', errorCategory: 'skipped', httpStatuses: [], fields: [] };
  const report = {
    schemaVersion: 1,
    probeId: '123e4567-e89b-12d3-a456-426614174000',
    routeKind: 'other',
    session: summary,
    defaultList: summary,
    orderedList: summary,
    archivedList: summary,
    defaultOrder: 'inconclusive',
    orderedOrder: 'inconclusive',
    orderSequenceChanged: 'inconclusive',
    archiveRelation: 'inconclusive',
    projectListMembership: 'not-tested',
  };
  assert.equal(isApiProbeReport(report), true);
  assert.equal(isApiProbeReport({ ...report, raw: 'private response' }), false);
  assert.equal(isApiProbeReport({
    ...report,
    session: { ...summary, fields: Array.from({ length: 33 }, (_, index) => ({
      path: `session.field_${index}`,
      type: 'string',
    })) },
  }), false);
});
