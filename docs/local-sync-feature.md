# Feature: Local Sync (ChatGPT → Local Database)

> **Current implementation:** this is a design reference, not a complete feature
> inventory. Manual current-chat and incremental sync, local diagnostics, and
> the separate read-only Wave 6A viewer are implemented. Wave 4A project metadata
> and viewer labels are implemented with signed-in acceptance pending. Wave 5
> image/file download (opt-in per run), viewer display, and Markdown export with
> files are implemented and automatically verified; signed-in acceptance is
> pending (see the [Wave 5 plan](./local-sync-wave-5-plan.md)).
> Wave 4B/4C coverage/reconciliation and account-selection work remains planned
> in the [detailed Wave 4 plan](./local-sync-wave-4-plan.md); archived-chat
> coverage and scheduled/live sync are descoped. Delivery and live
> acceptance status are tracked in the wave plans, not inferred from this design.

| | |
|---|---|
| **Status** | Design reference, rev 2 (reviewed; implementation status is in the [development waves](./local-sync-development-waves.md)) |
| **Owner** | TBD |
| **Affects** | `entrypoints/background.ts`, `entrypoints/popup/`, `wxt.config.ts`, `local-app/` |
| **Delivery plan** | [local-sync-development-waves.md](./local-sync-development-waves.md) |

### Constraints (rev 2)
- **Local use only.** The extension is loaded unpacked (`Load unpacked`) and is **not** published to the Chrome Web Store. No store listing, privacy declarations, or installers for other users.
- **Windows + Chrome** are the target. Edge only needs one more registry key and is optional. macOS, Linux, and Firefox are out of scope.
- **Local app stack: Node.js 24 + TypeScript.** Node 24 runs `.ts` directly through type stripping, and `node:sqlite` is built in. Both were checked on this machine (SQLite 3.53.1). There is no build step and no native modules, and the protocol types are shared with the extension. C#/.NET is a valid alternative, but the .NET SDK is not installed here (§16, R4).

---

## 1. Summary

The extension provides **Sync** for the currently open saved conversation. The
popup sends the raw conversation to a **local database** owned by a **local app**
(a native-messaging host; see §10). ChatGPT requests run in the logged-in
browser session; the access token stays in the extension. The current
implementation supports manual single-chat and incremental history sync.
Wave 4 extends it with project metadata, verified project-chat coverage,
reconciliation, and account selection; all runs remain user-started.

> **Why a local app?** A Chrome extension cannot open SQLite or other databases
> or write freely to the file system. A local process owns the database, and
> the extension talks to it through Native Messaging.

---

## 2. Goals and non-goals

### Goals
1. **Incremental one-way sync**: ChatGPT → local DB. Fetch only conversations that are new or whose `update_time` changed since the last sync.
2. **Lossless storage**: keep the **raw** conversation payload, including the full `mapping` tree with all branches, regenerations, and edits. Also keep a normalized form for querying.
3. **State visibility**: the extension popup shows the connection status, the last sync time, and local vs. remote counts. It also shows pending changes and progress.
4. **Resumable and idempotent**: a sync interrupted by a closed browser, a stopped service worker, a 429 response, or a crash continues safely. Writing the same data twice changes nothing.
5. **Assets (optional)**: sync images and attachments into a content-addressed local store. Duplicate files are stored once.
6. **Detect remote deletions** without destroying local data: by default, a conversation deleted on ChatGPT is *marked*, not removed locally.
7. **Security**: the ChatGPT access token never leaves the extension. Only allowed extensions can reach the local app.

### Non-goals (for this feature)
- **Two-way sync**, meaning pushing local edits back to ChatGPT. ChatGPT has no supported write API for this, so "sync" here means **mirroring**.
- Cloud or multi-device replication of the local DB. Users can put the DB in a synced folder at their own risk.
- Creating downloaded export files. This extension is now sync-only.
- Syncing temporary chats. ChatGPT does not list them.

---

## 3. Users and use cases

| Persona | Use case |
|---|---|
| Power user / researcher | Keep a searchable, always-current archive of all chats. Query it with SQL or scripts. |
| Developer | Use the local DB as a data source for tools such as RAG, analytics, or a personal knowledge base. |
| Writer / student | Use "Sync" so the archive stays current without re-downloading 2,000 chats each time. |
| Privacy-conscious user | Keep a local copy in case of account loss, workspace removal, or retention-policy changes. |

### User stories
- *As a user, I click **Sync now** and see "Synced 7 new, 3 updated, 1,942 unchanged" within seconds instead of re-downloading everything.*
- *As a user, I enable **Auto-sync every 30 min**, and my local archive stays current while ChatGPT is open in my browser.*
- *As a user, I see in the popup that the local app is **not installed** or **out of date**, with a link to install or update it.*
- *As a user, I can see which conversations were deleted on ChatGPT but kept locally.*
- *As a user, I can force a **full re-sync** (re-validate everything) if I suspect the DB is out of step.*

---

## 4. Current architecture (relevant parts)

The current single-chat implementation and future architecture boundaries are:

| Existing piece | Reuse in Sync |
|---|---|
| `loadToken()` / `clearTokenCache()` | Same auth flow. The token stays in service-worker memory. |
| Conversation-list endpoint (future) | Remote **manifest** listing for all-chat sync; not implemented in the current single-chat client. |
| `fetchConversation(token, id)` with 429/5xx backoff | Fetch changed conversations. |
| `parseConversationNodes()` | Host-side message-row derivation; the raw payload remains the source of truth. |
| Attachment/image retrieval | Wave 5 (implemented; signed-in acceptance pending): two-step `files/download`, opt-in per run; see the [Wave 5 plan](./local-sync-wave-5-plan.md). |
| Project metadata and conversation discovery | Wave 4: 4A saves sidebar names/information for viewer folders; 4B confirms the default list covers project chats, then adds reconciliation. Sidebar previews are not full conversations. |
| Popup sync action and native-host acknowledgements | Current single-chat status and failure feedback. |

Current permissions are `activeTab`, `nativeMessaging`, and host
`https://chatgpt.com/*`.

---

## 5. Proposed architecture

```
┌──────────────────────────── Browser ────────────────────────────┐
│                                                                  │
│  Popup UI ────────────(runtime message)───────────────┐           │
│                                                      ▼           │
│                                   Background service worker      │
│   chatgpt.com  ◀──fetch (session token)──  • Sync engine         │
│   backend-api                             • ChatGPT client       │
│                                           • Host client ─────────┼──┐
└──────────────────────────────────────────────────────────────────┘  │
                                                                      │ Native Messaging
                                                                      │ (stdio, JSON, length-prefixed)
┌──────────────────────── Local machine ───────────────────────────┐  │
│  Native host (Node 24 + TS, local-app/host), started by Chrome   │◀─┘
│  for each connectNative() and stopped when the port closes       │
│   • Protocol handler (versioned)                                 │
│   • Sync state + diff logic                                      │
│   • SQLite DB (WAL) + asset store (content-addressed files)      │
└───────────────┬──────────────────────────────────────────────────┘
                │ same DB file (WAL allows a reader while the host writes)
┌───────────────▼──────────────────────────────────────────────────┐
│  (Wave 6) Local viewer app: search, browse, export from the DB   │
└──────────────────────────────────────────────────────────────────┘
```

### 5.1 Communication options considered

| Option | How it works | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Chrome Native Messaging** | `chrome.runtime.connectNative('com.chatgpt_backup.sync')`. Chrome starts the host executable and they talk over stdio. | No open network port. Chrome lets only extension IDs in `allowed_origins` connect. An open port keeps the MV3 service worker alive. Works in Chrome, Edge, Brave, and Firefox. | Requires registering a host manifest (on Windows, one `HKCU` registry key pointing at a JSON file). Messages from the host to the extension are limited to **1 MB**; messages to the host are limited to **64 MiB**. | ✅ **Recommended (primary)** |
| B. Localhost HTTP/WebSocket server | The app listens on `127.0.0.1:<port>`. The extension calls it with `fetch` or a WebSocket. | Easy to debug. The app can run as a long-lived daemon and serve its own web UI. | Opens a port that any local process or web page can try. Needs a pairing token, strict `Origin` checks, and DNS-rebinding protection. Needs an extra `host_permissions` entry. Port conflicts are possible. | ⚠️ Optional later, for the app's own UI only |
| C. File System Access API (no app) | An extension page calls `showDirectoryPicker()` and writes files. The handle is kept in IndexedDB. | Nothing to install. | Not a DB. Permission must be granted again each session. Not usable from the service worker. No "local status" beyond reading files back. | ❌ Does not meet the "local DB" goal. Possible "lite" fallback |
| D. Downloads API + app watching a folder | The extension downloads JSON. The app imports from the Downloads folder. | No new extension permission. | The extension cannot learn local status, so the sync stays blind and one-way. Fills the folder with leftover files. | ❌ |

**Decision: Native Messaging.** It is the only option where the browser itself controls who can reach the local app and no listening socket is needed. The 1 MB limit for host → extension messages is not a problem because the host sends back only small status, diff, and ack messages. Large payloads go from the extension to the host, where the limit is 64 MiB, and are chunked.

### 5.2 Security model
- **The token never leaves the extension.** The app never calls ChatGPT and never receives the bearer token or cookies. It only receives conversation data that the extension already has.
- **Caller restriction:** the native host manifest lists only this extension's ID in `allowed_origins`. An unpacked extension's ID normally depends on its folder path, so the local build pins the ID with a manifest `key` taken from a git-ignored local file (§16, R2). The host also checks the caller origin that Chrome passes as its first command-line argument.
- **No network exposure:** there is no listening port in the recommended design.
- **Input validation:** the host validates every message against a schema (size limits, types, protocol version) and rejects unknown message types.
- **API probe:** an explicit developer action may send only bounded field paths/types and aggregate probe outcomes to the local host log. Raw ChatGPT responses, access tokens, cookies, identifiers, titles, and message content stay in the extension and are not logged.
- **Data at rest:** the DB is stored in the user profile directory, for example `%LOCALAPPDATA%\ChatGPTBackup\sync.db`. Optional: SQLCipher encryption, or rely on OS disk encryption (document both).
- **Permissions:** add `nativeMessaging` to the local build. No `alarms` permission: scheduled sync is descoped. This is a local-only build, so there is no optional-permission prompt.

---

## 6. Sync algorithm

### 6.1 Identity and scoping
A sync target is the pair **(ChatGPT account user id, workspace/account id)**, read from `/api/auth/session` and the conversation metadata. The host keeps separate data per target. If the logged-in account differs from the last synced account, the popup warns: *"You are logged in as B; local DB was last synced for A. Sync to a separate profile?"* This prevents personal and Team/Enterprise workspace data from getting mixed.

### 6.2 Change detection
ChatGPT's conversation list items expose `id` and `update_time`; the list item's `update_time` is the accepted per-chat no-op token. The detail payload's `update_time` is separate and remains part of raw-payload hashing.

> ⚠️ These are **unofficial** endpoints. Field names, formats (ISO string vs. epoch seconds), and ordering parameters (`order=updated`) must be checked in a spike and kept behind one adapter module, so a change in the API breaks only one place.

### 6.3 Incremental sync (default)
```
1. ext → host  beginRun {runId, mode:"incremental", account}
2. In All-chats mode, ext reads /backend-api/conversations pages (up to 50 per
   request) until an empty page confirms the end, advancing the offset by the returned item count.
   The API total is a hint, not an exact count; changing totals and short pages
   do not end or invalidate a scan. Duplicate IDs trigger one retry from offset 0.
3. In latest-10 validation mode, request only offset=0&limit=10 and select the
   returned entries in response order, without further paging or an end probe.
   This is a bounded validation sample, not verified global recency/completeness.
   All-chats mode selects every enumerated item.
4. ext → host  diffManifest {items:[{conversationId, updateTimeToken}]}
   For exact matching non-null tokens, skip the detail request. Fetch details
   for new/changed IDs and items whose list token is unavailable.
5. Serialize all ChatGPT requests and wait at least 2 seconds after the full
   response is read before starting another request.
6. ext → host  upsertConversation {runId, raw, sha256}
   host → ext  ack {id, status, messageCount, newMessageCount}
7. ext → host  endRun {runId, cancelled, failures}
```
- All-chats early-stop paging is not implemented. Validation deliberately reads
  one small page, independently of the unverified ordering optimization.
- The observed API returns offset-dependent totals such as 51 at offset 0 and
  101 at offset 50, each with 50 items. Listing progress shows only the number
  read; the exact total is set after an empty page is received. The terminal
  request is required even after a short page or an advertised exact total.
- Validation does not rank timestamps. Missing list tokens conservatively fetch
  details, using the existing per-conversation no-op rules.
- `newMessageCount` counts message IDs not previously stored for a conversation; it is separate from the number of new chats and the total messages in the response.
- Sync captures full list/detail HTTP response bodies before validation in the
  private local `logs\api-debug.jsonl` file, including retry/error responses.
  Pagination entries identify the scan, offset, item counts, reported total
  hints, duplicate rejection, and empty-page completion. Large events use acknowledged ordered chunks;
  logging failures are surfaced, not silently ignored. See the README's API
  diagnostics section for reconstruction, credential exclusions, and privacy
  precautions. The sanitized API probe and `host.log` remain separate.

### 6.4 Full reconciliation
Planned in Wave 4B / W4.1 as a manual, user-started run only (no weekly
scheduling; W4.4 is descoped):
- Verify account-scoped coverage of the default list, which includes project
  chats per the W4.3 evidence; consume it to its confirmed terminal condition
  with no early stop. Archived coverage (W4.2) is descoped.
- Deduplicate any additional verified source before manifest comparison/detail
  selection. Latest-10 and All-chats incremental runs do not authorize absence
  reconciliation; only an explicit successful full run does.
- Mark local conversations absent from that verified scope as
  `remote_state = 'missing'`, not “confirmed deleted.” Because archived chats
  are excluded from the default list, a chat archived after it was saved is
  also reported as missing ("no longer in your chat list").
- Unverified/inaccessible coverage, source failures, cancellation, or account
  mismatch prevents missing-state updates. Reappearance clears missing state.
- Optional: `verifyContent`, which re-fetches everything and compares sha256 to repair local corruption.
- Never hard-delete by default. Any opt-in removal setting is off by default
  and cannot bypass the successful-full-run coverage/account gates.

### 6.4.1 Project catalog and folder labels

Wave 4A / W4.0 implements the sidebar's account-scoped project catalog independently
of chat update tokens, on Latest-10 and All-chats runs. The host owns the planned
schema 3 -> 4 migration; the viewer stays read-only and retains schema 3 fallback
labels. Join saved names to stable `project:<gizmo_id>` groups by account and ID;
counts remain local chat counts, including zero-local-chat projects.

Root catalog pagination and nested project-conversation pagination are separate.
The supplied sidebar response establishes metadata shape/names, not complete
project membership or archive coverage. Preserve raw project information and
older metadata on failure/absence; do not infer deleted projects, import previews
as full chats, or fetch icon/file URLs. Metadata failures are explicit and
separate from conversation counts. See the
[Wave 4 plan](./local-sync-wave-4-plan.md) for bounds, contracts, and tests.

### 6.5 Asset sync (images and attachments)
Implemented in Wave 5 (signed-in acceptance pending); the [Wave 5 plan](./local-sync-wave-5-plan.md) owns the details:
- The host derives file references from each stored raw conversation: uploaded
  and generated images, attachments (with `library_file_id` aliases), and
  code-interpreter outputs. Earlier chats are backfilled without re-fetching.
- With the opt-in **Include images & files** checkbox, a user-started run asks
  `listPendingAssets`, downloads each file through `files/download`, and
  streams it to the host in **≤ 4 MB base64 chunks** (`assetChunk`, then
  `assetCommit {sha256, mime, size}`). The host verifies the hash and stores
  the file at `assets/<sha256[0:2]>/<sha256>`, so identical files are stored once.
- Limits: 5 MB per asset, 10 MB and 50 assets per run. Over-cap assets are
  skipped or deferred and reported; asset errors never fail chat sync.

### 6.6 Single-chat sync (live)
Descoped (Wave 4 / W4.5): no automatic trigger runs when a reply finishes or the
user navigates. Single-chat sync remains a manual popup action.

### 6.7 Throttling, resilience, and service-worker lifetime
- Reuse exponential backoff for 429/5xx responses. All ChatGPT session, list, detail, and API-probe requests are serialized with a two-second minimum quiet interval after each response is read.
- Every `upsertConversation` is committed in its own DB transaction. The host tracks listed/new/updated/unchanged/failed chat counts; the extension reports new message IDs separately. The host marks an unfinished owned run failed on shutdown. A subsequent run starts list paging at offset zero; it does not resume from a persisted page cursor.
- An open native-messaging port keeps the MV3 service worker alive (Chrome 105+). The sync client retains the host connection throughout an all-chat run; automatic/alarm-driven recovery is not implemented.
- The host process lives only as long as its port. The background closes the port after about 30 s idle after requests complete, so neither Node nor the service worker stays running for no reason. Each `connectNative()` starts a new host process, so all state lives in the DB, never in host memory.
- Only one run is active per account. The host holds a lock, so two Chrome profiles or browsers cannot sync into the same DB at once. The second caller gets `busy`.

---

## 7. Messaging protocol (v1)

Every message is a JSON envelope:
```json
{ "v": 1, "id": "<uuid>", "type": "upsertConversation", "payload": { } }
```
Responses echo `id` and use `type: "<request>.ok"` or `type: "error"` with `{code, message, retryable}`.

| Type (ext → host) | Payload | Reply |
|---|---|---|
| `ping` | `{}` | `pong {hostVersion, pid, uptimeMs}`. Used for diagnostics (Wave 1). |
| `echo` | `{data, size?}` | `{sha256, bytes}`. Checks large payloads in the extension → host direction (Wave 1). |
| `hello` | `protocolVersion`, `extVersion`, `browser`, `account? {userId, workspaceId, email?}` | `hostVersion`, `protocolRange`, `capabilities[]`, `dbPath`, `lastSync`, `counts` |
| `getStatus` | `account` | `counts {conversations, messages, assets, missing}`, `lastRun`, `activeRun?` |
| `beginRun` | `runId`, `mode: incremental\|full\|single`, `options` | `ok` or `busy` |
| `diffManifest` | `runId`, `items[{id, update_time, title, project_id?, is_archived?}]` | `new[]`, `changed[]`, `unchanged[]` |
| `upsertConversation` | `runId`, `conversationId`, `raw` (≤ 60 MiB, else chunked), `sha256` | `status: inserted\|updated\|noop` |
| `listPendingAssets` | `runId`, `conversationIds?`, `limit` | `items[]` of pending file references |
| `assetChunk` / `assetCommit` / `assetOutcome` | see 6.5 | `stored`/`deduplicated` / `hashMismatch` / recorded state |
| `markMissing` | `runId`, `seenIds` (only for full runs; streamed or summarized) | `markedCount` |
| `endRun` | `runId`, `stats`, `failures[]`, `cancelled` | `summary` |
| `cancelRun` | `runId` | `ok` |

Error codes: `PROTOCOL_MISMATCH`, `BUSY`, `INVALID_PAYLOAD`, `UNKNOWN_TYPE`, `TOO_LARGE`, `DB_ERROR`, `DISK_FULL`, `ACCOUNT_MISMATCH`, `FORBIDDEN_ORIGIN`.

Extension-side errors (from `chrome.runtime.lastError` on disconnect) are mapped to popup states:

| Chrome message | Meaning | Popup state |
|---|---|---|
| `Specified native messaging host not found.` | Registry key or manifest is missing | App not registered |
| `Access to the specified native messaging host is forbidden.` | Extension ID is not in `allowed_origins` | ID mismatch: run `register-host.ps1` again |
| `Native host has exited.` / `Error when communicating with the native messaging host.` | Crash, bad framing, or stdout pollution | Host error: see `host.log` |

**Versioning:** `hello` negotiates the protocol version. If the versions do not overlap, the popup shows *"Update the ChatGPT Sync app"* or *"Update the extension"*.

---

## 8. Local data model (SQLite, WAL mode)

```sql
accounts(id PK, user_id, workspace_id, email, label, created_at)

conversations(
  id PK,                 -- ChatGPT conversation id
  account_id FK,
  title, create_time, update_time,
  current_node,          -- active branch leaf
  project_id NULL, gizmo_id NULL, is_archived,
  raw_json,              -- full payload (or zstd-compressed BLOB)
  raw_sha256,
  remote_state,          -- 'present' | 'missing' | 'archived'
  first_synced_at, last_synced_at, last_seen_remote_at
)

messages(                -- one row per mapping node (all branches)
  id PK, conversation_id FK, parent_id, role, model,
  content_type, text, create_time, is_on_active_branch
)

assets(sha256 PK, size, mime, created_at)   -- file at assets/<aa>/<sha256>
asset_refs(account_id, conversation_id, file_id, kind, node_id, name,
  declared_mime, declared_size, library_file_id, sha256 NULL, state, attempts, ...)

sync_runs(id PK, account_id, owner_id, mode, started_at, ended_at, status,
          listed, new, updated, unchanged, failed, cancelled)
sync_failures(run_id, conversation_id, error, retryable)

messages_fts  -- FTS5 virtual table on messages(text) for local search
schema_migrations(version, applied_at)
```

- `raw_json` is the source of truth. `messages` is a derived table that can be rebuilt from `raw_json` after a parser improvement, with no re-fetch.
- Optional history: a `conversation_versions` table keeps old `raw_json` when `update_time` changes. It is off by default because of disk usage.

---

## 9. Extension UX

### Popup — new "Sync" section
| State | Display |
|---|---|
| Sync disabled | "Keep a local, always up-to-date copy of your chats." → **Set up Sync** |
| App not registered | ❌ "Local sync host not found. Run `local-app\scripts\register-host.ps1`." → **Retry** |
| Version mismatch | ⚠️ "Update required (app v1.0, needs ≥ v1.2)" |
| Connected, idle | ✅ "Local: 1,953 chats · Last sync 12 min ago" → **Sync now** · ⋯ (Full re-sync, Open DB folder) |
| Running | Progress bar (reuses the existing progress port): "Checking 3/40 pages… Fetching 5/10 changed chats" → **Stop** |
| Done | "7 new · 3 updated · 1,942 unchanged · 1 missing remotely" |
| Account mismatch | ⚠️ "Logged in as a different account than the local DB" → choose or create a profile |

### Planned sync settings
- Wave 4C adds account/profile selection to the existing local-sync UI, not a
  mandatory Options page redesign. A changed browser identity never silently
  changes the storage scope.
- Enable Sync, plus a **Test connection** button showing host version, DB path, and round-trip time.
- No auto-sync, scheduled, or live sync: every run is user-started (W4.4/W4.5
  descoped to avoid unattended API traffic).
- **Include images & files** checkbox per run (Wave 5); fixed caps of 5 MB per asset, 10 MB and 50 assets per run.
- Remove local copies of chats deleted on ChatGPT (default **off**).
- ChatGPT request pacing is fixed at two seconds between completed requests; there is no user-configurable throttle.
- Read-only info from the host: DB path, DB size, app version.

---

## 10. Local app

The "local app" is two pieces that share one SQLite file:

| Piece | Lifetime | Wave |
|---|---|---|
| **Native host** (`local-app/host/`) | Chrome starts it for each `connectNative()` and stops it when the port closes. It is **not** a daemon. Only the background service worker opens the port. The popup asks the background for status. | 1–5 |
| **Viewer app** (`local-app/viewer/`) | Started by the user. It reads the same DB in WAL mode for browsing, search, and export. | 6 |

### Native host responsibilities
1. Stdio framing: a 4-byte little-endian length prefix plus UTF-8 JSON. **Stdout carries protocol messages only.** `console.log` is redirected to a log file at `%LOCALAPPDATA%\ChatGPTBackup\logs\host.log`, because one stray print breaks the stream.
2. Checks the caller origin (`argv` contains `chrome-extension://<id>/`) against the expected ID.
3. Owns the SQLite DB (`node:sqlite`, WAL) and asset store, and runs schema migrations at startup.
4. Implements diff, upsert, reconciliation, and a single-writer lock (a lock row or lock file).

### Technology
- **Node 24 + TypeScript, run directly** (`node host/main.ts`). Use erasable-only TS syntax: no `enum`, `namespace`, or parameter properties, and imports include the `.ts` extension. `node:sqlite` is built in.
- **Shared code:** `lib/sync/protocol.ts` (message types and constants) is imported by both the extension (bundled by WXT) and the host (run by Node).
- **Windows launcher:** Chrome needs an executable path, so the host manifest points to `local-app\host\run-host.cmd`. It runs `node --disable-warning=ExperimentalWarning "%~dp0main.ts" %*`.
- **Registration:** `local-app\scripts\register-host.ps1` writes `com.chatgpt_backup.sync.json` (absolute launcher path plus `allowed_origins` with the pinned extension ID). It sets `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chatgpt_backup.sync` to the manifest path, and optionally the Edge key `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\...`. `unregister-host.ps1` removes the keys. No admin rights are needed.
- **Alternative (C#):** a .NET 8+ console app would follow the same protocol and registration, with an `.exe` path instead of a `.cmd`. It needs the .NET SDK, which is not installed here, and the protocol types would be maintained twice.

---

## 11. Changes to this repository

| Area | Change |
|---|---|
| `wxt.config.ts` | Add `nativeMessaging` (and later `alarms`) to `permissions`. Add `manifest.key` **only if** the git-ignored `.local/extension-key.pub.txt` exists, so builds without it are unchanged. |
| `.gitignore` | Ignore `.local/` and the local DB/log paths if they are ever placed inside the repo. |
| `scripts/local/gen-extension-key.mjs` | Generates an RSA key pair, writes the public key (base64 DER) to `.local/`, and prints the extension ID it produces. |
| `lib/sync/protocol.ts` | Shared protocol types and constants, imported by the extension and the host. |
| `entrypoints/background.ts` | Dispatch current-chat and all-chat sync, host status/echo, the sanitized API probe, and the sync progress/cancel channel. |
| `entrypoints/content.ts` | *(Wave 4)* Detect a finished reply and conversation navigation for live single-chat sync. |
| `entrypoints/popup/App.tsx` | Sync section and states (section 9). |
| `entrypoints/popup/LocalSyncPanel.tsx` | Sync action and expandable local status/diagnostics section. |
| `local-app/` | New: `host/` (native host), `scripts/` (register/unregister/smoke), `viewer/` (Wave 6). |
| `tests/` | Host framing and protocol tests (Node test runner, host spawned as a child process), diff/early-stop unit tests, and a fake-host test for the extension's host client. |

---

## 12. Edge cases

| Case | Handling |
|---|---|
| Message edited or response regenerated | New nodes in `mapping` change `update_time` → `changed` → re-upsert. All branches are kept, and `current_node` is updated. |
| Conversation renamed | Same as above. The title is updated, and the change may show in the list item before the detail payload. |
| Conversation deleted on ChatGPT | Detected only by full reconciliation → `remote_state='missing'`. Kept locally. |
| Archived chats | Descoped (W4.2): archived chats are excluded from the default list and are not synced. A chat archived after it was saved keeps its local copy; reconciliation reports it as no longer listed. |
| Project folders/chats | Wave 4A saves actual folder names/metadata. Wave 4B / W4.3 verifies complete project-conversation enumeration and nested paging, deduplicating against other sources before fetching full details. Do not assume an existing discovery helper establishes coverage. |
| Very large conversation (> 60 MiB raw) | Send `upsertConversation` in chunks (`begin` / `part` / `commit`). |
| 429 rate limiting | Exponential backoff (existing). The run pauses and shows "Rate limited, resuming in Xs". |
| Token expired mid-run | Existing 401 → `clearTokenCache()` → retry once. If that fails, the run ends with `needsLogin`. |
| Browser closed mid-run | Committed conversations stay. The next run's diff picks up the rest automatically. |
| Two browsers or profiles sync the same DB | Host lock → second gets `BUSY`. Different accounts are kept separate by `account_id`. |
| Clock skew | Comparisons use ChatGPT's `update_time`, never local clocks. |
| Host crashes or DB is corrupt | Each upsert is its own transaction. WAL mode is used. `PRAGMA integrity_check` is offered in the app. |
| Disk full | `DISK_FULL` error, the run stops cleanly, and the popup explains it. |
| ChatGPT API shape changes | Isolated adapter. `raw_json` is always stored, so the normalized tables can be rebuilt later. |

---

## 13. Delivery

Delivery is planned in waves in [local-sync-development-waves.md](./local-sync-development-waves.md):

| Wave | Goal |
|---|---|
| **1 — Milestone 1: local app + communication** | The extension (loaded unpacked) talks to the registered local host. Ping, hello, and a large echo work. The DB file is created. The popup shows the host status. |
| 2 | API spike plus single-chat sync: the current chat goes into the DB. |
| 3 | Incremental sync (full-list enumeration, manifest no-ops, runs, Stop); early-stop remains gated on ordering evidence. |
| 4 | **4A / W4.0:** project catalog and viewer folder labels. **4B / W4.3, W4.1:** confirmed project-chat coverage in the default list, then manual reconciliation. **4C / W4.6:** account selection. Archived coverage (W4.2) and scheduled/live sync (W4.4, W4.5) are descoped. See the [detailed Wave 4 plan](./local-sync-wave-4-plan.md). |
| 5 | Assets (images and files): host-derived references, opt-in download per run, viewer display, Markdown export with assets. See the [Wave 5 plan](./local-sync-wave-5-plan.md). |
| 6 | Local viewer app: search and export from the DB. |

---

## 14. Acceptance criteria (sync MVP = end of Wave 3)
1. The popup defaults to **Latest 10 chats (validation)** and offers **All
   chats**; **Stop** is available while a run is active. **Open** expands
   local-sync details and exposes **Sync this chat**. No download/export feature
   is included.
2. If the host is not registered, the popup shows "App not registered" with the command to fix it. If the ID is wrong, it shows "ID mismatch".
3. A latest-10 run requests one page with `offset=0&limit=10`, fetches no more than 10 chat details, and performs no further conversation-list paging. Its first-page sample is not guaranteed globally latest. Full-list mode remains available. Completion reports new chats and newly added message IDs separately.
4. Every conversation-list page is scanned. On a repeat run, matching list-item `update_time` tokens skip their `conversation/{id}` detail requests.
5. In **All chats** mode, after the user edits one chat and starts a new chat on chatgpt.com, the next sync reports one new chat and one updated chat, assuming the list item's update token changes for the edit. It separately reports newly added message IDs.
6. **Stop** finishes the in-flight request/upsert. Already-synced data is kept, and a later run restarts list paging from offset zero.
7. The ChatGPT access token never appears in the host's input. A fake-host test checks for token patterns.

---

## 15. Open questions
| # | Question | Status |
|---|---|---|
| 1 | Where does the local app live? | **Resolved:** `local-app/` in this repo. |
| 2 | Host language? | **Resolved:** Node 24 + TypeScript (C# remains an alternative). |
| 3 | Which browsers? | **Resolved:** Chrome. Edge is an optional extra registry key. |
| 4 | Store version history of edited chats? | Open. Default is latest only. Decide before Wave 3 finishes. |
| 5 | Encryption at rest? | Open. Default is to rely on Windows disk encryption (BitLocker). |
| 6 | Chrome Web Store review | **Dropped:** local use only. |
| 7 | Expose the archive to other tools (read-only localhost API or MCP server) from the viewer app? | Open. Wave 6+. |
| 8 | Which account and workspace identifiers does `/api/auth/session` actually return? | Open. Wave 2 spike. |

---

## 16. Design review (rev 2)

The first draft was checked against the new constraints (local install, Windows, Node/C# skills) and against how Chrome Native Messaging works.

| # | Severity | Finding | Resolution |
|---|---|---|---|
| R1 | Scope | The draft assumed store publishing (optional permissions, privacy and store docs, MSI/pkg installers, macOS/Linux/Firefox). | Removed. Use plain `permissions`, a PowerShell registration script, and Windows + Chrome only. |
| R2 | **Blocker** | `allowed_origins` needs a fixed extension ID. An **unpacked** extension's ID is derived from its folder path, so it changes if the repo moves or if `.output/chrome-mv3-dev` is loaded instead of `.output/chrome-mv3`. The draft did not cover this. | Pin the ID with `manifest.key` from a git-ignored `.local/` file. A script generates the key and prints the ID. `register-host.ps1` reads the same ID. (Wave 1, W1.1) |
| R3 | High | The draft described one long-running "companion app". In reality, Chrome **starts a new host process for each `connectNative()`** and stops it when the port closes. If the popup and background both connected, there would be two processes writing to the DB. | The host is stateless between connections, and only the background opens the port. The UI/viewer is a separate process that shares the DB in WAL mode. A single-writer lock remains. |
| R4 | Medium | Go/Rust were recommended, but the owner knows C#/JS. The .NET SDK is not installed; Node 24 is. | Node 24 + TypeScript (type stripping, `node:sqlite`; verified on this machine). Shares protocol types and parser with the extension and needs no build step. |
| R5 | High | Stdout is the protocol channel, so one `console.log` or Node warning corrupts it. Chrome on Windows also cannot run a `.ts` file directly. | Redirect `console.*` to a log file at host startup. Launch through `run-host.cmd` with `--disable-warning=ExperimentalWarning`. Add a smoke test that runs the host outside Chrome. |
| R6 | Medium | Early stop after **one** unchanged page depends on strict `update_time` ordering. Pinned or out-of-order items could cause changes to be missed. | Require 2 consecutive unchanged pages, and keep periodic full reconciliation. The ordering is checked in the Wave 2 spike. |
| R7 | Medium | Sending `normalized?` from the extension meant two representations, and the parser lived inside the `defineBackground` closure. | The extension sends **raw only**. `parseConversation`/`activeBranch` move to `lib/` and the TS host imports them to build `messages`. |
| R8 | Low | No diagnostic messages to prove the channel before the sync logic exists. | Add `ping` and `echo` (size and sha256) to the protocol, which are exactly what Milestone 1 needs. |
| R9 | Low | Chrome's disconnect errors were not mapped to user-facing states. | Error table added to §7. |
| R10 | Low | The host did not check which extension launched it. | The host compares the origin in `argv` with the expected ID and refuses others (`FORBIDDEN_ORIGIN`). |
| R11 | Info | Account identity fields, list ordering, and `update_time` format are unverified (unofficial API). | Wave 2 spike, kept behind one adapter module. |
