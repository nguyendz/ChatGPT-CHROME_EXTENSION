// Real Chrome in a disposable profile, using only a synthetic local archive.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startViewer } from '../../local-app/viewer/server.ts';
import { seedViewer, simpleRaw, writeConversation, scopeA, scopeB } from '../fixtures/viewer-archive.mjs';
import { assetRaw, ids as assetIds } from '../fixtures/asset-chat.mjs';
import { projectRaw, projectItem } from '../fixtures/project-catalog.mjs';
import { openDatabase } from '../../local-app/host/db.ts';

const directory = await mkdtemp(join(tmpdir(), 'chatgpt-viewer-browser-'));
let viewer;
let browser;
let closed;
let ws;
try {
  const { accountB } = seedViewer(directory, 52);
  viewer = await startViewer({ directory });
  const browserPath = process.env.CHROMIUM_PATH ?? join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe');
  browser = spawn(browserPath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${join(directory, 'profile')}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  closed = once(browser, 'close');
  closed.catch(() => {});
  const endpoint = await new Promise((accept, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out.')), 15_000);
    browser.once('error', error => { clearTimeout(timer); reject(error); });
    browser.once('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}.`)); });
    browser.stderr.on('data', chunk => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); accept(match[1]); }
    });
  });
  ws = new WebSocket(endpoint);
  await new Promise((accept, reject) => {
    ws.addEventListener('open', accept, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let requestId = 0;
  const pending = new Map();
  const externalRequests = [];
  const exceptions = [];
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url) &&
      !message.params.request.url.startsWith(viewer.origin + '/')) externalRequests.push(message.params.request.url);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.accept(message.result);
  });
  const command = (method, params = {}, sessionId) => new Promise((accept, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, 15_000);
    pending.set(id, { accept, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  async function until(expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(accept => setTimeout(accept, 50));
    }
    throw new Error(`Browser check timed out: ${expression}`);
  }
  async function chooseFolder(label) {
    await evaluate(`(() => {
      const select = document.querySelector('#folder-select');
      const option = [...select.options].find(item => item.textContent.trim().startsWith(${JSON.stringify(`${label} (`)}));
      if (!option) throw new Error('Folder option not found: ' + ${JSON.stringify(label)});
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }
  await command('Runtime.enable', {}, sessionId);
  await command('Network.enable', {}, sessionId);
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await command('Network.setBlockedURLs', { urls: ['https://*', 'http://example.*'] }, sessionId);
  await command('Page.navigate', { url: viewer.url }, sessionId);
  await until('document.querySelectorAll(".chat-item").length === 50');
  assert.equal(await evaluate('document.querySelector(".chat-item strong").textContent'), 'Conversation long-chat (205)');
  assert.equal(await evaluate('document.querySelector(".chat-item").textContent.includes("Updated") || document.querySelector(".chat-item").textContent.includes("Synced")'), false);
  assert.match(await evaluate('document.querySelector(".sidebar-footer-summary").innerText.replace(/\\s+/g, " ")'), /^\d+ conversations\s+Last sync /);
  assert.equal(await evaluate('document.querySelector(".sidebar-footer-summary").textContent.includes("Never")'), false);
  assert.equal(await evaluate('document.querySelector("aside.sidebar footer").textContent.includes("stored messages") || document.querySelector("aside.sidebar footer").textContent.includes("No ChatGPT connection required")'), false);
  assert.equal(await evaluate('location.hash'), '', 'Launch token must be removed from the address bar');
  assert.equal(await evaluate('document.body.innerText.includes("Local only / Read-only")'), true);
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Load more conversations').click()`);
  await until('document.querySelectorAll(".chat-item").length === 54');
  await command('Page.bringToFront', {}, sessionId);
  await until('document.hasFocus()');
  await evaluate('document.querySelector(".chat-item").focus()');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 }, sessionId);
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
  await until('!!document.querySelector(".conversation-heading")');

  await until('document.querySelectorAll("#folder-select option").length === 6');
  await chooseFolder('Unnamed project 1');
  await until('document.querySelectorAll(".chat-item").length === 2');
  assert.equal(await evaluate('document.querySelectorAll(".message").length'), 0);
  assert.ok((await evaluate('document.querySelector("#folder-select").selectedOptions[0].textContent.trim()')).startsWith('Unnamed project 1 ('));
  await chooseFolder('Unnamed custom GPT 1');
  await until('document.querySelectorAll(".chat-item").length === 1 && document.querySelector(".chat-item strong").textContent.startsWith("Untitled conversation (")');
  await chooseFolder('Other marked chats');
  await until('document.querySelectorAll(".chat-item").length === 1 && document.querySelector(".chat-item").textContent.includes("extra-001")');
  await chooseFolder('No project marker');
  await until('document.querySelectorAll(".chat-item").length === 49');
  await chooseFolder('All conversations');
  await until('document.querySelectorAll(".chat-item").length === 50');

  await evaluate(`[...document.querySelectorAll('.chat-item')].find(button => button.textContent.includes('Conversation long-chat')).click()`);
  await until('document.querySelectorAll(".message").length === 100');
  await until('!!document.querySelector(".saved-code")');
  assert.equal(await evaluate('document.querySelector(".saved-code").textContent.includes("**Stored code stays literal**")'), true);
  assert.equal(await evaluate('document.querySelector(".saved-code table")'), null);
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Load more messages').click()`);
  await until('document.querySelectorAll(".message").length === 200');
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Load more messages').click()`);
  await until('document.querySelectorAll(".message").length === 205');

  await evaluate(`[...document.querySelectorAll('.chat-item')].find(button => button.textContent.includes('Branch <img')).click()`);
  await until('document.querySelectorAll(".message").length === 3');
  assert.equal(await evaluate('!!globalThis.viewerInjected'), false);
  assert.equal(await evaluate('document.querySelectorAll(".reader script, .reader img").length'), 0);
  assert.equal(await evaluate('document.querySelector(".messages").innerText.includes("INACTIVE BRANCH ONLY")'), false);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".message-meta strong")].map(node => node.textContent)'), ['user', 'assistant', 'tool']);
  assert.equal(await evaluate('!!document.querySelector(".unsupported")'), true);
  await until('!!document.querySelector(".message-content h1")');
  assert.equal(await evaluate('document.querySelector(".message-content h1").textContent'), 'Rendered Markdown heading');
  assert.equal(await evaluate('[...document.querySelectorAll(".message-content strong")].some(node => node.textContent === "Bold text")'), true);
  assert.equal(await evaluate('[...document.querySelectorAll(".message-content em")].some(node => node.textContent === "italic text")'), true);
  assert.equal(await evaluate('[...document.querySelectorAll(".message-content del")].some(node => node.textContent === "deleted text")'), true);
  assert.equal(await evaluate('document.querySelector(".message-content blockquote").textContent.trim()'), 'Quoted text');
  assert.equal(await evaluate('document.querySelectorAll(".message-content table").length'), 2);
  assert.equal(await evaluate('[...document.querySelectorAll(".message-content td")].some(node => node.textContent === "Rendered HTML cell")'), true);
  assert.equal(await evaluate('[...document.querySelectorAll(".message-content strong")].some(node => node.textContent === "Safe inline HTML")'), true);
  assert.equal(await evaluate('document.querySelector(".message-content details summary").textContent'), 'More detail');
  assert.equal(await evaluate('document.querySelector(".message-content input[type=checkbox]").disabled'), true);
  assert.equal(await evaluate('document.querySelector(".message-content code.language-js").textContent.includes("<b>Literal code</b>")'), true);
  assert.equal(await evaluate('document.querySelector(".message-content code.language-js b")'), null);
  assert.equal(await evaluate('document.querySelectorAll(".message-content .blocked-media").length'), 2);
  assert.equal(await evaluate('document.querySelector(".message-content a").getAttribute("target")'), '_blank');
  assert.equal(await evaluate('document.querySelector(".message-content a").getAttribute("rel")'), 'noopener noreferrer');
  assert.equal(await evaluate('document.querySelectorAll(".message-content a[href^=javascript], .message-content [onclick], .message-content [onerror], .message-content [style], .message-content iframe, .message-content style, .message-content form").length'), 0);
  assert.equal(await evaluate('document.querySelectorAll(".html-preview").length'), 0);
  assert.equal(await evaluate('document.querySelector(".html-code-block pre").textContent.includes("<h3>HTML preview heading</h3>")'), true);
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Preview HTML').click()`);
  await until('!!document.querySelector(".html-preview h3")');
  assert.equal(await evaluate('document.querySelector(".html-preview h3").textContent'), 'HTML preview heading');
  assert.equal(await evaluate('document.querySelector(".html-preview td").textContent'), 'Preview cell');
  assert.equal(await evaluate('document.querySelector(".html-preview .blocked-media").textContent'), '[Image not loaded: Preview diagram]');
  assert.equal(await evaluate('document.querySelectorAll(".html-preview script, .html-preview iframe, .html-preview img, .html-preview [style], .html-preview [onclick]").length'), 0);
  assert.equal(await evaluate('!!globalThis.viewerInjected'), false);
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Hide HTML preview').click()`);
  await until('!document.querySelector(".html-preview")');
  await evaluate(`[...document.querySelectorAll('.chat-item')].find(button => button.textContent.includes('Branch <img')).click()`);
  assert.equal(await evaluate('document.querySelectorAll(".message").length'), 3, 'Selecting an already-open chat must not clear it');

  const downloads = join(directory, 'downloads');
  await mkdir(downloads);
  await command('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  const downloaded = async name => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const files = await readdir(downloads);
      if (files.includes(name)) return readFile(join(downloads, name));
      await new Promise(accept => setTimeout(accept, 50));
    }
    throw new Error(`Download timed out: ${name}; found ${(await readdir(downloads)).join(', ')}`);
  };
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Export Markdown').click()`);
  const single = (await downloaded('Branch img src=x onerror=alert(1) (branch-c).md')).toString('utf8');
  assert.match(single, /^---\ntitle: "Branch <img src=x onerror=alert\(1\)>"/);
  assert.deepEqual([...single.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['User', 'Assistant', 'Tool']);
  assert.equal(single.includes('INACTIVE BRANCH ONLY'), false);
  await chooseFolder('Unnamed project 1');
  await until('document.querySelectorAll(".chat-item").length === 2');
  await evaluate('delete window.showDirectoryPicker; window.showDirectoryPicker = undefined');
  await evaluate(`document.querySelector('.export-folder').click()`);
  await until('document.querySelector(".export-message")?.textContent.includes("Exported 2 of 2 conversations")');
  const archiveZip = await downloaded('Unnamed project 1.zip');
  const names = [];
  for (let offset = archiveZip.readUInt32LE(archiveZip.length - 6), index = 0; index < archiveZip.readUInt16LE(archiveZip.length - 12); index++) {
    const length = archiveZip.readUInt16LE(offset + 28);
    names.push(archiveZip.subarray(offset + 46, offset + 46 + length).toString('utf8'));
    offset += 46 + length;
  }
  assert.deepEqual(names, ['Unnamed project 1/Branch img src=x onerror=alert(1) (branch-c).md', 'Unnamed project 1/Conversation extra-003 (extra-00).md']);
  assert.equal(await evaluate('!!globalThis.viewerInjected'), false);
  await chooseFolder('All conversations');
  await until('document.querySelectorAll(".chat-item").length === 50 && !document.querySelector(".export-message")');
  await evaluate(`[...document.querySelectorAll('.chat-item')].find(button => button.textContent.includes('Branch <img')).click()`);
  await until('document.querySelectorAll(".message").length === 3');

  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".sidebar")).display'), 'none');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= 390'), true);
  await evaluate('document.querySelector(".back-button").click()');
  await until('getComputedStyle(document.querySelector(".sidebar")).display !== "none"');
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

  await evaluate(`(() => {
    const select = document.querySelector('#account');
    select.value = ${JSON.stringify(accountB)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until('document.querySelectorAll(".chat-item").length === 1 && document.querySelector(".chat-item").textContent.includes("other-account-chat")');
  assert.equal(await evaluate('document.querySelectorAll(".message").length'), 0);
  await until('document.querySelectorAll("#folder-select option").length === 2');
  assert.ok((await evaluate('document.querySelector("#folder-select").selectedOptions[0].textContent.trim()')).startsWith('All conversations ('));
  await chooseFolder('Unnamed project 1');
  await until('document.querySelector("#folder-select")?.selectedOptions[0]?.textContent.trim().startsWith("Unnamed project 1 (")');
  assert.equal(await evaluate('document.querySelectorAll(".chat-item").length'), 1);

  await evaluate(`document.querySelector('#account').value = [...document.querySelector('#account').options].find(option => option.value !== ${JSON.stringify(accountB)}).value;
    document.querySelector('#account').dispatchEvent(new Event('change', { bubbles: true }));`);
  await until('document.querySelectorAll(".chat-item").length === 50');
  await evaluate(`[...document.querySelectorAll('.chat-item')].find(button => button.textContent.includes('Conversation long-chat')).click()`);
  await until('document.querySelectorAll(".message").length === 100');
  writeConversation(directory, simpleRaw('long-chat', 206), undefined, 'browser-concurrent-update');
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Load more messages').click()`);
  await until('document.body.innerText.includes("changed during sync")');
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Reload conversation').click()`);
  await until('document.body.innerText.includes("206 active messages") && document.querySelectorAll(".message").length === 100');

  await evaluate('document.querySelector(".header-controls button").focus()');
  assert.equal(await evaluate('document.activeElement.textContent'), 'Refresh archive');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".header-controls button")).outlineStyle'), 'solid');
  assert.equal(await evaluate('!!document.querySelector("button").disabled'), false);
  await chooseFolder('Unnamed project 1');
  await until('document.querySelectorAll(".chat-item").length === 2');
  await evaluate('document.querySelector(".header-controls button").click()');
  await until('document.querySelectorAll("#folder-select option").length === 6 && document.querySelectorAll(".chat-item").length === 2');
  assert.ok((await evaluate('document.querySelector("#folder-select").selectedOptions[0].textContent.trim()')).startsWith('Unnamed project 1 ('));
  const saveCatalog = (runId, scope, items) => {
    const host = openDatabase(directory);
    try {
      host.beginRun(runId, 'incremental', scope, true);
      host.commitProjectCatalog(runId, items.map(projectItem));
      host.endRun(runId, false, [], { status: 'completed', count: items.length });
    } finally { host.close(); }
  };
  const projectName = 'Research <img src=https://example.test/icon onerror=alert(1)>';
  const project = projectRaw('g-p-fixture-a', projectName);
  project.gizmo.gizmo.display.description = '<script>not executed</script> Project description';
  project.gizmo.gizmo.display.profile_picture_url = 'https://example.test/remote-icon';
  saveCatalog('browser-projects', scopeA, [project, projectRaw('g-p-empty', 'Empty local project')]);
  saveCatalog('browser-other-projects', scopeB, [projectRaw('g-p-fixture-a', 'Other account project')]);
  await evaluate('document.querySelector(".chat-item").click()');
  await until('document.querySelectorAll(".message").length === 3');
  await evaluate('document.querySelector(".header-controls button").click()');
  await until(`document.querySelector('#folder-select')?.selectedOptions[0]?.textContent.trim().startsWith(${JSON.stringify(`${projectName} (`)})`);
  await until('document.querySelectorAll(".message").length === 3');
  assert.equal(await evaluate('document.querySelectorAll("#folder-select option").length'), 7);
  assert.equal(await evaluate('document.querySelectorAll(".section-label, .project-details, #folder-select img, #folder-select script").length'), 0);
  assert.ok((await evaluate('document.querySelector("#folder-select").selectedOptions[0].textContent')).includes(projectName));
  assert.equal(await evaluate('document.querySelectorAll(".chat-item").length'), 2);
  await chooseFolder('Empty local project');
  await until('document.querySelectorAll(".chat-item").length === 0 && document.body.innerText.includes("No conversations saved in this folder")');
  assert.ok((await evaluate('document.querySelector("#folder-select").selectedOptions[0].textContent.trim()')).endsWith('(0)'));
  project.gizmo.gizmo.display.name = 'Renamed research';
  saveCatalog('browser-project-rename', scopeA, [project]);
  await evaluate('document.querySelector(".header-controls button").click()');
  await until('[...document.querySelectorAll("#folder-select option")].some(option => option.textContent.includes("Renamed research"))');
  await chooseFolder('Renamed research');
  await until('document.querySelectorAll(".chat-item").length === 2');
  assert.equal(await evaluate('document.querySelectorAll(".section-label, .project-details").length'), 0);
  const readZip = buffer => {
    const entries = new Map();
    for (let offset = buffer.readUInt32LE(buffer.length - 6), index = 0; index < buffer.readUInt16LE(buffer.length - 12); index++) {
      const nameLength = buffer.readUInt16LE(offset + 28);
      const size = buffer.readUInt32LE(offset + 20);
      const local = buffer.readUInt32LE(offset + 42);
      const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      entries.set(buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'), buffer.subarray(dataStart, dataStart + size));
      offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    }
    return entries;
  };
  const png = await readFile(new URL('../fixtures/export-image.png', import.meta.url));
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>globalThis.viewerInjected = true</script></svg>');
  const notes = Buffer.from('# my notes');
  writeConversation(directory, assetRaw('browser-assets'));
  const assetHost = openDatabase(directory);
  try {
    assetHost.beginRun('browser-assets-run', 'incremental', scopeA);
    for (const [fileId, bytes, mime] of [[assetIds.upload, png, 'image/png'], [assetIds.doc, svg, 'image/svg+xml'], [assetIds.lonely, notes, 'text/markdown']]) {
      assetHost.assetChunk('browser-assets-run', `up-${fileId}`, 'browser-assets', fileId, 0, bytes.toString('base64'));
      assetHost.assetCommit('browser-assets-run', `up-${fileId}`, 'browser-assets', fileId, createHash('sha256').update(bytes).digest('hex'), bytes.length, mime);
    }
    assetHost.assetOutcome('browser-assets-run', 'browser-assets', assetIds.codeJupyter, 'unavailable', 'HTTP 404');
    assetHost.endRun('browser-assets-run', false, []);
  } finally { assetHost.close(); }
  await evaluate('document.querySelector(".header-controls button").click()');
  await until('!!document.querySelector("#folder-select") && !document.querySelector(".state[role=status]")');
  await chooseFolder('All conversations');
  await until('document.querySelectorAll(".chat-item").length === 50');
  await evaluate(`[...document.querySelectorAll('.chat-item')].find(button => button.textContent.includes('Assets browser-assets')).click()`);
  await until('document.querySelectorAll(".message").length === 3');
  await until('!!document.querySelector(".message-assets img")');
  assert.match(await evaluate('document.querySelector(".message-assets img").src'), /^blob:/);
  await until('document.querySelector(".message-assets img").naturalWidth > 0');
  assert.equal(await evaluate('document.querySelectorAll(".message-assets img").length'), 1, 'SVG is never shown inline');
  const chips = await evaluate('[...document.querySelectorAll(".asset-file button")].map(node => node.textContent)');
  assert.equal(chips.length, 2);
  assert.match(chips[0], /^Download file-document001\.bin \(\d+ KB\)$/);
  assert.match(chips[1], /^Download notes\.md \(1 KB\)$/);
  assert.equal(await evaluate('document.querySelectorAll(".asset-missing").length'), 4);
  assert.equal(await evaluate('document.querySelector(".asset-missing").textContent.includes("not downloaded yet")'), true);
  assert.equal(await evaluate('!!globalThis.viewerInjected'), false);
  await evaluate(`[...document.querySelectorAll('.asset-file button')].find(button => button.textContent.includes('notes.md')).click()`);
  assert.deepEqual(await downloaded('notes.md'), notes);
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Export Markdown').click()`);
  const singleZip = readZip(await downloaded('Assets browser-assets (browser-).zip'));
  assert.deepEqual([...singleZip.keys()].sort(), [
    `assets/${assetIds.doc}.bin`, `assets/${assetIds.lonely}.md`, `assets/${assetIds.upload}.png`, 'Assets browser-assets (browser-).md',
  ].sort());
  assert.deepEqual(singleZip.get(`assets/${assetIds.upload}.png`), png);
  assert.deepEqual(singleZip.get(`assets/${assetIds.doc}.bin`), svg);
  assert.ok(singleZip.get('Assets browser-assets (browser-).md').toString('utf8').includes(`![photo.png](assets/${assetIds.upload}.png)`));
  await chooseFolder('No project marker');
  await until('document.querySelectorAll(".chat-item").length > 1');
  await evaluate(`document.querySelector('.export-folder').click()`);
  await until('/Exported (\\d+) of \\1 conversations/.test(document.querySelector(".export-message")?.textContent ?? "")');
  const folderZip = readZip(await downloaded('No project marker.zip'));
  const folderAssets = [...folderZip.keys()].filter(name => name.includes('/assets/'));
  assert.deepEqual(folderAssets.sort(), [
    `No project marker/assets/${assetIds.doc}.bin`, `No project marker/assets/${assetIds.lonely}.md`, `No project marker/assets/${assetIds.upload}.png`,
  ].sort());
  assert.deepEqual(folderZip.get(`No project marker/assets/${assetIds.upload}.png`), png);
  assert.equal(await evaluate('!!globalThis.viewerInjected'), false);

  await evaluate(`document.querySelector('.export-option input').click()`);
  await evaluate(`document.querySelector('.chat-item').click()`);
  await until('!!document.querySelector(".export-conversation")');
  assert.equal(await evaluate('document.querySelector(".export-conversation").textContent'), 'Export Markdown (user messages only)');
  await evaluate(`document.querySelector('.export-folder').click()`);
  await until('/Exported (\\d+) of \\1 conversations to No project marker - user messages\\.zip/.test(document.querySelector(".export-message")?.textContent ?? "")');
  const userZip = readZip(await downloaded('No project marker - user messages.zip'));
  const userDocs = [...userZip.entries()].filter(([name]) => name.endsWith('.md') && !name.includes('/assets/'));
  assert.ok(userDocs.length > 1);
  for (const [name, data] of userDocs) {
    const text = data.toString('utf8');
    assert.ok(name.startsWith('No project marker - user messages/'), name);
    assert.ok(/ - user messages\.md$/.test(name), name);
    assert.ok(text.includes('included_roles: "user"'), name);
    assert.deepEqual([...text.matchAll(/^## (.+)$/gm)].map(match => match[1]).filter(role => role !== 'User'), [], name);
  }
  await evaluate(`document.querySelector('.export-option input').click()`);
  assert.equal(await evaluate('document.querySelector(".export-conversation").textContent'), 'Export Markdown');
  await evaluate(`document.querySelector('#account').value = ${JSON.stringify(accountB)};
    document.querySelector('#account').dispatchEvent(new Event('change', { bubbles: true }));`);
  await until('[...document.querySelectorAll("#folder-select option")].some(option => option.textContent.includes("Other account project"))');
  assert.equal(await evaluate('document.body.innerText.includes("Renamed research")'), false);
  await command('Page.reload', {}, sessionId);
  await until('document.body.innerText.includes("This tab has no access token")');
  assert.equal(await evaluate('document.querySelectorAll(".message").length'), 0);
  assert.deepEqual(externalRequests, [], 'Viewer must not request remote resources');
  assert.deepEqual(exceptions, [], 'Viewer must not throw browser runtime errors');
  console.log('Viewer browser checks passed: compact conversation rows, folder names/counts, last-sync footer, account isolation, hostile metadata, Markdown/HTML, paging, narrow layout, revision reload, saved images/files with ZIP export, and private launch.');
} finally {
  ws?.close();
  if (browser && browser.exitCode === null) browser.kill();
  if (closed) await closed;
  if (viewer) await viewer.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
