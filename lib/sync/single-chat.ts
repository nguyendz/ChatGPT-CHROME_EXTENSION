import { HostClient } from './host-client.ts';
import type { ChatGptRawConversation } from '../chatgpt-parse.ts';
import type { AccountScope, RequestPayloads, ResponsePayloads } from './protocol.ts';

type HostRequester = Pick<HostClient, 'request' | 'retain'>;
type SyncFailure = { conversationId: string | null; error: string; retryable: boolean };

export type SingleChatSyncResult = {
  conversationId: string;
  status: 'inserted' | 'updated' | 'unchanged';
  messageCount: number;
  newMessageCount?: number;
  changeKind?: 'metadata-only';
};

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function conversationIdFromUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Open a saved ChatGPT conversation first.');
  }
  if (url.origin !== 'https://chatgpt.com') throw new Error('Open a saved ChatGPT conversation first.');
  const segments = url.pathname.split('/').filter(Boolean);
  const conversationIndex = segments.indexOf('c');
  const conversationId = conversationIndex >= 0 ? segments[conversationIndex + 1] : undefined;
  if (!conversationId || !/^[a-zA-Z0-9-]+$/.test(conversationId)) {
    throw new Error('Open a saved ChatGPT conversation first.');
  }
  return conversationId;
}

async function finishFailedRun(
  client: HostRequester, runId: string, conversationId: string, originalError: unknown,
): Promise<never> {
  const failure: SyncFailure = {
    conversationId,
    error: 'Single-chat fetch or persistence failed.',
    retryable: true,
  };
  try {
    await client.request('endRun', { runId, cancelled: false, failures: [failure] });
  } catch (endError) {
    throw new AggregateError([originalError, endError], 'Conversation sync failed and the run could not be finalized.');
  }
  throw originalError;
}

export async function syncCurrentConversation(
  conversationId: string,
  account: AccountScope,
  fetchRaw: () => Promise<ChatGptRawConversation>,
  client: HostRequester = new HostClient(),
): Promise<SingleChatSyncResult> {
  const runId = crypto.randomUUID();
  const releaseHost = client.retain();

  try {
    await client.request('beginRun', { runId, mode: 'single', account });

    let raw: ChatGptRawConversation;
    try {
      raw = await fetchRaw();
      if (raw.conversation_id !== conversationId) {
        throw new Error('ChatGPT returned a different conversation than the active tab.');
      }
    } catch (error) {
      return finishFailedRun(client, runId, conversationId, error);
    }

    let rawJson: string;
    try {
      rawJson = JSON.stringify(raw);
      if (typeof rawJson !== 'string') throw new Error('Conversation payload is not JSON serializable.');
    } catch (error) {
      return finishFailedRun(client, runId, conversationId, error);
    }
    const digest = await sha256(rawJson);

    let result: ResponsePayloads['upsertConversation'];
    try {
      result = await client.request('upsertConversation', {
        runId,
        conversationId,
        raw: raw as Record<string, unknown>,
        sha256: digest,
      } satisfies RequestPayloads['upsertConversation']);
    } catch (error) {
      return finishFailedRun(client, runId, conversationId, error);
    }

    const summary = await client.request('endRun', { runId, cancelled: false, failures: [] });
    if (summary.status !== 'completed') {
      throw new Error(`The local host finalized the conversation sync as ${summary.status}.`);
    }
    return {
      conversationId,
      status: result.status === 'noop' ? 'unchanged' : result.status,
      messageCount: result.messageCount,
      ...(result.newMessageCount === undefined ? {} : { newMessageCount: result.newMessageCount }),
      ...(result.changeKind ? { changeKind: result.changeKind } : {}),
    };
  } finally {
    releaseHost();
  }
}
