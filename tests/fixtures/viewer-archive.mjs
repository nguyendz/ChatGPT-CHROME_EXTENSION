import { createHash } from 'node:crypto';
import { openDatabase } from '../../local-app/host/db.ts';

export const scopeA = { userId: 'viewer-user-a', workspaceId: 'workspace-a', email: 'reader@example.test' };
export const scopeB = { userId: 'viewer-user-b', workspaceId: 'workspace-b' };
export const digest = raw => createHash('sha256').update(JSON.stringify(raw)).digest('hex');

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
  writeConversation(directory, simpleRaw('long-chat', 205, 101));
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
