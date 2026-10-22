import type { ChatGptRawConversation } from '../chatgpt-parse.ts';
import {
  ChatGptApiError, CONVERSATION_LIST_PAGE_SIZE, fetchConversation,
  fetchConversationListPage, fetchProjectSidebarPage, verifyChatGptScope,
} from '../chatgpt-client.ts';
import type { ChatGptConversationListItem, ChatGptConversationListPage } from '../chatgpt-client.ts';
import { HostClient, HostConnectionError } from './host-client.ts';
import { ApiDebugLogError, createApiDebugLogger } from './api-debug.ts';
import type { ApiDebugLogger } from './api-debug.ts';
import type { AccountScope, RequestPayloads, ResponsePayloads } from './protocol.ts';
import type { ProjectSyncOutcome } from './protocol.ts';
import type { ProjectSidebarPage } from '../project-catalog.ts';
import { collectProjectCatalog, projectFailure } from './projects.ts';

type HostRequester = Pick<HostClient, 'request' | 'retain'>;
type SyncFailure = {
  conversationId: string | null;
  error: string;
  retryable: boolean;
};

export type AllChatSyncProgress = {
  phase: 'projects' | 'listing' | 'syncing';
  listed: number;
  total: number | null;
  selected: number | null;
  processed: number;
  new: number;
  newMessages: number;
  updated: number;
  unchanged: number;
  failed: number;
  projects?: ProjectSyncOutcome;
};

export type AllChatSyncResult = {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  counts: {
    listed: number; selected: number; new: number; newMessages: number;
    updated: number; unchanged: number; failed: number;
  };
  error?: string;
  failurePhase?: 'projects' | 'listing' | 'selection' | 'syncing';
  projects?: ProjectSyncOutcome;
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
  fetchProjects?: (cursor: string | null, signal?: AbortSignal) => Promise<ProjectSidebarPage>;
  verifyScope?: (account: AccountScope, token: string, signal?: AbortSignal) => Promise<void>;
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
  if (error instanceof ApiDebugLogError) return error.message;
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
    return 'Both consistency scans returned duplicate conversation IDs. Retry when the list is stable.';
  }
  return 'Could not fetch a complete conversation list due to a network or response error. Check your connection and retry.';
}

function isRetryableConversationListFailure(error: unknown) {
  if (error instanceof ApiDebugLogError) return false;
  if (!(error instanceof ChatGptApiError) || error.status === undefined) return true;
  return error.status === 429 || error.status >= 500;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

async function enumerateConversations(
  fetchPage: NonNullable<AllChatSyncDependencies['fetchPage']>,
  signal: AbortSignal | undefined,
  onPage: (listed: number) => void,
  logApi: ApiDebugLogger,
  validationLimit?: number,
): Promise<ChatGptConversationListItem[]> {
  if (validationLimit !== undefined) {
    throwIfAborted(signal);
    onPage(0);
    await logApi({ kind: 'pagination', scan: 1, offset: 0, reason: 'start' });
    const page = await fetchPage(0, validationLimit, signal);
    throwIfAborted(signal);
    const context = {
      kind: 'pagination' as const, scan: 1, offset: 0,
      returned: page.items.length, pageTotal: page.total, listed: page.items.length,
    };
    await logApi({ ...context, reason: 'page' });
    if (page.items.length > validationLimit || new Set(page.items.map(item => item.id)).size !== page.items.length) {
      throw new ChatGptApiError('ChatGPT returned an oversized or duplicate validation list.');
    }
    await logApi({ ...context, reason: 'validation-limit' });
    onPage(page.items.length);
    return page.items;
  }
  for (let scan = 0; scan < 2; scan++) {
    throwIfAborted(signal);
    const items: ChatGptConversationListItem[] = [];
    const ids = new Set<string>();
    let offset = 0;
    let unstable = false;
    onPage(0);
    await logApi({ kind: 'pagination', scan: scan + 1, offset, reason: 'start' });

    while (true) {
      throwIfAborted(signal);
      const page = await fetchPage(offset, CONVERSATION_LIST_PAGE_SIZE, signal);
      const pageContext = {
        kind: 'pagination' as const, scan: scan + 1, offset,
        returned: page.items.length, pageTotal: page.total,
        listed: items.length,
      };
      await logApi({ ...pageContext, reason: 'page' });
      // Observed totals grow with the offset; confirm the end with an empty page.
      if (page.items.length === 0) {
        await logApi({ ...pageContext, reason: 'complete' });
        return items;
      }
      for (const item of page.items) {
        if (ids.has(item.id)) {
          await logApi({ ...pageContext, reason: 'duplicate-id', listed: items.length });
          unstable = true;
          break;
        }
        ids.add(item.id);
        items.push(item);
      }
      if (unstable) break;
      offset += page.items.length;
      onPage(offset);
    }
  }
  throw new Error('Conversation list changed while paging; duplicate conversation IDs prevented a complete scan.');
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
  if (dependencies.maxConversations !== undefined &&
    (!Number.isSafeInteger(dependencies.maxConversations) ||
      dependencies.maxConversations < 1 || dependencies.maxConversations > CONVERSATION_LIST_PAGE_SIZE)) {
    throw new Error(`Validation limit must be between 1 and ${CONVERSATION_LIST_PAGE_SIZE}.`);
  }
  const client = dependencies.client ?? new HostClient();
  const runId = crypto.randomUUID();
  const logApi = createApiDebugLogger(client, runId);
  const signal = dependencies.signal;
  const fetchPage = dependencies.fetchPage ??
    ((offset, limit, requestSignal) => fetchConversationListPage(token, offset, limit, requestSignal, logApi));
  const fetchRaw = dependencies.fetchRaw ??
    ((conversationId, requestSignal) => fetchConversation(token, conversationId, 5, 1, requestSignal, logApi));
  const fetchProjects = dependencies.fetchProjects ??
    ((cursor, requestSignal) => fetchProjectSidebarPage(token, cursor, requestSignal, logApi));
  const verifyScope = dependencies.verifyScope ?? verifyChatGptScope;
  const onProgress = dependencies.onProgress ?? (() => {});
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
  let projects: ProjectSyncOutcome = { status: 'cancelled', category: 'cancelled' };

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
      !hostStatus.capabilities.includes('message-change-counts') ||
      !hostStatus.capabilities.includes('project-catalog') || hostStatus.schemaVersion < 4) {
      throw new Error('Update the local sync host before using all-chat sync with project information (schema 4 required).');
    }
    if (signal?.aborted) {
      return {
        runId, status: 'cancelled',
        counts: { listed: 0, selected: 0, new: 0, newMessages: 0, updated: 0, unchanged: 0, failed: 0 },
      };
    }
    await client.request('beginRun', { runId, mode: 'incremental', account, projectCatalog: true });
    runStarted = true;

    report('projects');
    let scopeVerified = false;
    try {
      await verifyScope(account, token, signal);
      scopeVerified = true;
      const items = await collectProjectCatalog(runId, account, fetchProjects, logApi, signal);
      scopeVerified = false;
      await verifyScope(account, token, signal);
      scopeVerified = true;
      throwIfAborted(signal);
      const result = await client.request('commitProjectCatalog', { runId, items });
      projects = { status: 'completed', count: result.count };
      if (result.count !== items.length) throw new HostConnectionError('host-exited', 'Inconsistent project catalog acknowledgement.');
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        cancelled = true;
      } else {
        const failure = error instanceof HostConnectionError || error instanceof ApiDebugLogError
          ? { category: 'local-host' as const, message: error.message }
          : projectFailure(error);
        projects = { status: 'failed', category: failure.category };
        runError = failure.message;
        failurePhase = 'projects';
        fatal = !scopeVerified || ['unauthorized', 'account-mismatch', 'local-host'].includes(failure.category);
      }
    }
    progress.projects = projects;
    report('projects');

    let manifest: ChatGptConversationListItem[] | undefined;
    try {
      if (!cancelled && !fatal) {
        manifest = await enumerateConversations(fetchPage, signal, listed => {
          progress.listed = listed;
          progress.total = null;
          report('listing');
        }, logApi, dependencies.maxConversations);
        progress.listed = manifest.length;
        progress.total = manifest.length;
        report('syncing');
      }
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
        selectedManifest = manifest;
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
    const summary = await client.request('endRun', { runId, cancelled, failures, projects });
    return {
      runId,
      status: summary.status,
      projects,
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
        projects,
        failures: shouldCancel ? failures : [...failures, {
          conversationId: null,
          error: 'All-chat sync could not be completed.',
          retryable: true,
        }],
      });
      return {
        runId,
        status: summary.status,
        projects,
        counts: {
          listed: progress.listed, selected: selectedCount,
          new: summary.counts.new,
          newMessages: progress.newMessages,
          updated: summary.counts.updated,
          unchanged: summary.counts.unchanged,
          failed: summary.counts.failed,
        },
        ...(!shouldCancel ? {
          error: runError ?? 'All-chat sync could not be completed.',
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
