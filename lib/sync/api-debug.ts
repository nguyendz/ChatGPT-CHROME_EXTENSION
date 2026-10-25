import { API_DEBUG_CHUNK_CHARS } from './protocol.ts';
import type { HostClient } from './host-client.ts';

export type ApiDebugEvent =
  | { kind: 'project-pagination'; scan: number; page: number; reason: 'page' | 'unstable' | 'complete'; returned?: number }
  | { kind: 'response'; url: string; attempt: number; status: number; body: string }
  | { kind: 'network-error'; url: string; attempt: number; error: string }
  | {
    // Signed download URLs and file bytes are never logged: status, size, MIME and host only.
    kind: 'asset'; fileKind: string; stage: 'url' | 'download' | 'rejected'; status?: number;
    bytes?: number; contentType?: string; host?: string; reason?: string;
  }
  | {
    kind: 'pagination'; scan: number; offset: number;
    reason: 'start' | 'page' | 'duplicate-id' | 'complete' | 'validation-limit';
    returned?: number; pageTotal?: number; listed?: number;
  };

export type ApiDebugLogger = (event: ApiDebugEvent) => Promise<void>;

export class ApiDebugLogError extends Error {
  constructor(cause: unknown) {
    super('Could not write the local API debug log. Check the host version, disk space, and logs directory.', { cause });
    this.name = 'ApiDebugLogError';
  }
}

export function createApiDebugLogger(client: Pick<HostClient, 'request'>, runId: string): ApiDebugLogger {
  return async event => {
    const data = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
    const entryId = crypto.randomUUID();
    const parts = Math.ceil(data.length / API_DEBUG_CHUNK_CHARS);
    try {
      for (let part = 0; part < parts; part++) {
        const response = await client.request('recordApiDebug', {
          runId, entryId, part, parts,
          data: data.slice(part * API_DEBUG_CHUNK_CHARS, (part + 1) * API_DEBUG_CHUNK_CHARS),
        });
        if (response.entryId !== entryId || response.part !== part || response.logged !== true) {
          throw new Error('The local host did not acknowledge the API debug-log chunk.');
        }
      }
    } catch (error) {
      throw new ApiDebugLogError(error);
    }
  };
}
