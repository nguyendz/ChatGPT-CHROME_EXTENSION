import type { ConversationDetail, ExportAsset, ViewerAsset, ViewerMessage } from './types.ts';

const ROLE_LABELS: Record<string, string> = { user: 'User', assistant: 'Assistant', system: 'System', tool: 'Tool' };
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_NAME_LENGTH = 80;
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'text/plain': 'txt', 'text/markdown': 'md', 'application/json': 'json', 'text/csv': 'csv',
};
export const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const ASSET_STATE_NOTES: Record<ViewerAsset['state'], string> = {
  stored: 'saved', pending: 'not downloaded yet', 'too-large': 'over the 5 MB limit',
  unavailable: 'no longer available', failed: 'download failed',
};

/** `file-abc.png`: the ID is already restricted to letters, digits, `-` and `_`, so the name needs no escaping. */
export function assetFileName(fileId: string, mime: string | null): string {
  return `${fileId}.${MIME_EXTENSIONS[mime ?? ''] ?? 'bin'}`;
}

/** Converts arbitrary text into a filename segment that is valid on Windows, macOS, and Linux. */
export function safeFileName(value: string | null | undefined, fallback = 'Untitled conversation'): string {
  let name = (value ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if ([...name].length > MAX_NAME_LENGTH) name = [...name].slice(0, MAX_NAME_LENGTH).join('').trim();
  name = name.replace(/^[. ]+|[. ]+$/g, '');
  if (!name || RESERVED_NAMES.test(name.split('.')[0])) name = name ? `_${name}` : fallback;
  return name;
}

export function markdownFileName(title: string | null, id: string): string {
  return `${safeFileName(title)} (${safeFileName(id.slice(0, 8), 'chat')}).md`;
}

function isoTime(value: number | string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function escapeInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>#|~]/g, '\\$&');
}

function fenced(text: string, language = ''): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}

function roleLabel(role: string): string {
  if (!role) return 'Unknown';
  return ROLE_LABELS[role] ?? escapeInline(role.charAt(0).toUpperCase() + role.slice(1));
}

/** Serializes the saved active branch of one conversation. Message text is exported verbatim. */
export function conversationMarkdown(
  detail: ConversationDetail, messages: ViewerMessage[], files: ReadonlyMap<string, ExportAsset> = new Map(),
): string {
  const title = detail.title?.trim() || 'Untitled conversation';
  const lines = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `conversation_id: ${JSON.stringify(detail.id)}`,
    `updated: ${JSON.stringify(isoTime(detail.updateTime))}`,
    `last_synced: ${JSON.stringify(isoTime(detail.lastSyncedAt) ?? detail.lastSyncedAt)}`,
    `active_messages: ${messages.length}`,
    `other_stored_messages: ${detail.otherMessageCount}`,
    '---',
    '',
    `# ${escapeInline(title)}`,
    '',
  ];
  if (detail.otherMessageCount > 0) {
    lines.push(`> Active branch only. ${detail.otherMessageCount} other stored message${detail.otherMessageCount === 1 ? ' is' : 's are'} not included.`, '');
  }
  for (const warning of detail.warnings) lines.push(`> **Warning:** ${escapeInline(warning)}`, '');
  for (const message of messages) {
    const heading = [roleLabel(message.role), message.model ? escapeInline(message.model) : null].filter(Boolean).join(' · ');
    lines.push('---', '', `## ${heading}`, '');
    const time = isoTime(message.createTime);
    if (time) lines.push(`*${time}*`, '');
    if (message.unsupportedContent && !(message.assets.length && message.assets.every(asset => asset.state === 'stored'))) {
      lines.push('> Contains unsupported content or attachment references; only saved text/reference data is included.', '');
    }
    if (message.contentType === 'code') lines.push(fenced(message.text));
    else lines.push(message.text.trim() ? message.text.replace(/\s+$/, '') : '*[No saved text in this message]*');
    lines.push('');
    for (const asset of message.assets) {
      const file = files.get(asset.fileId);
      const label = escapeInline(asset.name ?? asset.fileId);
      if (asset.state === 'stored' && file) {
        const embed = file.mime !== null && INLINE_IMAGE_TYPES.has(file.mime);
        lines.push(`${embed ? '!' : ''}[${label}](assets/${file.fileName})`, '');
      } else {
        lines.push(`*[File not included: ${label} (${ASSET_STATE_NOTES[asset.state]})]*`, '');
      }
    }
  }
  if (!messages.length) lines.push('*No messages on a valid saved active branch.*', '');
  return lines.join('\n');
}
