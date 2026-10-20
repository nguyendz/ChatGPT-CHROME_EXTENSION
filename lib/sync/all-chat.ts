import type { ChatGptRawConversation } from '../chatgpt-parse.ts';
import {
  ChatGptApiError, CONVERSATION_LIST_PAGE_SIZE, fetchConversation,
  fetchConversationListPage,
} from '../chatgpt-client.ts';
import type { ChatGptConversationListItem, ChatGptConversationListPage } from '../chatgpt-client.ts';
import { HostClient, HostConnectionError } from './host-client.ts';
import type { AccountScope, RequestPayloads, ResponsePayloads } from './protocol.ts';

type HostRequester = Pick<HostClient, 'request' | 'retain'>;
type SyncFailure = {
  conversationId: string | null;
  error: string;
  retryable: boolean;
};

export type AllChatSyncProgress = {
  phase: 'listing' | 'syncing';
  listed: number;
  total: number | null;
  selected: number | null;
  processed: number;
  new: number;
  newMessages: number;
  updated: number;
  unchanged: number;
  failed: number;
};

export type AllChatSyncResult = {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  counts: {
    listed: number; selected: number; new: number; newMessages: number;
    updated: number; unchanged: number; failed: number;
  };
  error?: string;
  failurePhase?: 'listing' | 'selection' | 'syncing';
};

export type AllChatSyncDependencies = {
  client?: HostRequester;
  fetchPage?: (
    offset: number, limit: number, signal?: AbortSignal,
  ) => Promise<ChatGptConversationListPage>;
  fetchRaw?: (conversationId: string, signal?: AbortSignal) => Promise<ChatGptRawConversation>;
  signal?: AbortSignal;
  onProgress?: (progress: AllChatSyncProgress) => void;
  maxConversations?: number;
};

function abortError() {
  const error = new Error('All-chat sync was cancelled.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function conversationListFailureMessage(error: unknown) {
  if (error instanceof ChatGptApiError) {
    if (error.status === 401) return 'ChatGPT sign-in expired (HTTP 401). Sign in and retry.';
    if (error.status === 403) return 'ChatGPT denied the conversation-list request (HTTP 403).';
    if (error.status === 429) return 'ChatGPT rate-limited the conversation-list request (HTTP 429). Wait and retry.';
    if (error.status !== undefined && error.status >= 500) {
      return `ChatGPT conversation-list service returned HTTP ${error.status}. Retry later.`;
    }
    if (error.status !== undefined && error.status >= 400) {
      return `ChatGPT rejected the conversation-list request (HTTP ${error.status}).`;
    }
    return `ChatGPT returned an invalid conversation-list response${error.status === undefined ? '' : ` (HTTP ${error.status})`}.`;
  }
  if (error instanceof Error && error.message.startsWith('Conversation list changed while paging')) {
    return 'The conversation list kept changing during both consistency scans. Retry when the list is stable.';
  }
  return 'Could not fetch a complete conversation list due to a network or response error. Check your connection and retry.';
}

function isRetryableConversationListFailure(error: unknown) {
  if (!(error instanceof ChatGptApiError) || error.status === undefined) return true;
  return error.status === 429 || error.status >= 500;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

async function enumerateConversations(
  fetchPage: NonNullable<AllChatSyncDependencies['fetchPage']>,
  signal: AbortSignal | undefined,
  onPage: (listed: number, total: number) => void,
): Promise<ChatGptConversationListItem[]> {
  for (let scan = 0; scan < 2; scan++) {
    throwIfAborted(signal);
    const items: ChatGptConversationListItem[] = [];
    const ids = new Set<string>();
    let offset = 0;
    let total: number | undefined;
    let unstable = false;

    do {
      throwIfAborted(signal);
      const page = await fetchPage(offset, CONVERSATION_LIST_PAGE_SIZE, signal);
      if (total === undefined) total = page.total;
      else if (page.total !== total) {
        unstable = true;
        break;
      }
      if (page.items.length === 0 && offset < total) {
        unstable = true;
        break;
      }
      for (const item of page.items) {
        if (ids.has(item.id)) {
          unstable = true;
          break;
        }
        ids.add(item.id);
        items.push(item);
      }
      if (unstable) break;
      offset += page.items.length;
      onPage(offset, total);
      if (offset > total) {
        unstable = true;
        break;
      }
    } while (offset < (total ?? 0));

    if (!unstable && total !== undefined && offset === total && items.length === total) return items;
  }
  throw new Error('Conversation list changed while paging; no complete scan could be confirmed.');
}

export function selectLatestConversations(
  items: ChatGptConversationListItem[],
  limit: number,
): ChatGptConversationListItem[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Latest-chat limit must be a positive safe integer.');
  }
  if (items.length <= limit) return items;

  const timestamps = items.map(item => {
    const token = item.updateTimeToken;
    if (token?.startsWith('s:')) {
      const value = Date.parse(token.slice(2));
      return Number.isFinite(value) ? { kind: 'string', value } : null;
    }
    if (token?.startsWith('n:')) {
      const value = Number(token.slice(2));
      return Number.isFinite(value) ? { kind: 'number', value } : null;
    }
    return null;
  });
  const kinds = new Set(timestamps.filter((value): value is NonNullable<typeof value> => value !== null)
    .map(value => value.kind));
  if (timestamps.some(value => value === null) || kinds.size !== 1) {
    throw new Error(
      `Cannot safely select the ${limit} latest chats because their update_time values are missing, invalid, or mixed. Choose All chats to validate without the latest-chat filter.`,
    );
  }

  return items.map((item, index) => ({ item, index, value: timestamps[index]!.value }))
    .sort((left, right) => right.value - left.value || left.index - right.index)
    .slice(0, limit)
    .map(entry => entry.item);
}

async function digestConversation(raw: ChatGptRawConversation) {
  const rawJson = JSON.stringify(raw);
  if (typeof rawJson !== 'string') throw new Error('Conversation payload is not JSON serializable.');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawJson));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function syncAllConversations(
  account: AccountScope,
  token: string,
  dependencies: AllChatSyncDependencies = {},
): Promise<AllChatSyncResult> {
  const client = dependencies.client ?? new HostClient();
  const signal = dependencies.signal;
  const fetchPage = dependencies.fetchPage ??
    ((offset, limit, requestSignal) => fetchConversationListPage(token, offset, limit, requestSignal));
  const fetchRaw = dependencies.fetchRaw ??
    ((conversationId, requestSignal) => fetchConversation(token, conversationId, 5, 1, requestSignal));
  const onProgress = dependencies.onProgress ?? (() => {});
  const runId = crypto.randomUUID();
  const releaseHost = client.retain();
  const failures: SyncFailure[] = [];
  const progress: AllChatSyncProgress = {
    phase: 'listing', listed: 0, total: null, selected: null, processed: 0,
    new: 0, newMessages: 0, updated: 0, unchanged: 0, failed: 0,
  };
  let runStarted = false;
  let cancelled = false;
  let fatal = false;
  let selectedCount = 0;
  let runError: string | undefined;
  let failurePhase: AllChatSyncResult['failurePhase'];

  function report(phase: AllChatSyncProgress['phase']) {
    progress.phase = phase;
    onProgress({ ...progress });
  }

  try {
    if (signal?.aborted) {
      return {
        runId, status: 'cancelled',
        counts: { listed: 0, selected: 0, new: 0, newMessages: 0, updated: 0, unchanged: 0, failed: 0 },
      };
    }
    const hostStatus = await client.request('getStatus', {});
    if (!hostStatus.capabilities.includes('all-chat-sync') ||
      !hostStatus.capabilities.includes('message-change-counts') || hostStatus.schemaVersion < 3) {
      throw new Error('Update the local sync host before using all-chat sync and new-message counts.');
    }
    if (signal?.aborted) {
      return {
        runId, status: 'cancelled',
        counts: { listed: 0, selected: 0, new: 0, newMessages: 0, updated: 0, unchanged: 0, failed: 0 },
      };
    }
    await client.request('beginRun', { runId, mode: 'incremental', account });
    runStarted = true;

    let manifest: ChatGptConversationListItem[] | undefined;
    try {
      manifest = await enumerateConversations(fetchPage, signal, (listed, total) => {
        progress.listed = listed;
        progress.total = total;
        report('listing');
      });
      progress.listed = manifest.length;
      progress.total = manifest.length;
      report('syncing');
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        cancelled = true;
      } else {
        runError = conversationListFailureMessage(error);
        failurePhase = 'listing';
        failures.push({
          conversationId: null,
          error: runError,
          retryable: isRetryableConversationListFailure(error),
        });
        progress.failed++;
      }
    }

    let selectedManifest: ChatGptConversationListItem[] | undefined;
    if (manifest && !cancelled) {
      try {
        selectedManifest = dependencies.maxConversations === undefined
          ? manifest
          : selectLatestConversations(manifest, dependencies.maxConversations);
        selectedCount = selectedManifest.length;
        progress.selected = selectedCount;
        report('syncing');
      } catch (error) {
        runError = error instanceof Error ? error.message : String(error);
        failurePhase = 'selection';
        failures.push({ conversationId: null, error: runError, retryable: false });
        progress.failed++;
      }
    }

    if (selectedManifest && !cancelled) {
      for (let offset = 0; offset < selectedManifest.length && !cancelled && !fatal; offset += 50) {
        throwIfAborted(signal);
        const page = selectedManifest.slice(offset, offset + 50);
        let diff: ResponsePayloads['diffManifest'];
        try {
          diff = await client.request('diffManifest', {
            runId,
            items: page.map(item => ({
              conversationId: item.id,
              updateTimeToken: item.updateTimeToken,
            })),
          } satisfies RequestPayloads['diffManifest']);
        } catch (error) {
          runError = 'The local host could not compare the conversation list.';
          failurePhase = 'syncing';
          failures.push({
            conversationId: null,
            error: runError,
            retryable: true,
          });
          progress.failed++;
          fatal = true;
          break;
        }
        const requestedTokens = new Map(page.map(item => [item.id, item.updateTimeToken]));
        if (diff.listed !== page.length || diff.changed.some(candidate =>
          !requestedTokens.has(candidate.conversationId) ||
          requestedTokens.get(candidate.conversationId) !== candidate.updateTimeToken)) {
          runError = 'The local host returned an inconsistent manifest comparison.';
          failurePhase = 'syncing';
          failures.push({
            conversationId: null,
            error: runError,
            retryable: false,
          });
          progress.failed++;
          fatal = true;
          break;
        }

        progress.unchanged += diff.unchanged;
        progress.processed += diff.unchanged;
        report('syncing');
        for (const candidate of diff.changed) {
          if (signal?.aborted) {
            cancelled = true;
            break;
          }
          try {
            const raw = await fetchRaw(candidate.conversationId, signal);
            if (raw.conversation_id !== candidate.conversationId) {
              throw new Error('ChatGPT returned a different conversation than requested.');
            }
            const sha256 = await digestConversation(raw);
            const result = await client.request('upsertConversation', {
              runId,
              conversationId: candidate.conversationId,
              raw: raw as Record<string, unknown>,
              sha256,
              manifestUpdateToken: candidate.updateTimeToken,
            } satisfies RequestPayloads['upsertConversation']);
            const newMessageCount = result.newMessageCount;
            if (typeof newMessageCount !== 'number' || !Number.isSafeInteger(newMessageCount) ||
              newMessageCount < 0 || newMessageCount > result.messageCount) {
              throw new Error('The local sync host did not return a valid new-message count.');
            }
            if (result.status === 'inserted') progress.new++;
            else if (result.status === 'updated') progress.updated++;
            else progress.unchanged++;
            progress.newMessages += newMessageCount;
            progress.processed++;
          } catch (error) {
            if (isAbortError(error) || signal?.aborted) {
              cancelled = true;
              break;
            }
            failures.push({
              conversationId: candidate.conversationId,
              error: 'Conversation detail fetch or persistence failed.',
              retryable: !(error instanceof ChatGptApiError && error.status === 401),
            });
            progress.failed++;
            progress.processed++;
            if (error instanceof ChatGptApiError && error.status === 401 ||
              error instanceof HostConnectionError) {
              fatal = true;
              break;
            }
          }
          report('syncing');
        }
      }
    }

    cancelled ||= Boolean(signal?.aborted);
    const summary = await client.request('endRun', { runId, cancelled, failures });
    return {
      runId,
      status: summary.status,
      counts: {
        listed: progress.listed, selected: selectedCount,
        new: summary.counts.new, newMessages: progress.newMessages,
        updated: summary.counts.updated, unchanged: summary.counts.unchanged,
        failed: summary.counts.failed,
      },
      ...(runError ? { error: runError } : {}),
      ...(failurePhase ? { failurePhase } : {}),
    };
  } catch (error) {
    const shouldCancel = cancelled || isAbortError(error) || Boolean(signal?.aborted);
    if (!runStarted) {
      if (shouldCancel) {
        return {
          runId, status: 'cancelled',
          counts: { listed: 0, selected: 0, new: 0, newMessages: 0, updated: 0, unchanged: 0, failed: 0 },
        };
      }
      throw error;
    }
    try {
      const summary = await client.request('endRun', {
        runId,
        cancelled: shouldCancel,
        failures: shouldCancel ? failures : [...failures, {
          conversationId: null,
          error: 'All-chat sync could not be completed.',
          retryable: true,
        }],
      });
      return {
        runId,
        status: summary.status,
        counts: {
          listed: progress.listed, selected: selectedCount,
          new: summary.counts.new,
          newMessages: progress.newMessages,
          updated: summary.counts.updated,
          unchanged: summary.counts.unchanged,
          failed: summary.counts.failed,
        },
        ...(!shouldCancel ? {
          error: 'All-chat sync could not be completed.',
          failurePhase: failurePhase ?? 'syncing',
        } : {}),
      };
    } catch (endError) {
      throw new AggregateError([error, endError], 'All-chat sync failed and the run could not be finalized.');
    }
  } finally {
    releaseHost();
  }
}
