import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

function usage() {
  return 'Usage: node local-app/scripts/db-query.mjs <counts|list|runs|show <conversation-id>>';
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['counts', 'list', 'runs', 'show'].includes(command) ||
    (command === 'show' ? args.length !== 1 : args.length !== 0)) {
    throw new Error(usage());
  }

  const base = process.env.CHATGPT_SYNC_DATA_DIR ??
    (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ChatGPTBackup') : undefined);
  if (!base) throw new Error('Set CHATGPT_SYNC_DATA_DIR or LOCALAPPDATA to locate sync.db.');

  const db = new DatabaseSync(join(base, 'sync.db'), { readOnly: true });
  try {
    if (command === 'counts') {
      const counts = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM accounts) AS accounts,
          (SELECT COUNT(*) FROM conversations) AS conversations,
          (SELECT COUNT(*) FROM messages) AS messages,
          (SELECT COUNT(*) FROM sync_runs) AS runs,
          (SELECT COUNT(*) FROM sync_failures) AS failures
      `).get();
      console.log(JSON.stringify(counts, null, 2));
      return;
    }

    if (command === 'list') {
      const rows = db.prepare(`
        SELECT c.id, c.update_time, c.last_synced_at,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
        FROM conversations c
        ORDER BY c.last_synced_at DESC, c.id
      `).all();
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    if (command === 'runs') {
      const rows = db.prepare(`
        SELECT mode, status, started_at, ended_at, new, updated, unchanged, failed
        FROM sync_runs
        ORDER BY started_at DESC
        LIMIT 10
      `).all();
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    const conversation = db.prepare(`
      SELECT id, title, create_time, update_time, current_node, remote_state, raw_sha256
      FROM conversations WHERE id = ?
    `).get(args[0]);
    if (!conversation) throw new Error(`Conversation not found: ${args[0]}`);
    const messages = db.prepare(`
      SELECT id, parent_id, role, model, content_type, text, create_time, is_on_active_branch
      FROM messages WHERE conversation_id = ?
      ORDER BY create_time, id
    `).all(args[0]);
    console.log(JSON.stringify({ ...conversation, messages, messageCount: messages.length }, null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
