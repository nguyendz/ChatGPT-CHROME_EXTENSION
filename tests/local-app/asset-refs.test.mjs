import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAssetRefs, isFileId, normalizeMime } from '../../lib/asset-refs.ts';
import { assetRaw, ids } from '../fixtures/asset-chat.mjs';

test('extractor finds every supported kind once, merging overlaps', () => {
  const { refs, ignoredDocumentPreviews, ignoredUnknownPointers } = extractAssetRefs(assetRaw());
  const byId = Object.fromEntries(refs.map(ref => [ref.fileId, ref]));
  assert.deepEqual(refs.map(ref => ref.fileId), [
    ids.upload, ids.doc, ids.lonely, ids.generated, ids.codeSediment, ids.codeFileService, ids.codeJupyter,
  ]);
  assert.equal(byId[ids.upload].kind, 'attachment');
  assert.equal(byId[ids.upload].name, 'photo.png');
  assert.equal(byId[ids.upload].declaredMime, 'image/png');
  assert.equal(byId[ids.upload].declaredSize, 1200);
  assert.equal(byId[ids.upload].libraryFileId, ids.library);
  assert.deepEqual(byId[ids.upload].messageIds, ['asset-chat-user']);
  assert.equal(byId[ids.doc].kind, 'image-upload');
  assert.equal(byId[ids.doc].declaredSize, 300);
  assert.equal(byId[ids.lonely].kind, 'attachment');
  assert.equal(byId[ids.generated].kind, 'image-generated');
  assert.equal(byId[ids.codeJupyter].kind, 'code-output');
  assert.deepEqual(byId[ids.codeJupyter].messageIds, ['asset-chat-tool']);
  assert.equal(ignoredDocumentPreviews, 1);
  assert.equal(ignoredUnknownPointers, 1);
  assert.equal(refs.some(ref => ref.fileId === ids.library), false, 'library IDs are aliases, not separate downloads');
});

test('extractor is deterministic and tolerates malformed input', () => {
  assert.deepEqual(extractAssetRefs(assetRaw()), extractAssetRefs(JSON.parse(JSON.stringify(assetRaw()))));
  for (const value of [null, 'x', [], {}, { mapping: null }, { mapping: { a: null, b: { message: 5 } } }]) {
    assert.deepEqual(extractAssetRefs(value).refs, []);
  }
  const odd = extractAssetRefs({ mapping: { a: { message: {
    content: { parts: [null, 4, { content_type: 'image_asset_pointer', asset_pointer: 4 }] },
    metadata: { attachments: 'x', aggregate_result: { messages: [null, { image_url: 5 }], jupyter_messages: 'x' } },
  } } } });
  assert.deepEqual(odd.refs, []);
});

test('message IDs fall back to the mapping key and are not duplicated', () => {
  const raw = { mapping: { key1: { message: { author: { role: 'user' }, content: { parts: [
    { content_type: 'image_asset_pointer', asset_pointer: 'file-abc12345' },
    { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file-abc12345' },
  ] } } } } };
  const { refs } = extractAssetRefs(raw);
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0].messageIds, ['key1']);
  assert.equal(refs[0].declaredSize, null);
});

test('file IDs and MIME types are validated', () => {
  for (const good of ['file-abc123', 'file_000000abcdef']) assert.equal(isFileId(good), true);
  for (const bad of ['', 'file-', 'file-a/b', '../file-abc', 'File-abc', 'file-abc def', 'file-' + 'a'.repeat(200), 5, null]) {
    assert.equal(isFileId(bad), false);
  }
  assert.equal(normalizeMime('Image/PNG; charset=binary'), 'image/png');
  assert.equal(normalizeMime('not a mime'), null);
  assert.equal(normalizeMime('<script>/x'), null);
  assert.equal(normalizeMime(5), null);
});
