export const ids = {
  upload: 'file-upload0001',
  doc: 'file-document001',
  library: 'file_library000001',
  generated: 'file-generated001',
  codeSediment: 'file-codesed0001',
  codeJupyter: 'file-codejup0001',
  codeFileService: 'file_codefs0000001',
  lonely: 'file-attachment01',
};

export function assetRaw(id = 'asset-chat') {
  const msg = (mid, role, content, metadata = {}) => ({
    id: mid, author: { role }, create_time: 1, content, metadata,
  });
  const mapping = {
    root: { parent: null, message: null },
    user: {
      parent: 'root',
      message: msg(`${id}-user`, 'user', {
        content_type: 'multimodal_text',
        parts: [
          { content_type: 'image_asset_pointer', asset_pointer: `sediment://${ids.upload}`, size_bytes: 1200, metadata: { dalle: null } },
          { content_type: 'image_asset_pointer', asset_pointer: `file-service://${ids.doc}`, size_bytes: 300 },
          { content_type: 'image_asset_pointer', asset_pointer: `sediment://hashvalue#${ids.doc}#p_1.jpg` },
          { content_type: 'image_asset_pointer', asset_pointer: 'weird://nothing' },
          'Describe these files',
        ],
      }, {
        attachments: [
          { id: ids.upload, name: 'photo.png', mime_type: 'image/png', size: 1200, library_file_id: ids.library },
          { id: ids.lonely, name: 'notes.md', mime_type: 'text/markdown', size: 40 },
          { id: 'not a file id', name: 'bad' },
        ],
      }),
    },
    assistant: {
      parent: 'user',
      message: msg(`${id}-assistant`, 'assistant', {
        content_type: 'multimodal_text',
        parts: [{ content_type: 'image_asset_pointer', asset_pointer: `sediment://${ids.generated}`, size_bytes: 900, metadata: { dalle: {} } }],
      }),
    },
    tool: {
      parent: 'assistant',
      message: msg(`${id}-tool`, 'tool', { content_type: 'execution_output', parts: ['done'] }, {
        aggregate_result: {
          messages: [
            { message_type: 'image', image_url: `sediment://${ids.codeSediment}` },
            { message_type: 'image', image_url: `file-service://${ids.codeFileService}` },
            { message_type: 'image', image_url: 'https://example.test/outside.png' },
          ],
          jupyter_messages: [
            { content: { data: { 'image/vnd.openai.fileservice.png': `file-service://${ids.codeJupyter}`, 'text/plain': 'x' } } },
            { content: { data: { 'image/vnd.openai.fileservice2.png': ids.codeJupyter } } },
          ],
        },
      }),
    },
  };
  return {
    conversation_id: id, title: `Assets ${id}`, update_time: 500, current_node: 'tool', mapping,
  };
}
