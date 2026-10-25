import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../../lib/sync/protocol.ts';
import { assetBlobPath } from '../host/assets.ts';
import { assetFileName, conversationMarkdown, markdownFileName } from './markdown.ts';
import type { Account, ArchiveStatus, AssetState, ConversationDetail, ConversationGroup, ConversationSummary, ExportAsset, MarkdownExport, Page, ViewerAsset, ViewerMessage } from './types.ts';

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

function catalogStatus(value: SQLOutputValue): 'running' | 'completed' | 'failed' | 'cancelled' {
  if (value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled') return value;
  return corrupt();
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
  private schemaVersion: number;
  private directory: string;

  constructor(directory: string) {
    this.directory = directory;
    this.db = new DatabaseSync(join(directory, 'sync.db'), { readOnly: true });
    try {
      this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000;');
      const version = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version;
      if (version !== 3 && version !== 4 && version !== 5) {
        throw new ViewerError(409, 'INCOMPATIBLE_SCHEMA', 'This viewer requires archive schema 3, 4, or 5. Update the host/viewer together.');
      }
      this.schemaVersion = version;
      const required: Record<string, string[]> = {
        accounts: ['id', 'label', 'email'],
        conversations: ['id', 'account_id', 'title', 'update_time', 'last_synced_at', 'raw_sha256', 'raw_json', 'project_id', 'gizmo_id'],
        messages: ['id', 'conversation_id', 'role', 'model', 'content_type', 'text', 'create_time'],
        sync_runs: ['ended_at'],
      };
      if (version >= 4) {
        required.projects = ['account_id', 'id', 'name', 'description', 'is_archived', 'remote_updated_at', 'last_synced_at', 'last_seen_run_id'];
        required.project_catalog_state = ['account_id', 'last_successful_run_id', 'status', 'error_category'];
      }
      if (version >= 5) {
        required.assets = ['sha256', 'size', 'mime'];
        required.asset_refs = ['account_id', 'conversation_id', 'file_id', 'kind', 'message_ids', 'name', 'declared_mime', 'declared_size', 'sha256', 'state'];
      }
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
      (SELECT COUNT(*) FROM messages) AS messages,
      (SELECT MAX(ended_at) FROM sync_runs) AS last_sync_at`).get();
    if (!row) return corrupt();
    return {
      schemaVersion: this.schemaVersion, accounts: number(row, 'accounts'),
      conversations: number(row, 'conversations'), messages: number(row, 'messages'),
      lastSyncAt: nullableText(row, 'last_sync_at') ? text(row, 'last_sync_at') : null,
    };
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
      const catalog = this.schemaVersion >= 4
        ? this.db.prepare(`SELECT p.*, s.last_successful_run_id, s.status AS catalog_status, s.error_category
          FROM projects p JOIN project_catalog_state s ON s.account_id = p.account_id
          WHERE p.account_id = ? ORDER BY p.id`).all(accountId) : [];
      const savedProjects = new Map(catalog.map(row => [`project:${text(row, 'id')}`, row]));
      for (const id of savedProjects.keys()) {
        if (!rows.some(row => row.group_id === id)) rows.push({ group_id: id, count: 0 });
      }
      rows.sort((a, b) => text(a, 'group_id').localeCompare(text(b, 'group_id')));
      for (const row of rows) {
        const id = text(row, 'group_id');
        const conversationCount = number(row, 'count');
        if (id.startsWith('project:')) {
          const saved = savedProjects.get(id);
          const fallback = `Unnamed project ${++projects}`;
          groups.push({ id, kind: 'project', label: saved ? text(saved, 'name') : fallback, conversationCount,
            ...(saved ? { project: {
              description: nullableText(saved, 'description'), archived: saved.is_archived === null ? null : number(saved, 'is_archived') === 1,
              updatedAt: nullableText(saved, 'remote_updated_at'), syncedAt: text(saved, 'last_synced_at'),
              older: text(saved, 'last_seen_run_id') !== saved.last_successful_run_id,
              catalogStatus: catalogStatus(saved.catalog_status), catalogError: nullableText(saved, 'error_category'),
            } } : {}),
          });
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
      const savedProject = this.schemaVersion >= 4 && group.startsWith('project:') &&
        this.db.prepare('SELECT 1 FROM projects WHERE account_id = ? AND id = ?').get(accountId, group.slice(8));
      if (group !== 'all' && !savedProject && !this.db.prepare(`SELECT 1 FROM conversations c
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

  /** Asset references of one conversation grouped by message. Stored files that vanished from disk read as unavailable. */
  private assetsByMessage(accountId: string, id: string): Map<string, ViewerAsset[]> {
    const result = new Map<string, ViewerAsset[]>();
    if (this.schemaVersion < 5) return result;
    const rows = this.db.prepare(`SELECT r.file_id, r.kind, r.name, r.declared_mime, r.declared_size, r.state,
        r.message_ids, r.sha256, a.mime AS stored_mime, a.size AS stored_size
      FROM asset_refs r LEFT JOIN assets a ON a.sha256 = r.sha256
      WHERE r.account_id = ? AND r.conversation_id = ? ORDER BY r.rowid`).all(accountId, id);
    for (const row of rows) {
      let state = text(row, 'state') as AssetState;
      const stored = state === 'stored';
      if (stored && !existsSync(assetBlobPath(this.directory, text(row, 'sha256')))) state = 'unavailable';
      const asset: ViewerAsset = {
        fileId: text(row, 'file_id'), kind: text(row, 'kind') as ViewerAsset['kind'], name: nullableText(row, 'name'),
        mime: stored ? nullableText(row, 'stored_mime') : nullableText(row, 'declared_mime'),
        size: stored ? number(row, 'stored_size') : row.declared_size === null ? null : number(row, 'declared_size'),
        state,
      };
      let messageIds: unknown;
      try { messageIds = JSON.parse(text(row, 'message_ids')); } catch { return corrupt(); }
      if (!Array.isArray(messageIds) || messageIds.some(item => typeof item !== 'string')) return corrupt();
      for (const messageId of messageIds as string[]) result.set(messageId, [...(result.get(messageId) ?? []), asset]);
    }
    return result;
  }

  private readMessages(accountId: string, id: string, nodes: Array<{ id: string; unsupported: boolean }>): ViewerMessage[] {
    const query = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id = ?');
    const assets = this.assetsByMessage(accountId, id);
    return nodes.map(node => {
      const row = query.get(id, node.id);
      if (!row) return corrupt();
      return {
        id: node.id, role: text(row, 'role'), model: nullableText(row, 'model'),
        contentType: nullableText(row, 'content_type'), text: text(row, 'text'),
        createTime: row.create_time === null ? null : number(row, 'create_time'),
        unsupportedContent: node.unsupported, assets: assets.get(node.id) ?? [],
      };
    });
  }

  /** Full saved active branch as one Markdown document, read from a single consistent snapshot. */
  exportMarkdown(accountId: string, id: string): MarkdownExport {
    return this.snapshot(() => {
      this.checkAccount(accountId);
      const { detail, path } = this.readConversation(accountId, id);
      const messages = this.readMessages(accountId, id, path);
      const files = new Map<string, ExportAsset>();
      for (const asset of messages.flatMap(message => message.assets)) {
        if (asset.state === 'stored' && asset.size !== null && !files.has(asset.fileId)) {
          files.set(asset.fileId, { fileId: asset.fileId, fileName: assetFileName(asset.fileId, asset.mime), mime: asset.mime, size: asset.size });
        }
      }
      return {
        id, fileName: markdownFileName(detail.title, id),
        markdown: conversationMarkdown(detail, messages, files), assets: [...files.values()],
      };
    });
  }

  /** Location and metadata of one stored file, only for the given account and conversation. */
  assetFile(accountId: string, conversationId: string, fileId: string):
    { path: string; mime: string | null; size: number; name: string | null } {
    if (this.schemaVersion < 5) throw new ViewerError(404, 'NOT_FOUND', 'Saved file not found.');
    return this.snapshot(() => {
      this.checkAccount(accountId);
      const row = this.db.prepare(`SELECT r.name, a.sha256, a.mime, a.size FROM asset_refs r
        JOIN assets a ON a.sha256 = r.sha256
        WHERE r.account_id = ? AND r.conversation_id = ? AND r.file_id = ? AND r.state = 'stored'`)
        .get(accountId, conversationId, fileId);
      if (!row) throw new ViewerError(404, 'NOT_FOUND', 'Saved file not found for this conversation.');
      const path = assetBlobPath(this.directory, text(row, 'sha256'));
      const size = number(row, 'size');
      if (!existsSync(path) || statSync(path).size !== size) {
        throw new ViewerError(404, 'NOT_FOUND', 'The saved file is missing from the local archive folder.');
      }
      return { path, mime: nullableText(row, 'mime'), size, name: nullableText(row, 'name') };
    });
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
      const items = this.readMessages(accountId, id, path.slice(offset, offset + limit));
      const next = offset + items.length;
      return {
        items,
        nextCursor: next < path.length ? encodeCursor({ account: accountId, id, revision, offset: next }) : null,
      };
    });
  }
}
