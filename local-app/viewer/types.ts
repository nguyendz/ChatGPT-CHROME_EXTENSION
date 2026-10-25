export type Account = { id: string; label: string; conversationCount: number };
export type ConversationGroup = {
  id: string; kind: 'all' | 'project' | 'gpt' | 'unmarked' | 'other';
  label: string; conversationCount: number;
  project?: {
    description: string | null; archived: boolean | null; updatedAt: string | null;
    syncedAt: string; older: boolean; catalogStatus: 'running' | 'completed' | 'failed' | 'cancelled';
    catalogError: string | null;
  };
};
export type ArchiveStatus = {
  schemaVersion: number; accounts: number; conversations: number; messages: number; lastSyncAt: string | null;
};
export type ConversationSummary = {
  id: string; title: string | null; updateTime: number | null;
  lastSyncedAt: string; messageCount: number;
};
export type ConversationDetail = ConversationSummary & {
  revision: string; activeMessageCount: number; otherMessageCount: number; warnings: string[];
};
export type AssetState = 'pending' | 'stored' | 'too-large' | 'unavailable' | 'failed';
export type ViewerAsset = {
  fileId: string; kind: 'attachment' | 'image-upload' | 'image-generated' | 'code-output';
  name: string | null; mime: string | null; size: number | null; state: AssetState;
};
export type ViewerMessage = {
  id: string; role: string; model: string | null; contentType: string | null;
  text: string; createTime: number | null; unsupportedContent: boolean; assets: ViewerAsset[];
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type ExportAsset = { fileId: string; fileName: string; mime: string | null; size: number };
export type MarkdownExport = { id: string; fileName: string; markdown: string; assets: ExportAsset[] };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
function nullableTime(value: unknown): value is number | null {
  return value === null || typeof value === 'number' && Number.isFinite(value);
}
export function isStatus(value: unknown): value is ArchiveStatus {
  return record(value) && count(value.schemaVersion) && count(value.accounts) && count(value.conversations) &&
    count(value.messages) && nullableText(value.lastSyncAt);
}
export function isAccounts(value: unknown): value is Account[] {
  return Array.isArray(value) && value.every(item => record(item) &&
    typeof item.id === 'string' && typeof item.label === 'string' && count(item.conversationCount));
}
export function isGroups(value: unknown): value is ConversationGroup[] {
  return Array.isArray(value) && value.every(item => record(item) &&
    typeof item.id === 'string' && typeof item.label === 'string' && count(item.conversationCount) &&
    typeof item.kind === 'string' && ['all', 'project', 'gpt', 'unmarked', 'other'].includes(item.kind) &&
    (item.project === undefined || record(item.project) &&
      nullableText(item.project.description) && (item.project.archived === null || typeof item.project.archived === 'boolean') &&
      nullableText(item.project.updatedAt) && typeof item.project.syncedAt === 'string' &&
      typeof item.project.older === 'boolean' && nullableText(item.project.catalogError) &&
      typeof item.project.catalogStatus === 'string' &&
      ['running', 'completed', 'failed', 'cancelled'].includes(item.project.catalogStatus)));
}
export function isSummary(value: unknown): value is ConversationSummary {
  return record(value) && typeof value.id === 'string' && nullableText(value.title) &&
    nullableTime(value.updateTime) && typeof value.lastSyncedAt === 'string' && count(value.messageCount);
}
export function isDetail(value: unknown): value is ConversationDetail {
  if (!record(value)) return false;
  const details = value;
  return isSummary(value) && typeof details.revision === 'string' &&
    count(details.activeMessageCount) && count(details.otherMessageCount) &&
    Array.isArray(details.warnings) && details.warnings.every(item => typeof item === 'string');
}
const ASSET_STATES = ['pending', 'stored', 'too-large', 'unavailable', 'failed'];
const ASSET_KINDS = ['attachment', 'image-upload', 'image-generated', 'code-output'];
function isViewerAsset(value: unknown): value is ViewerAsset {
  return record(value) && typeof value.fileId === 'string' && /^file[-_][A-Za-z0-9]+$/.test(value.fileId) &&
    ASSET_KINDS.includes(value.kind as string) && nullableText(value.name) && nullableText(value.mime) &&
    (value.size === null || count(value.size)) && ASSET_STATES.includes(value.state as string);
}
export function isMessage(value: unknown): value is ViewerMessage {
  return record(value) && typeof value.id === 'string' && typeof value.role === 'string' &&
    nullableText(value.model) && nullableText(value.contentType) && typeof value.text === 'string' &&
    nullableTime(value.createTime) && typeof value.unsupportedContent === 'boolean' &&
    Array.isArray(value.assets) && value.assets.every(isViewerAsset);
}
export function isMarkdownExport(value: unknown): value is MarkdownExport {
  return record(value) && typeof value.id === 'string' && typeof value.fileName === 'string' &&
    /^[^<>:"/\\|?*\u0000-\u001f]{1,200}\.md$/.test(value.fileName) && typeof value.markdown === 'string' &&
    Array.isArray(value.assets) && value.assets.every(item => record(item) && typeof item.fileId === 'string' &&
      /^file[-_][A-Za-z0-9]+$/.test(item.fileId) && typeof item.fileName === 'string' &&
      /^file[-_][A-Za-z0-9]+\.[a-z0-9]{1,8}$/.test(item.fileName) && nullableText(item.mime) && count(item.size));
}
export function isPage<T>(value: unknown, item: (value: unknown) => value is T): value is Page<T> {
  return record(value) && Array.isArray(value.items) && value.items.every(item) && nullableText(value.nextCursor);
}
