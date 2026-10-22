import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatGptApiError } from '../../lib/chatgpt-client.ts';
import { syncAllConversations as runAll } from '../../lib/sync/all-chat.ts';
import { projectRaw } from '../fixtures/project-catalog.mjs';

function syncAllConversations(account, token, dependencies = {}) {
  return runAll(account, token, {
    fetchProjects: async () => ({ items: [], cursor: null }),
    verifyScope: async () => {},
    ...dependencies,
  });
}

const account = { userId: 'user-1', workspaceId: 'workspace-1' };

function makeRaw(id, text = 'answer') {
  return {
    conversation_id: id,
    title: `Title ${id}`,
    current_node: 'assistant',
    mapping: {
      assistant: {
        parent: null,
        message: { id: `message-${id}`, author: { role: 'assistant' }, content: { parts: [text] } },
      },
    },
  };
}

function messageIds(raw) {
  return Object.values(raw.mapping)
    .map(node => node.message?.id)
    .filter(messageId => typeof messageId === 'string');
}

function fakeHost() {
  const sent = [];
  const decisions = [];
  const conversations = new Map();
  let counts = { listed: 0, new: 0, updated: 0, unchanged: 0, failed: 0 };
  const client = {
    sent,
    decisions,
    conversations,
    retain() { return () => {}; },
    async request(type, payload) {
      sent.push({ type, payload });
      if (type === 'recordApiDebug') {
        return { entryId: payload.entryId, part: payload.part, logged: true };
      }
      if (type === 'getStatus') {
        return { schemaVersion: 4, capabilities: ['all-chat-sync', 'message-change-counts', 'project-catalog'] };
      }
      if (type === 'beginRun') {
        counts = { listed: 0, new: 0, updated: 0, unchanged: 0, failed: 0 };
        return { runId: payload.runId, accountId: 'account-1' };
      }
      if (type === 'commitProjectCatalog') return { count: payload.items.length };
      if (type === 'diffManifest') {
        const changed = [];
        let unchanged = 0;
        for (const item of payload.items) {
          const previous = conversations.get(item.conversationId);
          if (previous && item.updateTimeToken !== null &&
            item.updateTimeToken === previous.updateTimeToken) unchanged++;
          else changed.push(item);
        }
        counts.listed += payload.items.length;
        counts.unchanged += unchanged;
        decisions.push({ changed, unchanged });
        return { listed: payload.items.length, unchanged, changed };
      }
      if (type === 'upsertConversation') {
        const previous = conversations.get(payload.conversationId);
        const status = !previous ? 'inserted' :
          previous.sha256 === payload.sha256 ? 'noop' : 'updated';
        const currentMessageIds = messageIds(payload.raw);
        const existingMessageIds = previous?.messageIds ?? new Set();
        const newMessageCount = currentMessageIds.filter(messageId => !existingMessageIds.has(messageId)).length;
        conversations.set(payload.conversationId, {
          sha256: payload.sha256,
          updateTimeToken: payload.manifestUpdateToken ?? previous?.updateTimeToken ?? null,
          messageIds: new Set(currentMessageIds),
        });
        if (status === 'inserted') counts.new++;
        else if (status === 'updated') counts.updated++;
        else counts.unchanged++;
        return {
          conversationId: payload.conversationId, status,
          messageCount: currentMessageIds.length, newMessageCount,
        };
      }
      if (type === 'endRun') {
        counts.failed = payload.failures.length;
        return {
          runId: payload.runId,
          status: payload.cancelled ? 'cancelled' : payload.failures.length || payload.projects?.status === 'failed' ? 'failed' : 'completed',
          counts: { ...counts },
        };
      }
      throw new Error(`Unexpected host request: ${type}`);
    },
  };
  return client;
}

function pageFor(items) {
  return async (offset, limit) => ({ total: items.length, items: items.slice(offset, offset + limit) });
}

test('project catalog refreshes on chat no-op without increasing selected detail calls', async () => {
  const host = fakeHost();
  let name = 'Before rename';
  const options = {
    client: host, maxConversations: 10, fetchPage: pageFor([{ id: 'chat-1', updateTimeToken: 'n:1' }]),
    fetchRaw: async id => makeRaw(id),
    fetchProjects: async () => ({ items: [projectRaw(undefined, name)], cursor: null }),
  };
  await syncAllConversations(account, 'secret', options);
  name = 'After rename';
  const result = await syncAllConversations(account, 'secret', options);
  assert.equal(result.status, 'completed');
  assert.equal(result.counts.unchanged, 1);
  assert.deepEqual(result.projects, { status: 'completed', count: 1 });
  assert.equal(host.sent.filter(x => x.type === 'upsertConversation').length, 1);
  const commits = host.sent.filter(x => x.type === 'commitProjectCatalog');
  assert.equal(commits.length, 2);
  assert.equal(commits[1].payload.items[0].raw.gizmo.gizmo.display.name, name);
});

test('project failure is explicit without inflating conversation failures or preventing useful chat sync', async () => {
  const host = fakeHost();
  const result = await syncAllConversations(account, 'secret', {
    client: host, fetchPage: pageFor([{ id: 'chat-1', updateTimeToken: 'n:1' }]),
    fetchRaw: async id => makeRaw(id),
    fetchProjects: async () => { throw new ChatGptApiError('denied', 403); },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.counts.new, 1);
  assert.equal(result.counts.failed, 0);
  assert.equal(result.failurePhase, 'projects');
  assert.equal(result.projects.category, 'forbidden');
  assert.match(result.error, /HTTP 403/);
  assert.equal(host.sent.some(x => x.type === 'commitProjectCatalog'), false);
});

test('scope change or expired auth stops conversation work and preserves a visible project failure', async () => {
  const host = fakeHost();
  const result = await syncAllConversations(account, 'secret', {
    client: host, fetchPage: async () => assert.fail('must not list another account'),
    verifyScope: async () => { throw new ChatGptApiError('expired', 401); },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.projects.category, 'unauthorized');
  assert.equal(result.counts.failed, 0);
});

test('loss of identity verification after the sidebar response prevents commit and further chat work', async () => {
  const host = fakeHost();
  let checks = 0;
  const result = await syncAllConversations(account, 'secret', {
    client: host, fetchProjects: async () => ({ items: [projectRaw()], cursor: null }),
    verifyScope: async () => { if (++checks === 2) throw new Error('session unavailable'); },
    fetchPage: async () => assert.fail('unverified account must not continue'),
  });
  assert.equal(result.status, 'failed');
  assert.equal(host.sent.some(x => x.type === 'commitProjectCatalog'), false);
});

test('Stop during project fetch leaves catalog uncommitted and run cancelled', async () => {
  const host = fakeHost();
  const controller = new AbortController();
  const result = await syncAllConversations(account, 'secret', {
    client: host, signal: controller.signal,
    fetchProjects: async () => { controller.abort(); return { items: [], cursor: null }; },
    fetchPage: async () => assert.fail('must not list after Stop'),
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.projects.status, 'cancelled');
  assert.equal(host.sent.some(x => x.type === 'commitProjectCatalog'), false);
});

test('old host is rejected before a run or any API work starts', async () => {
  const host = fakeHost();
  const request = host.request;
  host.request = (type, payload) => type === 'getStatus'
    ? { schemaVersion: 3, capabilities: ['all-chat-sync', 'message-change-counts'] } : request(type, payload);
  await assert.rejects(syncAllConversations(account, 'secret', {
    client: host, fetchProjects: async () => assert.fail(),
  }), /schema 4 required/);
  assert.equal(host.sent.some(x => x.type === 'beginRun'), false);
});

test('first all-chat run stores every listed conversation and never sends the token to the host', async () => {
  const host = fakeHost();
  const items = [
    { id: 'chat-1', updateTimeToken: 's:one' },
    { id: 'chat-2', updateTimeToken: 's:two' },
  ];
  const result = await syncAllConversations(account, 'synthetic-token', {
    client: host,
    fetchPage: pageFor(items),
    fetchRaw: async id => makeRaw(id),
  });

  assert.deepEqual(result.status, 'completed');
  assert.deepEqual(result.counts, {
    listed: 2, selected: 2, new: 2, newMessages: 2, updated: 0, unchanged: 0, failed: 0,
  });
  assert.equal(host.sent[0].type, 'getStatus');
  assert.equal(host.sent[1].payload.mode, 'incremental');
  assert.equal(host.sent.filter(request => request.type === 'upsertConversation').length, 2);
  assert.equal(JSON.stringify(host.sent).includes('synthetic-token'), false);
  assert.equal(JSON.stringify(host.sent).includes('Bearer '), false);
});

test('latest-10 validation requests exactly one page of ten and preserves returned order', async () => {
  const host = fakeHost();
  const items = Array.from({ length: 61 }, (_, index) => ({
    id: `chat-${index}`,
    updateTimeToken: `n:${index}`,
  }));
  const pageOffsets = [];
  const fetched = [];
  const result = await syncAllConversations(account, 'synthetic-token', {
    client: host,
    maxConversations: 10,
    fetchPage: async (offset, limit) => {
      pageOffsets.push({ offset, limit });
      return { total: items.length, items: items.slice(offset, offset + limit) };
    },
    fetchRaw: async id => {
      fetched.push(id);
      return makeRaw(id);
    },
  });

  assert.deepEqual(pageOffsets, [{ offset: 0, limit: 10 }]);
  assert.deepEqual(fetched, Array.from({ length: 10 }, (_, index) => `chat-${index}`));
  assert.equal(result.counts.listed, 10);
  assert.equal(result.counts.selected, 10);
  assert.equal(result.counts.new, 10);
  assert.equal(result.counts.newMessages, 10);
  assert.equal(host.sent.filter(request => request.type === 'diffManifest')
    .flatMap(request => request.payload.items).length, 10);
});

test('validation does not require timestamp ordering and missing tokens conservatively fetch details', async () => {
  const host = fakeHost();
  const items = Array.from({ length: 11 }, (_, index) => ({
    id: `chat-${index}`,
    updateTimeToken: index % 3 === 0 ? null : index % 3 === 1 ? `n:${index}` : 's:unparseable-time',
  }));
  let fetchCount = 0;
  const result = await syncAllConversations(account, 'synthetic-token', {
    client: host,
    maxConversations: 10,
    fetchPage: pageFor(items),
    fetchRaw: async id => {
      fetchCount++;
      return makeRaw(id);
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.counts.selected, 10);
  assert.equal(result.counts.failed, 0);
  assert.equal(fetchCount, 10);
});

test('validation never pages after an empty or short first page even with a larger total', async () => {
  for (const size of [0, 3]) {
    const host = fakeHost();
    let calls = 0;
    const result = await syncAllConversations(account, 'token', {
      client: host, maxConversations: 10,
      fetchPage: async (offset, limit) => {
        assert.equal(++calls, 1);
        assert.equal(offset, 0);
        assert.equal(limit, 10);
        return { total: 1000, items: Array.from({ length: size }, (_, i) => ({ id: `chat-${i}`, updateTimeToken: null })) };
      },
      fetchRaw: async id => makeRaw(id),
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.counts.listed, size);
    assert.equal(result.counts.selected, size);
    const events = host.sent.filter(request => request.type === 'recordApiDebug').map(request => JSON.parse(request.payload.data));
    assert.ok(events.some(event => event.reason === 'validation-limit'));
    assert.ok(!events.some(event => event.kind === 'pagination' && event.reason === 'complete'));
  }
});

test('validation rejects duplicate/oversized responses without retrying or syncing any details', async () => {
  for (const ids of [['duplicate', 'duplicate'], Array.from({ length: 11 }, (_, i) => `chat-${i}`)]) {
    let calls = 0;
    const result = await syncAllConversations(account, 'token', {
      client: fakeHost(), maxConversations: 10,
      fetchPage: async () => { calls++; return { total: 1000, items: ids.map(id => ({ id, updateTimeToken: null })) }; },
      fetchRaw: async () => assert.fail('Invalid validation list must not sync details'),
    });
    assert.equal(calls, 1);
    assert.equal(result.status, 'failed');
    assert.equal(result.failurePhase, 'listing');
  }
});

test('conversation-list failures report a safe cause and the failed phase', async () => {
  const host = fakeHost();
  const result = await syncAllConversations(account, 'synthetic-token', {
    client: host,
    fetchPage: async () => { throw new ChatGptApiError('private response body', 429); },
    fetchRaw: async id => makeRaw(id),
  });
  const endRun = host.sent.find(request => request.type === 'endRun');

  assert.equal(result.status, 'failed');
  assert.equal(result.failurePhase, 'listing');
  assert.equal(result.counts.failed, 1);
  assert.match(result.error, /rate-limited.*HTTP 429/);
  assert.equal(result.error.includes('private response body'), false);
  assert.equal(endRun.payload.failures[0].error, result.error);
  assert.equal(endRun.payload.failures[0].retryable, true);
  assert.equal(host.sent.some(request => request.type === 'diffManifest'), false);
});

test('new message count includes only message IDs not previously stored', async () => {
  const host = fakeHost();
  const firstRaw = makeRaw('chat-1');
  const updatedRaw = structuredClone(firstRaw);
  updatedRaw.mapping.newMessage = {
    parent: 'message-chat-1',
    message: {
      id: 'new-message',
      author: { role: 'assistant' },
      content: { parts: ['new'] },
    },
  };
  const run = (token, raw) => syncAllConversations(account, 'synthetic-token', {
    client: host,
    fetchPage: pageFor([{ id: 'chat-1', updateTimeToken: token }]),
    fetchRaw: async () => raw,
  });

  const inserted = await run('n:1', firstRaw);
  const updated = await run('n:2', updatedRaw);
  assert.equal(inserted.counts.new, 1);
  assert.equal(inserted.counts.newMessages, 1);
  assert.equal(updated.counts.new, 0);
  assert.equal(updated.counts.updated, 1);
  assert.equal(updated.counts.newMessages, 1);
});

test('matching list update_time tokens skip detail requests; changed tokens refresh the marker', async () => {
  const host = fakeHost();
  const raw = makeRaw('chat-1');
  let fetchCount = 0;
  const sync = updateTimeToken => syncAllConversations(account, 'synthetic-token', {
    client: host,
    fetchPage: pageFor([{ id: 'chat-1', updateTimeToken }]),
    fetchRaw: async () => {
      fetchCount++;
      return raw;
    },
  });

  assert.equal((await sync('s:one')).counts.new, 1);
  assert.equal(host.conversations.get('chat-1').updateTimeToken, 's:one');
  const second = await sync('s:one');
  assert.equal(second.counts.unchanged, 1);
  assert.deepEqual(host.decisions[1], { changed: [], unchanged: 1 });
  assert.equal(fetchCount, 1);
  assert.equal((await sync('s:two')).counts.unchanged, 1);
  assert.equal(fetchCount, 2);
  assert.equal((await sync('s:two')).counts.unchanged, 1);
  assert.equal(fetchCount, 2);
});

test('failed changed-detail fetch keeps the old update_time token so the next run retries', async () => {
  const host = fakeHost();
  const raw = makeRaw('chat-1');
  const run = (token, fetchRaw) => syncAllConversations(account, 'synthetic-token', {
    client: host,
    fetchPage: pageFor([{ id: 'chat-1', updateTimeToken: token }]),
    fetchRaw,
  });

  await run('s:old', async () => raw);
  const failed = await run('s:new', async () => { throw new Error('synthetic network failure'); });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.counts.failed, 1);
  assert.equal(host.conversations.get('chat-1').updateTimeToken, 's:old');
  const retried = await run('s:new', async () => raw);
  assert.equal(retried.status, 'completed');
  assert.equal(host.conversations.get('chat-1').updateTimeToken, 's:new');
});

test('missing list update_time tokens conservatively fetch details on every run', async () => {
  const host = fakeHost();
  let fetchCount = 0;
  const run = updateTimeToken => syncAllConversations(account, 'synthetic-token', {
    client: host,
    fetchPage: pageFor([{ id: 'chat-1', updateTimeToken }]),
    fetchRaw: async () => {
      fetchCount++;
      return makeRaw('chat-1');
    },
  });

  await run('s:known');
  await run(null);
  await run(null);
  assert.equal(fetchCount, 3);
});

test('expired ChatGPT session stops further detail requests and reports failure', async () => {
  const host = fakeHost();
  let fetchCount = 0;
  const result = await syncAllConversations(account, 'synthetic-token', {
    client: host,
    fetchPage: pageFor([
      { id: 'chat-1', updateTimeToken: 's:one' },
      { id: 'chat-2', updateTimeToken: 's:two' },
    ]),
    fetchRaw: async () => {
      fetchCount++;
      throw new ChatGptApiError('Failed to fetch conversation (401).', 401);
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.counts.failed, 1);
  assert.equal(fetchCount, 1);
});

test('cancellation preserves already committed conversations', async () => {
  const host = fakeHost();
  const controller = new AbortController();
  let fetchCount = 0;
  const result = await syncAllConversations(account, 'synthetic-token', {
    client: host,
    fetchPage: pageFor([
      { id: 'chat-1', updateTimeToken: 's:one' },
      { id: 'chat-2', updateTimeToken: 's:two' },
    ]),
    fetchRaw: async id => {
      fetchCount++;
      if (fetchCount === 1) {
        controller.abort();
      }
      return makeRaw(id);
    },
    signal: controller.signal,
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(result.counts.new, 1);
  assert.equal(result.counts.failed, 0);
  assert.equal(host.conversations.has('chat-1'), true);
  assert.equal(host.conversations.has('chat-2'), false);
});

test('cancellation aborts an in-flight conversation-list request', async () => {
  const host = fakeHost();
  const controller = new AbortController();
  let requestSignal;
  const resultPromise = syncAllConversations(account, 'synthetic-token', {
    client: host,
    signal: controller.signal,
    fetchPage: async (_offset, _limit, signal) => new Promise((_resolve, reject) => {
      requestSignal = signal;
      signal.addEventListener('abort', () => {
        const error = new Error('Aborted list request');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
    fetchRaw: async id => makeRaw(id),
  });
  while (!requestSignal) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const result = await resultPromise;

  assert.equal(result.status, 'cancelled');
  assert.equal(result.counts.selected, 0);
  assert.equal(host.sent.some(request => request.type === 'diffManifest'), false);
});

test('unstable overlapping list pages are retried once before syncing', async () => {
  const host = fakeHost();
  const items = Array.from({ length: 51 }, (_, index) => ({
    id: `chat-${index}`,
    updateTimeToken: `s:${index}`,
  }));
  let calls = 0;
  const fetchPage = async (offset, limit) => {
    calls++;
    if (calls === 2) return { total: items.length, items: [items[49]] };
    return { total: items.length, items: items.slice(offset, offset + limit) };
  };
  const result = await syncAllConversations(account, 'synthetic-token', {
    client: host,
    fetchPage,
    fetchRaw: async id => makeRaw(id),
  });

  assert.equal(calls, 5);
  assert.equal(result.status, 'completed');
  assert.equal(result.counts.listed, 51);
  assert.equal(result.counts.selected, 51);
  assert.equal(result.counts.new, 51);
  assert.equal(result.counts.newMessages, 51);
  const debug = host.sent.filter(request => request.type === 'recordApiDebug')
    .map(request => JSON.parse(request.payload.data));
  assert.deepEqual(debug.filter(event => event.reason === 'duplicate-id').map(event => event.scan), [1]);
  assert.equal(debug.at(-1).reason, 'complete');
});

test('all-chats still scans through 170 chats with offset-dependent totals to an empty page', async () => {
  const host = fakeHost();
  const items = Array.from({ length: 170 }, (_, index) => ({
    id: `chat-${index}`, updateTimeToken: `n:${index}`,
  }));
  const offsets = [];
  const progress = [];
  const fetched = [];
  const result = await syncAllConversations(account, 'synthetic-token', {
    client: host,
    onProgress: value => progress.push(value),
    fetchPage: async (offset, limit) => {
      offsets.push(offset);
      const page = items.slice(offset, offset + limit);
      return { total: offset + page.length + 1, items: page };
    },
    fetchRaw: async id => {
      assert.equal(offsets.at(-1), 170);
      fetched.push(id);
      return makeRaw(id);
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(offsets, [0, 50, 100, 150, 170]);
  assert.equal(result.counts.listed, 170);
  assert.equal(result.counts.selected, 170);
  assert.equal(result.counts.new, 170);
  assert.equal(result.counts.failed, 0);
  assert.deepEqual(fetched, Array.from({ length: 170 }, (_, index) => `chat-${index}`));
  const listing = progress.filter(value => value.phase === 'listing');
  assert.ok(listing.every(value => value.total === null));
  assert.deepEqual(listing.map(value => value.listed), [0, 50, 100, 150, 170]);
  assert.ok(progress.filter(value => value.phase === 'syncing').every(value => value.total === 170));
  const pages = host.sent.filter(request => request.type === 'recordApiDebug')
    .map(request => JSON.parse(request.payload.data)).filter(event => event.kind === 'pagination' && event.reason === 'page');
  assert.deepEqual(pages.map(event => event.pageTotal), [51, 101, 151, 171, 171]);
  assert.ok(pages.every(event => event.scan === 1));
});

test('debug-log failures are explicit and prevent unlogged pagination', async () => {
  const host = fakeHost();
  const request = host.request;
  host.request = async (type, payload) => {
    if (type === 'recordApiDebug') throw new Error('synthetic disk full');
    return request(type, payload);
  };
  let fetched = false;
  const result = await syncAllConversations(account, 'synthetic-token', {
    client: host,
    fetchPage: async () => { fetched = true; return { total: 0, items: [] }; },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.failurePhase, 'projects');
  assert.match(result.error, /Could not write the local API debug log/);
  assert.equal(fetched, false);
  assert.equal(host.sent.at(-1).payload.projects.category, 'local-host');
  assert.equal(result.counts.failed, 0);
});

test('duplicate IDs within or across pages fail both scans before any detail requests', async t => {
  const item = id => ({ id, updateTimeToken: null });
  for (const scenario of [
    { name: 'within one page', fetchPage: async () => ({ total: 3, items: [item('chat-1'), item('chat-1')] }) },
    { name: 'across pages', fetchPage: async () => ({ total: 2, items: [item('chat-1')] }) },
  ]) {
    await t.test(scenario.name, async () => {
      const host = fakeHost();
      const progress = [];
      const result = await syncAllConversations(account, 'synthetic-token', {
        client: host, fetchPage: scenario.fetchPage, onProgress: value => progress.push(value),
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.failurePhase, 'listing');
      assert.match(result.error, /Both consistency scans returned duplicate conversation IDs/);
      const diagnostics = host.sent.filter(request => request.type === 'recordApiDebug')
        .map(request => JSON.parse(request.payload.data));
      assert.deepEqual(diagnostics.filter(event => event.reason === 'duplicate-id')
        .map(event => event.scan), [1, 2]);
      assert.equal(progress.filter(value => value.phase === 'listing' && value.listed === 0).length, 2);
      assert.equal(host.sent.some(request => request.type === 'diffManifest'), false);
      assert.equal(host.sent.some(request => request.type === 'upsertConversation'), false);
    });
  }
});

test('listing ignores inaccurate totals and continues after short pages', async () => {
  const host = fakeHost();
  const items = Array.from({ length: 3 }, (_, index) => ({
    id: `chat-${index}`, updateTimeToken: null,
  }));
  const offsets = [];
  const result = await syncAllConversations(account, 'synthetic-token', {
    client: host,
    fetchPage: async offset => {
      offsets.push(offset);
      if (offset === 0) return { total: 0, items: items.slice(0, 2) };
      if (offset === 2) return { total: 999, items: items.slice(2) };
      assert.equal(offset, 3);
      return { total: 1, items: [] };
    },
    fetchRaw: async id => makeRaw(id),
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(offsets, [0, 2, 3]);
  assert.equal(result.counts.listed, 3);
  assert.equal(result.counts.new, 3);
});

test('an exact full-page list still requests an empty page to confirm completion', async () => {
  const host = fakeHost();
  const items = Array.from({ length: 50 }, (_, index) => ({
    id: `chat-${index}`, updateTimeToken: null,
  }));
  const offsets = [];
  const result = await syncAllConversations(account, 'synthetic-token', {
    client: host,
    fetchPage: async (offset, limit) => {
      offsets.push(offset);
      return pageFor(items)(offset, limit);
    },
    fetchRaw: async id => makeRaw(id),
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(offsets, [0, 50]);
  assert.equal(result.counts.listed, 50);
});

test('an initially empty page completes even when the API advertises more items', async () => {
  const host = fakeHost();
  let calls = 0;
  const result = await syncAllConversations(account, 'synthetic-token', {
    client: host,
    fetchPage: async () => { calls++; return { total: 51, items: [] }; },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.counts.listed, 0);
  assert.equal(result.counts.selected, 0);
  assert.equal(calls, 1);
});

test('failure or cancellation while confirming the end never syncs an incomplete list', async t => {
  for (const cancel of [false, true]) {
    await t.test(cancel ? 'cancelled' : 'network failure', async () => {
      const host = fakeHost();
      const controller = new AbortController();
      const result = await syncAllConversations(account, 'synthetic-token', {
        client: host, signal: controller.signal,
        fetchPage: async offset => {
          if (offset === 0) return { total: 1, items: [{ id: 'chat-1', updateTimeToken: null }] };
          assert.equal(offset, 1);
          if (cancel) {
            controller.abort();
            const error = new Error('Aborted list request');
            error.name = 'AbortError';
            throw error;
          }
          throw new TypeError('network failed');
        },
      });
      assert.equal(result.status, cancel ? 'cancelled' : 'failed');
      assert.equal(result.counts.selected, 0);
      assert.equal(host.sent.some(request => request.type === 'diffManifest'), false);
      assert.equal(host.sent.some(request => request.type === 'upsertConversation'), false);
    });
  }
});

test('default all-chat API adapters send full list and detail diagnostics to the same run', async t => {
  const host = fakeHost();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const raw = makeRaw('chat-1', 'private diagnostic message');
  const list = { total: 1, items: [{ id: 'chat-1', update_time: 42, title: 'Private list title' }] };
  const emptyList = { total: 1, items: [] };
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    return new Response(JSON.stringify(parsed.pathname === '/backend-api/conversations'
      ? parsed.searchParams.get('offset') === '0' ? list : emptyList
      : raw));
  };
  const result = await syncAllConversations(account, 'synthetic-debug-token', { client: host });
  assert.equal(result.status, 'completed');
  const chunks = host.sent.filter(request => request.type === 'recordApiDebug').map(request => request.payload);
  assert.ok(chunks.every(chunk => chunk.runId === result.runId));
  const events = chunks.map(chunk => JSON.parse(chunk.data));
  assert.deepEqual(events.filter(event => event.kind === 'response').map(event => JSON.parse(event.body)), [list, emptyList, raw]);
  assert.ok(events.some(event => event.reason === 'complete'));
  assert.equal(JSON.stringify(chunks).includes('synthetic-debug-token'), false);
});

test('production validation adapter sends offset=0&limit=10 once even when total advertises thousands', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const host = fakeHost();
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `chat-${i}`, update_time: i }));
  for (const item of items) host.conversations.set(item.id, { updateTimeToken: `n:${item.update_time}` });
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    return new Response(JSON.stringify({ items, total: 10000 }));
  };
  const result = await syncAllConversations(account, 'token', { client: host, maxConversations: 10 });
  assert.equal(result.status, 'completed');
  assert.deepEqual(urls, ['https://chatgpt.com/backend-api/conversations?offset=0&limit=10']);
  assert.equal(result.counts.listed, 10);
  assert.equal(result.counts.unchanged, 10);
});
