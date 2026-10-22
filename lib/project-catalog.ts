import { isRecord } from './sync/protocol.ts';
import type { ProjectFailureCategory } from './sync/protocol.ts';

export const MAX_PROJECT_BYTES = 1024 * 1024;
export const MAX_PROJECT_CATALOG_BYTES = 16 * 1024 * 1024;
export const MAX_PROJECT_PAGES = 100;

export class ProjectCatalogError extends Error {
  readonly category: ProjectFailureCategory;

  constructor(category: ProjectFailureCategory, message: string) {
    super(message);
    this.category = category;
  }
}

export type ProjectItem = {
  raw: Record<string, unknown>;
  sha256: string;
};

export type ProjectMetadata = {
  id: string; name: string; description: string | null; gizmoType: 'snorlax';
  createdAt: string | null; updatedAt: string | null; lastInteractedAt: string | null;
  archived: boolean | null; workspaceId: string | null;
};

export type ProjectSidebarPage = { items: Record<string, unknown>[]; cursor: string | null };

function invalid(): never {
  throw new ProjectCatalogError('invalid-response', 'ChatGPT returned invalid project sidebar metadata.');
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return invalid();
  return value;
}

function timestamp(value: unknown): string | null {
  const text = optionalText(value);
  if (text !== null && !Number.isFinite(Date.parse(text))) return invalid();
  return text;
}

export function projectMetadata(raw: unknown): ProjectMetadata {
  if (!isRecord(raw) || !isRecord(raw.gizmo) || !isRecord(raw.gizmo.gizmo) ||
    !isRecord(raw.conversations) || !Array.isArray(raw.conversations.items) ||
    !(raw.conversations.cursor === null || typeof raw.conversations.cursor === 'string')) return invalid();
  const gizmo = raw.gizmo.gizmo;
  if (typeof gizmo.id !== 'string' || !/^g-p-[a-zA-Z0-9-]{1,124}$/.test(gizmo.id) ||
    gizmo.gizmo_type !== 'snorlax' || !isRecord(gizmo.display) ||
    typeof gizmo.display.name !== 'string' || !gizmo.display.name.trim() ||
    gizmo.display.name.length > 4096 ||
    !(gizmo.is_archived === undefined || gizmo.is_archived === null || typeof gizmo.is_archived === 'boolean')) {
    return invalid();
  }
  for (const conversation of raw.conversations.items) {
    if (!isRecord(conversation) || typeof conversation.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(conversation.id) ||
      conversation.gizmo_id !== gizmo.id) return invalid();
  }
  return {
    id: gizmo.id, name: gizmo.display.name, description: optionalText(gizmo.display.description),
    gizmoType: 'snorlax', createdAt: timestamp(gizmo.created_at), updatedAt: timestamp(gizmo.updated_at),
    lastInteractedAt: timestamp(gizmo.last_interacted_at),
    archived: gizmo.is_archived ?? null, workspaceId: optionalText(gizmo.workspace_id),
  };
}

export function projectSidebarPage(value: unknown): ProjectSidebarPage {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 20 ||
    !(value.cursor === null || typeof value.cursor === 'string' && value.cursor.length > 0 && value.cursor.length <= 8192)) {
    return invalid();
  }
  const items: Record<string, unknown>[] = [];
  for (const raw of value.items) {
    projectMetadata(raw);
    if (!isRecord(raw)) return invalid();
    items.push(raw);
  }
  return { items, cursor: value.cursor };
}

export function projectItemJson(raw: Record<string, unknown>): string {
  const json = JSON.stringify(raw);
  if (new TextEncoder().encode(json).byteLength > MAX_PROJECT_BYTES) {
    throw new ProjectCatalogError('size-limit', 'A project exceeds the 1 MiB metadata limit.');
  }
  return json;
}

export function checkProjectCatalogSize(runId: string, items: ProjectItem[]): void {
  const request = { v: 1, id: 'x'.repeat(128), type: 'commitProjectCatalog', payload: { runId, items } };
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_PROJECT_CATALOG_BYTES) {
    throw new ProjectCatalogError('size-limit', 'Project catalog exceeds the 16 MiB request limit.');
  }
}
