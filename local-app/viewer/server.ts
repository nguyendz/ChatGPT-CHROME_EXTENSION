import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive, dataDirectory, pageLimit, ViewerError } from './archive.ts';
import { INLINE_IMAGE_TYPES, safeFileName } from './markdown.ts';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const defaultUi = fileURLToPath(new URL('../../.output/viewer/', import.meta.url));
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export async function startViewer(options: { directory?: string; uiDirectory?: string } = {}) {
  const uiDirectory = options.uiDirectory ?? defaultUi;
  try { await readFile(resolve(uiDirectory, 'index.html')); } catch {
    throw new Error('Viewer UI build is missing or unreadable. Run: corepack pnpm viewer:build');
  }
  const archive = new Archive(options.directory ?? dataDirectory());
  const token = randomBytes(32).toString('hex');
  let origin = '';
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', csp);
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status: number, value: unknown, limit = MAX_RESPONSE_BYTES) => {
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > limit) {
        throw new ViewerError(413, 'TOO_LARGE', limit === MAX_RESPONSE_BYTES
          ? 'This response exceeds the 8 MiB viewer limit. Request a smaller page; message text was not truncated.'
          : 'This export exceeds the 64 MiB viewer limit. Nothing was exported.');
      }
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(body);
    };
    try {
      if (request.headers.host !== new URL(origin).host ||
        request.headers.origin !== undefined && request.headers.origin !== origin ||
        request.headers['sec-fetch-site'] === 'cross-site') {
        throw new ViewerError(403, 'FORBIDDEN_ORIGIN', 'Only same-origin loopback requests are allowed.');
      }
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        throw new ViewerError(405, 'METHOD_NOT_ALLOWED', 'The viewer only supports read-only GET requests.');
      }
      const url = new URL(request.url ?? '/', origin);
      if (url.origin !== origin) throw new ViewerError(403, 'FORBIDDEN_ORIGIN', 'Invalid request origin.');
      if (url.pathname.startsWith('/api/')) {
        const supplied = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          throw new ViewerError(401, 'UNAUTHORIZED', 'Reopen the launch URL printed by the viewer to authorize this tab.');
        }
        for (const name of new Set(url.searchParams.keys())) {
          if (url.searchParams.getAll(name).length !== 1) throw new ViewerError(400, 'INVALID_INPUT', 'Duplicate query parameters are not allowed.');
        }
        if (url.pathname === '/api/status') return json(200, archive.status());
        if (url.pathname === '/api/accounts') return json(200, archive.accounts());
        const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
        if (assetMatch) {
          let fileId: string;
          try { fileId = decodeURIComponent(assetMatch[1]); } catch {
            throw new ViewerError(400, 'INVALID_INPUT', 'Invalid file ID encoding.');
          }
          const account = url.searchParams.get('accountId');
          const conversation = url.searchParams.get('conversationId');
          if (!/^file[-_][A-Za-z0-9]{1,120}$/.test(fileId) || !conversation || !/^[a-zA-Z0-9-]{1,128}$/.test(conversation) ||
            !account || account.length > 2048) {
            throw new ViewerError(400, 'INVALID_INPUT', 'A valid file, accountId and conversationId are required.');
          }
          const file = archive.assetFile(account, conversation, fileId);
          if (file.size > MAX_ASSET_BYTES) throw new ViewerError(413, 'TOO_LARGE', 'This saved file exceeds the viewer limit.');
          const body = await readFile(file.path);
          const inline = file.mime !== null && INLINE_IMAGE_TYPES.has(file.mime);
          const label = safeFileName(file.name, fileId).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
          response.writeHead(200, {
            'Content-Type': inline ? file.mime! : 'application/octet-stream',
            'Content-Length': body.length,
            'Content-Disposition': inline ? 'inline' : `attachment; filename="${label}"; filename*=UTF-8''${encodeURIComponent(safeFileName(file.name, fileId))}`,
          });
          return response.end(body);
        }
        if (url.pathname !== '/api/groups' && url.pathname !== '/api/conversations' && !url.pathname.startsWith('/api/conversations/')) {
          throw new ViewerError(404, 'NOT_FOUND', 'API route not found.');
        }
        const account = url.searchParams.get('accountId');
        if (!account || account.length > 2048) throw new ViewerError(400, 'INVALID_INPUT', 'An accountId is required.');
        if (url.pathname === '/api/groups') return json(200, archive.groups(account));
        if (url.pathname === '/api/conversations') {
          const group = url.searchParams.get('group') ?? 'all';
          if (!group || group.length > 2048) throw new ViewerError(400, 'INVALID_INPUT', 'Invalid conversation folder.');
          return json(200, archive.list(account, pageLimit(url.searchParams.get('limit'), 50, 100), url.searchParams.get('cursor'), group));
        }
        const match = url.pathname.match(/^\/api\/conversations\/([^/]+)(\/messages|\/markdown)?$/);
        if (!match) throw new ViewerError(404, 'NOT_FOUND', 'API route not found.');
        let id: string;
        try { id = decodeURIComponent(match[1]); } catch {
          throw new ViewerError(400, 'INVALID_INPUT', 'Invalid conversation ID encoding.');
        }
        if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new ViewerError(400, 'INVALID_INPUT', 'Invalid conversation ID.');
        if (!match[2]) return json(200, archive.detail(account, id));
        if (match[2] === '/markdown') return json(200, archive.exportMarkdown(account, id), MAX_EXPORT_BYTES);
        const revision = url.searchParams.get('revision');
        if (!revision || !/^[a-f0-9]{64}$/.test(revision)) throw new ViewerError(400, 'INVALID_INPUT', 'A valid conversation revision is required.');
        return json(200, archive.messages(account, id, revision,
          pageLimit(url.searchParams.get('limit'), 100, 200), url.searchParams.get('cursor')));
      }
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); } catch {
        throw new ViewerError(400, 'INVALID_INPUT', 'Invalid asset path.');
      }
      const path = resolve(uiDirectory, pathname === '/' ? 'index.html' : `.${pathname}`);
      const within = relative(resolve(uiDirectory), path);
      if (within.startsWith('..') || isAbsolute(within) || pathname.includes('\\') || pathname.includes('\0')) {
        throw new ViewerError(404, 'NOT_FOUND', 'Asset not found.');
      }
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
      const type = mime[extname(path)];
      if (!type) throw new ViewerError(404, 'NOT_FOUND', 'Asset not found.');
      let body: Buffer;
      try { body = await readFile(path); } catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EISDIR')) {
          throw new ViewerError(404, 'NOT_FOUND', 'Asset not found.');
        }
        throw error;
      }
      response.writeHead(200, { 'Content-Type': type.startsWith('text/') ? `${type}; charset=utf-8` : type });
      response.end(body);
    } catch (error) {
      if (error instanceof ViewerError) {
        json(error.status, { error: { code: error.code, message: error.message } });
      } else {
        const busy = error instanceof Error && /database is (?:locked|busy)/i.test(error.message);
        console.error(busy ? 'Viewer database is busy.' : 'Viewer request failed; archive or local asset could not be read.');
        json(busy ? 503 : 500, { error: {
          code: busy ? 'BUSY' : 'READ_ERROR',
          message: busy ? 'The archive is busy. Retry shortly.' : 'Could not read the local archive or viewer assets. No data was changed.',
        } });
      }
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); accept(); });
    });
  } catch (error) {
    archive.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Viewer did not bind a loopback port.');
  origin = `http://127.0.0.1:${address.port}`;
  let stopping: Promise<void> | undefined;
  return {
    origin, token, url: `${origin}/#token=${token}`,
    close() {
      stopping ??= new Promise<void>((accept, reject) => {
        server.close(error => {
          archive.close();
          if (error) reject(error); else accept();
        });
        server.closeIdleConnections();
      });
      return stopping;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startViewer().then(viewer => {
    console.log(`Local archive (read-only): ${viewer.url}`);
    console.log('Keep this private launch URL local. Press Ctrl+C to stop.');
    const stop = () => { viewer.close().catch(() => { console.error('Could not close viewer cleanly.'); process.exitCode = 1; }); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(error => {
    console.error(error instanceof ViewerError ? error.message : 'Viewer could not start. Check the UI build, archive path, schema, and file permissions.');
    if (error instanceof Error && error.message.startsWith('Viewer UI build')) console.error(error.message);
    process.exitCode = 1;
  });
}
