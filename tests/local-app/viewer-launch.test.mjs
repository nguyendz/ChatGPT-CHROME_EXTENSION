import assert from 'node:assert/strict';
import test from 'node:test';
import { ViewerError } from '../../local-app/viewer/archive.ts';
import { createViewerLauncher } from '../../local-app/host/viewer-launch.ts';
import { isResponsePayload, isViewerLaunchUrl } from '../../lib/sync/protocol.ts';

const url = `http://127.0.0.1:43127/#token=${'a'.repeat(64)}`;
const request = (overrides = {}) => ({
  v: 1, id: 'launch', type: 'launchViewer', payload: {}, ...overrides,
});

test('viewer launch starts once, reuses its private URL, and closes with the host', async () => {
  let starts = 0;
  let closes = 0;
  const launcher = createViewerLauncher(async () => {
    starts++;
    return { url, close: async () => { closes++; } };
  });

  const first = await launcher.handle(request());
  const second = await launcher.handle(request({ id: 'launch-again' }));
  assert.deepEqual(first, { v: 1, id: 'launch', type: 'launchViewer.ok', payload: { url } });
  assert.deepEqual(second, { v: 1, id: 'launch-again', type: 'launchViewer.ok', payload: { url } });
  assert.equal(starts, 1);
  assert.equal(isResponsePayload('launchViewer', first.payload), true);

  await launcher.close();
  await launcher.close();
  assert.equal(closes, 1);
});

test('viewer launch validates request envelope and payload before starting', async () => {
  let starts = 0;
  const launcher = createViewerLauncher(async () => {
    starts++;
    return { url, close: async () => {} };
  });

  const malformed = await launcher.handle(request({ payload: { path: 'arbitrary' } }));
  const incompatible = await launcher.handle(request({ v: 2 }));
  assert.equal(malformed.payload.code, 'INVALID_PAYLOAD');
  assert.equal(incompatible.payload.code, 'PROTOCOL_MISMATCH');
  assert.equal(starts, 0);
});

test('viewer startup errors are explicit and do not retain a failed session', async () => {
  let attempts = 0;
  const launcher = createViewerLauncher(async () => {
    attempts++;
    throw new ViewerError(409, 'INCOMPATIBLE_SCHEMA', 'Update the local archive first.');
  });

  const response = await launcher.handle(request());
  assert.equal(response.payload.code, 'VIEWER_ERROR');
  assert.equal(response.payload.message, 'Update the local archive first.');
  assert.equal(attempts, 1);
});

test('viewer launch URL validation rejects external and malformed launch URLs', () => {
  assert.equal(isViewerLaunchUrl(url), true);
  assert.equal(isViewerLaunchUrl('http://example.com/#token=' + 'a'.repeat(64)), false);
  assert.equal(isViewerLaunchUrl('http://127.0.0.1:43127/#token=short'), false);
  assert.equal(isResponsePayload('launchViewer', { url }), true);
  assert.equal(isResponsePayload('launchViewer', { url, extra: true }), false);
  assert.equal(isResponsePayload('launchViewer', { url: 'http://example.com/' }), false);
});
