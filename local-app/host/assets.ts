import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;

export function assetBlobPath(directory: string, sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error('Invalid asset hash.');
  return join(directory, 'assets', sha256.slice(0, 2), sha256);
}

/** Content-addressed blob writer: bytes are written to a temp file, then renamed into place. */
export function writeAssetBlob(directory: string, sha256: string, bytes: Buffer): 'stored' | 'deduplicated' {
  const target = assetBlobPath(directory, sha256);
  if (existsSync(target)) {
    if (statSync(target).size === bytes.length) return 'deduplicated';
    rmSync(target, { force: true });
  }
  mkdirSync(join(directory, 'assets', sha256.slice(0, 2)), { recursive: true });
  mkdirSync(join(directory, 'assets', 'tmp'), { recursive: true });
  const temp = join(directory, 'assets', 'tmp', randomUUID());
  try {
    writeFileSync(temp, bytes, { flag: 'wx' });
    try {
      renameSync(temp, target);
    } catch (error) {
      // Windows refuses to rename over an existing file; identical content is already in place.
      if (!existsSync(target) || statSync(target).size !== bytes.length) throw error;
    }
  } finally {
    rmSync(temp, { force: true });
  }
  return 'stored';
}
