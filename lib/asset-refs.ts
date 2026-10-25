export type AssetKind = 'attachment' | 'image-upload' | 'image-generated' | 'code-output';

export type AssetRef = {
  fileId: string;
  kind: AssetKind;
  messageIds: string[];
  name: string | null;
  declaredMime: string | null;
  declaredSize: number | null;
  libraryFileId: string | null;
};

export type AssetExtraction = {
  refs: AssetRef[];
  ignoredDocumentPreviews: number;
  ignoredUnknownPointers: number;
};

export const ASSET_KINDS: readonly AssetKind[] = ['attachment', 'image-upload', 'image-generated', 'code-output'];

const FILE_ID = /^file[-_][A-Za-z0-9]+$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/;
const PRIORITY: Record<AssetKind, number> = { attachment: 0, 'image-upload': 1, 'image-generated': 2, 'code-output': 3 };
const MAX_NAME_LENGTH = 255;

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFileId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && FILE_ID.test(value);
}

export function normalizeMime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const mime = value.split(';')[0].trim().toLowerCase();
  return MIME.test(mime) ? mime : null;
}

function pointerFileId(pointer: string): string | null {
  const value = pointer.replace(/^(?:sediment|file-service):\/\//, '');
  return isFileId(value) ? value : null;
}

type ImagePointer = { fileId: string } | { documentPreview: true } | { unknown: true };

function imagePointer(pointer: string): ImagePointer {
  const segments = pointer.replace(/^(?:sediment|file-service):\/\//, '').split('#');
  if (isFileId(segments[0])) return { fileId: segments[0] };
  // Rendered pages of an attached document embed the original file's ID in the second segment.
  if (segments.length >= 3 && isFileId(segments[1]) && /^p_\d+\./.test(segments[2])) return { documentPreview: true };
  return { unknown: true };
}

/**
 * Finds the downloadable files referenced by a saved raw conversation. Pure and deterministic, so the
 * host can derive references from stored JSON and earlier chats are backfilled without re-fetching.
 */
export function extractAssetRefs(raw: unknown): AssetExtraction {
  const result: AssetExtraction = { refs: [], ignoredDocumentPreviews: 0, ignoredUnknownPointers: 0 };
  if (!isRecord(raw) || !isRecord(raw.mapping)) return result;
  const byId = new Map<string, AssetRef>();

  function add(fileId: string, kind: AssetKind, messageId: string, details: Partial<AssetRef> = {}) {
    let ref = byId.get(fileId);
    if (!ref) {
      ref = {
        fileId, kind, messageIds: [], name: null, declaredMime: null, declaredSize: null, libraryFileId: null,
      };
      byId.set(fileId, ref);
      result.refs.push(ref);
    }
    if (PRIORITY[kind] < PRIORITY[ref.kind]) ref.kind = kind;
    if (!ref.messageIds.includes(messageId)) ref.messageIds.push(messageId);
    ref.name ??= details.name ?? null;
    ref.declaredMime ??= details.declaredMime ?? null;
    ref.declaredSize ??= details.declaredSize ?? null;
    ref.libraryFileId ??= details.libraryFileId ?? null;
  }

  for (const [mappingId, node] of Object.entries(raw.mapping)) {
    if (!isRecord(node) || !isRecord(node.message)) continue;
    const message = node.message;
    const messageId = typeof message.id === 'string' && message.id ? message.id : mappingId;
    const author = isRecord(message.author) ? message.author : {};
    const content = isRecord(message.content) ? message.content : {};
    const metadata = isRecord(message.metadata) ? message.metadata : {};

    if (Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (!isRecord(part) || part.content_type !== 'image_asset_pointer' || typeof part.asset_pointer !== 'string') continue;
        const pointer = imagePointer(part.asset_pointer);
        if ('documentPreview' in pointer) result.ignoredDocumentPreviews++;
        else if ('unknown' in pointer) result.ignoredUnknownPointers++;
        else {
          add(pointer.fileId, author.role === 'user' ? 'image-upload' : 'image-generated', messageId, {
            declaredSize: typeof part.size_bytes === 'number' && Number.isSafeInteger(part.size_bytes) && part.size_bytes >= 0
              ? part.size_bytes : null,
          });
        }
      }
    }

    if (Array.isArray(metadata.attachments)) {
      for (const attachment of metadata.attachments) {
        if (!isRecord(attachment) || !isFileId(attachment.id)) continue;
        const name = typeof attachment.name === 'string' ? attachment.name.trim().slice(0, MAX_NAME_LENGTH) : '';
        add(attachment.id, 'attachment', messageId, {
          name: name || null,
          declaredMime: normalizeMime(attachment.mime_type),
          declaredSize: typeof attachment.size === 'number' && Number.isSafeInteger(attachment.size) && attachment.size >= 0
            ? attachment.size : null,
          libraryFileId: isFileId(attachment.library_file_id) ? attachment.library_file_id : null,
        });
      }
    }

    const aggregate = isRecord(metadata.aggregate_result) ? metadata.aggregate_result : undefined;
    if (aggregate) {
      for (const item of Array.isArray(aggregate.messages) ? aggregate.messages : []) {
        if (!isRecord(item) || typeof item.image_url !== 'string') continue;
        const fileId = pointerFileId(item.image_url);
        if (fileId) add(fileId, 'code-output', messageId);
      }
      for (const item of Array.isArray(aggregate.jupyter_messages) ? aggregate.jupyter_messages : []) {
        const data = isRecord(item) && isRecord(item.content) && isRecord(item.content.data) ? item.content.data : {};
        for (const [key, value] of Object.entries(data)) {
          if (!key.startsWith('image/vnd.openai.fileservice') || typeof value !== 'string') continue;
          const fileId = pointerFileId(value);
          if (fileId) add(fileId, 'code-output', messageId);
        }
      }
    }
  }
  return result;
}
