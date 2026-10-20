import assert from 'node:assert/strict';
import test from 'node:test';
import { HostClient, connectionError } from '../../lib/sync/host-client.ts';

function setup(t, options = {}) {
  const old = globalThis.chrome;
  const ports = [];
  const runtime = {
    lastError: undefined,
    connectNative() {
      const messages = [], disconnects = [];
      const port = {
        onMessage: { addListener(listener) { messages.push(listener); } },
        onDisconnect: { addListener(listener) { disconnects.push(listener); } },
        sent: [], disconnected: false,
        postMessage(value) { this.sent.push(value); },
        disconnect() { this.disconnected = true; for (const listener of disconnects) listener(); },
        receive(value) { for (const listener of messages) listener(value); },
      };
      ports.push(port);
      return port;
    },
  };
  globalThis.chrome = { runtime };
  const client = new HostClient(options.timeout ?? 500, options.idle ?? 500);
  t.after(() => { client.close(); globalThis.chrome = old; });
  return { client, ports, runtime };
}
const pong = { hostVersion: '0.1.0', protocolVersion: 1, pid: 42, uptimeMs: 1 };
function reply(port, index = 0) {
  port.receive({ ...port.sent[index], type: 'ping.ok', payload: pong });
}

test('client correlates concurrent replies on a single port', async t => {
  const { client, ports } = setup(t);
  const first = client.request('ping', {}), second = client.request('ping', {});
  assert.equal(ports.length, 1);
  reply(ports[0], 1);
  reply(ports[0], 0);
  assert.deepEqual(await first, pong);
  assert.deepEqual(await second, pong);
});

test('disconnect rejects every pending request and next request reconnects', async t => {
  const { client, ports, runtime } = setup(t);
  const first = client.request('ping', {}), second = client.request('ping', {});
  const failed = Promise.all([
    assert.rejects(first, error => error.state === 'not-registered'),
    assert.rejects(second, error => error.state === 'not-registered'),
  ]);
  runtime.lastError = { message: 'Specified native messaging host not found.' };
  ports[0].disconnect();
  runtime.lastError = undefined;
  await failed;
  const next = client.request('ping', {});
  reply(ports[1]);
  assert.deepEqual(await next, pong);
});

test('timeout disconnects and rejects outstanding requests', async t => {
  const { client, ports } = setup(t, { timeout: 20 });
  await assert.rejects(client.request('ping', {}), /timed out/);
  assert.equal(ports[0].disconnected, true);
});

test('idle port closes after last reply, not during a pending request', async t => {
  const { client, ports } = setup(t, { idle: 20 });
  const pending = client.request('ping', {});
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(ports[0].disconnected, false);
  reply(ports[0]);
  await pending;
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(ports[0].disconnected, true);
});

test('retained host connection stays open during a long-running single-chat fetch', async t => {
  const { client, ports } = setup(t, { idle: 20 });
  const release = client.retain();
  const pending = client.request('ping', {});
  reply(ports[0]);
  await pending;
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(ports[0].disconnected, false);
  release();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(ports[0].disconnected, true);
});

test('client rejects malformed payloads and incompatible versions', async t => {
  const { client, ports } = setup(t);
  const bad = client.request('ping', {});
  ports[0].receive({ ...ports[0].sent[0], type: 'ping.ok', payload: {} });
  await assert.rejects(bad, /Invalid host response/);
  const incompatible = client.request('ping', {});
  ports[0].receive({ ...ports[0].sent[1], v: 2, type: 'ping.ok', payload: pong });
  await assert.rejects(incompatible, error => error.state === 'protocol-mismatch');
});

test('client maps host protocol error and native launch errors explicitly', async t => {
  const { client, ports } = setup(t);
  const pending = client.request('hello', { protocolVersion: 1, extVersion: 'test' });
  ports[0].receive({ ...ports[0].sent[0], type: 'error', payload: {
    code: 'PROTOCOL_MISMATCH', message: 'Update host', retryable: false,
  } });
  await assert.rejects(pending, error => error.state === 'protocol-mismatch');
  assert.equal(connectionError('Access to the specified native messaging host is forbidden.').state, 'forbidden');
  assert.equal(connectionError('Native host has exited.').state, 'host-exited');
  assert.equal(connectionError('Error when communicating with the native messaging host.').state, 'host-exited');
});

test('send failure rejects all requests and releases the port', async t => {
  const { client, ports } = setup(t);
  const first = client.request('ping', {});
  ports[0].postMessage = () => { throw new Error('Native host has exited.'); };
  const second = client.request('ping', {});
  await Promise.all([assert.rejects(first, /exited/), assert.rejects(second, /exited/)]);
  assert.equal(ports[0].disconnected, true);
});
