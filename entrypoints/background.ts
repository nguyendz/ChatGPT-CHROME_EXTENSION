import { classifyApiProbeRoute, collectChatGptApiProbe } from '@/lib/chatgpt-api-probe';
import { fetchConversation, loadChatGptAccount, loadToken } from '@/lib/chatgpt-client';
import { echoHost, getHostStatus, recordApiProbe } from '@/lib/sync/diagnostics';
import { syncAllConversations } from '@/lib/sync/all-chat';
import { conversationIdFromUrl, syncCurrentConversation } from '@/lib/sync/single-chat';

type SyncDiagnosticRequest = { message: 'syncHostStatus' | 'syncHostEcho' | 'syncApiProbe' };
type SyncCurrentChatRequest = { message: 'syncCurrentChat' };
type BackgroundRequest = SyncDiagnosticRequest | SyncCurrentChatRequest;

export default defineBackground(() => {
  const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

  function isExtensionSender(sender: chrome.runtime.MessageSender): boolean {
    return sender.id === chrome.runtime.id
      && Boolean(sender.url?.startsWith(chrome.runtime.getURL('/')));
  }

  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'local-sync-progress') return;
    if (!port.sender || !isExtensionSender(port.sender)) {
      port.disconnect();
      return;
    }

    const controller = new AbortController();
    let started = false;
    let terminal = false;
    const send = (message: unknown) => {
      if (terminal) return;
      try {
        port.postMessage(message);
      } catch {
        controller.abort();
      }
    };
    const finish = (message: unknown) => {
      terminal = true;
      try {
        port.postMessage(message);
      } catch {
        controller.abort();
      }
      try {
        port.disconnect();
      } catch {
        controller.abort();
      }
    };

    port.onDisconnect.addListener(() => controller.abort());
    port.onMessage.addListener((rawMessage: unknown) => {
      if (!rawMessage || typeof rawMessage !== 'object' || !('type' in rawMessage)) {
        send({ type: 'error', message: 'Invalid sync control message.' });
        return;
      }
      const messageType = (rawMessage as { type: unknown }).type;
      const scope = (rawMessage as { scope?: unknown }).scope;
      if (messageType === 'cancel') {
        controller.abort();
        return;
      }
      if (messageType !== 'start' || started ||
        (scope !== 'latest-10' && scope !== 'all')) {
        send({ type: 'error', message: 'Invalid or repeated sync start request.' });
        return;
      }
      started = true;
      (async () => {
        const [token, account] = await Promise.all([loadToken(), loadChatGptAccount()]);
        return syncAllConversations(account, token, {
          signal: controller.signal,
          ...(scope === 'latest-10' ? { maxConversations: 10 } : {}),
          onProgress: progress => send({ type: 'progress', progress }),
        });
      })().then(
        result => finish({ type: 'complete', result }),
        error => finish({ type: 'error', message: getErrorMessage(error) }),
      );
    });
  });

  chrome.runtime.onMessage.addListener((
    rawRequest: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse,
  ) => {
    if (!rawRequest || typeof rawRequest !== 'object' || !('message' in rawRequest)) return false;
    const request = rawRequest as BackgroundRequest;

    if (request.message === 'syncCurrentChat') {
      if (!isExtensionSender(sender)) {
        sendResponse({ error: 'Chat sync must be started from the extension popup.' });
        return false;
      }
      (async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.url) throw new Error('Open a saved ChatGPT conversation first.');
        const conversationId = conversationIdFromUrl(tab.url);
        const [token, account] = await Promise.all([loadToken(), loadChatGptAccount()]);
        return syncCurrentConversation(
          conversationId,
          account,
          logApi => fetchConversation(token, conversationId, 5, 1, undefined, logApi),
        );
      })().then(sendResponse).catch(error => sendResponse({ error: getErrorMessage(error) }));
      return true;
    }

    if (request.message === 'syncHostStatus' || request.message === 'syncHostEcho') {
      if (!isExtensionSender(sender)) {
        sendResponse({ error: 'Local sync diagnostics must be started from the extension.' });
        return false;
      }
      const action = request.message === 'syncHostStatus' ? getHostStatus() : echoHost();
      action.then(sendResponse).catch(error => sendResponse({ error: getErrorMessage(error) }));
      return true;
    }

    if (request.message === 'syncApiProbe') {
      if (!isExtensionSender(sender)) {
        sendResponse({ error: 'The ChatGPT API probe must be started from the extension popup.' });
        return false;
      }
      (async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.url) throw new Error('Open a signed-in ChatGPT tab before running the API probe.');
        const route = classifyApiProbeRoute(tab.url);
        const report = await collectChatGptApiProbe(route);
        const result = await recordApiProbe(report);
        if (!result.logged || result.probeId !== report.probeId) {
          throw new Error('The local host did not confirm that the API probe was logged.');
        }
        const summaries = [report.session, report.defaultList, report.orderedList, report.archivedList];
        return {
          probeId: result.probeId,
          logged: true,
          warningCount: summaries.filter(summary => summary.status !== 'ok').length +
            [report.defaultOrder, report.orderedOrder, report.archiveRelation, report.projectListMembership]
              .filter(value => value === 'inconclusive' || value === 'not-tested').length,
        };
      })().then(sendResponse).catch(error => sendResponse({ error: getErrorMessage(error) }));
      return true;
    }

    return false;
  });
});
