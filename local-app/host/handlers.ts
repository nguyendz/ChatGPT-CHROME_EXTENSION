import { createHash } from 'node:crypto';
import { HOST_VERSION, PROTOCOL_VERSION, isApiDebugChunk, isApiProbeReport, isAssetRunSummary, isProjectSyncOutcome, isRecord } from '../../lib/sync/protocol.ts';
import { ProjectCatalogError } from '../../lib/project-catalog.ts';
import { HostOperationError, type HostDatabase } from './db.ts';
import type { AccountScope, ApiDebugChunk, ErrorCode, HostResponse, ResponsePayloads } from '../../lib/sync/protocol.ts';

export function errorResponse(id: string, code: ErrorCode, message: string): HostResponse {
  return { v: 1, id, type: 'error', payload: { code, message, retryable: false } };
}

function success<K extends keyof ResponsePayloads>(id: string, type: K, payload: ResponsePayloads[K]): HostResponse {
  return { v: 1, id, type: `${type}.ok`, payload } as HostResponse;
}

function isAccountScope(value: unknown): value is AccountScope {
  return isRecord(value) && typeof value.userId === 'string' && value.userId.trim().length > 0 &&
    value.userId === value.userId.trim() && value.userId.length <= 512 &&
    typeof value.workspaceId === 'string' && value.workspaceId.trim().length > 0 &&
    value.workspaceId === value.workspaceId.trim() && value.workspaceId.length <= 512 &&
    (value.email === undefined || typeof value.email === 'string' && value.email.length <= 320);
}

function isRunId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);
}

function hasKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function isManifestItem(value: unknown): value is { conversationId: string; updateTimeToken: string | null } {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'conversationId') || !Object.hasOwn(value, 'updateTimeToken') ||
    typeof value.conversationId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(value.conversationId)) return false;
  const token = value.updateTimeToken;
  return token === null || typeof token === 'string' && token.length <= 514 &&
    (token.startsWith('s:') && token.length > 2 ||
      token.startsWith('n:') && token.length > 2 && Number.isFinite(Number(token.slice(2))));
}

function operationError(id: string, error: unknown): HostResponse {
  if (error instanceof HostOperationError) return errorResponse(id, error.code, error.message);
  if (error instanceof ProjectCatalogError) {
    return errorResponse(id, error.category === 'size-limit' ? 'TOO_LARGE' : 'INVALID_PAYLOAD', error.message);
  }
  console.error('Database request failed:', error);
  return errorResponse(id, 'DB_ERROR', 'Cannot complete the local sync operation. See host.log.');
}

export function handleRequest(
  value: unknown, database: () => HostDatabase, writeApiDebug: (chunk: ApiDebugChunk) => void,
): HostResponse {
  const id = isRecord(value) && typeof value.id === 'string' ? value.id.slice(0, 128) : '';
  if (!isRecord(value) || !id || value.id !== id || typeof value.type !== 'string' || !isRecord(value.payload)) {
    return errorResponse(id, 'INVALID_PAYLOAD', 'Expected an envelope with id, type and object payload');
  }
  if (value.v !== PROTOCOL_VERSION) return errorResponse(id, 'PROTOCOL_MISMATCH', 'This host requires protocol 1');
  const { type, payload } = value;
  if (type === 'ping') return {
    v: 1, id, type: 'ping.ok',
    payload: { hostVersion: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) },
  };
  if (type === 'echo') {
    if (typeof payload.data !== 'string') return errorResponse(id, 'INVALID_PAYLOAD', 'echo.data must be a string');
    return { v: 1, id, type: 'echo.ok', payload: {
      bytes: Buffer.byteLength(payload.data), sha256: createHash('sha256').update(payload.data).digest('hex'),
    } };
  }
  if (type === 'hello' || type === 'getStatus') {
    if (type === 'hello' && payload.protocolVersion !== PROTOCOL_VERSION) {
      return errorResponse(id, 'PROTOCOL_MISMATCH', 'This host requires protocol 1');
    }
    if (type === 'hello' && typeof payload.extVersion !== 'string') {
      return errorResponse(id, 'INVALID_PAYLOAD', 'hello.extVersion must be a string');
    }
    try {
      return success(id, type, database().status());
    } catch (error) {
      return operationError(id, error);
    }
  }
  if (type === 'recordApiProbe') {
    if (!isApiProbeReport(payload)) {
      return errorResponse(id, 'INVALID_PAYLOAD', 'recordApiProbe requires a bounded, sanitized API probe report.');
    }
    try {
      console.info('API_PROBE', JSON.stringify(payload));
      return success(id, type, { probeId: payload.probeId, logged: true });
    } catch {
      return errorResponse(id, 'LOG_ERROR', 'Could not write the API probe report to host.log.');
    }
  }
  if (type === 'recordApiDebug') {
    if (!isApiDebugChunk(payload)) {
      return errorResponse(id, 'INVALID_PAYLOAD', 'recordApiDebug requires a bounded debug-log chunk.');
    }
    try {
      writeApiDebug(payload);
      return success(id, type, { entryId: payload.entryId, part: payload.part, logged: true });
    } catch {
      return errorResponse(id, 'LOG_ERROR', 'Could not write api-debug.jsonl. Check disk space and directory permissions.');
    }
  }
  if (type === 'beginRun') {
    if (typeof payload.runId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(payload.runId) ||
      (payload.mode !== 'single' && payload.mode !== 'incremental') || !isAccountScope(payload.account) ||
      (payload.projectCatalog !== undefined && typeof payload.projectCatalog !== 'boolean')) {
      return errorResponse(id, 'INVALID_PAYLOAD', 'beginRun requires a run ID, supported mode, and user/workspace scope.');
    }
    try {
      return success(id, type, database().beginRun(payload.runId, payload.mode, payload.account, payload.projectCatalog));
    } catch (error) {
      return operationError(id, error);
    }
  }
  if (type === 'commitProjectCatalog') {
      if (Object.keys(payload).length !== 2 || typeof payload.runId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(payload.runId) || !Array.isArray(payload.items) ||
        !payload.items.every(item => isRecord(item) && Object.keys(item).length === 2 &&
          isRecord(item.raw) && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256))) {
        return errorResponse(id, 'INVALID_PAYLOAD', 'Expected a run ID and hashed project metadata items.');
      }
      try {
        return success(id, type, database().commitProjectCatalog(payload.runId, payload.items));
      } catch (error) {
        return operationError(id, error);
      }
    }
  if (type === 'diffManifest') {
    if (typeof payload.runId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(payload.runId) ||
      !Array.isArray(payload.items) || payload.items.length > 50 ||
      !payload.items.every(isManifestItem) ||
      new Set(payload.items.map(item => item.conversationId)).size !== payload.items.length) {
      return errorResponse(id, 'INVALID_PAYLOAD', 'diffManifest requires up to 50 unique, valid manifest items.');
    }
    try {
      return success(id, type, database().diffManifest(payload.runId, payload.items));
    } catch (error) {
      return operationError(id, error);
    }
  }
  if (type === 'upsertConversation') {
    if (typeof payload.runId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(payload.runId) ||
      typeof payload.conversationId !== 'string' || !payload.conversationId ||
      !isRecord(payload.raw) || typeof payload.sha256 !== 'string' ||
      (payload.manifestUpdateToken !== undefined &&
        payload.manifestUpdateToken !== null && typeof payload.manifestUpdateToken !== 'string') ||
      typeof payload.manifestUpdateToken === 'string' &&
        !isManifestItem({ conversationId: payload.conversationId, updateTimeToken: payload.manifestUpdateToken })) {
      return errorResponse(id, 'INVALID_PAYLOAD', 'upsertConversation requires a run ID, conversation ID, raw payload, and SHA-256.');
    }
    try {
      return success(id, type, database().upsertConversation(
        payload.runId, payload.conversationId, payload.raw, payload.sha256,
        payload.manifestUpdateToken as string | null | undefined,
      ));
    } catch (error) {
      return operationError(id, error);
    }
  }
  if (type === 'endRun') {
    if (typeof payload.runId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(payload.runId) ||
      typeof payload.cancelled !== 'boolean' || !Array.isArray(payload.failures) ||
      !payload.failures.every(failure => isRecord(failure) &&
        (failure.conversationId === null || typeof failure.conversationId === 'string') &&
        typeof failure.error === 'string' && typeof failure.retryable === 'boolean') ||
      (payload.projects !== undefined && !isProjectSyncOutcome(payload.projects)) ||
      (payload.assets !== undefined && !isAssetRunSummary(payload.assets))) {
      return errorResponse(id, 'INVALID_PAYLOAD', 'endRun requires a run ID, cancellation state, and valid failures.');
    }
    try {
      return success(id, type, database().endRun(
        payload.runId, payload.cancelled, payload.failures, payload.projects, payload.assets,
      ));
    } catch (error) {
      return operationError(id, error);
    }
  }
  if (type === 'listPendingAssets') {
    if (!hasKeys(payload, ['runId', 'conversationIds', 'includeOthers', 'limit']) || !isRunId(payload.runId) ||
      !Array.isArray(payload.conversationIds) || typeof payload.includeOthers !== 'boolean' ||
      typeof payload.limit !== 'number') {
      return errorResponse(id, 'INVALID_PAYLOAD', 'listPendingAssets requires a run ID, conversation IDs, scope flag, and limit.');
    }
    try {
      return success(id, type, { items: database().listPendingAssets(
        payload.runId, payload.conversationIds as string[], payload.includeOthers, payload.limit,
      ) });
    } catch (error) {
      return operationError(id, error);
    }
  }
  if (type === 'assetChunk') {
    if (!hasKeys(payload, ['runId', 'uploadId', 'conversationId', 'fileId', 'seq', 'data']) ||
      !isRunId(payload.runId) || typeof payload.uploadId !== 'string' || typeof payload.conversationId !== 'string' ||
      typeof payload.fileId !== 'string' || typeof payload.seq !== 'number' || typeof payload.data !== 'string') {
      return errorResponse(id, 'INVALID_PAYLOAD', 'assetChunk requires a run, upload, file, sequence number, and base64 data.');
    }
    try {
      return success(id, type, database().assetChunk(
        payload.runId, payload.uploadId, payload.conversationId, payload.fileId, payload.seq, payload.data,
      ));
    } catch (error) {
      return operationError(id, error);
    }
  }
  if (type === 'assetCommit') {
    if (!hasKeys(payload, ['runId', 'uploadId', 'conversationId', 'fileId', 'sha256', 'size', 'mime']) ||
      !isRunId(payload.runId) || typeof payload.uploadId !== 'string' || typeof payload.conversationId !== 'string' ||
      typeof payload.fileId !== 'string' || typeof payload.sha256 !== 'string' || typeof payload.size !== 'number' ||
      typeof payload.mime !== 'string') {
      return errorResponse(id, 'INVALID_PAYLOAD', 'assetCommit requires a run, upload, file, hash, size, and MIME type.');
    }
    try {
      return success(id, type, database().assetCommit(
        payload.runId, payload.uploadId, payload.conversationId, payload.fileId, payload.sha256, payload.size, payload.mime,
      ));
    } catch (error) {
      return operationError(id, error);
    }
  }
  if (type === 'assetOutcome') {
    const keys = ['runId', 'conversationId', 'fileId', 'state'].concat(payload.error === undefined ? [] : ['error']);
    if (!hasKeys(payload, keys) || !isRunId(payload.runId) || typeof payload.conversationId !== 'string' ||
      typeof payload.fileId !== 'string' ||
      (payload.state !== 'too-large' && payload.state !== 'unavailable' && payload.state !== 'failed') ||
      (payload.error !== undefined && (typeof payload.error !== 'string' || payload.error.length > 500))) {
      return errorResponse(id, 'INVALID_PAYLOAD', 'assetOutcome requires a run, file, and terminal state.');
    }
    try {
      return success(id, type, database().assetOutcome(
        payload.runId, payload.conversationId, payload.fileId, payload.state, payload.error as string | undefined,
      ));
    } catch (error) {
      return operationError(id, error);
    }
  }
  return errorResponse(id, 'UNKNOWN_TYPE', `Unknown request type: ${type.slice(0, 80)}`);
}
