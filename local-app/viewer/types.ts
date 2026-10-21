export type Account = { id: string; label: string; conversationCount: number };
export type ConversationGroup = {
  id: string; kind: 'all' | 'project' | 'gpt' | 'unmarked' | 'other';
  label: string; conversationCount: number;
};
export type ArchiveStatus = { schemaVersion: number; accounts: number; conversations: number; messages: number };
export type ConversationSummary = {
  id: string; title: string | null; updateTime: number | null;
  lastSyncedAt: string; messageCount: number;
};
export type ConversationDetail = ConversationSummary & {
  revision: string; activeMessageCount: number; otherMessageCount: number; warnings: string[];
};
export type ViewerMessage = {
  id: string; role: string; model: string | null; contentType: string | null;
  text: string; createTime: number | null; unsupportedContent: boolean;
};
export type Page<T> = { items: T[]; nextCursor: string | null };

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
  return record(value) && count(value.schemaVersion) && count(value.accounts) && count(value.conversations) && count(value.messages);
}
export function isAccounts(value: unknown): value is Account[] {
  return Array.isArray(value) && value.every(item => record(item) &&
    typeof item.id === 'string' && typeof item.label === 'string' && count(item.conversationCount));
}
export function isGroups(value: unknown): value is ConversationGroup[] {
  return Array.isArray(value) && value.every(item => record(item) &&
    typeof item.id === 'string' && typeof item.label === 'string' && count(item.conversationCount) &&
    typeof item.kind === 'string' && ['all', 'project', 'gpt', 'unmarked', 'other'].includes(item.kind));
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
export function isMessage(value: unknown): value is ViewerMessage {
  return record(value) && typeof value.id === 'string' && typeof value.role === 'string' &&
    nullableText(value.model) && nullableText(value.contentType) && typeof value.text === 'string' &&
    nullableTime(value.createTime) && typeof value.unsupportedContent === 'boolean';
}
export function isPage<T>(value: unknown, item: (value: unknown) => value is T): value is Page<T> {
  return record(value) && Array.isArray(value.items) && value.items.every(item) && nullableText(value.nextCursor);
}
