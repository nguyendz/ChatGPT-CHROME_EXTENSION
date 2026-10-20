export type AnyRecord = Record<string, unknown>;

export type ChatGptRawConversation = {
  title?: string;
  create_time?: number;
  update_time?: number;
  conversation_id?: string;
  current_node?: string | null;
  gizmo_id?: string;
  gizmo_type?: string;
  conversation_template_id?: string;
  mapping?: Record<string, {
    parent?: string | null;
    message?: {
      id?: string;
      author?: { role?: string };
      content?: {
        parts?: unknown[];
        text?: unknown;
        content_type?: string;
        contentType?: string;
        [key: string]: unknown;
      };
      metadata?: AnyRecord;
      create_time?: number;
      [key: string]: unknown;
    } | null;
  }>;
  [key: string]: unknown;
};

export type StoredConversationMessage = {
  id: string;
  parentId: string | null;
  role: string;
  model: string | null;
  contentType: string | null;
  text: string;
  createTime: number | null;
  isOnActiveBranch: boolean;
};

export function parseConversationNodes(rawConversation: ChatGptRawConversation): StoredConversationMessage[] {
  const mapping = rawConversation.mapping ?? {};
  const activePath = new Set<string>();
  let nodeId = rawConversation.current_node;
  while (nodeId && mapping[nodeId] && !activePath.has(nodeId)) {
    activePath.add(nodeId);
    nodeId = mapping[nodeId].parent ?? undefined;
  }

  return Object.entries(mapping).flatMap(([mappingId, node]) => {
    const message = node.message;
    if (!message) return [];
    const content = message.content;
    const parts = Array.isArray(content?.parts)
      ? content.parts
      : content?.text != null ? [String(content.text)] : [];
    const text = parts
      .filter((part) => part != null)
      .map((part) => typeof part === 'string' ? part : JSON.stringify(part))
      .join('\n\n');

    return [{
      id: typeof message.id === 'string' && message.id ? message.id : mappingId,
      parentId: typeof node.parent === 'string' ? node.parent : null,
      role: typeof message.author?.role === 'string' ? message.author.role : 'unknown',
      model: typeof message.metadata?.model_slug === 'string' ? message.metadata.model_slug : null,
      contentType: typeof content?.content_type === 'string'
        ? content.content_type
        : typeof content?.contentType === 'string' ? content.contentType : null,
      text,
      createTime: typeof message.create_time === 'number' ? message.create_time : null,
      isOnActiveBranch: activePath.has(mappingId),
    }];
  });
}
