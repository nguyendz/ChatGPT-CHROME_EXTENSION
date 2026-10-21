import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { join } from 'node:path';
import { isRecord } from '../../lib/sync/protocol.ts';
import type { Account, ArchiveStatus, ConversationDetail, ConversationGroup, ConversationSummary, Page, ViewerMessage } from './types.ts';

type Row = Record<string, SQLOutputValue>;
const MAX_RAW_BYTES = 60 * 1024 * 1024;
// Project/custom-GPT distinctions are based on observed conversation-root metadata.
const GROUP_KEY_SQL = `CASE
  WHEN c.gizmo_id GLOB 'g-p-?*' AND json_extract(c.raw_json, '$.gizmo_type') = 'snorlax'
    THEN 'project:' || c.gizmo_id
  WHEN c.gizmo_id GLOB 'g-?*' AND json_extract(c.raw_json, '$.gizmo_type') = 'gpt'
    THEN 'gpt:' || c.gizmo_id
  WHEN COALESCE(c.gizmo_id, '') = '' AND COALESCE(c.project_id, '') = ''
    THEN 'unmarked'
  ELSE 'other' END`;

export class ViewerError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ViewerError';
    this.status = status;
    this.code = code;
  }
}

function corrupt(): never {
  throw new ViewerError(500, 'INVALID_ARCHIVE', 'Stored archive data is invalid. The viewer has not changed it.');
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') return corrupt();
  return value;
}

function number(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return corrupt();
  return value;
}

function nullableText(row: Row, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}

function summary(row: Row): ConversationSummary {
  return {
    id: text(row, 'id'), title: nullableText(row, 'title'),
    updateTime: row.update_time === null ? null : number(row, 'update_time'),
    lastSyncedAt: text(row, 'last_synced_at'), messageCount: number(row, 'message_count'),
  };
}

export function dataDirectory(): string {
  const directory = process.env.CHATGPT_SYNC_DATA_DIR ??
    (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ChatGPTBackup') : undefined);
  if (!directory) throw new ViewerError(500, 'MISSING_DIRECTORY', 'Set CHATGPT_SYNC_DATA_DIR or LOCALAPPDATA to locate sync.db.');
  return directory;
}

export function pageLimit(value: string | null, fallback: number, maximum: number): number {
  if (value === null) return fallback;
  if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > maximum) {
    throw new ViewerError(400, 'INVALID_INPUT', `Page limit must be between 1 and ${maximum}.`);
  }
  return Number(value);
}

function decodeCursor(value: string): Record<string, unknown> {
  if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ViewerError(400, 'INVALID_CURSOR', 'Invalid page cursor.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new ViewerError(400, 'INVALID_CURSOR', 'Invalid page cursor.');
  }
  if (!isRecord(decoded)) throw new ViewerError(400, 'INVALID_CURSOR', 'Invalid page cursor.');
  return decoded;
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export class Archive {
  private db: DatabaseSync;

  constructor(directory: string) {
    this.db = new DatabaseSync(join(directory, 'sync.db'), { readOnly: true });
    try {
      this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000;');
      const version = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version;
      if (version !== 3) {
        throw new ViewerError(409, 'INCOMPATIBLE_SCHEMA', 'This viewer requires archive schema 3. Update the host/viewer together.');
      }
      const required: Record<string, string[]> = {
        accounts: ['id', 'label', 'email'],
        conversations: ['id', 'account_id', 'title', 'update_time', 'last_synced_at', 'raw_sha256', 'raw_json', 'project_id', 'gizmo_id'],
        messages: ['id', 'conversation_id', 'role', 'model', 'content_type', 'text', 'create_time'],
      };
      for (const [table, columns] of Object.entries(required)) {
        const existing = this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
        if (columns.some(column => !existing.includes(column))) {
          throw new ViewerError(409, 'INCOMPATIBLE_SCHEMA', 'Archive columns are missing. Update the host/viewer together.');
        }
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  private snapshot<T>(read: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = read();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  status(): ArchiveStatus {
    const row = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM accounts) AS accounts,
      (SELECT COUNT(*) FROM conversations) AS conversations,
      (SELECT COUNT(*) FROM messages) AS messages`).get();
    if (!row) return corrupt();
    return { schemaVersion: 3, accounts: number(row, 'accounts'), conversations: number(row, 'conversations'), messages: number(row, 'messages') };
  }

  accounts(): Account[] {
    return this.db.prepare(`SELECT a.id, a.label, a.email,
      (SELECT COUNT(*) FROM conversations c WHERE c.account_id = a.id) AS count
      FROM accounts a ORDER BY a.id`).all().map((row, index) => ({
      id: text(row, 'id'),
      label: nullableText(row, 'label') || nullableText(row, 'email') || `Local account ${index + 1}`,
      conversationCount: number(row, 'count'),
    }));
  }

  private checkAccount(accountId: string) {
    if (!this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) {
      throw new ViewerError(404, 'NOT_FOUND', 'Local account not found.');
    }
  }

  groups(accountId: string): ConversationGroup[] {
    return this.snapshot(() => {
      this.checkAccount(accountId);
      const rows = this.db.prepare(`SELECT ${GROUP_KEY_SQL} AS group_id, COUNT(*) AS count
        FROM conversations c WHERE c.account_id = ? GROUP BY group_id ORDER BY group_id`).all(accountId);
      const groups: ConversationGroup[] = [{
        id: 'all', kind: 'all', label: 'All conversations',
        conversationCount: rows.reduce((sum, row) => sum + number(row, 'count'), 0),
      }];
      let projects = 0;
      let gpts = 0;
      for (const row of rows) {
        const id = text(row, 'group_id');
        const conversationCount = number(row, 'count');
        if (id.startsWith('project:')) {
          groups.push({ id, kind: 'project', label: `Unnamed project ${++projects}`, conversationCount });
        } else if (id.startsWith('gpt:')) {
          groups.push({ id, kind: 'gpt', label: `Unnamed custom GPT ${++gpts}`, conversationCount });
        } else if (id === 'unmarked' || id === 'other') {
          groups.push({
            id, kind: id, label: id === 'unmarked' ? 'No project marker' : 'Other marked chats', conversationCount,
          });
        } else return corrupt();
      }
      const order: Record<ConversationGroup['kind'], number> = { all: 0, project: 1, gpt: 2, unmarked: 3, other: 4 };
      return groups.sort((left, right) => order[left.kind] - order[right.kind]);
    });
  }

  list(accountId: string, limit: number, cursor: string | null, group = 'all'): Page<ConversationSummary> {
    return this.snapshot(() => {
      this.checkAccount(accountId);
      if (group !== 'all' && !this.db.prepare(`SELECT 1 FROM conversations c
        WHERE c.account_id = ? AND (${GROUP_KEY_SQL}) = ? LIMIT 1`).get(accountId, group)) {
        throw new ViewerError(404, 'NOT_FOUND', 'Conversation folder not found in this account. Refresh the archive.');
      }
      let after: { time: number | null; id: string } | undefined;
      if (cursor !== null) {
        const value = decodeCursor(cursor);
        if (value.account !== accountId || value.group !== group || typeof value.id !== 'string' ||
          !(value.time === null || typeof value.time === 'number' && Number.isFinite(value.time))) {
          throw new ViewerError(400, 'INVALID_CURSOR', 'The list cursor is invalid for this account or folder.');
        }
        after = { time: value.time, id: value.id };
      }
      const condition = after
        ? after.time === null ? 'AND c.update_time IS NULL AND c.id > ?'
          : 'AND (c.update_time < ? OR (c.update_time = ? AND c.id > ?) OR c.update_time IS NULL)'
        : '';
      const parameters = !after ? [] : after.time === null ? [after.id] : [after.time, after.time, after.id];
      const groupCondition = group === 'all' ? '' : `AND (${GROUP_KEY_SQL}) = ?`;
      const groupParameters = group === 'all' ? [] : [group];
      const rows = this.db.prepare(`SELECT c.id, c.title, c.update_time, c.last_synced_at,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
        FROM conversations c WHERE c.account_id = ? ${groupCondition} ${condition}
        ORDER BY c.update_time DESC NULLS LAST, c.id ASC LIMIT ?`).all(accountId, ...groupParameters, ...parameters, limit + 1);
      const items = rows.slice(0, limit).map(summary);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last
          ? encodeCursor({ account: accountId, group, time: last.updateTime, id: last.id }) : null,
      };
    });
  }

  private readConversation(accountId: string, id: string) {
    const row = this.db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
      FROM conversations c WHERE c.account_id = ? AND c.id = ?`).get(accountId, id);
    if (!row) throw new ViewerError(404, 'NOT_FOUND', 'Saved conversation not found in this account.');
    const rawJson = text(row, 'raw_json');
    if (Buffer.byteLength(rawJson) > MAX_RAW_BYTES) {
      throw new ViewerError(413, 'TOO_LARGE', 'This saved conversation exceeds the 60 MiB viewer limit.');
    }
    let raw: unknown;
    try { raw = JSON.parse(rawJson); } catch { return corrupt(); }
    if (!isRecord(raw) || !isRecord(raw.mapping)) return corrupt();
    const mapping = raw.mapping;
    const warnings: string[] = [];
    const path: Array<{ id: string; unsupported: boolean }> = [];
    const visited = new Set<string>();
    let key = raw.current_node;
    if (typeof key !== 'string' || !key) {
      warnings.push('The saved active branch has no valid current_node. No transcript was inferred.');
    } else {
      while (key !== null && key !== undefined) {
        if (typeof key !== 'string' || visited.has(key) || !Object.hasOwn(mapping, key) || !isRecord(mapping[key])) {
          warnings.push('The saved active branch contains a cycle or missing/invalid node. No partial transcript was inferred.');
          path.length = 0;
          break;
        }
        visited.add(key);
        const node = mapping[key];
        if (!isRecord(node)) return corrupt();
        if (node.message !== null && node.message !== undefined) {
          if (!isRecord(node.message)) return corrupt();
          const message = node.message;
          const content = isRecord(message.content) ? message.content : {};
          const contentType = content.content_type ?? content.contentType;
          const metadata = isRecord(message.metadata) ? message.metadata : {};
          path.push({
            id: typeof message.id === 'string' && message.id ? message.id : key,
            unsupported: (Array.isArray(content.parts) && content.parts.some(part => part !== null && typeof part !== 'string')) ||
              (Array.isArray(metadata.attachments) && metadata.attachments.length > 0) ||
              (typeof contentType === 'string' && !['text', 'code'].includes(contentType)),
          });
        }
        key = node.parent;
      }
    }
    path.reverse();
    if (new Set(path.map(item => item.id)).size !== path.length) return corrupt();
    const detail: ConversationDetail = {
      ...summary(row), revision: text(row, 'raw_sha256'), activeMessageCount: path.length,
      otherMessageCount: number(row, 'message_count') - path.length, warnings,
    };
    if (detail.otherMessageCount < 0) return corrupt();
    return { detail, path };
  }

  detail(accountId: string, id: string): ConversationDetail {
    return this.snapshot(() => this.readConversation(accountId, id).detail);
  }

  messages(accountId: string, id: string, revision: string, limit: number, cursor: string | null): Page<ViewerMessage> {
    return this.snapshot(() => {
      const { detail, path } = this.readConversation(accountId, id);
      if (detail.revision !== revision) {
        throw new ViewerError(409, 'STALE_REVISION', 'This conversation changed during sync. Reload it before reading more messages.');
      }
      let offset = 0;
      if (cursor !== null) {
        const value = decodeCursor(cursor);
        if (value.account !== accountId || value.id !== id || value.revision !== revision ||
          typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) ||
          value.offset < 0 || value.offset > path.length) {
          throw new ViewerError(400, 'INVALID_CURSOR', 'The message cursor is invalid for this conversation revision.');
        }
        offset = value.offset;
      }
      const selected = path.slice(offset, offset + limit);
      const query = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id = ?');
      const items = selected.map(node => {
        const row = query.get(id, node.id);
        if (!row) return corrupt();
        return {
          id: node.id, role: text(row, 'role'), model: nullableText(row, 'model'),
          contentType: nullableText(row, 'content_type'), text: text(row, 'text'),
          createTime: row.create_time === null ? null : number(row, 'create_time'),
          unsupportedContent: node.unsupported,
        };
      });
      const next = offset + items.length;
      return {
        items,
        nextCursor: next < path.length ? encodeCursor({ account: accountId, id, revision, offset: next }) : null,
      };
    });
  }
}
