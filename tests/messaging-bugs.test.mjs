import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual source nodes, not copied implementations. Isolating them
// avoids starting the background worker or mounting React during these tests.
function sourceNode(path, predicate) {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if (predicate(node, source)) {
      assert.equal(found, undefined, 'Expected one matching source node');
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found, `Source node not found in ${path}`);
  return found.getText(source);
}

function execute(source, globals) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return vm.runInNewContext(outputText, globals);
}

const listenerSource = sourceNode('../entrypoints/background.ts', (node, source) =>
  ts.isCallExpression(node) && node.expression.getText(source) === 'chrome.runtime.onMessage.addListener');
const connectListenerSource = sourceNode('../entrypoints/background.ts', (node, source) =>
  ts.isCallExpression(node) && node.expression.getText(source) === 'chrome.runtime.onConnect.addListener');
const senderCheckSource = sourceNode('../entrypoints/background.ts', node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'isExtensionSender');

function background({ chrome: chromeOverrides = {}, ...globals } = {}) {
  let listener;
  let connectListener;
  const chrome = {
    runtime: {
      onMessage: { addListener: callback => { listener = callback; } },
      onConnect: { addListener: callback => { connectListener = callback; } },
      ...chromeOverrides.runtime,
    },
    tabs: chromeOverrides.tabs,
  };
  execute(`${senderCheckSource}\n${listenerSource}\n${connectListenerSource}`, {
    chrome,
    ...globals,
  });
  return { listener, connectListener };
}

// Regression tests for extension-to-host messaging and sender checks.
test('unknown messages do not promise an asynchronous response', async () => {
  const { listener } = background();
  const responses = [];
  assert.equal(listener({ message: '__unknown_test_message__' }, {}, value => responses.push(value)), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(responses.length, 0);
});

test('sync diagnostics reject a content-script caller before connecting to the local host', () => {
  const { listener } = background();
  const responses = [];
  assert.equal(listener({ message: 'syncHostStatus' },
    { id: 'not-our-extension', url: 'https://chatgpt.com/' }, value => responses.push(value)), false);
  assert.match(responses[0].error, /must be started from the extension/);
});

test('current-chat sync rejects a content-script caller before reading the active tab', () => {
  const { listener } = background();
  const responses = [];
  assert.equal(listener({ message: 'syncCurrentChat' },
    { id: 'not-our-extension', url: 'https://chatgpt.com/' }, value => responses.push(value)), false);
  assert.match(responses[0].error, /started from the extension popup/);
});

test('API probe rejects a content-script caller before reading the active tab', () => {
  const { listener } = background();
  const responses = [];
  assert.equal(listener({ message: 'syncApiProbe' },
    { id: 'not-our-extension', url: 'https://chatgpt.com/' }, value => responses.push(value)), false);
  assert.match(responses[0].error, /started from the extension popup/);
});

test('all-chat progress ports reject a content-script caller', () => {
  const extensionId = 'extension-id';
  const { connectListener } = background({
    chrome: {
      runtime: { id: extensionId, getURL: path => `chrome-extension://${extensionId}${path}` },
    },
  });
  let disconnected = false;
  const port = {
    name: 'local-sync-progress',
    sender: { id: 'not-our-extension', url: 'https://chatgpt.com/' },
    disconnect() { disconnected = true; },
  };
  connectListener(port);
  assert.equal(disconnected, true);
});

test('popup API probe sends only its sanitized report to the host and confirms logging', async () => {
  const probeReport = {
    schemaVersion: 1,
    probeId: '123e4567-e89b-12d3-a456-426614174000',
    routeKind: 'conversation',
    session: { status: 'ok', errorCategory: 'none', httpStatuses: [200], fields: [] },
    defaultList: { status: 'ok', errorCategory: 'none', httpStatuses: [200], fields: [] },
    orderedList: { status: 'ok', errorCategory: 'none', httpStatuses: [200], fields: [] },
    archivedList: { status: 'ok', errorCategory: 'none', httpStatuses: [200], fields: [] },
    defaultOrder: 'descending',
    orderedOrder: 'descending',
    orderSequenceChanged: 'same',
    archiveRelation: 'disjoint',
    projectListMembership: 'found',
  };
  let recordedReport;
  const extensionId = 'extension-id';
  const { listener } = background({
    chrome: {
      runtime: { id: extensionId, getURL: path => `chrome-extension://${extensionId}${path}` },
      tabs: { query: async () => [{ url: 'https://chatgpt.com/c/private-chat-id' }] },
    },
    classifyApiProbeRoute: () => ({ routeKind: 'conversation', conversationId: 'private-chat-id' }),
    collectChatGptApiProbe: async () => probeReport,
    recordApiProbe: async report => {
      recordedReport = report;
      return { probeId: report.probeId, logged: true };
    },
  });
  const responses = [];
  assert.equal(listener({ message: 'syncApiProbe' },
    { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` },
    value => responses.push(value)), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(recordedReport, probeReport);
  assert.deepEqual(JSON.parse(JSON.stringify(responses)), [{
    probeId: probeReport.probeId,
    logged: true,
    warningCount: 0,
  }]);
});
