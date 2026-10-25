import { AssetDownloadError, fetchAssetFile } from '../chatgpt-client.ts';
import type { AssetFetchOptions, FetchedAsset } from '../chatgpt-client.ts';
import { normalizeMime } from '../asset-refs.ts';
import { ApiDebugLogError } from './api-debug.ts';
import type { ApiDebugLogger } from './api-debug.ts';
import { HostConnectionError } from './host-client.ts';
import type { HostClient } from './host-client.ts';
import {
  ASSET_CHUNK_BYTES, MAX_ASSET_BYTES, MAX_ASSET_HINT_CONVERSATIONS, MAX_RUN_ASSET_BYTES, MAX_RUN_ASSETS,
} from './protocol.ts';
import type { AssetRunSummary, PendingAsset } from './protocol.ts';

type HostRequester = Pick<HostClient, 'request'>;

export type AssetProgress = { total: number; processed: number; bytes: number };

export type AssetSyncOptions = {
  client: HostRequester;
  runId: string;
  token: string;
  conversationIds: string[];
  includeOthers: boolean;
  logApi: ApiDebugLogger;
  signal?: AbortSignal;
  onProgress?: (progress: AssetProgress) => void;
  fetchAsset?: (token: string, fileId: string, conversationId: string, options: AssetFetchOptions) => Promise<FetchedAsset>;
  limits?: { assetBytes?: number; runBytes?: number; assets?: number };
};

export function emptyAssetSummary(): AssetRunSummary {
  return { stored: 0, deduplicated: 0, skippedTooLarge: 0, unavailable: 0, failed: 0, deferred: 0, bytes: 0 };
}

export function toBase64(bytes: Uint8Array): string {
  // 3-byte-aligned blocks keep each btoa call free of padding until the final block.
  const block = 24_576;
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += block) {
    result += btoa(String.fromCharCode(...bytes.subarray(offset, offset + block)));
  }
  return result;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function isAbort(error: unknown, signal?: AbortSignal) {
  return Boolean(signal?.aborted) || error instanceof Error && error.name === 'AbortError';
}

function outcomeMessage(error: unknown) {
  return (error instanceof Error ? error.message : 'Download failed.').slice(0, 200);
}

/**
 * Downloads the pending files the host asks for, within per-file, per-run-size and per-run-count limits.
 * File problems are recorded per file and never throw: they must not fail the chat sync that called this.
 */
export async function syncAssets(options: AssetSyncOptions): Promise<AssetRunSummary> {
  const { client, runId, token, signal, logApi } = options;
  const maxAsset = options.limits?.assetBytes ?? MAX_ASSET_BYTES;
  const maxRun = options.limits?.runBytes ?? MAX_RUN_ASSET_BYTES;
  const maxCount = options.limits?.assets ?? MAX_RUN_ASSETS;
  const fetchAsset = options.fetchAsset ?? fetchAssetFile;
  const summary = emptyAssetSummary();
  let items: PendingAsset[];
  try {
    if (signal?.aborted) return { ...summary, stopped: 'cancelled' };
    items = (await client.request('listPendingAssets', {
      runId, conversationIds: options.conversationIds.slice(0, MAX_ASSET_HINT_CONVERSATIONS),
      includeOthers: options.includeOthers, limit: maxCount,
    })).items;
  } catch {
    return { ...summary, stopped: 'local-host' };
  }

  const done = new Set<string>();
  let processed = 0;
  const report = () => options.onProgress?.({ total: items.length, processed, bytes: summary.bytes });
  report();

  async function record(item: PendingAsset, state: 'too-large' | 'unavailable' | 'failed', error: string) {
    await client.request('assetOutcome', {
      runId, conversationId: item.conversationId, fileId: item.fileId, state, error,
    });
  }

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const remaining = maxRun - summary.bytes;
    const rest = items.length - index;
    if (signal?.aborted) { summary.stopped = 'cancelled'; summary.deferred += rest; break; }
    if (done.has(item.fileId)) { processed++; report(); continue; }
    try {
      if (item.declaredSize !== null && item.declaredSize > maxAsset) {
        await record(item, 'too-large', 'Larger than the 5 MB file limit.');
        summary.skippedTooLarge++;
      } else if (item.declaredSize !== null ? item.declaredSize > remaining : remaining < maxAsset) {
        summary.deferred++;
      } else {
        const limit = Math.min(maxAsset, remaining);
        const fetchOptions = {
          maxBytes: limit, fileKind: item.kind, downloadIntent: item.kind === 'attachment',
          ...(signal ? { signal } : {}), logApi,
        };
        let file: FetchedAsset;
        try {
          file = await fetchAsset(token, item.fileId, item.conversationId, fetchOptions);
        } catch (error) {
          if (!(error instanceof AssetDownloadError) || error.failure !== 'unavailable' || !item.libraryFileId) throw error;
          file = await fetchAsset(token, item.libraryFileId, item.conversationId, fetchOptions);
        }
        const digest = await sha256(file.bytes);
        const uploadId = crypto.randomUUID();
        for (let offset = 0, seq = 0; offset < file.bytes.length; offset += ASSET_CHUNK_BYTES, seq++) {
          await client.request('assetChunk', {
            runId, uploadId, conversationId: item.conversationId, fileId: item.fileId, seq,
            data: toBase64(file.bytes.subarray(offset, offset + ASSET_CHUNK_BYTES)),
          });
        }
        const committed = await client.request('assetCommit', {
          runId, uploadId, conversationId: item.conversationId, fileId: item.fileId, sha256: digest,
          size: file.bytes.length, mime: normalizeMime(file.mime) ?? item.declaredMime ?? 'application/octet-stream',
        });
        if (committed.status === 'deduplicated') summary.deduplicated++;
        else summary.stored++;
        summary.bytes += file.bytes.length;
        done.add(item.fileId);
      }
    } catch (error) {
      if (isAbort(error, signal)) { summary.stopped = 'cancelled'; summary.deferred += rest; break; }
      if (error instanceof HostConnectionError || error instanceof ApiDebugLogError) {
        summary.stopped = 'local-host'; summary.deferred += rest; break;
      }
      const failure = error instanceof AssetDownloadError ? error.failure : 'failed';
      try {
        if (failure === 'unauthorized') {
          summary.stopped = 'unauthorized'; summary.deferred += rest; break;
        }
        if (failure === 'too-large') {
          if (maxRun - summary.bytes < maxAsset) summary.deferred++;
          else { await record(item, 'too-large', 'Larger than the 5 MB file limit.'); summary.skippedTooLarge++; }
        } else if (failure === 'unavailable') {
          await record(item, 'unavailable', outcomeMessage(error)); summary.unavailable++;
        } else {
          await record(item, 'failed', outcomeMessage(error)); summary.failed++;
          if (failure === 'rate-limited') { summary.stopped = 'rate-limited'; summary.deferred += rest - 1; break; }
        }
      } catch {
        summary.stopped = 'local-host'; summary.deferred += rest; break;
      }
    }
    processed++;
    report();
  }
  return summary;
}
