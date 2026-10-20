# Local Sync — Wave 2 Implementation Plan

Companion to [local-sync-development-waves.md](./local-sync-development-waves.md)
and [local-sync-feature.md](./local-sync-feature.md). Wave 2 delivers the first
persisted conversation: one user-triggered sync of the currently open chat. It
does not implement all-chat sync, background/automatic sync, assets, or a viewer.

## Starting point

At the start of Wave 2, Wave 1 was locally verified. The TypeScript check,
local-sync tests, production build, messaging/PDF regression tests, and
disposable-Chrome native-host check passed. The local DB was healthy in WAL
mode at schema version 1 and contained only the Wave 1 metadata and migration
tables.

**Status:** Wave 2 implementation, including the Wave 2.1 probe, and automated
verification are complete. Signed-in regular and project-conversation probes
have been reviewed; the tested project conversation appeared in the sampled
default list, without establishing full coverage. Signed-in DB history shows
insert and updated outcomes without failures. Repeated same-chat diffs changed
only `safe_urls[]`; that case now refreshes the raw snapshot without rewriting
message rows and is reported as metadata-only. Live confirmation of that
classification followed by a byte-identical no-op remains pending. The user
reloaded the rebuilt extension and confirmed the Sync/Open popup UI. See the
[Wave 2.1 API probe plan](./local-sync-wave-2.1-probe-plan.md).

## Goal and boundaries

By the end of the wave, a user can click **Sync this chat** in the extension
popup and persist the active conversation. A byte-identical sync is a no-op;
an edited conversation updates its stored raw payload and derived messages.
A `safe_urls[]`-only change refreshes raw metadata without rewriting message
rows. That raw snapshot refresh still counts as `updated` in run totals. All
branches are retained, with the active branch identified.

- Keep the extension sync-only: file downloads and conversation exports are
  not part of the current product.
- Keep ChatGPT API details in one client/parser boundary; treat endpoints and
  response fields as unofficial and subject to change.
- Never send cookies, bearer tokens, or JWTs to the native host. The host needs
  only the account scope, conversation payload, and its SHA-256.
- Store the raw payload as the source of truth; derive message rows locally.
- Do not start all-chat enumeration, early-stop paging, asset downloads,
  auto-sync, project/archive discovery, or viewer work in this wave.
- Use sanitized fixtures for tests and findings. Do not check real conversation
  contents, titles, account identifiers, or credentials into the repository.
- Do not mark the signed-in manual acceptance checks complete until they have
  actually been run in the user's ChatGPT profile.

## Dependency order

```text
                 ┌─ W2.1 API spike and findings ─────────────┐
Wave 1 complete ─┤                                           ├─ W2.4 host protocol/storage
                 ├─ W2.2 client/parser extraction ───────────┤              │
                 └─ W2.3 migration 2 ────────────────────────┘              └─ W2.5 popup sync
                              └─ W2.6 read-only DB query CLI
```

W2.1 and W2.2 can proceed in parallel. W2.3 can proceed alongside them after
Wave 1. W2.4 requires both W2.2 and W2.3; W2.5 requires W2.4. W2.6 requires
only W2.3.

## Tasks

### W2.1 — Verify and document the ChatGPT API assumptions

- [x] Implement the explicit button-triggered, sanitized probe in
  [the Wave 2.1 probe plan](./local-sync-wave-2.1-probe-plan.md).
- [x] **Existing files:** `lib/chatgpt-client.ts`,
  `docs/local-sync-api-findings.md`, and sanitized fixtures under `tests/`.
- [x] Record static endpoint behavior from the existing client and ensure the
  extracted client does not log session or conversation response bodies.
- [x] Run the probe from a signed-in regular-conversation profile and review
  its `API_PROBE` line(s) in `%LOCALAPPDATA%\ChatGPTBackup\logs\host.log`.
  Record only sanitized field names/types and aggregate outcomes.
- [x] Run the probe from a project-conversation route and review the sanitized
  project/list evidence. The tested conversation was found in the sampled
  default list; this does not establish complete project coverage.
- [x] Keep account resolution fail-closed when either stable ID is absent;
  no conversation or credentials are sent to the host in that case.
- [x] Automated fixtures and tests validate the report sanitizer and host
  logger boundary; no raw response values or real host-log lines are stored.
- [x] Add synthetic sanitized fixtures from reviewed findings and update the
  API findings document. Do not store real response values or host-log lines.
- [x] **Done when:** live findings record verified shapes and explicitly leave
  unsupported ordering/archive conclusions and full project coverage
  unresolved for follow-up.

### W2.2 — Extract the ChatGPT client and parser without behavior changes

- [x] **Files:** `entrypoints/background.ts`, `lib/chatgpt-client.ts`,
  `lib/chatgpt-parse.ts`, and focused tests/fixtures.
- [x] Move the existing ChatGPT request/client logic out of the
  `defineBackground` closure into `lib/chatgpt-client.ts`; preserve request
  behavior, retries, throttling, and explicit error reporting.
- [x] Move conversation/message parsing into `lib/chatgpt-parse.ts`. Keep the
  parser independent of `chrome.*`, so both extension code and the native host
  can use it.
- [x] Add fixture-based tests for active-branch selection and all-branch
  parsing; ensure raw payload data remains available for storage.
- [x] **Automated checks:** compile, local-sync tests, and messaging tests pass.
  No signed-in ChatGPT session was used for this run.

### W2.3 — Add migration 2 for single-chat storage

- [x] **Files:** `local-app/host/db.ts` and `tests/local-app/host.test.mjs`.
- [x] Add migration 2 for `accounts`, `conversations`, `messages`, `sync_runs`,
  and `sync_failures` following feature document §8. Add the foreign keys,
  uniqueness constraints, and indexes needed for account/conversation lookup.
- [x] Apply migration transactionally and preserve migration 1 behavior. A
  database already at v1 must upgrade once; opening a v2 database again must
  not repeat the migration.
- [x] Do not add assets or FTS tables in this migration; those belong to later
  waves.
- [x] **Done when:** tests upgrade a pre-existing v1 DB, verify the v2 schema,
  preserve Wave 1 metadata, and verify a second open is idempotent.

### W2.4 — Add host protocol and transactional conversation upsert

- [x] **Files:** `lib/sync/protocol.ts`, `local-app/host/handlers.ts`,
  `local-app/host/db.ts`, shared parser module, and host tests.
- [x] Add typed `beginRun`, `upsertConversation`, and `endRun` request/reply
  messages. Validate protocol envelopes and required fields before touching the
  database; reject malformed payloads explicitly.
- [x] `beginRun` records the account scope and run. `upsertConversation`
  verifies the supplied SHA-256 against the raw payload, then in one DB
  transaction inserts or updates the conversation and rebuilds its message
  rows from the shared parser. Preserve all mapping nodes/branches and mark
  `is_on_active_branch` consistently with `current_node`.
- [x] Return `inserted`, `updated`, or `noop`. A repeat with the same hash must
  not rewrite message rows; a changed hash must replace the derived rows
  atomically. Associate failures with the run where applicable.
- [x] `endRun` persists completion, counts, cancellation, and failure status
  using the migration schema.
- [x] **Done when:** host tests prove insert → noop → update, account scoping,
  all-branch persistence and active-branch flags, hash/payload rejection,
  rollback on a failed upsert, and run completion. Existing host tests still
  pass.

### W2.5 — Sync the active chat from the popup

- [x] **Files:** `entrypoints/background.ts`, `lib/sync/*`,
  `entrypoints/popup/App.tsx`, and focused tests.
- [x] Add a popup **Sync this chat** action that requests the active tab and
  conversation ID, checks that it is a supported ChatGPT tab, obtains the
  current account scope and conversation payload through the extracted client,
  computes SHA-256, and sends only the account scope/payload/hash to the host.
- [x] Use `beginRun` → `upsertConversation` → `endRun`; ensure run completion
  and user-visible error reporting on every failure path. Do not silently
  convert API, parsing, host, or persistence errors into success.
- [x] Show whether the result was inserted, updated, or unchanged, and prevent
  duplicate clicks while the request is in flight. Keep connection diagnostics
  in the expandable local-sync section.
- [x] Add tests for a non-ChatGPT tab, missing conversation ID, each host
  result, API/host failures, and the message boundary: access tokens and
  cookies must never be included in host messages.
- [x] Signed-in DB inspection observed completed single-chat runs with `new=1`
  and subsequent `updated=1` outcomes, with no recorded failures.
- [x] A same-chat resync attempt returned `updated=1` again (55 messages), not
  `unchanged=1`. The host compares the full raw JSON hash; this result alone
  does not identify which response field differed.
- [x] Sanitized inspection of the stored sync response found a root `mapping`
  with 56 nodes (55 containing messages) and no `messages[]`, `page_info`, or
  cursor fields. This differs from the DevTools `conversations/{id}` response
  with `num_turns=10`; absence of pagination metadata does not prove the sync
  response is always complete.
- [x] On a changed resync, the host now logs a bounded `SYNC_DIFF` containing
  normalized field paths and change categories only. It omits IDs and values;
  oversized payloads explicitly skip this diagnostic.
- [x] Two same-chat resyncs reported only `safe_urls[]` as `value-changed`
  (neither diff was truncated); no message, title, or root timestamp path
  changed. This explains `updated=1` under the current full-raw-payload hash.
  The sanitized diff cannot distinguish changed array values from a reorder,
  and whether `safe_urls` should count as a semantic update remains a product
  decision.
- [ ] **No-op acceptance still pending:** observe `unchanged=1` for a sync
  where the fetched conversation payload matches the stored payload. After
  loading the updated native host, share only the `SYNC_DIFF` line from
  `%LOCALAPPDATA%\ChatGPTBackup\logs\host.log` after another same-chat sync.

### W2.6 — Add a read-only DB inspection CLI

- [x] **Files:** `local-app/scripts/db-query.mjs` and focused CLI tests.
- [x] Add `counts`, `list`, `runs`, and `show <id>` commands using a read-only
  SQLite connection. `counts` reports stored row totals; `list` gives a compact
  conversation summary; `runs` shows recent outcome counts without chat IDs;
  `show` prints the selected chat and message count.
- [x] Validate command arguments and return a non-zero exit status with a
  useful message for an unknown command, missing ID, or DB error. Do not add
  mutation commands.
- [x] Treat output as private: conversation titles and messages must not be
  printed by `counts` or `list`; `show` is explicitly requested for local
  inspection and should include only the selected record.
- [x] **Done when:** tests verify all commands, unknown/missing input,
  read-only behavior, and output shape against a temporary v2 database.

## Wave exit checklist

- [x] API findings and unknowns are recorded with no secrets or real
  conversation content.
- [x] Client/parser extraction passes compile and existing regression tests.
- [x] A v1 DB upgrades to v2 and reopens without repeating migrations.
- [x] Host round-trip persists a conversation, all branches, and a sync run;
  unchanged input is a no-op and changed input updates atomically.
- [x] Popup action syncs only the active conversation and reports outcomes and
  failures accurately.
- [x] Host-bound messages contain no bearer token, JWT, or cookie.
- [x] Read-only DB CLI works against the test DB and cannot mutate it.
- [ ] Signed-in manual check confirms insert → metadata-only (`safe_urls[]`)
  → unchanged. Insert and updated outcomes are observed; a same-chat resync
  changed only safe-URL metadata, and the new behavior awaits live confirmation.
- [x] Run `corepack pnpm compile`, `corepack pnpm test:local-sync`,
  `node --test .\tests\messaging-bugs.test.mjs`,
  `corepack pnpm build`, and
  `node .\tests\local-app\connection.browser.mjs`.

**Wave 2 exit:** one current chat round-trips into SQLite, API assumptions have
written evidence, and the signed-in manual acceptance check passes. Wave 3
implementation proceeded at the user's request while that live check remains
pending; do not mark Wave 2 closed or sign off live Wave 3 acceptance until the
check has been completed.
