import type { Writable } from 'node:stream';
import { MAX_EXT_TO_HOST_BYTES, MAX_HOST_TO_EXT_BYTES } from '../../lib/sync/protocol.ts';

export async function* readFrames(input: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let header = Buffer.alloc(4);
  let headerUsed = 0;
  let body: Buffer | undefined;
  let bodyUsed = 0;
  for await (const chunk of input) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!body) {
        const count = Math.min(4 - headerUsed, chunk.length - offset);
        chunk.copy(header, headerUsed, offset, offset + count);
        headerUsed += count;
        offset += count;
        if (headerUsed < 4) continue;
        const size = header.readUInt32LE();
        if (!size || size > MAX_EXT_TO_HOST_BYTES) throw new Error(`Invalid frame size: ${size}`);
        body = Buffer.alloc(size);
      }
      const count = Math.min(body.length - bodyUsed, chunk.length - offset);
      chunk.copy(body, bodyUsed, offset, offset + count);
      offset += count;
      bodyUsed += count;
      if (bodyUsed === body.length) {
        yield body;
        body = undefined;
        bodyUsed = 0;
        headerUsed = 0;
      }
    }
  }
  if (headerUsed || body) throw new Error('Truncated native message');
}

export function writeFrame(output: Writable, message: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_HOST_TO_EXT_BYTES) throw new Error('Host reply exceeds 1 MB');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return new Promise((resolve, reject) => {
    output.write(Buffer.concat([header, body]), error => error ? reject(error) : resolve());
  });
}
