import { ChatGptApiError } from '../chatgpt-client.ts';
import {
  MAX_PROJECT_PAGES, ProjectCatalogError, checkProjectCatalogSize, projectItemJson,
  projectMetadata, projectSidebarPage,
} from '../project-catalog.ts';
import type { ProjectItem, ProjectSidebarPage } from '../project-catalog.ts';
import type { ApiDebugLogger } from './api-debug.ts';
import type { AccountScope, ProjectFailureCategory } from './protocol.ts';

export function projectFailure(error: unknown): { category: ProjectFailureCategory; message: string } {
  if (error instanceof ProjectCatalogError) return { category: error.category, message: error.message };
  if (error instanceof ChatGptApiError) {
    const status = error.status;
    const category = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' :
      status === 429 ? 'rate-limited' : status !== undefined && status >= 500 ? 'server-error' : 'invalid-response';
    return { category, message: `Project information sync failed${status ? ` (HTTP ${status})` : ''}. Previous metadata was retained.` };
  }
  if (error instanceof SyntaxError) return { category: 'invalid-response', message: 'Project sidebar returned invalid JSON. Previous metadata was retained.' };
  return { category: 'network-error', message: 'Could not sync project information. Check the connection and API debug log; previous metadata was retained.' };
}

function checkAbort(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

export async function collectProjectCatalog(
  runId: string, account: AccountScope,
  fetchPage: (cursor: string | null, signal?: AbortSignal) => Promise<ProjectSidebarPage>,
  log: ApiDebugLogger, signal?: AbortSignal,
): Promise<ProjectItem[]> {
  for (let scan = 1; scan <= 2; scan++) {
    const items: ProjectItem[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < MAX_PROJECT_PAGES; pageIndex++) {
      checkAbort(signal);
      const page = projectSidebarPage(await fetchPage(cursor, signal));
      await log({ kind: 'project-pagination', scan, page: pageIndex, returned: page.items.length, reason: 'page' });
      let unstable = false;
      for (const raw of page.items) {
        const metadata = projectMetadata(raw);
        if (metadata.workspaceId !== null && metadata.workspaceId !== account.workspaceId) {
          throw new ProjectCatalogError('account-mismatch', 'Project sidebar belongs to a different workspace. No project metadata was stored.');
        }
        if (ids.has(metadata.id)) { unstable = true; break; }
        ids.add(metadata.id);
        const json = projectItemJson(raw);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
        items.push({ raw, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') });
      }
      checkProjectCatalogSize(runId, items);
      if (page.cursor !== null && cursors.has(page.cursor)) unstable = true;
      if (unstable) {
        await log({ kind: 'project-pagination', scan, page: pageIndex, reason: 'unstable' });
        break;
      }
      if (page.cursor === null) {
        checkAbort(signal);
        await log({ kind: 'project-pagination', scan, page: pageIndex, reason: 'complete', returned: items.length });
        return items;
      }
      cursors.add(page.cursor);
      cursor = page.cursor;
      if (pageIndex === MAX_PROJECT_PAGES - 1) {
        throw new ProjectCatalogError('size-limit', 'Project metadata scan exceeded the 100-page limit. Previous metadata was retained.');
      }
    }
  }
  throw new ProjectCatalogError('unstable-pagination', 'Project metadata remained unstable after two scans. Previous metadata was retained.');
}
