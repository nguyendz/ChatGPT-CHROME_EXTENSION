import type { ChatGptRawConversation } from './chatgpt-parse.ts';
import type { ApiDebugLogger } from './sync/api-debug.ts';

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
