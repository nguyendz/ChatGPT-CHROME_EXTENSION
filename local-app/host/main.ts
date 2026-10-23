import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureLogging } from './log.ts';
import { readFrames, writeFrame } from './framing.ts';
import { errorResponse, handleRequest } from './handlers.ts';
import { isRecord } from '../../lib/sync/protocol.ts';
import { startViewer } from '../viewer/server.ts';
import { createViewerLauncher } from './viewer-launch.ts';
import type { HostDatabase } from './db.ts';

async function main() {
  const base = process.env.CHATGPT_SYNC_DATA_DIR ??
    (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ChatGPTBackup') : undefined);
  if (!base) throw new Error('LOCALAPPDATA or CHATGPT_SYNC_DATA_DIR must be set');
  const writeApiDebug = configureLogging(base);
  const expected = process.env.CHATGPT_SYNC_ALLOWED_ORIGIN ??
    readFileSync(new URL('./allowed-origin.txt', import.meta.url), 'utf8').trim();
  if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(expected) || process.argv[2] !== expected) {
    console.error('Rejected caller origin');
    await writeFrame(process.stdout, errorResponse('', 'FORBIDDEN_ORIGIN', 'Caller origin is not allowed'));
    process.exitCode = 1;
    return;
  }
  let database: HostDatabase | undefined;
  const viewerLauncher = createViewerLauncher(() => startViewer({ directory: base }));
  const { openDatabase } = await import('./db.ts');
  console.info('Host started', process.pid);
  try {
    for await (const body of readFrames(process.stdin)) {
      let request: unknown;
      try {
        request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      } catch {
        console.warn('Rejected invalid JSON or UTF-8');
        await writeFrame(process.stdout, errorResponse('', 'INVALID_PAYLOAD', 'Invalid JSON or UTF-8'));
        continue;
      }
      const response = isRecord(request) && request.type === 'launchViewer'
        ? await viewerLauncher.handle(request)
        : handleRequest(request, () => {
          database ??= openDatabase(base);
          return database;
        }, writeApiDebug);
      await writeFrame(process.stdout, response);
    }
  } finally {
    try {
      await viewerLauncher.close();
    } catch {
      console.error('Could not close the local viewer cleanly.');
      process.exitCode = 1;
    }
    database?.close();
    console.info('Host stopped', process.pid);
  }
}

main().catch(error => {
  console.error('Native host failed:', error);
  process.exitCode = 1;
});
