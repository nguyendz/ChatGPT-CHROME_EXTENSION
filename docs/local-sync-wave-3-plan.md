# Local Sync — Wave 3 Implementation Plan

Companion to the [development waves](./local-sync-development-waves.md) and
the [local-sync design reference](./local-sync-feature.md).

**Status:** Implemented; local automated validation is passing. Signed-in
initial/repeat all-chat acceptance remains pending. Wave 3 adds a user-started
all-chat sync to the existing local database. It does not restore file
downloads, exports, an Options page, or the removed backup progress flow.

## Goal

The popup's primary action defaults to a validation scope that requests only
the first 10 conversation-list entries (`offset=0&limit=10`) and fetches details
for at most those entries, without further list paging. The user
can switch to **All chats**. Sync reports new chats and newly added message IDs,
shows progress, and supports stopping safely.

The existing current-chat sync remains available from the expanded **Open**
section. Each conversation remains independently committed; stopping or a
failure must not roll back conversations already stored.

## Starting point and evidence

- Wave 2 implements manual current-chat sync, raw-payload SHA-256 comparison,
  metadata-only handling for `safe_urls[]`, and the native-host protocol.
- The user reloaded the rebuilt extension and confirmed the Sync/Open UI. The
  signed-in sequence confirming metadata-only followed by an identical no-op
  is still pending.
- The API probe sampled
  `/backend-api/conversations?offset=<n>&limit=50`. Sample list items had a
  string `id`, string `update_time`, and boolean `is_archived`.
- Two sampled default-list pages were descending by `update_time`. The
  `order=updated` query returned the same sampled ID sequence, so its effect is
  unconfirmed. Two pages do not establish stable ordering or complete paging.
- A known conversation's detail-root `update_time` appeared unchanged across
  repeated syncs. This is distinct from the conversation-list item's
  `update_time`. The agreed Wave 3 decision is to treat the list item's
  `update_time` as a sufficient per-conversation no-op token: compare it as an
  opaque value and skip the detail request when it matches. If it is absent or
  malformed, fetch that conversation's detail conservatively. Do not coerce the
  list token into the detail timestamp column.
- Archive semantics and complete project-list coverage remain unconfirmed.
  Neither is required for this wave.

The list-token no-op rule is an accepted product decision. The existing
observations do not establish stable ordering, complete paging, or safety for
early-stop paging.

At the user's request, validation now uses a bounded first-page sample rather
than the previous full-history timestamp ranking. Page ordering remains
unverified, so “latest-10” does not guarantee the account-wide latest chats.
Missing/mixed timestamps do not require ranking. All-chats mode still scans
the complete list to an empty terminal page.

## Entry gate and no-op decision

The Wave 2 signed-in acceptance check for insert/update, metadata-only, and
byte-identical unchanged outcomes remains required before Wave 2 can be closed.
Wave 3 code implementation proceeded at the user's request while that check is
pending; live Wave 3 acceptance is still outstanding.

For Wave 3, equality of the conversation-list item's `update_time` is
sufficient to skip fetching that conversation's detail. This does not require
a separate live proof before implementation. The raw payload hash remains the
content comparison when a detail is fetched; it cannot independently verify a
conversation whose detail request was skipped.

Early-stop paging is a separate All-chats optimization. All-chats must
enumerate every list page; enable stopping after unchanged pages only after
stable descending ordering has been established. Keep IDs, titles, message
content, and session values out of logs and committed fixtures.

## Scope

### Included

- One user-started incremental run for the currently selected ChatGPT account.
- Default conversation-list paging with validated responses, duplicate
  detection, and an explicit policy for list totals changing during a run.
- Host-side account-scoped manifest comparison and the existing per-conversation
  transactional upsert.
- Serialized ChatGPT requests with a two-second quiet interval after each
  response is read, plus existing 401/429/5xx handling.
- A default latest-10 validation scope and an explicit all-chats option.
- Visible listed/selected/processed/new-chat/new-message/updated/unchanged/
  failed counts and a Stop action.
- A single-writer guarantee across current-chat and all-chat runs.
- Sanitized API probe or fixture coverage for list response shape, token
  handling, and paging behavior.

### Not included

- Archive or project enumeration, and marking absent conversations as deleted.
- Automatic/live/background sync, multiple-account selection, or a local
  viewer.
- Attachment/image retrieval, file output, or restoring any download/export
  feature.
- An Options page or user-configurable throttle.
- A persisted page cursor. A later run starts listing from offset zero; already
  committed conversations remain intact.

## Implementation sequence

### [x] W3.0 — Track the Wave 2 gate and encode the list-token decision

**Files:** `docs/local-sync-api-findings.md`, `docs/local-sync-wave-2-plan.md`,
and only if needed, `lib/chatgpt-api-probe.ts` plus its tests.

- Record the user's signed-in current-chat acceptance without retaining private
  values.
- Encode the agreed rule: an exactly matching, well-formed list `update_time`
  skips that conversation's detail request; a missing or malformed token falls
  back to fetching its detail.
- Keep early-stop paging disabled unless ordering evidence supports it. A
  sanitized probe may be used to establish that optimization separately; it
  must report aggregate results and field types only.

**Done when:** the live Wave 2 gate is accurately recorded, the list token rule
is implemented as agreed, and early-stop remains disabled unless separately
verified. The live gate is still pending.

### [x] W3.1 — Add account-scoped manifest protocol and storage

**Files:** `lib/sync/protocol.ts`, `local-app/host/handlers.ts`,
`local-app/host/db.ts`, host tests.

- Extend `beginRun` to accept `incremental`; retain the existing per-account
  unique active-run lock. Test collisions between `single` and `incremental`
  runs rather than adding a second lock mechanism.
- Add a paged `diffManifest` request carrying only each conversation ID and
  its list update token. Return new, changed, and unchanged classifications
  scoped to the run's account.
- Migrate schema v2 to v3 with a separate text field for the list update token.
  The list probe observed strings while stored conversation detail timestamps
  are currently numeric; do not coerce the two into one timestamp column or
  assume they use the same units.
- Advance a changed item's stored list token only in the same transaction as
  its successful detail upsert. If fetching or persisting the detail fails,
  keep the previous token so the next run retries it.
- Count each distinct listed conversation once per run. Do not mark local
  conversations missing in Wave 3.

**Done when:** migration preserves existing v2 data; account scoping,
new/changed/unchanged comparison, retry-after-failure, and concurrent-run
behavior are covered by host tests.

### [x] W3.2 — Implement validated list paging

**Files:** `lib/chatgpt-client.ts`, new `lib/sync/engine.ts` or equivalent,
focused client/engine tests.

- Add a list adapter for the observed endpoint and page size of 50. Validate
  `total`, `items`, IDs, and optional list fields; preserve a type-safe update
  token without logging list contents.
- Advance offsets using the actual number of returned items. Deduplicate IDs
  across the run.
- Detect malformed pages, empty pages before the reported total, repeated page
  content, and a changing total. On an unstable scan, retry listing from offset
  zero once; if it remains unstable, end with an explicit partial/failure
  result and do not infer deletions.
- Page the full list in All-chats mode. Validation requests one page of ten
  entries and never claims complete remote coverage. Do not infer completeness
  from the number of unchanged pages; early-stop can be added later if ordering
  is established.

**Done when:** synthetic tests cover empty, malformed, duplicate, overlapping,
and changing pages, plus an unchanged second run that makes no detail requests
for entries with matching well-formed list tokens.

### [x] W3.3 — Add the incremental run engine

**Files:** `lib/sync/all-chat.ts`, `lib/sync/protocol.ts`,
`entrypoints/background.ts`, client and fake-host tests.

- Begin one account-scoped run, enumerate pages, compare each page with the
  host manifest, and fetch details for new/changed IDs.
- If a list token is missing or malformed, fetch that conversation's detail and
  rely on the existing raw hash for safe no-op writes.
- Route session, list, conversation-detail, and API-probe requests through one
  serialized request pacer. Wait at least two seconds after the complete
  response is read before starting another ChatGPT request.
- In the default validation scope, request only `offset=0&limit=10`, preserve
  response order, and make no second list request even for short/empty pages
  or a larger advertised total. Reject oversized/duplicate responses without
  syncing details. Do not claim globally latest selection.
- Report newly inserted chat counts separately from message IDs not previously
  stored for those conversations.
- Reuse the current 401 and 429/5xx error behavior. A fatal session/host error
  stops the run; a per-conversation failure is recorded and does not discard
  prior commits. Never advance a changed manifest token after a failed detail
  fetch.
- Stop at a safe boundary after the in-flight fetch/upsert completes. Finalize
  the run as cancelled and preserve all committed conversation rows.
- On host/service-worker interruption, the host's existing cleanup marks the
  run failed. A later user-started run restarts listing at offset zero; do not
  claim exact-cursor resume.

**Done when:** fake-API/fake-host tests cover initial sync, no-change sync,
changed and new chats, pagination, stop, 401, retried 429/5xx, per-chat
failures, host failure, and interrupted-run restart.

### [x] W3.4 — Put all-chat sync in the popup

**Files:** `entrypoints/popup/App.tsx`,
`entrypoints/popup/LocalSyncPanel.tsx`, popup/browser tests.

- Make latest-10 validation the default scope and provide an **All chats**
  selector. Show **Stop** while a run is active.
- Keep **Open** as the action that expands the currently collapsed local-sync
  section. Keep **Sync this chat**, connection checks, and developer
  diagnostics in that section.
- Add a sync-specific progress channel; do not restore the removed backup
  progress port. Report phase and aggregate counts, including new chats and new
  message IDs, but not conversation titles, IDs, or message content.
- Keep run outcome and error text visible after completion/cancellation and
  when the details section is collapsed.

**Done when:** the popup/browser test verifies the primary action, Open/close
behavior, progress, Stop, completion, and error rendering without a signed-in
profile.

### W3.5 — Integrate, verify, and document

**Files:** relevant tests and the Wave 3 status in
`docs/local-sync-development-waves.md`.

- [x] Run `corepack pnpm compile`, `corepack pnpm test:local-sync`,
  `node .\tests\messaging-bugs.test.mjs`, `corepack pnpm build`, and the
  isolated Chrome/native-host smoke test.
- Perform a signed-in initial all-chat sync and a repeat sync. Inspect only
  sanitized run summaries; do not commit host logs or private DB data.
- [x] Confirm the built manifest has no downloads/storage permission and the
  build has no PDF or Options entrypoint.
- [x] Update the roadmap with verified outcomes and remaining API limitations.

Automated and local integration checks are complete:

- [x] TypeScript compile and production build pass.
- [x] Local-sync suite passes (64 tests); messaging security suite passes
  (6 tests).
- [x] Chrome/native-host smoke passes, including the 10 MB framed echo,
  popup failure/recovery states, and idle host shutdown.
- [x] Generated manifest permission and removed-entrypoint check passes.
- [ ] Signed-in Wave 2 metadata-only/no-op and Wave 3 initial/repeat all-chat
  acceptance remain pending.

## Wave 3 acceptance

- A user can start and stop an all-chat sync from the primary popup action.
- The popup defaults to one list page of ten entries and at most ten detail
  requests, with a clear unverified-recency disclaimer, and can switch to all chats.
- In All-chats mode every list page is processed; early-stop is not part of the first
  implementation unless stable ordering is separately verified.
- New and changed conversations are stored; unchanged conversations do not
  rewrite message rows. A matching list `update_time` is the agreed no-op
  marker; the raw payload hash remains the content check for fetched details.
- Failed detail fetches are retried on a later run because their manifest token
  was not advanced.
- Completion reports newly inserted chats and newly seen message IDs separately.
- All writes remain account-scoped and protected by the existing single-writer
  lock. No bearer token, cookie, title, or message content is sent in progress
  messages or logs.
- A cancellation or host restart preserves already committed conversations.
- All-chat completion does not imply archive/project completeness or remote
  deletion reconciliation; those remain Wave 4 work.

**Wave 3 must not infer list completeness or enable early-stop paging** from an
unverified ordering assumption. Per-conversation no-op uses the agreed
conversation-list `update_time` token.
