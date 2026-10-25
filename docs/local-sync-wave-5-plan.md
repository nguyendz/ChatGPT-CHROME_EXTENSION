# Wave 5 — Assets (images and files)

**Status:** implemented and automatically verified 2026-10-25 (W5.0–W5.5). Signed-in
acceptance (W5.6) is pending: endpoint behavior for each asset kind has not been
observed against the live service. Scope confirmed by the user.

Wave 5 downloads the images and files that saved conversations reference,
stores them once in a local content-addressed store, shows them in the viewer,
and includes them in Markdown export. It depends on the existing Wave 3 sync and
Wave 6A viewer. It does not depend on Wave 4B/4C. See the
[development waves](./local-sync-development-waves.md),
[feature design §6.5](./local-sync-feature.md#65-asset-sync-images-and-attachments),
and [Wave 6 plan](./local-sync-wave-6-plan.md).

This document owns Wave 5 implementation details and acceptance gates.

## Implementation status (2026-10-25)

| Task | Status | Evidence |
|---|---|---|
| W5.0 extractor | Done | `lib/asset-refs.ts`; `tests/local-app/asset-refs.test.mjs`. |
| W5.1 protocol | Done | `listPendingAssets`, `assetChunk`, `assetCommit`, `assetOutcome`, `endRun.assets`, `asset-sync` capability; host v0.7.0. |
| W5.2 host store | Done | Schema 5, `local-app/host/assets.ts`; `tests/local-app/assets-host.test.mjs`. |
| W5.3 engine and popup | Done | `lib/sync/assets.ts`, `fetchAssetFile`; `tests/local-app/assets-engine.test.mjs`. |
| W5.4 viewer | Done | `tests/local-app/viewer-assets.test.mjs` and the real-Chrome check in `viewer.browser.mjs` (image shown from a `blob:` URL). |
| W5.5 Markdown export | Done | Single-chat ZIP and folder `assets/` verified in Chrome, byte for byte. |
| W5.6 signed-in acceptance | **Pending** | Needs one signed-in run per asset kind; see the task table. |

Differences from the first draft of this plan:

- `PROTOCOL_VERSION` stays 1: the new messages are additive and gated by the
  `asset-sync` capability and schema 5. The popup reports an update message when
  the host is older, instead of hiding the checkbox.
- References that are not downloaded (document previews, unknown pointers) are
  counted by the extractor only. They are not stored, so there is no `unsupported`
  state.
- `asset_refs` keeps `message_ids` (a JSON array) instead of `node_id`/`roles`, and
  `kind` is the primary kind (attachment, then image-upload, image-generated,
  code-output).
- The host keeps in-flight uploads in memory (at most 4, bound to a run, 5 MB
  each); only the verified result is written, through a temp file and rename. A
  SHA-256 or size mismatch is an `INVALID_PAYLOAD` error and stores nothing.
- Once a file is stored, any other reference to the same file ID in the same account
  is marked stored too, so forked chats are not downloaded twice.
- `unavailable` references are retried on at most 3 runs; `failed` ones keep being
  retried, ordered after fresh files, and never twice in one run.
- A file whose size is unknown starts only if a full 5 MB remains in the run
  budget; otherwise it waits for the next run.
- Rate limiting (HTTP 429) or an expired sign-in (HTTP 401) stops the asset phase
  and reports the remaining files as waiting; chats already synced are unaffected.
- Images render after the message text (not at the original position inside it).
- The viewer file route is `GET /api/assets/:fileId?accountId=&conversationId=`.

Real-archive migration check (a copy of the archive; counts only): schema 4 to
5 derived 28 references in 19 chats: 16 attachments, 9 generated images and 3
code outputs, about 16.8 MB of declared size in total, none over 5 MB. With the
10 MB run budget the backfill takes at least two runs.

## Scope decisions 2026-10-25

| Decision | Choice |
|---|---|
| Asset kinds | Uploaded images/files, generated images, code-interpreter outputs, and library file references. |
| Trigger | Opt-in **Include images & files** checkbox on user-started runs (single chat, Latest 10, All chats). Default off. A run with the checkbox on also backfills missing assets of chats saved earlier. No separate or scheduled trigger. |
| Limits | **5 MB per asset**, **10 MB downloaded per run**, and at most **50 assets per run**. Over-cap assets are skipped and reported, not failed. |
| Viewer/export | Show images inline and files as download links in the viewer; Markdown export includes the assets. |

These follow the Wave 4 rule that no API traffic runs unattended. The run caps
also bound traffic for one click: at most 100 asset requests (two per asset).

## Evidence from the local archive (2026-10-25)

Read-only aggregate scan of `sync.db` (schema 4). No IDs, names, or content
were recorded.

- 18 of 296 conversations reference files. About 40 distinct file-like IDs exist.
- **Image parts** (`content.parts[].content_type = image_asset_pointer`): 24,
  all with a direct file ID. 21 use `sediment://`, 3 use `file-service://`.
  15 are user uploads and 9 are tool-generated (`metadata.dalle` /
  `metadata.generation`). Every part declares `size_bytes`: 16.0 MB total,
  3.2 MB max. No document-page-preview pointers are present.
- **Attachments** (`message.metadata.attachments[]`): 16, all with `size`
  (5.6 MB total, 1.7 MB max). 15 share their ID with an image part. Types: 12
  images, 1 Markdown, 3 with no `mime_type`. 9 have a `library_file_id` that
  always differs from the attachment `id`.
- **Code-interpreter outputs:** 3 IDs not seen elsewhere, in
  `metadata.aggregate_result.messages[].image_url` (`sediment://`,
  `file-service://`) and `aggregate_result.jupyter_messages[].content.data`
  (`image/vnd.openai.fileservice.png`, `…fileservice2.png`).
- **References only:** `tether_quote` `content.url` (3) points to already-
  uploaded files. 2 assistant text parts mention IDs inline. One
  `model_dil_v2` image uses an external `https:` URL.
- All current assets fit the 5 MB cap. Backfilling about 22 MB of unique
  bytes takes about three runs at 10 MB per run.

Endpoint evidence: none in this codebase. The API-debug log has no file
requests. The pre-sync export (removed in `ae72803`) used
`GET /backend-api/files/download/{fileId}?conversation_id=…&inline=false&download_intent=…`,
which returned `{status: 'success', download_url}`, then fetched `download_url`
with only the `https://chatgpt.com/*` host permission. That suggests, but does
not prove, a same-origin download URL. Code-output and library IDs were never
downloaded by that code.

## Reference model

A pure, shared extractor (`lib/asset-refs.ts`) reads a raw conversation and
returns deduplicated references. The host runs it, so the raw JSON stays the
single source of truth and earlier chats can be backfilled without re-fetching.

| Kind | Source path | Download |
|---|---|---|
| `image-upload` | image part, author `user` | Direct file ID from `sediment://` / `file-service://` pointer. |
| `image-generated` | image part, author `tool`/`assistant` | Same as above; keep `dalle`/`generation` flags as metadata only. |
| `attachment` | `metadata.attachments[].id` | Download by `id`; keep `name`, `mime_type`, `size`. Same ID as an image part → one reference with both roles. |
| `library` | `metadata.attachments[].library_file_id` | Stored as an alias on the attachment reference. Used only as a fallback if the attachment `id` download fails and W5.6 shows library IDs download. |
| `code-output` | `aggregate_result.messages[].image_url`, `aggregate_result.jupyter_messages[].content.data[image/vnd.openai.fileservice*.png]` | Direct file ID from the pointer or bare value. |
| Not downloaded | document-page previews (`<hash>#file-…#p_N.`), `tether_quote` URLs, IDs inside text, external `http(s)` URLs, unknown pointer formats | Counted by the extractor, never stored or fetched. External URLs are never fetched. |

File IDs must match `^file[-_][A-Za-z0-9]+$` before any request. References
keep the IDs of the messages that use them so the viewer can show them there.

## Storage (host, schema 5)

- Files: `%LOCALAPPDATA%\ChatGPTBackup\assets\<sha256[0:2]>\<sha256>` with no
  extension. Write to a temp file in `assets\tmp`, verify size and SHA-256,
  then rename atomically. Identical bytes are stored once across accounts.
- `assets(sha256 PK, size, mime, created_at)`.
- `asset_refs(account_id, conversation_id, file_id, kind, message_ids, name,
  declared_mime, declared_size, library_file_id, sha256 NULL, state,
  attempts, last_error, last_attempt_run_id, updated_at)`; primary key
  `(account_id, conversation_id, file_id)`. `state` is `pending`, `stored`,
  `too-large`, `unavailable`, or `failed`.
- The migration derives references for all saved conversations. Each
  `upsertConversation` re-derives references for that chat: new references
  are added as `pending`, and references no longer in the raw JSON are
  removed; stored blobs remain until a later explicit cleanup.
- `getStatus.counts` adds `assets` (stored), `assetBytes`, and
  `assetsPending`.

## Protocol (W5.1)

Replaces the earlier `hasAssets` sketch with a host-driven list, since the host
owns reference extraction. All requests are run-bound and account-scoped.

| Request | Payload | Response |
|---|---|---|
| `listPendingAssets` | `runId`, `conversationIds` (this run's chats first), `includeOthers`, `limit` | `items[] {conversationId, fileId, kind, declaredSize, declaredMime, libraryFileId}` |
| `assetChunk` | `runId`, `uploadId`, `conversationId`, `fileId`, `seq`, `data` (base64, ≤ 4 MB) | `{received}` |
| `assetCommit` | `runId`, `uploadId`, `conversationId`, `fileId`, `sha256`, `size`, `mime` | `{status: 'stored' \| 'deduplicated'}`; a hash or size mismatch is an `INVALID_PAYLOAD` error |
| `assetOutcome` | `runId`, `conversationId`, `fileId`, `state` (`too-large`, `unavailable`, `failed`), `error?` | `{state, attempts}` |
| `endRun` | adds `assets?: {stored, deduplicated, skippedTooLarge, unavailable, failed, deferred, bytes, stopped?}` | unchanged |

Host checks: the reference exists for the run's account, chunks are in order,
total bytes stay at or under 5 MB, the hash matches, and uploads for cancelled
or ended runs are discarded. The host adds an `asset-sync` capability and schema 5;
the protocol version is unchanged.

## Engine (W5.3)

When the checkbox is on, a run adds an **assets** phase after its chat phase:

1. Ask the host for pending references, this run's chats first, then other
   chats (backfill), up to 50 items.
2. Skip an item if its declared size is over 5 MB (`too-large`) or would
   exceed the remaining 10 MB budget (deferred to the next run). Start an
   item of unknown size only if at least 5 MB of budget remains.
3. Download in two steps: get `download_url` from `files/download`, then
   fetch it. Send the bearer token only when the URL is on
   `https://chatgpt.com`. If it is on another origin, fail as `unavailable`
   with reason `unverified-origin` until W5.6 approves that origin and its
   host permission.
4. Stream the body and abort once it exceeds 5 MB. Send `assetChunk`s, then
   `assetCommit`.
5. Map 403/404/410 or `status != success` to `unavailable` (retried on at most
   3 runs). Map network errors and 5xx to `failed` (retried next run).
   Asset errors never fail the chat sync or the run.

Reuse the existing two-second pacing, retries, Stop/cancellation, writer lock,
and private API-debug capture. Debug entries record status, content type, and
size only: no binary bodies, signed-URL query strings, or file names.
Progress shows `Assets 3/12 · 4.1 MB`. The checkbox value is kept in popup
`localStorage`; no new permission is needed unless W5.6 requires another
download origin.

## Viewer and export (W5.4, W5.5)

- Route `GET /api/assets/:fileId?accountId=<id>&conversationId=<id>`, using the same bearer
  token and loopback checks. It serves only `stored` references of the
  selected account and conversation, with `X-Content-Type-Options: nosniff`.
  PNG, JPEG, GIF, and WebP are served inline; everything else, including SVG,
  is served with `Content-Disposition: attachment`.
- The UI fetches images with the token and shows them through `blob:` URLs.
  The CSP becomes `img-src 'self' blob:`; remote and Markdown-embedded images
  stay blocked. Images render after the message text. Attachments and code outputs show
  as chips with a name, size, and download link. Missing assets show
  `[File not downloaded: <name> (<state>)]`.
- The message list returns asset metadata (kind, state, mime, size, name) per
  message. It does not return paths or hashes.
- Markdown export for a single chat with stored assets downloads a ZIP:
  `<title> (<id8>).md` plus `assets/<fileId><ext>`. The Markdown links use
  relative `assets/…` paths. Folder export writes one shared `assets/`
  subfolder. Chats with no stored assets still export as plain `.md`, and
  missing assets are listed as notes. The extension comes from the stored
  MIME type (`.bin` if unknown). The existing 64 MiB export limit applies.

## Tasks

| ID / phase | Work / likely files | Depends | Done when |
|---|---|---|---|
| W5.0 / 5A | Shared reference extractor and synthetic fixtures covering every kind and exclusion in the table above. `lib/asset-refs.ts`, `tests/local-app/`. | — | Fixtures cover both pointer schemes, attachment/image overlap, library aliases, code outputs, document previews, external URLs, and malformed IDs; output is deduplicated and deterministic. |
| W5.1 / 5A | Protocol messages, validators, capability, version bump. `lib/sync/protocol.ts`, `local-app/host/handlers.ts`. | W5.0 | Validator tests reject oversize chunks, bad IDs, foreign accounts, and out-of-order chunks. |
| W5.2 / 5A | Schema 5 migration, reference derivation on migrate/upsert, temp-write/verify/rename store, status counts. `local-app/host/db.ts`, new `local-app/host/assets.ts`. | W5.0, W5.1 | Disposable-archive tests: migration from schema 4 derives references; dedupe across chats/accounts; hash mismatch, partial upload, and cancellation leave no file or `stored` row; re-upsert keeps stored state. |
| W5.3 / 5A | Popup checkbox, assets phase in single/all-chat engines, two-step download, caps, origin rule, retries, debug redaction. `lib/chatgpt-client.ts`, `lib/sync/*.ts`, `entrypoints/background.ts`, `entrypoints/popup/LocalSyncPanel.tsx`. | W5.1, W5.2 | Mocked-fetch tests: 5 MB/10 MB/50-item caps, unknown-size rule, Stop mid-download, 403/404/5xx states, no token to foreign origins, no signed URL in debug log, chat sync unaffected by asset errors. |
| W5.4 / 5B | Viewer asset route, per-message asset metadata, inline images, file chips, CSP update. `local-app/viewer/*`. | W5.2 (synthetic store) | API tests for account/conversation scoping, nosniff, SVG served as attachment, missing/too-large states; real-Chrome check renders a fixture image via `blob:`. |
| W5.5 / 5B | Markdown export with assets (single ZIP, folder `assets/`). `local-app/viewer/markdown.ts`, `archive.ts`, `ui/main.tsx`. | W5.4 | Export tests: relative links resolve inside ZIP/folder, shared assets written once, missing-asset notes, plain `.md` when no assets. |
| W5.6 / acceptance | **Pending.** Signed-in evidence and acceptance with the real account. | W5.3 | One single-chat run per kind (upload, generated, attachment, code output; library fallback if an attachment fails) records sanitized outcomes: endpoint status, download-URL origin, MIME, size. Backfill completes within about three All-chats runs; the viewer shows the images offline. |

5A delivers stored assets; 5B makes them visible and exportable. 5B can be
built against a synthetic schema 5 archive in parallel with W5.3.

## Acceptance

- With the checkbox off, a run sends no asset requests and behaves exactly as
  before.
- With it on, every run stays within 5 MB per asset, 10 MB, and 50 assets, and
  reports stored/skipped/deferred/failed counts in the popup and run record.
- Assets are verified by SHA-256 and stored once; the viewer works offline and
  never loads a remote image.
- Failures, cancellation, and host disconnects keep committed chats and never
  leave half-written files or false `stored` rows.
- Existing local-sync, viewer, type-check, build, and isolated Chrome checks
  pass. Signed-in acceptance (W5.6) is recorded separately from synthetic tests.

## Risks and open questions

| Risk / question | Handling |
|---|---|
| `download_url` origin is not `chatgpt.com` | No token sent; recorded as `unverified-origin`. W5.6 decides whether to add that origin to `host_permissions`. |
| Old files expire or code-output files are not downloadable | `unavailable` after 3 attempts; the reference and its metadata remain visible. |
| Library IDs need a different endpoint | Library is fallback-only; leave it unsupported if W5.6 shows `files/download` rejects them. |
| Asset traffic increases block risk | Opt-in, user-started only, with per-run caps, existing pacing, and Stop. |
| Stored files are private data | Stored only under the local archive folder; never logged; the viewer serves them only on loopback with the token. |
