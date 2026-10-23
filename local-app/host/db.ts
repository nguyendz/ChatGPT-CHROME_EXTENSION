import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseConversationNodes, type ChatGptRawConversation } from '../../lib/chatgpt-parse.ts';
import { HOST_VERSION } from '../../lib/sync/protocol.ts';
import type { AccountScope, HostStatus, ProjectSyncOutcome, UpsertStatus } from '../../lib/sync/protocol.ts';
import { checkProjectCatalogSize, projectItemJson, projectMetadata } from '../../lib/project-catalog.ts';
import type { ProjectItem } from '../../lib/project-catalog.ts';

const SCHEMA_VERSION = 4;
const MAX_CONVERSATION_BYTES = 60 * 1024 * 1024;
const MAX_SYNC_DIFF_BYTES = 5 * 1024 * 1024;
const MAX_SYNC_DIFF_PATHS = 64;
const MAX_SYNC_DIFF_DEPTH = 32;
const SAFE_SYNC_DIFF_FIELDS = new Set([
  'conversation_id', 'title', 'create_time', 'update_time', 'current_node', 'mapping',
  'parent', 'children', 'message', 'id', 'author', 'role', 'name', 'metadata',
  'content', 'content_type', 'parts', 'text', 'status', 'end_turn', 'weight',
  'recipient', 'channel', 'moderation_results', 'plugin_ids', 'conversation_template_id',
  'gizmo_id', 'gizmo_type', 'is_archived', 'is_starred', 'safe_urls', 'blocked_urls',
  'default_model_slug', 'atlas_mode_enabled', 'conversation_origin', 'is_read_only',
  'voice', 'async_status', 'disabled_tool_ids', 'is_temporary_chat', 'is_do_not_remember',
  'memory_scope', 'context_scopes', 'sugar_item_id', 'sugar_item_visible', 'pinned_time',
  'is_study_mode', 'owner', 'sectioned_conversation', 'context_truncation_continuation',
  'finish_details', 'stop', 'stop_tokens', 'is_complete', 'real_author',
]);
type SyncDiffKind = 'added' | 'removed' | 'type-changed' | 'value-changed' |
  'array-length-changed' | 'nested-changed';
type SyncDiffReport =
  | { schemaVersion: 1; status: 'skipped-size-limit' }
  | {
    schemaVersion: 1;
    changedPaths: Array<{ path: string; change: SyncDiffKind }>;
    truncated: boolean;
    noSemanticChanges: boolean;
  };

export class HostOperationError extends Error {
  readonly code: 'BUSY' | 'INVALID_PAYLOAD' | 'TOO_LARGE' | 'ACCOUNT_MISMATCH';

  constructor(code: 'BUSY' | 'INVALID_PAYLOAD' | 'TOO_LARGE' | 'ACCOUNT_MISMATCH', message: string) {
    super(message);
    this.code = code;
  }
}

export interface HostDatabase {
  status(): HostStatus;
  beginRun(runId: string, mode: 'single' | 'incremental', account: AccountScope, projectCatalog?: boolean): { runId: string; accountId: string };
  commitProjectCatalog(runId: string, items: ProjectItem[]): { count: number };
  diffManifest(
    runId: string,
    items: Array<{ conversationId: string; updateTimeToken: string | null }>,
  ): {
    listed: number;
    unchanged: number;
    changed: Array<{ conversationId: string; updateTimeToken: string | null }>;
  };
  upsertConversation(
    runId: string, conversationId: string, raw: Record<string, unknown>, sha256: string,
    manifestUpdateToken?: string | null,
  ): {
    conversationId: string; status: UpsertStatus; messageCount: number;
    newMessageCount: number; changeKind?: 'metadata-only';
  };
  endRun(
    runId: string,
    cancelled: boolean,
    failures: Array<{ conversationId: string | null; error: string; retryable: boolean }>,
    projects?: ProjectSyncOutcome,
  ): {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    counts: { listed: number; new: number; updated: number; unchanged: number; failed: number };
  };
  close(): void;
}

function accountIdFor(account: AccountScope) {
  return JSON.stringify([account.userId, account.workspaceId]);
}

function syncFailureCategory(error: string) {
  const message = error.toLowerCase();
  if (message.includes('http 401') || message.includes('sign-in expired')) return 'chatgpt-auth';
  if (message.includes('http 403')) return 'chatgpt-forbidden';
  if (message.includes('http 429') || message.includes('rate-limited')) return 'chatgpt-rate-limit';
  if (/http 5\d\d/.test(message)) return 'chatgpt-server';
  if (message.includes('consistency scans')) return 'list-unstable';
  if (message.includes('invalid conversation-list response')) return 'list-response';
  if (message.includes('complete conversation list') || message.includes('conversation-list request')) {
    return 'list-fetch';
  }
  if (message.includes('local host')) return 'local-host';
  if (message.includes('conversation detail')) return 'conversation-detail';
  return 'other';
}

function isConversationMapping(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(node => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    const candidate = node as Record<string, unknown>;
    return (candidate.parent === undefined || candidate.parent === null || typeof candidate.parent === 'string') &&
      (candidate.message === undefined || candidate.message === null ||
        typeof candidate.message === 'object' && !Array.isArray(candidate.message));
  });
}

function syncDiffReport(
  previousJson: unknown, next: Record<string, unknown>, nextBytes: number,
): SyncDiffReport {
  if (typeof previousJson !== 'string') throw new Error('Stored conversation payload is not text.');
  if (Buffer.byteLength(previousJson, 'utf8') > MAX_SYNC_DIFF_BYTES || nextBytes > MAX_SYNC_DIFF_BYTES) {
    return { schemaVersion: 1, status: 'skipped-size-limit' };
  }

  let previous: unknown;
  try {
    previous = JSON.parse(previousJson);
  } catch {
    throw new Error('Stored conversation payload is invalid JSON.');
  }

  const changedPaths: Array<{ path: string; change: SyncDiffKind }> = [];
  const seen = new Set<string>();
  let truncated = false;

  function add(path: string, change: SyncDiffKind) {
    const key = `${path}:${change}`;
    if (seen.has(key)) return;
    if (changedPaths.length >= MAX_SYNC_DIFF_PATHS) {
      truncated = true;
      return;
    }
    seen.add(key);
    changedPaths.push({ path: path || '$', change });
  }

  function compare(oldValue: unknown, newValue: unknown, path: string, depth: number) {
    if (truncated) return;
    const oldType = oldValue === null ? 'null' : Array.isArray(oldValue) ? 'array' : typeof oldValue;
    const newType = newValue === null ? 'null' : Array.isArray(newValue) ? 'array' : typeof newValue;
    if (oldType !== newType) {
      add(path, 'type-changed');
      return;
    }
    if (depth >= MAX_SYNC_DIFF_DEPTH) {
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) add(path, 'nested-changed');
      return;
    }
    if (Array.isArray(oldValue) && Array.isArray(newValue)) {
      if (oldValue.length !== newValue.length) add(`${path}[]`, 'array-length-changed');
      for (let index = 0; index < Math.min(oldValue.length, newValue.length) && !truncated; index++) {
        compare(oldValue[index], newValue[index], `${path}[]`, depth + 1);
      }
      return;
    }
    if (oldType === 'object' && newType === 'object' && oldValue && newValue) {
      const oldRecord = oldValue as Record<string, unknown>;
      const newRecord = newValue as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(oldRecord), ...Object.keys(newRecord)])].sort();
      for (const key of keys) {
        const segment = path === 'mapping' || !SAFE_SYNC_DIFF_FIELDS.has(key) ? '*' : key;
        const childPath = path ? `${path}.${segment}` : segment;
        const inOld = Object.hasOwn(oldRecord, key);
        const inNew = Object.hasOwn(newRecord, key);
        if (!inOld) add(childPath, 'added');
        else if (!inNew) add(childPath, 'removed');
        else compare(oldRecord[key], newRecord[key], childPath, depth + 1);
        if (truncated) return;
      }
      return;
    }
    if (!Object.is(oldValue, newValue)) add(path, 'value-changed');
  }

  compare(previous, next, '', 0);
  return {
    schemaVersion: 1,
    changedPaths,
    truncated,
    noSemanticChanges: changedPaths.length === 0,
  };
}

function isSafeUrlsOnlyDiff(report: SyncDiffReport) {
  return 'changedPaths' in report && !report.truncated && report.changedPaths.length > 0 &&
    report.changedPaths.every(({ path }) => path === 'safe_urls' || path.startsWith('safe_urls[]'));
}

export function openDatabase(directory: string): HostDatabase {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'sync.db');
  const db = new DatabaseSync(path);
  const ownerId = randomUUID();
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version;
    if (typeof version === 'number' && version > SCHEMA_VERSION) throw new Error('Database schema is newer than this host');
    if (!version) {
      db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const insert = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
      insert.run('created_at', new Date().toISOString());
      insert.run('host_version', HOST_VERSION);
      insert.run('install_id', randomUUID());
      db.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run(new Date().toISOString());
    }
    if (typeof version !== 'number' || version < 2) {
      db.exec(`
        CREATE TABLE accounts(
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          email TEXT,
          label TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE conversations(
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id),
          title TEXT,
          create_time REAL,
          update_time REAL,
          current_node TEXT,
          project_id TEXT,
          gizmo_id TEXT,
          is_archived INTEGER NOT NULL DEFAULT 0,
          raw_json TEXT NOT NULL,
          raw_sha256 TEXT NOT NULL,
          remote_state TEXT NOT NULL DEFAULT 'present'
            CHECK(remote_state IN ('present', 'missing', 'archived')),
          first_synced_at TEXT NOT NULL,
          last_synced_at TEXT NOT NULL,
          last_seen_remote_at TEXT
        );
        CREATE INDEX conversations_account_idx ON conversations(account_id);
        CREATE TABLE messages(
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          parent_id TEXT,
          role TEXT NOT NULL,
          model TEXT,
          content_type TEXT,
          text TEXT NOT NULL,
          create_time REAL,
          is_on_active_branch INTEGER NOT NULL CHECK(is_on_active_branch IN (0, 1))
        );
        CREATE INDEX messages_conversation_idx ON messages(conversation_id);
        CREATE TABLE sync_runs(
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id),
          owner_id TEXT NOT NULL,
          mode TEXT NOT NULL CHECK(mode IN ('single', 'incremental', 'full')),
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
          listed INTEGER NOT NULL DEFAULT 0,
          new INTEGER NOT NULL DEFAULT 0,
          updated INTEGER NOT NULL DEFAULT 0,
          unchanged INTEGER NOT NULL DEFAULT 0,
          failed INTEGER NOT NULL DEFAULT 0,
          cancelled INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX sync_runs_account_started_idx ON sync_runs(account_id, started_at);
        CREATE UNIQUE INDEX sync_runs_one_active_per_account
          ON sync_runs(account_id) WHERE status = 'running';
        CREATE TABLE sync_failures(
          id INTEGER PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
          conversation_id TEXT,
          error TEXT NOT NULL,
          retryable INTEGER NOT NULL CHECK(retryable IN (0, 1))
        );
        INSERT INTO schema_migrations(version, applied_at) VALUES (2, '${new Date().toISOString()}');
      `);
    }
    if (typeof version !== 'number' || version < 3) {
      db.exec(`
        ALTER TABLE conversations ADD COLUMN list_update_token TEXT;
        INSERT INTO schema_migrations(version, applied_at) VALUES (3, '${new Date().toISOString()}');
      `);
    }
    if (typeof version !== 'number' || version < 4) {
      db.exec(`
        CREATE TABLE projects(
          account_id TEXT NOT NULL REFERENCES accounts(id),
          id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          gizmo_type TEXT NOT NULL,
          remote_created_at TEXT,
          remote_updated_at TEXT,
          remote_last_interacted_at TEXT,
          is_archived INTEGER CHECK(is_archived IN (0, 1)),
          raw_json TEXT NOT NULL,
          raw_sha256 TEXT NOT NULL,
          first_synced_at TEXT NOT NULL,
          last_synced_at TEXT NOT NULL,
          last_seen_run_id TEXT NOT NULL REFERENCES sync_runs(id),
          PRIMARY KEY(account_id, id)
        );
        CREATE TABLE project_catalog_state(
          account_id TEXT PRIMARY KEY REFERENCES accounts(id),
          last_attempt_run_id TEXT NOT NULL REFERENCES sync_runs(id),
          last_attempt_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
          error_category TEXT,
          last_successful_run_id TEXT REFERENCES sync_runs(id),
          last_successful_at TEXT,
          observed_count INTEGER
        );
        INSERT INTO schema_migrations(version, applied_at) VALUES (4, '${new Date().toISOString()}');
      `);
    }
    db.prepare("UPDATE meta SET value = ? WHERE key = 'host_version'").run(HOST_VERSION);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    db.close();
    throw error;
  }
  return {
    status(): HostStatus {
      const installId = db.prepare("SELECT value FROM meta WHERE key = 'install_id'").get()?.value;
      if (typeof installId !== 'string') throw new Error('Database install_id is missing');
      const counts = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM conversations) AS conversations,
          (SELECT COUNT(*) FROM messages) AS messages
      `).get();
      if (!counts) throw new Error('Database counts are unavailable');
      return {
        hostVersion: HOST_VERSION, protocolRange: [1, 1],
        capabilities: [
          'ping', 'echo', 'status', 'single-chat-sync', 'all-chat-sync', 'message-change-counts', 'project-catalog',
          'local-viewer',
        ], dbPath: path,
        schemaVersion: SCHEMA_VERSION, installId,
        counts: { conversations: Number(counts.conversations), messages: Number(counts.messages) },
      };
    },
    beginRun(runId: string, mode: 'single' | 'incremental', account: AccountScope, projectCatalog = false) {
      if (projectCatalog && mode !== 'incremental') {
        throw new HostOperationError('INVALID_PAYLOAD', 'Project metadata requires an incremental run.');
      }
      const accountId = accountIdFor(account);
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`
          INSERT INTO accounts(id, user_id, workspace_id, email, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET email = excluded.email
        `).run(accountId, account.userId, account.workspaceId, account.email ?? null, now);
        const active = db.prepare("SELECT id FROM sync_runs WHERE account_id = ? AND status = 'running'").get(accountId);
        if (active) {
          db.exec('ROLLBACK');
          throw new HostOperationError('BUSY', 'A sync is already active for this account.');
        }
        db.prepare(`
          INSERT INTO sync_runs(id, account_id, owner_id, mode, started_at, status, listed)
          VALUES (?, ?, ?, ?, ?, 'running', ?)
        `).run(runId, accountId, ownerId, mode, now, mode === 'single' ? 1 : 0);
        if (projectCatalog) {
          db.prepare(`INSERT INTO project_catalog_state(account_id, last_attempt_run_id, last_attempt_at, status)
            VALUES (?, ?, ?, 'running') ON CONFLICT(account_id) DO UPDATE SET
            last_attempt_run_id = excluded.last_attempt_run_id, last_attempt_at = excluded.last_attempt_at,
            status = 'running', error_category = NULL`).run(accountId, runId, now);
        }
        db.exec('COMMIT');
        return { runId, accountId };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        if (error instanceof HostOperationError) throw error;
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
          throw new HostOperationError('BUSY', 'A sync is already active for this account.');
        }
        throw error;
      }
    },
    commitProjectCatalog(runId: string, items: ProjectItem[]) {
      const run = db.prepare(`SELECT r.account_id, a.workspace_id FROM sync_runs r
        JOIN accounts a ON a.id = r.account_id JOIN project_catalog_state s ON s.account_id = r.account_id
        WHERE r.id = ? AND r.owner_id = ? AND r.status = 'running' AND r.mode = 'incremental'
          AND s.last_attempt_run_id = r.id AND s.status = 'running'`).get(runId, ownerId);
      if (!run || typeof run.account_id !== 'string') {
        throw new HostOperationError('INVALID_PAYLOAD', 'Project catalog run is not active or owned by this host.');
      }
      checkProjectCatalogSize(runId, items);
      const ids = new Set<string>();
      const records = items.map(item => {
        const metadata = projectMetadata(item.raw);
        const json = projectItemJson(item.raw);
        if (ids.has(metadata.id) || createHash('sha256').update(json).digest('hex') !== item.sha256) {
          throw new HostOperationError('INVALID_PAYLOAD', 'Project ID is duplicated or SHA-256 does not match.');
        }
        if (metadata.workspaceId !== null && metadata.workspaceId !== run.workspace_id) {
          throw new HostOperationError('ACCOUNT_MISMATCH', 'Project belongs to a different workspace.');
        }
        ids.add(metadata.id);
        return { metadata, json, hash: item.sha256 };
      });
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const insert = db.prepare(`INSERT INTO projects(account_id, id, name, description, gizmo_type,
          remote_created_at, remote_updated_at, remote_last_interacted_at, is_archived,
          raw_json, raw_sha256, first_synced_at, last_synced_at, last_seen_run_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, id) DO UPDATE SET name = excluded.name, description = excluded.description,
          gizmo_type = excluded.gizmo_type, remote_created_at = excluded.remote_created_at,
          remote_updated_at = excluded.remote_updated_at, remote_last_interacted_at = excluded.remote_last_interacted_at,
          is_archived = excluded.is_archived, raw_json = excluded.raw_json, raw_sha256 = excluded.raw_sha256,
          last_synced_at = excluded.last_synced_at, last_seen_run_id = excluded.last_seen_run_id`);
        for (const { metadata: m, json, hash } of records) {
          insert.run(run.account_id, m.id, m.name, m.description, m.gizmoType, m.createdAt, m.updatedAt,
            m.lastInteractedAt, m.archived === null ? null : Number(m.archived), json, hash, now, now, runId);
        }
        db.prepare(`UPDATE project_catalog_state SET status = 'completed', error_category = NULL,
          last_successful_run_id = ?, last_successful_at = ?, observed_count = ?
          WHERE account_id = ?`).run(runId, now, records.length, run.account_id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { count: records.length };
    },
    diffManifest(
      runId: string,
      items: Array<{ conversationId: string; updateTimeToken: string | null }>,
    ) {
      if (items.length > 50) {
        throw new HostOperationError('INVALID_PAYLOAD', 'Manifest pages are limited to 50 conversations.');
      }
      const ids = new Set<string>();
      for (const item of items) {
        const token = item.updateTimeToken;
        const validToken = token === null ||
          token.length <= 514 && (token.startsWith('s:') && token.length > 2 ||
            token.startsWith('n:') && token.length > 2 && Number.isFinite(Number(token.slice(2))));
        if (!/^[a-zA-Z0-9-]{1,128}$/.test(item.conversationId) || ids.has(item.conversationId) || !validToken) {
          throw new HostOperationError('INVALID_PAYLOAD', 'Manifest item is invalid or duplicated.');
        }
        ids.add(item.conversationId);
      }
      const run = db.prepare("SELECT account_id, mode FROM sync_runs WHERE id = ? AND status = 'running'").get(runId);
      if (!run || typeof run.account_id !== 'string' || run.mode !== 'incremental') {
        throw new HostOperationError('INVALID_PAYLOAD', 'Incremental sync run is not active.');
      }

      const changed: Array<{ conversationId: string; updateTimeToken: string | null }> = [];
      let unchanged = 0;
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const findConversation = db.prepare(
          'SELECT account_id, list_update_token FROM conversations WHERE id = ?',
        );
        const markSeen = db.prepare('UPDATE conversations SET last_seen_remote_at = ? WHERE id = ?');
        for (const item of items) {
          const existing = findConversation.get(item.conversationId);
          if (existing && existing.account_id !== run.account_id) {
            throw new HostOperationError('ACCOUNT_MISMATCH', 'Conversation is already stored under a different account.');
          }
          if (existing && item.updateTimeToken !== null &&
            existing.list_update_token === item.updateTimeToken) {
            markSeen.run(now, item.conversationId);
            unchanged++;
          } else {
            changed.push(item);
          }
        }
        db.prepare('UPDATE sync_runs SET listed = listed + ?, unchanged = unchanged + ? WHERE id = ?')
          .run(items.length, unchanged, runId);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return { listed: items.length, unchanged, changed };
    },
    upsertConversation(
      runId: string,
      conversationId: string,
      raw: Record<string, unknown>,
      sha256: string,
      manifestUpdateToken?: string | null,
    ): {
      conversationId: string; status: UpsertStatus; messageCount: number;
      newMessageCount: number; changeKind?: 'metadata-only';
    } {
      const rawJson = JSON.stringify(raw);
      const rawBytes = Buffer.byteLength(rawJson, 'utf8');
      if (rawBytes > MAX_CONVERSATION_BYTES) {
        throw new HostOperationError('TOO_LARGE', 'Conversation exceeds the 60 MiB storage limit.');
      }
      const actualHash = createHash('sha256').update(rawJson, 'utf8').digest('hex');
      if (!/^[a-f0-9]{64}$/.test(sha256) || actualHash !== sha256) {
        throw new HostOperationError('INVALID_PAYLOAD', 'Conversation SHA-256 did not match its payload.');
      }
      if (raw.conversation_id !== conversationId || !isConversationMapping(raw.mapping) ||
        (raw.current_node !== undefined && raw.current_node !== null && typeof raw.current_node !== 'string')) {
        throw new HostOperationError('INVALID_PAYLOAD', 'Conversation ID or mapping is invalid.');
      }
      const run = db.prepare("SELECT account_id FROM sync_runs WHERE id = ? AND status = 'running'").get(runId);
      if (!run || typeof run.account_id !== 'string') {
        throw new HostOperationError('INVALID_PAYLOAD', 'Sync run is not active.');
      }
      const accountId = run.account_id;
      const existing = db.prepare('SELECT account_id, raw_sha256, raw_json, first_synced_at FROM conversations WHERE id = ?').get(conversationId);
      if (existing && existing.account_id !== accountId) {
        throw new HostOperationError('ACCOUNT_MISMATCH', 'Conversation is already stored under a different account.');
      }

      if (existing?.raw_sha256 === sha256) {
        const now = new Date().toISOString();
        db.exec('BEGIN IMMEDIATE');
        let count: unknown;
        try {
          db.prepare(`UPDATE conversations
            SET last_synced_at = ?, last_seen_remote_at = ?,
              list_update_token = COALESCE(?, list_update_token)
            WHERE id = ?`).run(now, now, manifestUpdateToken ?? null, conversationId);
          db.prepare('UPDATE sync_runs SET unchanged = unchanged + 1 WHERE id = ?').run(runId);
          count = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?')
            .get(conversationId)?.count;
          if (typeof count !== 'number') throw new Error('Conversation message count is unavailable');
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        return {
          conversationId, status: 'noop',
          messageCount: count, newMessageCount: 0,
        };
      }

      let metadataOnly = false;
      if (existing) {
        const diff = syncDiffReport(existing.raw_json, raw, rawBytes);
        metadataOnly = isSafeUrlsOnlyDiff(diff);
        console.info('SYNC_DIFF', JSON.stringify({
          ...diff,
          classification: metadataOnly ? 'metadata-only' : 'full-update',
        }));
      }
      if (metadataOnly) {
        const now = new Date().toISOString();
        const count = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?')
          .get(conversationId)?.count;
        if (typeof count !== 'number') throw new Error('Conversation message count is unavailable');
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(`
            UPDATE conversations
            SET raw_json = ?, raw_sha256 = ?, last_synced_at = ?, last_seen_remote_at = ?,
              list_update_token = COALESCE(?, list_update_token)
            WHERE id = ?
          `).run(rawJson, sha256, now, now, manifestUpdateToken ?? null, conversationId);
          db.prepare('UPDATE sync_runs SET updated = updated + 1 WHERE id = ?').run(runId);
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        return {
          conversationId, status: 'updated', changeKind: 'metadata-only',
          messageCount: count, newMessageCount: 0,
        };
      }

      const parsed = parseConversationNodes(raw as ChatGptRawConversation);
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const status: UpsertStatus = existing ? 'updated' : 'inserted';
        const existingMessageIds = new Set(
          db.prepare('SELECT id FROM messages WHERE conversation_id = ?').all(conversationId)
            .map(message => message.id),
        );
        const newMessageCount = parsed.reduce(
          (count, message) => count + (existingMessageIds.has(message.id) ? 0 : 1), 0,
        );
        db.prepare(`
          INSERT INTO conversations(
            id, account_id, title, create_time, update_time, current_node,
            project_id, gizmo_id, raw_json, raw_sha256, remote_state,
            first_synced_at, last_synced_at, last_seen_remote_at, list_update_token
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'present', ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title, create_time = excluded.create_time,
            update_time = excluded.update_time, current_node = excluded.current_node,
            project_id = excluded.project_id, gizmo_id = excluded.gizmo_id,
            raw_json = excluded.raw_json, raw_sha256 = excluded.raw_sha256,
            remote_state = 'present', last_synced_at = excluded.last_synced_at,
            last_seen_remote_at = excluded.last_seen_remote_at,
            list_update_token = COALESCE(excluded.list_update_token, conversations.list_update_token)
        `).run(
          conversationId, accountId,
          typeof raw.title === 'string' ? raw.title : null,
          typeof raw.create_time === 'number' ? raw.create_time : null,
          typeof raw.update_time === 'number' ? raw.update_time : null,
          typeof raw.current_node === 'string' ? raw.current_node : null,
          typeof raw.project_id === 'string' ? raw.project_id : null,
          typeof raw.gizmo_id === 'string' ? raw.gizmo_id : null,
          rawJson, sha256, existing?.first_synced_at ?? now, now, now, manifestUpdateToken ?? null,
        );
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
        const insertMessage = db.prepare(`
          INSERT INTO messages(
            id, conversation_id, parent_id, role, model, content_type, text, create_time, is_on_active_branch
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const message of parsed) {
          insertMessage.run(
            message.id, conversationId, message.parentId, message.role, message.model,
            message.contentType, message.text, message.createTime, message.isOnActiveBranch ? 1 : 0,
          );
        }
        db.prepare(`UPDATE sync_runs SET ${status === 'inserted' ? 'new' : 'updated'} = ${status === 'inserted' ? 'new' : 'updated'} + 1 WHERE id = ?`).run(runId);
        db.exec('COMMIT');
        return { conversationId, status, messageCount: parsed.length, newMessageCount };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },
    endRun(
      runId: string,
      cancelled: boolean,
      failures: Array<{ conversationId: string | null; error: string; retryable: boolean }>,
      projects?: ProjectSyncOutcome,
    ) {
      const run = db.prepare("SELECT account_id, listed, new, updated, unchanged FROM sync_runs WHERE id = ? AND owner_id = ? AND status = 'running'").get(runId, ownerId);
      if (!run) throw new HostOperationError('INVALID_PAYLOAD', 'Sync run is not active.');
      const catalog = db.prepare('SELECT * FROM project_catalog_state WHERE last_attempt_run_id = ?').get(runId);
      if (catalog && !projects || !catalog && projects ||
        projects?.status === 'cancelled' && !cancelled ||
        catalog && projects?.status === 'completed' &&
          (catalog.status !== 'completed' || catalog.observed_count !== projects.count) ||
        catalog && projects && projects.status !== 'completed' && catalog.status === 'completed') {
        throw new HostOperationError('INVALID_PAYLOAD', 'Project outcome does not match the committed catalog.');
      }
      const now = new Date().toISOString();
      const status = cancelled ? 'cancelled' : failures.length || projects?.status === 'failed' ? 'failed' : 'completed';
      db.exec('BEGIN IMMEDIATE');
      try {
        const insertFailure = db.prepare(`
          INSERT INTO sync_failures(run_id, conversation_id, error, retryable) VALUES (?, ?, ?, ?)
        `);
        for (const failure of failures) {
          insertFailure.run(runId, failure.conversationId, failure.error.slice(0, 1000), failure.retryable ? 1 : 0);
        }
        if (projects && projects.status !== 'completed') {
          db.prepare(`UPDATE project_catalog_state SET status = ?, error_category = ?
            WHERE last_attempt_run_id = ? AND status = 'running'`)
            .run(projects.status, projects.category, runId);
          if (projects.status === 'failed') {
            insertFailure.run(runId, null, `Project metadata sync failed: ${projects.category}.`, 1);
          }
        }
        db.prepare(`
          UPDATE sync_runs SET ended_at = ?, status = ?, failed = ?, cancelled = ?
          WHERE id = ? AND status = 'running'
        `).run(now, status, failures.length, cancelled ? 1 : 0, runId);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      if (failures.length > 0) {
        const categories: Record<string, number> = {};
        for (const failure of failures) {
          const category = syncFailureCategory(failure.error);
          categories[category] = (categories[category] ?? 0) + 1;
        }
        if (projects?.status === 'failed') {
          console.info('PROJECT_SYNC_FAILURE', JSON.stringify({ category: projects.category }));
        }
        console.info('SYNC_RUN_FAILURE', JSON.stringify({
          status,
          failureCount: failures.length,
          retryableCount: failures.filter(failure => failure.retryable).length,
          categories,
        }));
      }
      return {
        runId,
        status,
        counts: {
          listed: Number(run.listed),
          new: Number(run.new), updated: Number(run.updated),
          unchanged: Number(run.unchanged), failed: failures.length,
        },
      };
    },
    close() {
      try {
        const activeRuns = db.prepare("SELECT id FROM sync_runs WHERE owner_id = ? AND status = 'running'").all(ownerId);
        if (activeRuns.length) {
          const now = new Date().toISOString();
          db.exec('BEGIN IMMEDIATE');
          try {
            const failRun = db.prepare(`
              UPDATE sync_runs SET ended_at = ?, status = 'failed', failed = failed + 1
              WHERE id = ? AND status = 'running'
            `);
            const addFailure = db.prepare(`
              INSERT INTO sync_failures(run_id, conversation_id, error, retryable)
              VALUES (?, NULL, 'Native host disconnected before the run completed.', 1)
            `);
            for (const run of activeRuns) {
              if (typeof run.id !== 'string') continue;
              failRun.run(now, run.id);
              addFailure.run(run.id);
              db.prepare(`UPDATE project_catalog_state SET status = 'failed', error_category = 'local-host'
                WHERE last_attempt_run_id = ? AND status = 'running'`).run(run.id);
            }
            db.exec('COMMIT');
          } catch (error) {
            try { db.exec('ROLLBACK'); } catch {}
            throw error;
          }
        }
      } finally {
        db.close();
      }
    },
  };
}
