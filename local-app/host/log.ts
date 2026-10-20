import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

export function configureLogging(dataDir: string) {
  const directory = join(dataDir, 'logs');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'host.log');
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...values: unknown[]) => {
      appendFileSync(path, `${new Date().toISOString()} ${level} ${format(...values)}\n`);
    };
  }
}
