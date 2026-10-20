import type {
  ApiProbeArchiveRelation, ApiProbeErrorCategory, ApiProbeField, ApiProbeJsonType,
  ApiProbeMembership, ApiProbeOrder, ApiProbeReport, ApiProbeResponseSummary,
  ApiProbeRouteKind, ApiProbeStatus,
} from './sync/protocol.ts';
import { isRecord } from './sync/protocol.ts';
import { requestChatGpt } from './chatgpt-client.ts';

const chatGptOrigin = 'https://chatgpt.com';
const pageSize = 50;
const requestTimeoutMs = 10_000;
const maxFields = 32;
const maxVisitedNodes = 6000;
const safeKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const dynamicKeyPattern = /^(?:[0-9a-f]{32,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const expandableObjectKeys = new Set([
  'user', 'account', 'accounts', 'workspace', 'workspaces', 'organization',
  'profile', 'auth', 'session', 'metadata', 'project', 'gizmo',
]);
const expandableArrayKeys = new Set(['items', 'accounts', 'workspaces', 'projects']);
const importantKeys = new Set([
  'accessToken', 'user', 'account', 'user_id', 'workspace_id', 'workspaceId',
  'account_id', 'accountId', 'id', 'items', 'total', 'update_time',
  'is_archived', 'project_id', 'gizmo_id', 'gizmo',
]);

type ProbeRoute = {
  routeKind: ApiProbeRouteKind;
  conversationId?: string;
};

type RequestOutcome = {
  status: ApiProbeStatus;
  errorCategory: ApiProbeErrorCategory;
  httpStatus: number | null;
  value?: unknown;
  fields: ApiProbeField[];
};

type ConversationList = {
  items: Record<string, unknown>[];
  total: number;
};

function safeObjectKey(key: string): boolean {
  return safeKeyPattern.test(key) && !dynamicKeyPattern.test(key) && !/\d{6,}/.test(key);
}

function jsonType(value: unknown): ApiProbeJsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (isRecord(value)) return 'object';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  return 'string';
}

function keyPriority(key: string): number {
  return importantKeys.has(key) ? 0 : 1;
}

function pathPriority(path: string): number {
  const lastKey = path.slice(path.lastIndexOf('.') + 1).replace(/\[\]/g, '');
  return keyPriority(lastKey);
}

function collectFieldShapes(value: unknown, root: string): ApiProbeField[] {
  const fields = new Map<string, ApiProbeJsonType>();
  let visited = 0;

  function visit(current: unknown, path: string, depth: number, expand: boolean) {
    if (visited++ >= maxVisitedNodes || path.length > 64) return;
    fields.set(path, jsonType(current));
    if (!expand || depth >= 4) return;

    if (Array.isArray(current)) {
      const sampleLimit = path.endsWith('.items') ? pageSize : 5;
      current.slice(0, sampleLimit).forEach(item => visit(item, `${path}[]`, depth + 1, true));
      return;
    }
    if (!isRecord(current)) return;

    const keys = Object.keys(current).filter(safeObjectKey).sort((left, right) =>
      keyPriority(left) - keyPriority(right) || left.localeCompare(right));
    for (const key of keys) {
      visit(current[key], `${path}.${key}`, depth + 1,
        expandableObjectKeys.has(key) || expandableArrayKeys.has(key));
    }
  }

  visit(value, root, 0, true);
  return [...fields]
    .sort(([left], [right]) => pathPriority(left) - pathPriority(right) || left.localeCompare(right))
    .slice(0, maxFields)
    .map(([path, type]) => ({ path, type }));
}

function classifyHttpError(status: number): ApiProbeErrorCategory {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server-error';
  return 'request-error';
}

async function requestJson(url: string, token?: string): Promise<RequestOutcome> {
  try {
    return await requestChatGpt(async () => {
      const signal = AbortSignal.timeout(requestTimeoutMs);
      const response = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal,
    });
    if (!response.ok) {
      return {
        status: 'http-error',
        errorCategory: classifyHttpError(response.status),
        httpStatus: response.status,
        fields: [],
      };
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      return {
        status: 'invalid-response',
        errorCategory: 'invalid-json',
        httpStatus: response.status,
        fields: [],
      };
    }
    return {
      status: 'ok',
      errorCategory: 'none',
      httpStatus: response.status,
      value,
      fields: collectFieldShapes(value, url.includes('/api/auth/session') ? 'session' : 'list'),
    };
    });
  } catch {
    return {
      status: 'network-error',
      errorCategory: 'request-error',
      httpStatus: null,
      fields: [],
    };
  }
}

function asConversationList(outcome: RequestOutcome): ConversationList | undefined {
  if (outcome.status !== 'ok') return undefined;
  if (!isRecord(outcome.value) || !Array.isArray(outcome.value.items) ||
    typeof outcome.value.total !== 'number' || !Number.isFinite(outcome.value.total)) {
    outcome.status = 'invalid-response';
    outcome.errorCategory = 'invalid-shape';
    return undefined;
  }
  const items: Record<string, unknown>[] = [];
  for (const item of outcome.value.items) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id) {
      outcome.status = 'invalid-response';
      outcome.errorCategory = 'invalid-shape';
      return undefined;
    }
    items.push(item);
  }
  return { items, total: outcome.value.total };
}

function summarize(outcomes: RequestOutcome[]): ApiProbeResponseSummary {
  const successful = outcomes.filter(outcome => outcome.status === 'ok').length;
  let status: ApiProbeStatus;
  if (!outcomes.length) status = 'skipped';
  else if (successful === outcomes.length) status = 'ok';
  else if (successful) status = 'partial';
  else status = outcomes[0].status;

  const errorCategory = outcomes.find(outcome => outcome.errorCategory !== 'none')?.errorCategory ??
    (outcomes.length ? 'none' : 'skipped');
  const fields = new Map<string, ApiProbeJsonType>();
  for (const outcome of outcomes) {
    for (const field of outcome.fields) fields.set(`${field.path}\u0000${field.type}`, field.type);
  }
  const normalizedFields = [...fields.keys()]
    .map(key => {
      const separator = key.lastIndexOf('\u0000');
      return { path: key.slice(0, separator), type: fields.get(key)! };
    })
    .sort((left, right) => pathPriority(left.path) - pathPriority(right.path) ||
      left.path.localeCompare(right.path) || left.type.localeCompare(right.type))
    .slice(0, maxFields);

  return {
    status,
    errorCategory,
    httpStatuses: outcomes.flatMap(outcome => outcome.httpStatus === null ? [] : [outcome.httpStatus]).slice(0, 2),
    fields: normalizedFields,
  };
}

function stopAfter(outcome: RequestOutcome): boolean {
  return outcome.status !== 'ok';
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function orderOf(items: Record<string, unknown>[], complete: boolean): ApiProbeOrder {
  if (!complete || items.length < 2) return 'inconclusive';
  const rawTimestamps = items.map(item => item.update_time);
  const timestampType = typeof rawTimestamps[0];
  if ((timestampType !== 'number' && timestampType !== 'string') ||
    rawTimestamps.some(timestamp => typeof timestamp !== timestampType)) return 'inconclusive';
  const timestamps = rawTimestamps.map(timestampValue);
  if (timestamps.some(timestamp => timestamp === undefined)) return 'inconclusive';
  for (let index = 1; index < timestamps.length; index++) {
    if (timestamps[index - 1]! < timestamps[index]!) return 'not-descending';
  }
  return 'descending';
}

function changedSequence(
  defaultItems: Record<string, unknown>[],
  orderedItems: Record<string, unknown>[],
  complete: boolean,
): 'same' | 'changed' | 'inconclusive' {
  if (!complete || !defaultItems.length || !orderedItems.length) return 'inconclusive';
  if (defaultItems.length !== orderedItems.length) return 'changed';
  return defaultItems.every((item, index) => item.id === orderedItems[index].id) ? 'same' : 'changed';
}

function archiveRelationship(
  defaultItems: Record<string, unknown>[],
  archivedItems: Record<string, unknown>[],
): ApiProbeArchiveRelation {
  if (!defaultItems.length || !archivedItems.length) return 'inconclusive';
  const defaultIds = new Set(defaultItems.map(item => item.id as string));
  const archivedIds = new Set(archivedItems.map(item => item.id as string));
  if (defaultIds.size === archivedIds.size && [...defaultIds].every(id => archivedIds.has(id))) return 'same';
  if ([...archivedIds].every(id => defaultIds.has(id))) return 'subset';
  if ([...archivedIds].some(id => defaultIds.has(id))) return 'overlap';
  return 'disjoint';
}

function requestFailed(outcome: RequestOutcome | undefined): boolean {
  return outcome !== undefined && outcome.status !== 'ok';
}

export function classifyApiProbeRoute(rawUrl: string): ProbeRoute {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Open a signed-in ChatGPT tab before running the API probe.');
  }
  if (url.origin !== chatGptOrigin) {
    throw new Error('Open a signed-in ChatGPT tab before running the API probe.');
  }

  const projectMatch = url.pathname.match(/^\/g\/g-p-[^/]+\/c\/([A-Za-z0-9-]+)(?:\/|$)/);
  if (projectMatch) return { routeKind: 'project-conversation', conversationId: projectMatch[1] };
  const conversationMatch = url.pathname.match(/^\/c\/([A-Za-z0-9-]+)(?:\/|$)/);
  if (conversationMatch) return { routeKind: 'conversation', conversationId: conversationMatch[1] };
  return { routeKind: 'other' };
}

export async function collectChatGptApiProbe(route: ProbeRoute): Promise<ApiProbeReport> {
  const probeId = crypto.randomUUID();
  const routeKind = route.routeKind;
  const sessionOutcome = await requestJson(`${chatGptOrigin}/api/auth/session`);
  let token: string | undefined;
  if (sessionOutcome.status === 'ok') {
    if (isRecord(sessionOutcome.value) && typeof sessionOutcome.value.accessToken === 'string' &&
      sessionOutcome.value.accessToken.length > 0) {
      token = sessionOutcome.value.accessToken;
    } else {
      sessionOutcome.status = 'invalid-response';
      sessionOutcome.errorCategory = 'invalid-shape';
    }
  }

  const defaultOutcomes: RequestOutcome[] = [];
  const orderedOutcomes: RequestOutcome[] = [];
  const archivedOutcomes: RequestOutcome[] = [];
  let defaultPages: ConversationList[] = [];
  let orderedPages: ConversationList[] = [];
  let archivedPage: ConversationList | undefined;

  if (token && !stopAfter(sessionOutcome)) {
    const defaultFirstOutcome = await requestJson(
      `${chatGptOrigin}/backend-api/conversations?offset=0&limit=${pageSize}`, token,
    );
    defaultOutcomes.push(defaultFirstOutcome);
    const defaultFirst = asConversationList(defaultFirstOutcome);
    if (defaultFirst) defaultPages.push(defaultFirst);

    if (defaultFirst && defaultFirst.total > pageSize) {
      const second = await requestJson(
        `${chatGptOrigin}/backend-api/conversations?offset=${pageSize}&limit=${pageSize}`, token,
      );
      defaultOutcomes.push(second);
      const page = asConversationList(second);
      if (page) defaultPages.push(page);
    }

    if (!requestFailed(defaultOutcomes[0]) && !requestFailed(defaultOutcomes[1])) {
      const orderedFirstOutcome = await requestJson(
        `${chatGptOrigin}/backend-api/conversations?offset=0&limit=${pageSize}&order=updated`, token,
      );
      orderedOutcomes.push(orderedFirstOutcome);
      const orderedFirst = asConversationList(orderedFirstOutcome);
      if (orderedFirst) orderedPages.push(orderedFirst);

      if (orderedFirst && defaultFirst && defaultFirst.total > pageSize) {
        const second = await requestJson(
          `${chatGptOrigin}/backend-api/conversations?offset=${pageSize}&limit=${pageSize}&order=updated`, token,
        );
        orderedOutcomes.push(second);
        const page = asConversationList(second);
        if (page) orderedPages.push(page);
      }

      if (!requestFailed(orderedOutcomes[0]) && !requestFailed(orderedOutcomes[1])) {
        const archivedOutcome = await requestJson(
          `${chatGptOrigin}/backend-api/conversations?offset=0&limit=${pageSize}&is_archived=true`, token,
        );
        archivedOutcomes.push(archivedOutcome);
        archivedPage = asConversationList(archivedOutcome);
      }
    }
  }

  const defaultComplete = defaultPages.length === (defaultPages[0]?.total > pageSize ? 2 : 1) &&
    !defaultOutcomes.some(outcome => outcome.status !== 'ok');
  const orderedComplete = orderedPages.length === (defaultPages[0]?.total > pageSize ? 2 : 1) &&
    !orderedOutcomes.some(outcome => outcome.status !== 'ok');
  const defaultItems = defaultPages.flatMap(page => page.items);
  const orderedItems = orderedPages.flatMap(page => page.items);
  const allListItems = defaultItems;
  const projectListMembership: ApiProbeMembership = !route.conversationId ? 'not-tested' :
    allListItems.some(item => item.id === route.conversationId) ? 'found' :
      defaultComplete && (defaultPages[0]?.total ?? 0) <= pageSize * 2 ? 'not-found' : 'not-tested';

  const session = summarize([sessionOutcome]);
  const defaultList = summarize(defaultOutcomes);
  const orderedList = summarize(orderedOutcomes);
  const archivedList = summarize(archivedOutcomes);
  const defaultOrder = orderOf(defaultItems, defaultComplete);
  const orderedOrder = orderOf(orderedItems, orderedComplete);
  const orderSequenceChanged = changedSequence(defaultItems, orderedItems, defaultComplete && orderedComplete);
  const archiveRelation = archivedPage && defaultPages[0]
    ? archiveRelationship(defaultPages[0].items, archivedPage.items)
    : 'inconclusive';

  for (const outcome of [sessionOutcome, ...defaultOutcomes, ...orderedOutcomes, ...archivedOutcomes]) {
    delete outcome.value;
  }
  defaultItems.length = 0;
  orderedItems.length = 0;
  defaultPages.length = 0;
  orderedPages.length = 0;
  archivedPage = undefined;
  route.conversationId = undefined;
  token = undefined;

  return {
    schemaVersion: 1,
    probeId,
    routeKind,
    session,
    defaultList,
    orderedList,
    archivedList,
    defaultOrder,
    orderedOrder,
    orderSequenceChanged,
    archiveRelation,
    projectListMembership,
  };
}
