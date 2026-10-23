export const HOST_NAME = 'com.chatgpt_backup.sync';
export const HOST_VERSION = '0.6.0';
export const PROTOCOL_VERSION = 1;
export const MAX_HOST_TO_EXT_BYTES = 1_000_000;
export const MAX_EXT_TO_HOST_BYTES = 64 * 1024 * 1024;
export const ECHO_BYTES = 10 * 1024 * 1024;
export const MAX_API_PROBE_REPORT_BYTES = 16 * 1024;
export const API_DEBUG_CHUNK_CHARS = 16 * 1024;

export type ApiDebugChunk = {
  runId: string; entryId: string; part: number; parts: number; data: string;
};

export type ProjectFailureCategory = 'unauthorized' | 'forbidden' | 'rate-limited' |
  'server-error' | 'invalid-response' | 'pagination-unverified' | 'unstable-pagination' |
  'size-limit' | 'account-mismatch' | 'local-host' | 'network-error' | 'cancelled';
export type ProjectSyncOutcome =
  | { status: 'completed'; count: number }
  | { status: 'failed' | 'cancelled'; category: ProjectFailureCategory };

export function isProjectSyncOutcome(value: unknown): value is ProjectSyncOutcome {
  return isRecord(value) && (
    value.status === 'completed' && typeof value.count === 'number' &&
      Number.isSafeInteger(value.count) && value.count >= 0 ||
    (value.status === 'failed' || value.status === 'cancelled') && typeof value.category === 'string' &&
      ['unauthorized', 'forbidden', 'rate-limited', 'server-error', 'invalid-response',
        'pagination-unverified', 'unstable-pagination', 'size-limit', 'account-mismatch',
        'local-host', 'network-error', 'cancelled'].includes(value.category));
}

export type ErrorCode = 'PROTOCOL_MISMATCH' | 'BUSY' | 'INVALID_PAYLOAD' |
  'UNKNOWN_TYPE' | 'TOO_LARGE' | 'DB_ERROR' | 'DISK_FULL' |
  'ACCOUNT_MISMATCH' | 'FORBIDDEN_ORIGIN' | 'LOG_ERROR' | 'VIEWER_ERROR';

export type ApiProbeRouteKind = 'conversation' | 'project-conversation' | 'other';
export type ApiProbeOrder = 'descending' | 'not-descending' | 'inconclusive';
export type ApiProbeArchiveRelation = 'same' | 'subset' | 'overlap' | 'disjoint' | 'inconclusive';
export type ApiProbeMembership = 'found' | 'not-found' | 'not-tested';
export type ApiProbeJsonType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';
export type ApiProbeErrorCategory = 'none' | 'unauthorized' | 'rate-limited' | 'server-error' |
  'request-error' | 'invalid-json' | 'invalid-shape' | 'skipped';
export type ApiProbeStatus = 'ok' | 'partial' | 'http-error' | 'network-error' |
  'invalid-response' | 'skipped';
export type ApiProbeField = { path: string; type: ApiProbeJsonType };
export type ApiProbeResponseSummary = {
  status: ApiProbeStatus;
  errorCategory: ApiProbeErrorCategory;
  httpStatuses: number[];
  fields: ApiProbeField[];
};
export type ApiProbeReport = {
  schemaVersion: 1;
  probeId: string;
  routeKind: ApiProbeRouteKind;
  session: ApiProbeResponseSummary;
  defaultList: ApiProbeResponseSummary;
  orderedList: ApiProbeResponseSummary;
  archivedList: ApiProbeResponseSummary;
  defaultOrder: ApiProbeOrder;
  orderedOrder: ApiProbeOrder;
  orderSequenceChanged: 'same' | 'changed' | 'inconclusive';
  archiveRelation: ApiProbeArchiveRelation;
  projectListMembership: ApiProbeMembership;
};

export type RequestPayloads = {
  ping: Record<string, never>;
  echo: { data: string };
  hello: { protocolVersion: number; extVersion: string };
  getStatus: Record<string, never>;
  launchViewer: Record<string, never>;
  recordApiProbe: ApiProbeReport;
  recordApiDebug: ApiDebugChunk;
  beginRun: { runId: string; mode: 'single' | 'incremental'; account: AccountScope; projectCatalog?: boolean };
  commitProjectCatalog: { runId: string; items: Array<{ raw: Record<string, unknown>; sha256: string }> };
  diffManifest: {
    runId: string;
    items: Array<{ conversationId: string; updateTimeToken: string | null }>;
  };
  upsertConversation: {
    runId: string;
    conversationId: string;
    raw: Record<string, unknown>;
    sha256: string;
    manifestUpdateToken?: string | null;
  };
  endRun: {
    runId: string;
    cancelled: boolean;
    failures: Array<{ conversationId: string | null; error: string; retryable: boolean }>;
    projects?: ProjectSyncOutcome;
  };
};
export type AccountScope = { userId: string; workspaceId: string; email?: string };
export type UpsertStatus = 'inserted' | 'updated' | 'noop';
export type HostStatus = {
  hostVersion: string;
  protocolRange: [number, number];
  capabilities: string[];
  dbPath: string;
  schemaVersion: number;
  installId: string;
  counts: { conversations: number; messages: number };
};
export type ResponsePayloads = {
  ping: { hostVersion: string; protocolVersion: number; pid: number; uptimeMs: number };
  echo: { bytes: number; sha256: string };
  hello: HostStatus;
  getStatus: HostStatus;
  launchViewer: { url: string };
  recordApiProbe: { probeId: string; logged: true };
  recordApiDebug: { entryId: string; part: number; logged: true };
  beginRun: { runId: string; accountId: string };
  commitProjectCatalog: { count: number };
  diffManifest: {
    listed: number;
    unchanged: number;
    changed: Array<{ conversationId: string; updateTimeToken: string | null }>;
  };
  upsertConversation: {
    conversationId: string; status: UpsertStatus; messageCount: number;
    newMessageCount?: number; changeKind?: 'metadata-only';
  };
  endRun: {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    counts: { listed?: number; new: number; updated: number; unchanged: number; failed: number };
  };
};
export type HostRequest = {
  [K in keyof RequestPayloads]: { v: 1; id: string; type: K; payload: RequestPayloads[K] }
}[keyof RequestPayloads];
export type HostResponse = {
  [K in keyof ResponsePayloads]: { v: 1; id: string; type: `${K}.ok`; payload: ResponsePayloads[K] }
}[keyof ResponsePayloads] | {
  v: 1; id: string; type: 'error';
  payload: { code: ErrorCode; message: string; retryable: boolean };
};
export type ConnectionState = 'connected' | 'not-registered' | 'forbidden' |
  'host-exited' | 'protocol-mismatch' | 'unknown';
export type ConnectionStatus = {
  state: ConnectionState;
  error?: string;
  host?: HostStatus;
  rttMs?: number;
};
export type EchoResult = { bytes: number; sha256: string; matches: boolean };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isViewerLaunchUrl(value: string): boolean {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/#token=[a-f0-9]{64}$/.test(value)) return false;
  try {
    const url = new URL(value);
    return Number(url.port) > 0 && url.pathname === '/' && url.search === '';
  } catch {
    return false;
  }
}

export function isHostStatus(value: unknown): value is HostStatus {
  return isRecord(value) && typeof value.hostVersion === 'string' &&
    Array.isArray(value.protocolRange) && value.protocolRange.length === 2 &&
    value.protocolRange.every(item => typeof item === 'number') &&
    Array.isArray(value.capabilities) && value.capabilities.every(item => typeof item === 'string') &&
    typeof value.dbPath === 'string' && typeof value.schemaVersion === 'number' &&
    typeof value.installId === 'string' && isRecord(value.counts) &&
    typeof value.counts.conversations === 'number' && typeof value.counts.messages === 'number';
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

export function isApiDebugChunk(value: unknown): value is ApiDebugChunk {
  return isRecord(value) && hasExactKeys(value, ['runId', 'entryId', 'part', 'parts', 'data']) &&
    typeof value.runId === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value.runId) &&
    typeof value.entryId === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value.entryId) &&
    typeof value.part === 'number' && Number.isSafeInteger(value.part) && value.part >= 0 &&
    typeof value.parts === 'number' && Number.isSafeInteger(value.parts) &&
    value.parts > value.part && typeof value.data === 'string' &&
    value.data.length > 0 && value.data.length <= API_DEBUG_CHUNK_CHARS;
}

const apiProbeJsonTypes: ApiProbeJsonType[] = ['null', 'boolean', 'number', 'string', 'array', 'object'];
const apiProbeStatuses: ApiProbeStatus[] = ['ok', 'partial', 'http-error', 'network-error', 'invalid-response', 'skipped'];
const apiProbeErrors: ApiProbeErrorCategory[] = [
  'none', 'unauthorized', 'rate-limited', 'server-error', 'request-error',
  'invalid-json', 'invalid-shape', 'skipped',
];

function isApiProbeResponseSummary(value: unknown): value is ApiProbeResponseSummary {
  return isRecord(value) && hasExactKeys(value, ['status', 'errorCategory', 'httpStatuses', 'fields']) &&
    apiProbeStatuses.includes(value.status as ApiProbeStatus) &&
    apiProbeErrors.includes(value.errorCategory as ApiProbeErrorCategory) &&
    Array.isArray(value.httpStatuses) && value.httpStatuses.length <= 2 &&
    value.httpStatuses.every(status => Number.isInteger(status) && status >= 100 && status <= 599) &&
    Array.isArray(value.fields) && value.fields.length <= 32 &&
    value.fields.every(field => isRecord(field) && hasExactKeys(field, ['path', 'type']) &&
      typeof field.path === 'string' && field.path.length <= 64 &&
      /^[A-Za-z][A-Za-z0-9_.\[\]]*$/.test(field.path) &&
      apiProbeJsonTypes.includes(field.type as ApiProbeJsonType));
}

export function isApiProbeReport(value: unknown): value is ApiProbeReport {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'probeId', 'routeKind', 'session', 'defaultList', 'orderedList',
    'archivedList', 'defaultOrder', 'orderedOrder', 'orderSequenceChanged',
    'archiveRelation', 'projectListMembership',
  ])) return false;

  if (value.schemaVersion !== 1 || typeof value.probeId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.probeId) ||
    !['conversation', 'project-conversation', 'other'].includes(value.routeKind as string) ||
    !isApiProbeResponseSummary(value.session) || !isApiProbeResponseSummary(value.defaultList) ||
    !isApiProbeResponseSummary(value.orderedList) || !isApiProbeResponseSummary(value.archivedList) ||
    !['descending', 'not-descending', 'inconclusive'].includes(value.defaultOrder as string) ||
    !['descending', 'not-descending', 'inconclusive'].includes(value.orderedOrder as string) ||
    !['same', 'changed', 'inconclusive'].includes(value.orderSequenceChanged as string) ||
    !['same', 'subset', 'overlap', 'disjoint', 'inconclusive'].includes(value.archiveRelation as string) ||
    !['found', 'not-found', 'not-tested'].includes(value.projectListMembership as string)) return false;

  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_API_PROBE_REPORT_BYTES;
  } catch {
    return false;
  }
}

export function isResponsePayload<K extends keyof ResponsePayloads>(
  type: K, value: unknown,
): value is ResponsePayloads[K] {
  if (type === 'hello' || type === 'getStatus') return isHostStatus(value);
  if (type === 'recordApiProbe') return isRecord(value) && hasExactKeys(value, ['probeId', 'logged']) &&
    typeof value.probeId === 'string' && value.logged === true;
  if (type === 'recordApiDebug') return isRecord(value) &&
    hasExactKeys(value, ['entryId', 'part', 'logged']) &&
    typeof value.entryId === 'string' && typeof value.part === 'number' &&
    Number.isSafeInteger(value.part) && value.part >= 0 && value.logged === true;
  if (!isRecord(value)) return false;
  if (type === 'launchViewer') return hasExactKeys(value, ['url']) &&
    typeof value.url === 'string' && isViewerLaunchUrl(value.url);
  if (type === 'echo') return typeof value.bytes === 'number' && typeof value.sha256 === 'string';
  if (type === 'beginRun') return typeof value.runId === 'string' && typeof value.accountId === 'string';
  if (type === 'commitProjectCatalog') return typeof value.count === 'number' &&
    Number.isSafeInteger(value.count) && value.count >= 0;
  if (type === 'diffManifest') return typeof value.listed === 'number' &&
    Number.isSafeInteger(value.listed) && value.listed >= 0 &&
    typeof value.unchanged === 'number' && Number.isSafeInteger(value.unchanged) &&
    value.unchanged >= 0 &&
    Array.isArray(value.changed) && value.changed.every(item => isRecord(item) &&
      typeof item.conversationId === 'string' &&
      (item.updateTimeToken === null || typeof item.updateTimeToken === 'string')) &&
    value.listed === value.unchanged + value.changed.length;
  if (type === 'upsertConversation') return typeof value.conversationId === 'string' &&
    (value.status === 'inserted' || value.status === 'updated' || value.status === 'noop') &&
    typeof value.messageCount === 'number' &&
    (value.newMessageCount === undefined || Number.isSafeInteger(value.newMessageCount) &&
      typeof value.newMessageCount === 'number' && value.newMessageCount >= 0) &&
    (value.changeKind === undefined || value.changeKind === 'metadata-only');
  if (type === 'endRun') return typeof value.runId === 'string' &&
    (value.status === 'completed' || value.status === 'failed' || value.status === 'cancelled') &&
    isRecord(value.counts) && (value.counts.listed === undefined ||
      Number.isSafeInteger(value.counts.listed) && typeof value.counts.listed === 'number' &&
      value.counts.listed >= 0) &&
    typeof value.counts.new === 'number' &&
    typeof value.counts.updated === 'number' && typeof value.counts.unchanged === 'number' &&
    typeof value.counts.failed === 'number';
  return typeof value.hostVersion === 'string' && typeof value.protocolVersion === 'number' &&
    typeof value.pid === 'number' && typeof value.uptimeMs === 'number';
}
