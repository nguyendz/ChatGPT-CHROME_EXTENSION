# Local Sync - Wave 6: Local Viewer Plan

Companion to the [development waves](./local-sync-development-waves.md) and
[local-sync design reference](./local-sync-feature.md).

**Status:** Wave 6A implemented. Reader/API tests, isolated real-Chrome checks,
and a read-only API smoke test of the current 10-chat archive pass. Final user
visual acceptance remains pending. Waves 6B and 6C are not implemented.
**Decisions confirmed:** 2026-10-20. Build a separate localhost browser app.
Deliver browse/read first; add branch navigation, search, and export in later
Wave 6 milestones. This document does not start a `.planning/` workflow.

## 1. Goal and starting evidence

Open the local archive in a browser, select a saved chat, and read it without
ChatGPT, an extension connection, or a network request to a remote service.
The first useful release is a read-only viewer, not another sync interface.

Read-only inspection of the current archive on 2026-10-20 confirmed:

- Schema version 3, tracked by `schema_migrations`, not `PRAGMA user_version`.
- One account, 10 conversations, and 566 stored message rows across all branches.
- Latest run: `incremental`, `completed`, 8 new, 2 updated, 0 unchanged, 0 failed.
- Raw conversation JSON and normalized message rows are already stored.
- No `messages_fts` table or viewer implementation exists.

These are aggregate observations, not committed chat IDs, titles, or contents.
The 566 rows are not necessarily all on the selected branches. This checkpoint
does not establish complete remote-history coverage or close the remaining
Wave 2/3 repeat-sync acceptance checks.

### Existing code to reuse

| Resource | Reuse / constraint |
|---|---|
| `local-app/scripts/db-query.mjs` | Data-directory resolution and read-only SQLite access patterns. Its timestamp-sorted `show` output is not a branch-ordering algorithm. |
| `local-app/host/db.ts` | Schema, account ownership, migrations, and transactional sync fixtures. Do not call `openDatabase()` from the viewer: it is a writer and performs migrations/startup maintenance. |
| `lib/chatgpt-parse.ts` | Raw conversation types and message-content normalization. Mapping keys and message IDs need not be interchangeable. |
| `lib/export-document.ts` | Shared export content model and safe-link helper. It is not a complete Markdown/JSON serializer. |
| `tests/local-app/*.test.mjs` | Node test runner, temporary database fixtures, and isolated-process testing patterns. |

## 2. Milestones and scope

| Milestone | Deliverable | Release gate |
|---|---|---|
| **6A - Browse and read** | Start a local viewer, list saved chats, choose an account/chat, read the active branch, refresh from the DB. | The current 10 chats are browseable offline without modifying the archive. |
| **6B - Navigate and find** | Branch navigation and account-scoped FTS5 search; safe richer rendering is already included in 6A. | Search results open the correct chat and branch; indexing stays correct after sync. |
| **6C - Export** | Explicit user-requested Markdown and raw JSON downloads from saved data. | Export scope is clear and the DB stays unchanged. |

Not required for 6A: FTS indexing, alternate-branch controls,
exports, assets, a desktop installer, a popup launch button, or an MCP server.
Not part of this wave: editing/deleting chats, syncing from the viewer,
reconciliation, automatic sync, cloud hosting, or exposing the server on a LAN.

Wave 6A can proceed with the existing archive. Waves 4 and 5 are not prerequisites.
Unavailable images/attachments must be shown honestly as unsupported/not stored;
do not fetch them from ChatGPT or activate remote URLs automatically.

## 3. Architecture

```text
User starts viewer command
    |
    +-- Node 24 HTTP server, bound only to 127.0.0.1 on an OS-selected port
    |       |
    |       +-- Static, locally built UI
    |       +-- Authenticated, read-only JSON endpoints
    |       +-- Separate SQLite read-only connection -> existing sync.db
    |
    +-- Prints a local launch URL with a per-process access token

Browser UI <---- localhost HTTP ----> viewer
Native sync host ------------------> same DB through the existing WAL writer
```

- Resolve the archive with `CHATGPT_SYNC_DATA_DIR`, otherwise
  `%LOCALAPPDATA%\ChatGPTBackup`, matching the existing CLI.
- Start independently of Chrome Native Messaging. Closing the popup must not
  stop the viewer; stopping the viewer must not stop or finalize a sync run.
- Use Node's built-in HTTP/SQLite facilities. Reuse declared React dependencies
  for the UI and a small standalone Vite build. Declare any directly invoked
  build dependency explicitly; do not rely on WXT's transitive dependencies.
- Keep the viewer build separate from the WXT extension build and manifest.
- Serve UI assets locally; no CDN, analytics, remote fonts, or external scripts.
- Start manually and print the URL. Automatic browser launching and an extension
  launch button are optional follow-ups, not blockers.

### Archive safety and consistency

- Open `DatabaseSync` with `{ readOnly: true }` and enable `query_only`.
  A missing database is an explicit error, never an empty successful archive.
- Check the schema version and required columns. Support schemas 3 and 4;
  reject incompatible schemas with a clear update instruction.
- Do not migrate, seed, set `journal_mode`, repair rows, update metadata,
  or mark running syncs failed. The sync host remains the only archive writer.
- Reuse existing WAL mode. Bound read transactions and apply a busy timeout;
  never hold a snapshot open across browser interactions.
- Read a conversation's raw mapping and normalized messages consistently in
  a short snapshot. Return a revision based on `raw_sha256`.
- Message-page requests include that revision. If a sync changes it between
  requests, respond with an explicit stale-view conflict and offer Reload.
- Refresh is user-triggered in 6A. Do not silently mix old and new revisions.

### Local access boundary

- Bind only to `127.0.0.1`, not `0.0.0.0` or a network interface.
- Generate a cryptographically random per-process token. Put it in the launch
  URL fragment, not a query string; the browser removes the fragment after
  reading it and keeps the token in memory.
- Send the token in an authorization header for private API requests.
  A reload without an in-memory token prompts the user to reopen the launch URL.
- Validate the Host header against the actual bound address/port and reject
  mismatched Origin headers. Do not enable cross-origin access.
- Require authentication on every data/export route. Do not use ambient cookies.
- Use `Cache-Control: no-store`, a restrictive content security policy, and
  a no-referrer policy. Keep chat contents and tokens out of server logs.
- Render stored content as untrusted data. Markdown and raw HTML now pass through
  an allowlist sanitizer before React rendering, never unsanitized `innerHTML`.
  Code remains escaped; fenced HTML has an opt-in sanitized preview. Scripts,
  event handlers, inline styles, forms, embedded objects/pages, and automatic
  media requests stay disabled.
- No arbitrary filesystem path, SQL, or write endpoint is exposed.

## 4. Wave 6A user experience

### Layout

- Header: **Local archive**, account selector, Refresh, and local-only status.
- Sidebar: paginated conversation list with title, updated time, last-synced
  time, and stored-message count. Use an explicit untitled fallback.
- Main panel: selected title and readable messages on the active branch.
  Distinguish user, assistant, system, and tool roles without relabeling all
  non-user messages as assistant.
- Preserve newlines, code text, long words, and horizontal scrolling where
  needed. Show model/timestamp metadata when available.
- Empty database/account, no selection, loading, stale revision, and failed
  requests have distinct states. Never turn an error into "No chats".
- Show alternate-branch counts if available, but do not interleave those messages
  into the active transcript. Branch switching belongs to 6B.
- Display unsupported content as a labeled fallback. Do not claim attachments
  are backed up merely because their references exist in stored JSON.
- Support keyboard selection, visible focus, descriptive controls, and a
  narrow-window layout that can switch between list and detail.

### Transcript correctness

The transcript is a tree path, not a timestamp-sorted list.

1. Walk `raw_json.mapping` from `current_node` through `parent` mapping keys.
2. Detect cycles and missing referenced nodes; reverse the path to root-to-leaf.
3. Traverse through message-less nodes but do not invent message bubbles for them.
4. Resolve each mapping node's message using the existing parser conventions;
   test cases where mapping keys differ from message IDs.
5. Keep equal or missing timestamps in tree order.
6. If the active leaf/path is invalid, show a visible data-integrity warning
   rather than silently concatenating every branch.

Do not change sync normalization or rewrite the archive to make the viewer work.
If shared parsing logic is extracted, preserve existing sync behavior and tests.

### Initial read contracts

All endpoints are authenticated, use prepared SQL, validate inputs, and enforce
account ownership. The client never supplies raw SQL or a database path.

| Route | Purpose |
|---|---|
| `GET /api/status` | Schema support and aggregate archive counts; no raw payloads or access token. |
| `GET /api/accounts` | Local profile identifiers/labels for explicit account selection. |
| `GET /api/groups?accountId=...` | Account-scoped project/GPT folders, saved project names/details where available, unmarked/other buckets, and local counts. |
| `GET /api/conversations?accountId=...&limit=...&cursor=...` | Summary list only, with a next-page cursor. |
| `GET /api/conversations/:id?accountId=...` | Metadata, revision, active-branch count, and warnings. |
| `GET /api/conversations/:id/messages?accountId=...&revision=...&cursor=...&limit=...` | Ordered active-branch message page, not raw mapping or all branches. |

- Account scope is required even when only one account exists.
- Conversation lists accept an optional `group` ID (default `all`). List
  cursors are bound to both account and folder; message paging remains tied
  to the selected conversation revision.
- Sort the list deterministically by `update_time DESC, id ASC`, with null
  timestamps placed last. Cursor pagination uses the same ordering.
- Default list page: 50, maximum: 100. Default message page: 100, maximum: 200.
  Reject invalid limits/cursors rather than silently changing their meaning.
- Return explicit invalid-input, unauthenticated, not-found, stale-revision,
  busy, and incompatible-schema errors. An ID from a different account is
  not a successful lookup.
- Bound response sizes; do not truncate message text silently. If an individual
  stored message cannot be served within the documented limit, surface the
  limitation explicitly.

## 5. Implementation sequence

The 6A reader, server, UI/build, and tests below are implemented. Keep later
milestones separate; the viewer is not another sync writer.

| Task | Work / likely files | Depends on | Done when |
|---|---|---|---|
| **6A.1 Reader** | `local-app/viewer/archive.ts`; read-only schema checks, scoped list/detail reads, active-path reconstruction, revision-aware pagination. | Existing schema 3 archive | Synthetic multi-account and branch fixtures return correct bounded results; rows/schema stay unchanged. |
| **6A.2 Local server** | `local-app/viewer/server.ts`; static assets, authenticated routes, local binding, error mapping, shutdown. | 6A.1 | Ephemeral-port startup works; missing token, foreign Host/Origin, invalid input, and missing DB are rejected. |
| **6A.3 UI/build** | `local-app/viewer/ui/`, viewer Vite config, root package scripts, type-check coverage. | Read contracts; final integration needs 6A.2 | Locally built React UI lists/selects/reads chats, handles all states, and performs no remote fetches. |
| **6A.4 Integrated acceptance** | `tests/local-app/viewer*.test.mjs`, browser smoke test, README/privacy updates. | 6A.1-6A.3 | Isolated tests pass, concurrent sync/read works, then the user can read the existing 10-chat archive offline. |
| **6B.1 Branches** | Reader branch selection and UI branch controls, reusing the existing safe Markdown/code renderer. | 6A accepted | Switching sibling branches preserves shared ancestry and never changes stored `current_node`; hostile markup is inert. |
| **6B.2 Search indexing** | Host-owned schema migration and FTS maintenance; viewer search queries. | 6A accepted; coordinate host/viewer schema compatibility | Existing rows are backfilled; insert/update/delete/rollback tests keep the index consistent; cross-account results are excluded. |
| **6B.3 Search UI** | Query input, bounded snippets, result-to-branch navigation. | 6B.1, 6B.2 | A result from an inactive branch opens that branch and locates the matching message; invalid FTS syntax is reported clearly. |
| **6C.1 Export** | DB-backed Markdown serializer and raw JSON download routes/UI. | 6B accepted | Downloads match the documented scope, have safe filenames, and do not modify the DB. |

Within 6A, UI work can use synthetic contract fixtures while the reader/server
are built. Do not delay the first browse/read release for 6B or 6C.

### Later milestone details

**FTS:** the viewer stays read-only even when search arrives. The native host
owns the versioned migration, backfill, and transactional index maintenance.
Do not let opening a viewer create `messages_fts`. Define whether search covers
all branches explicitly; the intended default is all stored branches, with the
matching branch identified in results. Never render FTS snippets as trusted HTML.

**Export:** Markdown defaults to the currently displayed branch and labels that
scope. Raw JSON exports the full saved payload, including alternate branches,
with a clear warning about private metadata. Preserve original stored JSON for
raw export, not the viewer's display projection. Use explicit user actions, no
automatic export files, and no extension download feature restoration.

**Optional later:** extension launch shortcut, read-only MCP integration,
offline asset rendering after Wave 5, packaging, and background refresh. These
are not entry gates for the approved milestones.

## 6. Verification and acceptance

### Automated fixtures and tests

Use synthetic data only; never copy the user's archive or debug log into tests.

- Read-only behavior: missing DB is not created; schema/rows and sync-run state
  are unchanged by viewer requests. A sync's legitimate writes are tested
  separately, not mistaken for viewer writes.
- Accounts/listing: multiple profiles, duplicate titles, untitled chats, null
  dates, stable cursor boundaries, empty account, and requests for another
  account's conversation.
- Transcript: branching/edit/regeneration, message-less root, distinct mapping
  and message IDs, repeated/missing timestamps, missing parents, invalid leaf,
  cycle detection, and unsupported/mixed content.
- Message pagination: no missing/repeated nodes, consistent revision, and a
  visible stale-view response after a concurrent sync update.
- Local server: port readiness, token enforcement, Host/Origin rejection,
  malformed cursors, SQL-like inputs, static path traversal, clean shutdown.
- Browser: select two chats, paginate a long transcript, refresh, keyboard
  navigation, narrow layout, explicit errors, inert hostile HTML, no remote
  requests, and a missing-token launch.
- Sync coexistence: hold a read briefly, sync through the real host database
  API in a temporary directory, and confirm no writer lock or transaction is
  held across UI requests.
- Later: FTS migration/backfill/update/rollback and branch-aware search;
  Markdown/JSON export scope, safe filenames, and private-response caching.

### Implemented commands

```powershell
corepack pnpm viewer:build
corepack pnpm viewer
```

`viewer` starts the production-built localhost server. It must report a missing
UI build with the build command, rather than serving a blank page.

Validation uses the existing tools, with focused selectors first:

```powershell
corepack pnpm compile
node --test .\tests\local-app\viewer*.test.mjs
node .\tests\local-app\viewer.browser.mjs
corepack pnpm viewer:build
corepack pnpm build
```

The viewer-specific commands/files above are implemented. The browser test uses
a disposable Chrome profile and synthetic archive; set `CHROMIUM_PATH` if needed.
Run existing parser/host tests too if shared parsing or schema code changes.
During a self-contained browser check, stop the test server/browser afterward.

### Implementation checkpoint (2026-10-20)

- `local-app/viewer/archive.ts`: read-only schema-3/4 reader, account scoping,
  deterministic cursors, active-path validation, and revision-aware paging.
- `local-app/viewer/server.ts`: authenticated loopback-only server, private
  response headers, bounded responses, locally built assets, and shutdown.
- `local-app/viewer/ui/`: React list/reader, account selection, Refresh,
  explicit errors/warnings, long-chat pagination, and narrow-window navigation.
- Project grouping now derives account-scoped folders from saved root metadata:
  `snorlax` + `g-p-` IDs for observed project-like groups; `gpt` + `g-` IDs
  for custom GPTs. Missing markers and unclassified markers remain separate.
  Wave 4A enriches stable project groups with saved sidebar names/details,
  including zero-local-chat projects and older metadata indicators. Schema 3
  and groups without saved names retain provisional labels. Only the host
  migrates/writes the catalog; the viewer stays read-only.
- Rich rendering was added at the user's request: GFM Markdown, sanitized raw
  HTML, opt-in HTML-code previews, readable tables/code, safe external links,
  and blocked-image placeholders. This does not enable branch navigation,
  search, or exports. Browser fixtures check formatted output and malicious
  markup in both normal messages and HTML previews.
- `tests/local-app/viewer.test.mjs`: synthetic read-only, account, branch,
  concurrency, API boundary, size-limit, and performance checks.
- `tests/local-app/viewer.browser.mjs`: real Chrome checks for pagination,
  account switching, sanitized hostile markup, keyboard selection, narrow
  layout, changed-revision reload, local-only requests, and missing-token state.
- A fixture with 1,000 chats / 50,000 message rows returned a first 50-chat
  page in 2.2 ms and its first message page in 0.2 ms on this machine.
- The real archive API smoke check opened all 10 conversations and paged
  through 559 active-branch messages of 566 stored rows, with no active-path
  warnings. No titles, message bodies, or account identifiers were logged.
- User comparison of displayed chats with expected content remains the final
  live acceptance step. Search/FTS, branch switching, and export remain deferred.

### 6A live acceptance checklist

1. Build/start the viewer; open the printed loopback URL.
2. See the existing account and exactly the conversations currently stored
   (10 at this checkpoint). Do not assume all remote chats are backed up.
3. Open at least two chats and compare their active paths with stored data.
   Verify a long chat loads all active messages across page boundaries.
4. Disable external network access while keeping loopback available. Browsing
   and reloading saved chats still work; no ChatGPT login/extension port is used.
5. Refresh after a separately initiated sync; updated content appears only as
   a coherent revision. The viewer must not start a sync by itself.
6. Observe no viewer changes to conversation/message rows, schema, or run status.
   Sidecar WAL/SHM file activity alone is not proof of an archive data write.
7. On a local synthetic fixture of 1,000 chats / 50,000 messages, target a first
   list page and first 100-message page within 1 second each after startup;
   record actual measurements. Never preload the entire archive into the UI.
8. Stop the viewer cleanly; the archive and extension sync remain usable.

**6A exit:** all required automated checks and the live read-only acceptance
pass. Track branch/search/export separately; do not label all of Wave 6 complete
when only browse/read is delivered.
