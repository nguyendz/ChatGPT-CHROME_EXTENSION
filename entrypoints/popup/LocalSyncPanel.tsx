import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { AssetRunSummary, ConnectionStatus, EchoResult } from '@/lib/sync/protocol';
import { isAssetRunSummary, isProjectSyncOutcome } from '@/lib/sync/protocol';
import type { SingleChatSyncResult } from '@/lib/sync/single-chat';
import type { AllChatSyncProgress, AllChatSyncResult } from '@/lib/sync/all-chat';

async function diagnostic<T>(message: string, extra: Record<string, unknown> = {}): Promise<T> {
  const response: T & { error?: string } = await chrome.runtime.sendMessage({ message, ...extra });
  if (!response) throw new Error('No response from the background. Reload the extension.');
  return response;
}

const INCLUDE_ASSETS_KEY = 'localSync.includeAssets';

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const assetStopReasons: Record<NonNullable<AssetRunSummary['stopped']>, string> = {
  cancelled: 'stopped by you',
  'rate-limited': 'ChatGPT rate-limited file downloads',
  unauthorized: 'ChatGPT sign-in expired',
  'local-host': 'the local app was unavailable',
};

function assetSummaryText(summary?: AssetRunSummary) {
  if (!summary) return '';
  const parts = [`${summary.stored + summary.deduplicated} saved${summary.bytes ? ` (${formatBytes(summary.bytes)})` : ''}`];
  if (summary.skippedTooLarge) parts.push(`${summary.skippedTooLarge} over the 5 MB limit`);
  if (summary.unavailable) parts.push(`${summary.unavailable} unavailable`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  if (summary.deferred) parts.push(`${summary.deferred} waiting for the next run`);
  const stopped = summary.stopped ? ` Stopped early: ${assetStopReasons[summary.stopped]}.` : '';
  return ` Files: ${parts.join(', ')}.${stopped}`;
}

const labels = {
  connected: 'Connected',
  'not-registered': 'App not registered',
  forbidden: 'ID mismatch',
  'host-exited': 'Host error',
  'protocol-mismatch': 'Update required',
  unknown: 'Connection error',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isProgress(value: unknown): value is AllChatSyncProgress {
  return isRecord(value) && (value.phase === 'projects' || value.phase === 'listing' || value.phase === 'syncing' || value.phase === 'assets') &&
    isCount(value.listed) && (value.total === null || isCount(value.total)) &&
    (value.selected === null || isCount(value.selected)) &&
    isCount(value.processed) && isCount(value.new) && isCount(value.newMessages) &&
    isCount(value.updated) && isCount(value.unchanged) && isCount(value.failed) &&
    (value.projects === undefined || isProjectSyncOutcome(value.projects)) &&
    (value.assets === undefined || isRecord(value.assets) && isCount(value.assets.total) &&
      isCount(value.assets.processed) && isCount(value.assets.bytes));
}

function isRunResult(value: unknown): value is AllChatSyncResult {
  if (!isRecord(value) || typeof value.runId !== 'string' ||
    typeof value.status !== 'string' || !['completed', 'failed', 'cancelled'].includes(value.status) ||
    !isRecord(value.counts)) return false;
  return isCount(value.counts.listed) && isCount(value.counts.selected) &&
    isCount(value.counts.new) && isCount(value.counts.newMessages) &&
    isCount(value.counts.updated) && isCount(value.counts.unchanged) &&
    isCount(value.counts.failed) && (value.error === undefined || typeof value.error === 'string') &&
    (value.projects === undefined || isProjectSyncOutcome(value.projects)) &&
    (value.assets === undefined || isAssetRunSummary(value.assets)) &&
    (value.failurePhase === undefined ||
      value.failurePhase === 'projects' || value.failurePhase === 'listing' ||
      value.failurePhase === 'selection' || value.failurePhase === 'syncing');
}

export function LocalSyncPanel() {
  const [status, setStatus] = useState<ConnectionStatus>();
  const [action, setAction] = useState<'connection' | 'echo' | 'sync-current' | 'sync-all' | 'probe' | 'viewer'>();
  const [check, setCheck] = useState({ count: 0, completedAt: '' });
  const [feedback, setFeedback] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [syncScope, setSyncScope] = useState<'latest-10' | 'all'>('latest-10');
  const [includeAssets, setIncludeAssets] = useState(false);
  const [syncProgress, setSyncProgress] = useState<AllChatSyncProgress>();
  const [stopRequested, setStopRequested] = useState(false);
  const syncPort = useRef<chrome.runtime.Port | undefined>(undefined);
  const busy = action !== undefined;

  useEffect(() => {
    try { setIncludeAssets(localStorage.getItem(INCLUDE_ASSETS_KEY) === '1'); } catch { /* storage unavailable */ }
  }, []);

  function changeIncludeAssets(value: boolean) {
    setIncludeAssets(value);
    try { localStorage.setItem(INCLUDE_ASSETS_KEY, value ? '1' : '0'); } catch { /* storage unavailable */ }
  }

  async function testConnection() {
    setAction('connection');
    setFeedback('');
    try {
      setStatus(await diagnostic<ConnectionStatus>('syncHostStatus'));
    } catch (error) {
      setStatus({ state: 'unknown', error: error instanceof Error ? error.message : String(error) });
    } finally {
      const completedAt = new Date().toLocaleTimeString();
      setCheck(previous => ({ count: previous.count + 1, completedAt }));
      setAction(undefined);
    }
  }

  async function echo() {
    setAction('echo');
    setFeedback('');
    try {
      const result = await diagnostic<EchoResult & { error?: string }>('syncHostEcho');
      if (result.error) throw new Error(result.error);
      if (!result.matches) throw new Error('Echo verification failed');
      setFeedback(`10 MB verified. SHA-256: ${result.sha256}`);
    } catch (error) {
      setFeedback(`Echo failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAction(undefined);
    }
  }

  async function syncCurrentChat() {
    setAction('sync-current');
    setFeedback('');
    try {
      const result = await diagnostic<SingleChatSyncResult & { error?: string }>('syncCurrentChat', { includeAssets });
      if (result.error) throw new Error(result.error);
      const fileHint = assetSummaryText(result.assets);
      if (result.changeKind === 'metadata-only') {
        const count = result.newMessageCount === undefined ? '' : `${result.newMessageCount} new messages; `;
        setFeedback(`Current chat metadata refreshed; ${count}message rows unchanged (${result.messageCount} total).${fileHint}`);
        return;
      }
      const label = result.status === 'unchanged' ? 'unchanged' : result.status;
      const count = result.newMessageCount === undefined ? '' : `; ${result.newMessageCount} new messages`;
      setFeedback(`Current chat ${label}${count} (${result.messageCount} total messages).${fileHint}`);
    } catch (error) {
      setFeedback(`Chat sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAction(undefined);
    }
  }

  function syncAllChats() {
    setAction('sync-all');
    setFeedback('');
    setSyncProgress(undefined);
    setStopRequested(false);
    let settled = false;
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: 'local-sync-progress' });
    } catch (error) {
      setAction(undefined);
      setFeedback(`All-chat sync failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    syncPort.current = port;
    port.onMessage.addListener((raw: unknown) => {
      if (!isRecord(raw) || typeof raw.type !== 'string') {
        settled = true;
        setAction(undefined);
        setFeedback('The background returned an invalid sync response.');
        port.disconnect();
        return;
      }
      if (raw.type === 'progress' && isProgress(raw.progress)) {
        setSyncProgress(raw.progress);
        return;
      }
      if (raw.type === 'complete' && isRunResult(raw.result)) {
        settled = true;
        setAction(undefined);
        setStopRequested(false);
        const { counts } = raw.result;
        setSyncProgress({
          phase: raw.result.failurePhase === 'projects' ? 'projects' :
            raw.result.failurePhase === 'listing' ? 'listing' : 'syncing',
          listed: counts.listed,
          total: counts.listed,
          selected: counts.selected,
          processed: counts.new + counts.updated + counts.unchanged + counts.failed,
          new: counts.new,
          newMessages: counts.newMessages,
          updated: counts.updated,
          unchanged: counts.unchanged,
          failed: counts.failed,
          projects: raw.result.projects,
        });
        const outcome = raw.result.status === 'completed' ? 'completed' :
          raw.result.status === 'cancelled' ? 'stopped' : 'finished with failures';
        const selectedSummary = counts.selected === counts.listed
          ? `${counts.selected} ${counts.selected === 1 ? 'chat' : 'chats'} selected`
          : `${counts.selected} of ${counts.listed} chats selected`;
        const newChatSummary = `${counts.new} new ${counts.new === 1 ? 'chat' : 'chats'}`;
        const newMessageSummary = `${counts.newMessages} new ${counts.newMessages === 1 ? 'message' : 'messages'}`;
        const retryHint = counts.failed > 0 && !raw.result.error
          ? ' Failed conversations will be retried on the next run.'
          : '';
        const errorHint = raw.result.error ? ` ${raw.result.error}` : '';
        const projectHint = raw.result.projects?.status === 'completed'
          ? ` Project information: ${raw.result.projects.count} saved.`
          : raw.result.projects ? ` Project information: ${raw.result.projects.status} (${raw.result.projects.category}).` : '';
        const logHint = raw.result.status === 'failed'
          ? ' See sanitized SYNC_RUN_FAILURE details in %LOCALAPPDATA%\\ChatGPTBackup\\logs\\host.log.'
          : '';
        const fileHint = assetSummaryText(raw.result.assets);
        setFeedback(`All-chat sync ${outcome}: ${selectedSummary}; ${newChatSummary}, ${newMessageSummary}, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.failed} failed.${projectHint}${fileHint}${retryHint}${errorHint}${logHint}`);
        port.disconnect();
        return;
      }
      if (raw.type === 'error' && typeof raw.message === 'string') {
        settled = true;
        setAction(undefined);
        setStopRequested(false);
        setFeedback(`All-chat sync failed: ${raw.message}`);
        port.disconnect();
        return;
      }
      settled = true;
      setAction(undefined);
      setFeedback('The background returned an invalid sync response.');
      port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      if (syncPort.current === port) syncPort.current = undefined;
      if (!settled) {
        setAction(undefined);
        setStopRequested(false);
        setFeedback('Sync was interrupted. Conversations already saved remain available.');
      }
    });
    try {
      port.postMessage({ type: 'start', scope: syncScope, includeAssets });
    } catch (error) {
      settled = true;
      setAction(undefined);
      setFeedback(`All-chat sync failed: ${error instanceof Error ? error.message : String(error)}`);
      port.disconnect();
    }
  }

  function stopAllChats() {
    setStopRequested(true);
    setFeedback('Stopping after the current request...');
    try {
      syncPort.current?.postMessage({ type: 'cancel' });
    } catch (error) {
      setFeedback(`Could not send the stop request: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function probeChatGptApi() {
    setAction('probe');
    setFeedback('');
    try {
      const result = await diagnostic<{ probeId: string; logged: boolean; warningCount: number } & { error?: string }>('syncApiProbe');
      if (result.error) throw new Error(result.error);
      if (!result.logged) throw new Error('The local host did not confirm that the API probe was logged.');
      const outcome = result.warningCount
        ? 'Some checks were incomplete or inconclusive.'
        : 'All checks completed.';
      setFeedback(`API probe ${result.probeId.slice(0, 8)} logged. ${outcome} Review API_PROBE in %LOCALAPPDATA%\\ChatGPTBackup\\logs\\host.log.`);
    } catch (error) {
      setFeedback(`API probe failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAction(undefined);
    }
  }

  async function openViewer() {
    setAction('viewer');
    setFeedback('');
    try {
      const result = await diagnostic<{ opened: boolean } & { error?: string }>('openArchiveViewer');
      if (result.error) throw new Error(result.error);
      if (!result.opened) throw new Error('The browser did not confirm that the viewer tab opened.');
      setFeedback('Local archive viewer opened in a new tab. Closing its last tab stops the local viewer.');
    } catch (error) {
      setFeedback(`Viewer launch failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAction(undefined);
    }
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(status?.host?.dbPath ?? '');
      setFeedback('DB path copied.');
    } catch (error) {
      setFeedback(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor="local-sync-scope" className="block text-xs font-bold text-[#215145]">Chats to sync</label>
        <select
          id="local-sync-scope"
          value={syncScope}
          disabled={busy}
          onChange={event => {
            const value = event.currentTarget.value;
            if (value === 'latest-10' || value === 'all') setSyncScope(value);
          }}
          className="h-9 w-full rounded-md border border-[#C6F0E5] bg-white px-2 text-sm text-[#215145] disabled:opacity-60"
        >
          <option value="latest-10">Latest 10 chats (validation)</option>
          <option value="all">All chats</option>
        </select>
        <p className="text-xs text-[#4B5563]">
          Validation mode requests only the first 10 list entries, without paging. ChatGPT ordering is unverified; these may not be the account-wide latest 10. Project information still syncs.
        </p>
        <label className="flex items-start gap-2 pt-1 text-xs text-[#215145]">
          <input
            type="checkbox"
            checked={includeAssets}
            disabled={busy}
            onChange={event => changeIncludeAssets(event.currentTarget.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-bold">Include images &amp; files</span>
            <span className="block text-[#4B5563]">Downloads saved chats' images and files, up to 5 MB each and 10 MB / 50 files per run. Earlier chats are backfilled over several runs.</span>
          </span>
        </label>
      </div>
      <div className="flex gap-3">
        <Button type="button" size="lg" disabled={(busy && action !== 'sync-all') || stopRequested} onClick={action === 'sync-all' ? stopAllChats : syncAllChats} className="h-11 flex-1 bg-[#10A37F] text-white hover:bg-[#0D8A6C]">
          {action === 'sync-all' ? stopRequested ? 'Stopping...' : 'Stop sync' :
            syncScope === 'latest-10' ? 'Sync latest 10 chats' : 'Sync all chats'}
        </Button>
        <Button type="button" size="lg" variant="outline" aria-expanded={expanded} aria-controls="local-sync-details" onClick={() => setExpanded(true)} className="h-11 px-6">
          Open
        </Button>
      </div>
      <Button type="button" size="lg" variant="outline" disabled={busy} onClick={openViewer} className="h-10 w-full">
        {action === 'viewer' ? 'Opening viewer...' : 'Open local viewer'}
      </Button>
      <p className="min-h-4 break-all text-xs text-[#4B5563]" role="status" aria-live="polite">{feedback}</p>
      {syncProgress && <div className="rounded-md border border-[#C6F0E5] bg-[#E7F2E8]/45 p-2 text-xs text-[#215145]" role="status" aria-live="polite">
        <p className="font-bold">{syncProgress.phase === 'projects' ? 'Syncing project information' :
          syncProgress.phase === 'listing' ? 'Reading conversation list' :
          syncProgress.phase === 'assets' ? 'Downloading images and files' : 'Syncing conversations'}{syncProgress.phase !== 'projects' && syncProgress.phase !== 'assets' &&
          (syncProgress.total === null ? ` (${syncProgress.listed} read)` : ` (${syncProgress.listed}/${syncProgress.total})`)}{syncProgress.phase === 'assets' && syncProgress.assets &&
          ` (${syncProgress.assets.processed}/${syncProgress.assets.total} · ${formatBytes(syncProgress.assets.bytes)})`}</p>
        <p>{syncProgress.selected === null ? 'Chat selection pending' : `${syncProgress.selected} selected`}; processed {syncProgress.processed}; new chats {syncProgress.new}; new messages {syncProgress.newMessages}; updated {syncProgress.updated}; unchanged {syncProgress.unchanged}; failed {syncProgress.failed}.</p>
      </div>}
      <details id="local-sync-details" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)} className="rounded-lg border border-[#C6F0E5] bg-white p-3 text-xs text-[#215145]">
        <summary className="cursor-pointer font-bold">Local sync: {action === 'connection' ? 'Checking...' : action === 'sync-current' ? 'Syncing chat...' : action === 'sync-all' ? 'Syncing all chats...' : action === 'viewer' ? 'Opening viewer...' : status ? labels[status.state] : 'Not tested'}</summary>
        <div className="mt-3 space-y-2">
          <p>Sync the currently open saved ChatGPT conversation to the local database.</p>
          <Button size="sm" disabled={busy} onClick={syncCurrentChat}>{action === 'sync-current' ? 'Syncing chat...' : 'Sync this chat'}</Button>
        <div role="status" aria-live="polite" aria-atomic="true">
          {action === 'connection' ? <p>Checking the local app and opening its database...</p> :
            check.count > 0 && <div className={status?.state === 'connected' ?
              'rounded-md border border-[#9FE3D5] bg-[#E7F2E8] p-2' :
              'rounded-md border border-red-200 bg-red-50 p-2 text-red-700'}>
              <p className="font-bold">Connection test #{check.count} {status?.state === 'connected' ? 'passed' : 'failed'}.</p>
              {status?.state === 'connected' && <p>The local app replied and its database is ready. No chats were synced.</p>}
              <p>Last checked: {check.completedAt}</p>
            </div>}
        </div>
        {status?.host && <>
          <p>Host {status.host.hostVersion} / Protocol {status.host.protocolRange.join('-')} / Schema {status.host.schemaVersion}</p>
          <p>Round trip: {status.rttMs} ms</p>
          <p className="break-all">Database: {status.host.dbPath}</p>
          <Button size="sm" variant="outline" onClick={copyPath}>Copy DB path</Button>
        </>}
        {status?.error && <div className="space-y-1 text-red-700">
          <p className="break-words">{status.error}</p>
          {status.state === 'not-registered' || status.state === 'forbidden' ?
            <p>From the repo, run: <code className="break-all">powershell -ExecutionPolicy Bypass -File .\local-app\scripts\register-host.ps1</code>. Reload the extension.</p> :
            <p>Check %LOCALAPPDATA%\ChatGPTBackup\logs\host.log. For incompatible versions, rebuild the extension and re-register the host.</p>}
        </div>}
        <Button size="sm" disabled={busy} onClick={testConnection}>{action === 'connection' ? 'Testing...' : 'Test connection'}</Button>
        <details>
          <summary className="cursor-pointer">Developer diagnostics</summary>
          <Button className="mt-2" size="sm" variant="outline" disabled={busy} onClick={echo}>{action === 'echo' ? 'Verifying 10 MB...' : 'Echo 10 MB'}</Button>
          <Button className="mt-2" size="sm" variant="outline" disabled={busy} onClick={probeChatGptApi}>{action === 'probe' ? 'Probing ChatGPT API...' : 'Probe ChatGPT API'}</Button>
        </details>
      </div>
    </details>
    </div>
  );
}
