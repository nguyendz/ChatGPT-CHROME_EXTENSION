import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import type { ApiDebugChunk } from '../../lib/sync/protocol.ts';

export function configureLogging(dataDir: string) {
  const directory = join(dataDir, 'logs');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'host.log');
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...values: unknown[]) => {
      appendFileSync(path, `${new Date().toISOString()} ${level} ${format(...values)}\n`);
    };
  }
  return (chunk: ApiDebugChunk) => {
    appendFileSync(join(directory, 'api-debug.jsonl'),
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...chunk })}\n`);
  };
}
