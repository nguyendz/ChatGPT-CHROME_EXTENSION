import { createHash } from 'node:crypto';
import { openDatabase } from '../../local-app/host/db.ts';

export const scopeA = { userId: 'viewer-user-a', workspaceId: 'workspace-a', email: 'reader@example.test' };
export const scopeB = { userId: 'viewer-user-b', workspaceId: 'workspace-b' };
export const digest = raw => createHash('sha256').update(JSON.stringify(raw)).digest('hex');
export const richMessage = [
  '# Rendered Markdown heading',
  '',
  '**Bold text**, *italic text*, ~~deleted text~~, and `inline <code>`.',
  '',
  '> Quoted text',
  '',
  '- First item',
  '- Second item',
  '',
  '- [x] Completed task',
  '',
  '| Column A | Column B |',
  '| --- | --- |',
  '| Markdown cell | Other cell |',
  '',
  '<table style="position:fixed" onclick="globalThis.viewerInjected = true"><thead><tr><th>HTML column</th></tr></thead><tbody><tr><td>Rendered HTML cell</td></tr></tbody></table>',
  '',
  '<strong onclick="globalThis.viewerInjected = true">Safe inline HTML</strong>',
  '',
  '<details><summary>More detail</summary><p>Expanded HTML text</p></details>',
  '',
  '[Reference](https://example.test/docs)',
  '',
  '[Unsafe Markdown link](javascript:alert%281%29)',
  '',
  '<a href="javascript:alert(1)" onclick="globalThis.viewerInjected = true">Unsafe HTML link</a>',
  '',
  '![Diagram](https://example.test/image.png)',
  '',
  '<img src="https://example.test/html-image.png" onerror="globalThis.viewerInjected = true" alt="HTML diagram">',
  '',
  '<script>globalThis.viewerInjected = true</script>',
  '',
  '<style>body { display: none; }</style>',
  '',
  '<iframe src="https://example.test/frame"></iframe>',
  '',
  '<form action="https://example.test/send"><button>Unsafe submit</button></form>',
  '',
  '```js',
  'const example = "<b>Literal code</b>";',
  '```',
  '',
  '```html',
  '<h3>HTML preview heading</h3>',
  '<table><tr><th>Preview column</th></tr><tr><td>Preview cell</td></tr></table>',
  '<script>globalThis.viewerInjected = true</script>',
  '<img src="https://example.test/preview-image.png" onerror="globalThis.viewerInjected = true" alt="Preview diagram">',
  '<iframe src="https://example.test/preview-frame"></iframe>',
  '<p style="position:fixed" onclick="globalThis.viewerInjected = true">Preview paragraph</p>',
  '```',
].join('\n');

export function simpleRaw(id, count = 1, updateTime = 100) {
  const mapping = { root: { parent: null, message: null } };
  for (let index = 0; index < count; index++) {
    mapping[`node-${index}`] = {
      parent: index ? `node-${index - 1}` : 'root',
      message: {
        id: `${id}-message-${index}`, author: { role: index % 2 ? 'assistant' : 'user' },
        create_time: index === 0 ? null : index,
        content: { content_type: 'text', parts: [`Saved ${id} message ${index}`] },
      },
    };
  }
  return {
    conversation_id: id, title: `Conversation ${id}`, update_time: updateTime,
    current_node: `node-${count - 1}`, mapping,
  };
}

export function branchRaw() {
  const raw = simpleRaw('branch-chat', 2);
  raw.gizmo_id = 'g-p-fixture-a';
  raw.gizmo_type = 'snorlax';
  raw.title = 'Branch <img src=x onerror=alert(1)>';
  raw.mapping['node-0'].message.create_time = 200;
  raw.mapping['node-0'].message.content.parts = ['<script>globalThis.viewerInjected = true</script>\nUser first'];
  raw.mapping['node-1'].message.create_time = 1;
  raw.mapping['node-1'].message.content.parts = [richMessage];
  raw.mapping.alternate = {
    parent: 'node-0',
    message: { id: 'branch-alternative', author: { role: 'assistant' }, content: { parts: ['INACTIVE BRANCH ONLY'] } },
  };
  raw.mapping.tool = {
    parent: 'node-1',
    message: {
      id: 'branch-tool', author: { role: 'tool' }, create_time: 0,
      content: { content_type: 'multimodal_text', parts: ['Saved tool text', { asset_pointer: 'not-downloaded' }] },
    },
  };
  raw.current_node = 'tool';
  return raw;
}

export function writeConversation(directory, raw, account = scopeA, runId = `run-${raw.conversation_id}`) {
  const db = openDatabase(directory);
  try {
    const { accountId } = db.beginRun(runId, 'single', account);
    db.upsertConversation(runId, raw.conversation_id, raw, digest(raw));
    db.endRun(runId, false, []);
    return accountId;
  } finally { db.close(); }
}

export function seedViewer(directory, extras = 0) {
  const raw = branchRaw();
  const accountA = writeConversation(directory, raw);
  const long = simpleRaw('long-chat', 205, 101);
  long.mapping['node-0'].message.content = {
    content_type: 'code', parts: ['**Stored code stays literal**\n<table><tr><td>Not rendered as a table</td></tr></table>'],
  };
  writeConversation(directory, long);
  const other = simpleRaw('other-account-chat');
  other.gizmo_id = 'g-p-fixture-a';
  other.gizmo_type = 'snorlax';
  const accountB = writeConversation(directory, other, scopeB);
  if (extras) {
    const db = openDatabase(directory);
    try {
      db.beginRun('extra-chats', 'incremental', scopeA);
      for (let index = 0; index < extras; index++) {
        const extra = simpleRaw(`extra-${String(index).padStart(3, '0')}`);
        if (index % 3 === 0) delete extra.update_time;
        if (index === 0) extra.title = null;
        if (index < 4) {
          extra.gizmo_id = ['g-fixture-assistant', 'g-unknown', 'g-p-fixture-b', 'g-p-fixture-a'][index];
          extra.gizmo_type = ['gpt', 'new-kind', 'snorlax', 'snorlax'][index];
        }
        db.upsertConversation('extra-chats', extra.conversation_id, extra, digest(extra));
      }
      db.endRun('extra-chats', false, []);
    } finally { db.close(); }
  }
  return { accountA, accountB, raw, revision: digest(raw) };
}
