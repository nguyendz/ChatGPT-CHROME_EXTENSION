import type { ChatGptRawConversation } from './chatgpt-parse.ts';
import type { ApiDebugLogger } from './sync/api-debug.ts';
import { ProjectCatalogError, projectSidebarPage } from './project-catalog.ts';
import type { ProjectSidebarPage } from './project-catalog.ts';

export type ChatGptAccount = {
  userId: string;
  workspaceId: string;
  email?: string;
};

export type ChatGptConversationListItem = {
  id: string;
  updateTimeToken: string | null;
};

export type ChatGptConversationListPage = {
  // The API may report an offset-dependent lower bound, not an exact list size.
  total: number;
  items: ChatGptConversationListItem[];
};

export const CONVERSATION_LIST_PAGE_SIZE = 50;
export const CHATGPT_REQUEST_INTERVAL_MS = 2000;
const maxUpdateTimeLength = 512;

export class ChatGptApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

type SessionPayload = Record<string, unknown> & { accessToken: string };

let sessionCache: SessionPayload | undefined;
let sessionRequest: Promise<SessionPayload> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

export function accountFromSession(value: unknown): ChatGptAccount {
  if (!isRecord(value)) throw new Error('ChatGPT returned an invalid session response.');
  const user = isRecord(value.user) ? value.user : {};
  const account = isRecord(value.account) ? value.account : {};
  const userId = firstString(user.id, user.user_id, value.user_id);
  const workspaceId = firstString(
    account.workspace_id, account.workspaceId, account.id, account.account_id,
    value.workspace_id, value.workspaceId, value.account_id, user.workspace_id, user.account_id,
  );
  if (!userId || !workspaceId) {
    throw new Error('ChatGPT session does not expose a stable user and workspace ID; no conversation was synced.');
  }

  const email = firstString(user.email, account.email, value.email);
  return { userId, workspaceId, ...(email ? { email } : {}) };
}

async function loadSession(): Promise<SessionPayload> {
  if (sessionCache) return sessionCache;
  sessionRequest ??= requestChatGpt(async () => {
    const response = await fetch('https://chatgpt.com/api/auth/session');
    if (!response.ok) throw new Error(`Failed to fetch ChatGPT session (${response.status}).`);
    const value: unknown = await response.json();
    if (!isRecord(value) || typeof value.accessToken !== 'string' || !value.accessToken) {
      throw new Error('ChatGPT session response did not include an access token.');
    }
    return value as SessionPayload;
  });
  try {
    sessionCache = await sessionRequest;
    return sessionCache;
  } finally {
    sessionRequest = undefined;
  }
}

export async function loadToken(): Promise<string> {
  return (await loadSession()).accessToken;
}

export async function loadChatGptAccount(): Promise<ChatGptAccount> {
  return accountFromSession(await loadSession());
}

export async function verifyChatGptScope(account: ChatGptAccount, token: string, signal?: AbortSignal): Promise<void> {
  await requestChatGpt(async () => {
    const response = await fetch('https://chatgpt.com/api/auth/session', { signal, cache: 'no-store' });
    if (!response.ok) {
      if (response.status === 401) clearTokenCache();
      throw new ChatGptApiError('Could not verify the ChatGPT session.', response.status);
    }
    const value: unknown = await response.json();
    let current: ChatGptAccount;
    try { current = accountFromSession(value); }
    catch {
      throw new ProjectCatalogError('account-mismatch', 'Could not establish the current ChatGPT user and workspace. No project metadata was stored.');
    }
    if (!isRecord(value) || value.accessToken !== token ||
      current.userId !== account.userId || current.workspaceId !== account.workspaceId) {
      clearTokenCache();
      throw new ProjectCatalogError('account-mismatch', 'ChatGPT account or workspace changed. Reload ChatGPT and retry sync.');
    }
  }, signal);
}

export function clearTokenCache() {
  sessionCache = undefined;
  sessionRequest = undefined;
}

function abortError() {
  const error = new Error('ChatGPT request was cancelled.');
  error.name = 'AbortError';
  return error;
}

function sleepWithSignal(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type ChatGptRequestRunner = <T>(
  request: () => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

export function createChatGptRequestPacer(
  intervalMs = CHATGPT_REQUEST_INTERVAL_MS,
  now: () => number = Date.now,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = sleepWithSignal,
): ChatGptRequestRunner {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error('ChatGPT request interval must be a non-negative number.');
  }
  let nextAllowedAt = 0;
  let queue = Promise.resolve();
  return async <T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    let started = false;
    try {
      if (signal?.aborted) throw abortError();
      await sleep(Math.max(0, nextAllowedAt - now()), signal);
      if (signal?.aborted) throw abortError();
      started = true;
      return await request();
    } finally {
      if (started) nextAllowedAt = now() + intervalMs;
      release();
    }
  };
}

const pacedChatGptRequest = createChatGptRequestPacer();

export function requestChatGpt<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return pacedChatGptRequest(request, signal);
}

async function fetchApiResponse(
  token: string,
  url: string,
  resource: string,
  signal?: AbortSignal,
  maxAttempts = 5,
  firstAttempt = 1,
  logApi?: ApiDebugLogger,
): Promise<Response> {
  for (let attempt = firstAttempt; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw abortError();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      await logApi?.({
        kind: 'network-error', url, attempt,
        error: (error instanceof Error ? error.message : String(error)).replaceAll(token, '[REDACTED]'),
      });
      throw error;
    }
    if (logApi) {
      await logApi({
        kind: 'response', url, attempt, status: response.status,
        body: (await response.clone().text()).replaceAll(token, '[REDACTED]'),
      });
    }
    if (response.ok) return response;
    if (response.status === 401) clearTokenCache();
    if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
      await sleepWithSignal(Math.min(5000 * attempt, 30_000), signal);
      continue;
    }
    throw new ChatGptApiError(`Failed to fetch ${resource} (${response.status}).`, response.status);
  }
  throw new Error(`Failed to fetch ${resource} after retries.`);
}

export function conversationListUpdateToken(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0 && value.length <= maxUpdateTimeLength) {
    return `s:${value}`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return `n:${value}`;
  return null;
}

export async function fetchConversationListPage(
  token: string,
  offset: number,
  limit = CONVERSATION_LIST_PAGE_SIZE,
  signal?: AbortSignal,
  logApi?: ApiDebugLogger,
): Promise<ChatGptConversationListPage> {
  if (!Number.isSafeInteger(offset) || offset < 0 ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > CONVERSATION_LIST_PAGE_SIZE) {
    throw new Error('Conversation list page request has an invalid offset or limit.');
  }

  return requestChatGpt(async () => {
    const url = new URL('https://chatgpt.com/backend-api/conversations');
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(limit));
    const response = await fetchApiResponse(token, url.toString(), 'conversation list', signal, 5, 1, logApi);
    const value: unknown = await response.json();
    if (!isRecord(value) || !Array.isArray(value.items) || typeof value.total !== 'number' ||
      !Number.isSafeInteger(value.total) || value.total < 0 ||
      value.items.length > limit) {
      throw new ChatGptApiError('ChatGPT returned an invalid conversation list response.', response.status);
    }
    const items: ChatGptConversationListItem[] = [];
    for (const item of value.items) {
      if (!isRecord(item) || typeof item.id !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(item.id)) {
        throw new ChatGptApiError('ChatGPT returned an invalid conversation list item.', response.status);
      }
      items.push({ id: item.id, updateTimeToken: conversationListUpdateToken(item.update_time) });
    }
    return { total: value.total, items };
  }, signal);
}

export async function fetchProjectSidebarPage(
  token: string, cursor: string | null, signal?: AbortSignal, logApi?: ApiDebugLogger,
): Promise<ProjectSidebarPage> {
  if (cursor !== null) {
    throw new ProjectCatalogError('pagination-unverified',
      'Project sidebar needs another page, but its continuation request is not verified. Previous project information was retained.');
  }
  return requestChatGpt(async () => {
    const response = await fetchApiResponse(token,
      'https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=5&limit=20&owned_only=false',
      'project sidebar', signal, 5, 1, logApi);
    return projectSidebarPage(await response.json());
  }, signal);
}

export async function fetchConversation(
  token: string,
  id: string,
  maxAttempts = 5,
  attempt = 1,
  signal?: AbortSignal,
  logApi?: ApiDebugLogger,
): Promise<ChatGptRawConversation> {
  if (signal?.aborted) throw abortError();
  return requestChatGpt(async () => {
    const response = await fetchApiResponse(
      token,
      `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(id)}`,
      'conversation',
      signal,
      maxAttempts,
      attempt,
      logApi,
    );

    const value: unknown = await response.json();
    if (!isRecord(value) || !isRecord(value.mapping)) {
      throw new ChatGptApiError('ChatGPT returned an invalid conversation response.', response.status);
    }
    return value as ChatGptRawConversation;
  }, signal);
}

export type AssetDownloadFailure = 'unavailable' | 'failed' | 'too-large' | 'rate-limited' | 'unauthorized';

export class AssetDownloadError extends Error {
  readonly failure: AssetDownloadFailure;

  constructor(failure: AssetDownloadFailure, message: string) {
    super(message);
    this.name = 'AssetDownloadError';
    this.failure = failure;
  }
}

export type FetchedAsset = { bytes: Uint8Array; mime: string | null };
export type AssetFetchOptions = {
  maxBytes: number;
  fileKind: string;
  downloadIntent?: boolean;
  signal?: AbortSignal;
  logApi?: ApiDebugLogger;
  request?: ChatGptRequestRunner;
};

const ASSET_URL_ORIGIN = 'https://chatgpt.com';

function assetStatusFailure(status: number, stage: string): AssetDownloadError {
  if (status === 401) {
    clearTokenCache();
    return new AssetDownloadError('unauthorized', `ChatGPT sign-in expired during file ${stage} (HTTP 401).`);
  }
  if (status === 429) return new AssetDownloadError('rate-limited', `ChatGPT rate-limited the file ${stage} (HTTP 429).`);
  if (status === 403 || status === 404 || status === 410) {
    return new AssetDownloadError('unavailable', `ChatGPT no longer provides this file (HTTP ${status}).`);
  }
  return new AssetDownloadError('failed', `ChatGPT file ${stage} failed (HTTP ${status}).`);
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new AssetDownloadError('too-large', 'File is larger than the allowed size.');
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new AssetDownloadError('too-large', 'File is larger than the allowed size.');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AssetDownloadError('too-large', 'File is larger than the allowed size.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/**
 * Two-step download: `files/download` returns a short-lived URL, which is fetched next. The bearer token is only
 * ever sent to chatgpt.com; any other origin is refused until it has been reviewed.
 */
export async function fetchAssetFile(
  token: string, fileId: string, conversationId: string, options: AssetFetchOptions,
): Promise<FetchedAsset> {
  if (!/^file[-_][A-Za-z0-9]{1,120}$/.test(fileId) || !/^[a-zA-Z0-9-]{1,128}$/.test(conversationId)) {
    throw new AssetDownloadError('unavailable', 'Refusing an invalid file or conversation ID.');
  }
  const { signal, logApi, fileKind, maxBytes } = options;
  const run = options.request ?? requestChatGpt;
  const metadataUrl = `${ASSET_URL_ORIGIN}/backend-api/files/download/${encodeURIComponent(fileId)}` +
    `?conversation_id=${encodeURIComponent(conversationId)}&inline=false&download_intent=${Boolean(options.downloadIntent)}`;
  const downloadUrl = await run(async () => {
    const response = await fetch(metadataUrl, { headers: { authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) });
    await logApi?.({ kind: 'asset', fileKind, stage: 'url', status: response.status });
    if (!response.ok) throw assetStatusFailure(response.status, 'lookup');
    let value: unknown;
    try { value = await response.json(); } catch {
      throw new AssetDownloadError('failed', 'ChatGPT returned an unreadable file lookup response.');
    }
    if (!isRecord(value) || value.status !== 'success' || typeof value.download_url !== 'string') {
      throw new AssetDownloadError('unavailable', 'ChatGPT did not return a download URL for this file.');
    }
    return value.download_url;
  }, signal);

  let target: URL;
  try { target = new URL(downloadUrl); } catch {
    throw new AssetDownloadError('failed', 'ChatGPT returned an invalid download URL.');
  }
  if (target.origin !== ASSET_URL_ORIGIN) {
    await logApi?.({ kind: 'asset', fileKind, stage: 'rejected', host: target.hostname, reason: 'unverified-origin' });
    throw new AssetDownloadError('unavailable', 'The file is hosted on an origin that has not been approved (unverified-origin).');
  }

  return run(async () => {
    const response = await fetch(target.toString(), { headers: { authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) });
    if (!response.ok) {
      await logApi?.({ kind: 'asset', fileKind, stage: 'download', status: response.status });
      throw assetStatusFailure(response.status, 'download');
    }
    const bytes = await readLimited(response, maxBytes);
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || null;
    await logApi?.({
      kind: 'asset', fileKind, stage: 'download', status: response.status, bytes: bytes.length,
      ...(contentType ? { contentType: contentType.slice(0, 100) } : {}),
    });
    if (bytes.length === 0) throw new AssetDownloadError('unavailable', 'ChatGPT returned an empty file.');
    return { bytes, mime: contentType };
  }, signal);
}
