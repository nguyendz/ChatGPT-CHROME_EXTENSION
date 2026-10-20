// Real Chrome + real registered host in a disposable browser profile. No ChatGPT session is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'chatgpt-sync-browser-'));
const output = resolve('.output', 'chrome-mv3');
const expectedId = (await readFile(resolve('.local', 'extension-id.txt'), 'utf8')).trim();
const browserPath = process.env.CHROMIUM_PATH ?? join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe');
const browser = spawn(browserPath, [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-extension-debugging', '--remote-debugging-port=0',
  `--user-data-dir=${directory}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const closed = once(browser, 'close');
closed.catch(() => {});
let ws;
try {
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(`Chrome startup timed out: ${log.slice(-1000)}`)), 15_000);
    browser.once('error', error => { clearTimeout(timer); reject(error); });
    browser.once('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}: ${log.slice(-1000)}`)); });
    browser.stderr.on('data', chunk => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
    });
  });
  ws = new WebSocket(endpoint);
  await new Promise((resolveOpen, reject) => {
    ws.addEventListener('open', resolveOpen, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ({ data }) => {
    const reply = JSON.parse(data);
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timer);
    if (reply.error) request.reject(new Error(JSON.stringify(reply.error)));
    else request.resolve(reply.result);
  });
  const command = (method, params = {}, sessionId) => new Promise((resolveCommand, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 15_000);
    pending.set(requestId, { resolve: resolveCommand, reject, timer });
    ws.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const loaded = await command('Extensions.loadUnpacked', { path: output });
  assert.equal(loaded.id, expectedId, 'Unpacked extension ID must match the pinned key');
  const { targetId } = await command('Target.createTarget', { url: `chrome-extension://${expectedId}/popup.html` });
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  async function until(expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    throw new Error(`Timed out: ${expression}\n${await evaluate('document.body?.innerText ?? "(body unavailable)"')}`);
  }
  await until('document.readyState === "complete" && !!document.body');
  await until('document.body?.innerText.includes("Local sync: Not tested") ?? false');
  assert.equal(await evaluate('document.querySelector("details").open'), false);
  assert.equal(await evaluate('!![...document.querySelectorAll("button")].find(b => b.textContent === "Sync latest 10 chats")'), true);
  assert.equal(await evaluate('document.querySelector("#local-sync-scope").value'), 'latest-10');
  await evaluate(`(() => {
    const select = document.querySelector('#local-sync-scope');
    select.value = 'all';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until('!![...document.querySelectorAll("button")].find(b => b.textContent === "Sync all chats")');
  await evaluate(`(() => {
    const select = document.querySelector('#local-sync-scope');
    select.value = 'latest-10';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until('!![...document.querySelectorAll("button")].find(b => b.textContent === "Sync latest 10 chats")');
  assert.equal(await evaluate('[...document.querySelectorAll("button")].find(b => b.textContent === "Sync this chat").closest("details").open'), false);
  assert.equal(await evaluate('!![...document.querySelectorAll("button")].find(b => b.textContent === "Open")'), true);
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Open').click()`);
  await until('document.querySelector("details").open');
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Test connection').click()`);
  await until('document.body.innerText.includes("Local sync: Connected")');
  await until('document.body.innerText.includes("Connection test #1 passed.")');
  assert.match(await evaluate('document.body.innerText'), /Last checked: .+/);
  assert.ok((await evaluate('document.body.innerText')).includes('No chats were synced.'));
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Test connection').click()`);
  await until('document.body.innerText.includes("Connection test #2 passed.")');
  const status = await evaluate("chrome.runtime.sendMessage({message:'syncHostStatus'})");
  assert.equal(status.state, 'connected', JSON.stringify(status));
  assert.equal(await evaluate('chrome.runtime.getManifest().permissions.includes("downloads")'), false);
  assert.equal(status.host.schemaVersion, 3);
  assert.equal(status.host.hostVersion, '0.4.0');
  assert.equal(status.host.capabilities.includes('message-change-counts'), true);
  await evaluate(`document.querySelector('details details').open = true; [...document.querySelectorAll('button')].find(b => b.textContent === 'Echo 10 MB').click()`);
  await until('document.body.innerText.includes("10 MB verified.")');
  assert.equal(await evaluate('!![...document.querySelectorAll("button")].find(b => b.textContent === "Probe ChatGPT API")'), true);
  assert.equal(await evaluate('!![...document.querySelectorAll("button")].find(b => b.textContent.includes("Download"))'), false);
  assert.equal(await evaluate('!![...document.querySelectorAll("button")].find(b => b.textContent === "Sync this chat")'), true);
  await evaluate(`globalThis.syncProgressPort = (() => {
    const messages = [], disconnects = [];
    return {
      sent: [],
      onMessage: { addListener(listener) { messages.push(listener); } },
      onDisconnect: { addListener(listener) { disconnects.push(listener); } },
      postMessage(message) { this.sent.push(message); },
      emit(message) { for (const listener of messages) listener(message); },
      disconnect() { for (const listener of disconnects) listener(); },
    };
  })();
  chrome.runtime.connect = () => globalThis.syncProgressPort;
  [...document.querySelectorAll('button')].find(b => b.textContent === 'Sync latest 10 chats').click()`);
  assert.deepEqual(await evaluate('globalThis.syncProgressPort.sent'), [{ type: 'start', scope: 'latest-10' }]);
  await until('!![...document.querySelectorAll("button")].find(b => b.textContent === "Stop sync")');
  await evaluate(`globalThis.syncProgressPort.emit({type:'progress',progress:{
    phase:'listing',listed:1,total:2,selected:null,processed:0,new:0,newMessages:0,updated:0,unchanged:0,failed:0
  }})`);
  await until('document.body.innerText.includes("Reading conversation list (1/2)")');
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Stop sync').click()`);
  assert.equal(await evaluate('globalThis.syncProgressPort.sent.some(message => message.type === "cancel")'), true);
  await evaluate(`globalThis.syncProgressPort.emit({type:'complete',result:{
    runId:'test-run',status:'cancelled',
    counts:{listed:2,selected:2,new:1,newMessages:3,updated:0,unchanged:0,failed:0}
  }})`);
  await until('document.body.innerText.includes("All-chat sync stopped: 2 chats selected; 1 new chat, 3 new messages")');
  await evaluate(`chrome.runtime.sendMessage = () => new Promise(resolve => { globalThis.finishApiProbe = resolve; });
    [...document.querySelectorAll('button')].find(b => b.textContent === 'Probe ChatGPT API').click()`);
  await until('document.body.innerText.includes("Probing ChatGPT API...")');
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Probing ChatGPT API...').disabled`), true);
  await evaluate(`globalThis.finishApiProbe({probeId:'123e4567-e89b-12d3-a456-426614174000',logged:true,warningCount:2})`);
  await until('document.body.innerText.includes("API probe 123e4567 logged.")');
  assert.ok((await evaluate('document.body.innerText')).includes('Some checks were incomplete or inconclusive.'));
  console.log(`Real Chrome popup: Connected (${expectedId}), schema ${status.host.schemaVersion}, RTT ${status.rttMs} ms`);
  console.log(`Database: ${status.host.dbPath}`);
  console.log('Real Chrome -> native host: 10 MB SHA-256 verified.');
  await evaluate(`chrome.runtime.sendMessage = () => new Promise(resolve => { globalThis.finishConnectionTest = resolve; });
    [...document.querySelectorAll('button')].find(b => b.textContent === 'Test connection').click()`);
  await until('document.body.innerText.includes("Local sync: Checking...")');
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Testing...').disabled`), true);
  assert.equal(await evaluate('document.body.innerText.includes("Connection test #2 passed.")'), false);
  await evaluate(`globalThis.finishConnectionTest(${JSON.stringify(status)})`);
  await until('document.body.innerText.includes("Connection test #3 passed.")');
  console.log('Repeated connection tests show a fresh result; pending tests show checking feedback.');
  let checkCount = 3;
  for (const [state, label, guidance] of [
    ['not-registered', 'App not registered', 'register-host.ps1'],
    ['forbidden', 'ID mismatch', 'register-host.ps1'],
    ['host-exited', 'Host error', 'host.log'],
    ['protocol-mismatch', 'Update required', 'rebuild the extension'],
  ]) {
    // Failure rendering uses injected runtime replies; launch-error mapping is tested separately.
    await evaluate(`chrome.runtime.sendMessage = async () => (${JSON.stringify({ state, error: 'Synthetic diagnostic failure' })});
      [...document.querySelectorAll('button')].find(b => b.textContent === 'Test connection').click()`);
    await until(`document.body.innerText.includes(${JSON.stringify(`Local sync: ${label}`)})`);
    await until(`document.body.innerText.includes("Connection test #${++checkCount} failed.")`);
    assert.equal(await evaluate('document.body.innerText.includes("database is ready")'), false);
    assert.ok((await evaluate('document.body.innerText')).includes(guidance));
  }
  console.log('Popup failure states and recovery instructions verified.');
  await command('Target.closeTarget', { targetId });
  // Wait beyond the background client's idle timeout and verify its host actually stopped.
  await new Promise(resolveWait => setTimeout(resolveWait, 32_000));
  const log = await readFile(join(process.env.LOCALAPPDATA, 'ChatGPTBackup', 'logs', 'host.log'), 'utf8');
  const lastStart = [...log.matchAll(/Host started (\d+)/g)].at(-1)?.[1];
  assert.ok(lastStart);
  assert.match(log, new RegExp(`Host stopped ${lastStart}(?:\\r?\\n|$)`));
  console.log('Native host exited after the background idle timeout.');
  await command('Browser.close');
} finally {
  ws?.close();
  if (browser.exitCode === null) browser.kill();
  await closed;
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
