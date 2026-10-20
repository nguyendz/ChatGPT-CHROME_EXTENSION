import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConversationNodes } from '../../lib/chatgpt-parse.ts';

const raw = {
  conversation_id: 'chat-1',
  current_node: 'assistant-new',
  title: 'Example',
  mapping: {
    root: { parent: null, message: { id: 'root', author: { role: 'system' }, content: { parts: [] } } },
    user: { parent: 'root', message: { id: 'user', author: { role: 'user' }, content: { parts: ['Question'] }, create_time: 2 } },
    'assistant-old': { parent: 'user', message: { id: 'assistant-old', author: { role: 'assistant' }, content: { parts: ['Old answer'] }, create_time: 3 } },
    'assistant-new': {
      parent: 'user',
      message: {
        id: 'assistant-new', author: { role: 'assistant' },
        content: { parts: ['New answer'] }, metadata: { model_slug: 'test-model' }, create_time: 4,
      },
    },
    empty: { parent: null, message: null },
  },
};

test('storage parser retains every branch and marks only current-node ancestry active', () => {
  const messages = parseConversationNodes(raw);
  assert.equal(messages.length, 4);
  assert.deepEqual(
    messages.filter(message => message.isOnActiveBranch).map(message => message.id),
    ['root', 'user', 'assistant-new'],
  );
  assert.equal(messages.find(message => message.id === 'assistant-old').parentId, 'user');
  assert.equal(messages.find(message => message.id === 'assistant-old').isOnActiveBranch, false);
});
