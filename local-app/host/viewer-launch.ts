import { PROTOCOL_VERSION, isRecord, isViewerLaunchUrl } from '../../lib/sync/protocol.ts';
import type { HostResponse } from '../../lib/sync/protocol.ts';
import { ViewerError } from '../viewer/archive.ts';
import { errorResponse } from './handlers.ts';

type ViewerSession = { url: string; close: () => Promise<void> };
type StartViewer = () => Promise<ViewerSession>;

export function createViewerLauncher(startViewer: StartViewer) {
  let viewer: ViewerSession | undefined;

  return {
    async handle(value: unknown): Promise<HostResponse> {
      const id = isRecord(value) && typeof value.id === 'string' ? value.id.slice(0, 128) : '';
      if (!isRecord(value) || !id || value.id !== id || value.type !== 'launchViewer' ||
        !isRecord(value.payload)) {
        return errorResponse(id, 'INVALID_PAYLOAD', 'Expected a launchViewer request with an ID and object payload.');
      }
      if (value.v !== PROTOCOL_VERSION) {
        return errorResponse(id, 'PROTOCOL_MISMATCH', 'This host requires protocol 1.');
      }
      if (Object.keys(value.payload).length !== 0) {
        return errorResponse(id, 'INVALID_PAYLOAD', 'launchViewer does not accept a payload.');
      }

      try {
        if (!viewer) {
          const started = await startViewer();
          if (!isViewerLaunchUrl(started.url)) {
            await started.close();
            throw new Error('Viewer returned an invalid launch URL.');
          }
          viewer = started;
        }
        return { v: 1, id, type: 'launchViewer.ok', payload: { url: viewer.url } };
      } catch (error) {
        const message = error instanceof ViewerError
          ? error.message
          : 'Viewer could not start. Build it with corepack pnpm viewer:build and check the local archive.';
        return errorResponse(id, 'VIEWER_ERROR', message);
      }
    },
    async close(): Promise<void> {
      const activeViewer = viewer;
      viewer = undefined;
      await activeViewer?.close();
    },
  };
}
