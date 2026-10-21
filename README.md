# ChatGPT Local Sync

A Chrome extension for syncing saved ChatGPT conversations to a local SQLite
database through a Chrome Native Messaging host.

## Current behavior

- **Sync latest 10 chats (validation)** is the default scope. The extension
  scans every conversation-list page, ranks parseable `update_time` values, and
  fetches details only for the 10 most recently updated chats. Choose **All
  chats** to sync the full list. Missing or mixed timestamps stop latest-10
  mode rather than guessing the order.
- Every request to ChatGPT is serialized and separated from the preceding
  request by at least two seconds after its response is read.
- Sync results report new chats and newly added message IDs, along with
  updated, unchanged, and failed chat counts.
- **Stop** finishes the current request/upsert and preserves conversations
  already committed. A later run starts the list scan again from the beginning.
- **Open** expands the local-sync details, including **Sync this chat**,
  connection status, and diagnostics.
- A safe-URL-only change refreshes conversation metadata without rewriting
  message rows; an identical payload is a no-op.
- ChatGPT credentials stay in the extension and are not sent to the local host.
- Sync is manual. Project/archive reconciliation and automatic sync are not
  included yet.
- File downloads and conversation exports are not part of this extension.

For local setup, host registration, verification, and removal, see the
[local development waves](./docs/local-sync-development-waves.md#run-wave-1-locally).
The [Wave 3 plan](./docs/local-sync-wave-3-plan.md) records all-chat behavior
and remaining live acceptance checks.

## Inspect the local database

The read-only CLI can report row counts and recent sync outcomes:

```powershell
node .\local-app\scripts\db-query.mjs counts
node .\local-app\scripts\db-query.mjs runs
```

`list` shows compact conversation IDs; `show <id>` displays a selected
conversation. These commands open the database read-only.

## Local archive viewer (Wave 6A)

Browse synced chats in a separate localhost browser app:

```powershell
corepack pnpm viewer:build
corepack pnpm viewer
```

Node.js 24 or newer is required. Open the **full private URL** printed by the
command. Keep that terminal running; press Ctrl+C to stop the viewer. The
viewer binds only to `127.0.0.1` on a randomly assigned port, not your LAN.
It reads `%LOCALAPPDATA%\ChatGPTBackup\sync.db`; set `CHATGPT_SYNC_DATA_DIR`
before starting to use another archive directory. It never creates a missing
database, migrates its schema, or starts a sync.

- Select an archive account and a conversation to read its active branch.
  Message order follows the saved mapping tree, not timestamps.
- The sidebar groups saved chats into provisional **Unnamed project** and
  **Unnamed custom GPT** folders, plus **No project marker**. Unknown marked
  metadata appears under **Other marked chats**, not as an inferred project.
  **All conversations** preserves the complete account list. Folder counts and
  pagination are account-scoped; switching folders clears the open chat.
- Project grouping uses conversation-root `gizmo_type = "snorlax"` with a
  `g-p-` gizmo ID; custom GPTs use `gizmo_type = "gpt"` with a `g-` ID.
  These are observed API conventions, not verified remote project names.
  No project names are stored, so labels are provisional numbers ordered by
  saved IDs and may renumber when groups change. Grouping never writes to the DB.
- Use **Load more conversations/messages** for longer archives and chats.
- Use **Refresh archive** to reread saved data. If a sync changes a conversation
  between message pages, choose **Reload conversation** rather than mixing
  different versions.
- The private launch token is removed from the address bar and retained only
  in tab memory. Browser reload loses authorization; reopen the printed URL.
  Do not share it or terminal screenshots containing it.
- The app works without ChatGPT access or a running extension. Viewing is
  read-only and does not finalize or interfere with sync runs.
- This first milestone is an escaped text preview. Images and attachments
  are not fetched/rendered, and alternate branches are counted but not shown.
  Branch navigation, search, and exports are later Wave 6 milestones.

The viewer currently supports archive schema 3. It reads at most 50 chats or
100 messages per default page (maximum 100 / 200), with explicit errors for
responses over 8 MiB or saved raw conversations over 60 MiB. Content is never
silently truncated.

Checks:

```powershell
corepack pnpm test:viewer
corepack pnpm test:viewer:browser
```

Build the viewer first for the browser check. That check uses a disposable
Chrome profile and synthetic archive, then cleans up both; no ChatGPT login
or real chat content is used. Set `CHROMIUM_PATH` to override Chrome's path.
See the [Wave 6 plan](./docs/local-sync-wave-6-plan.md) for the staged scope.

## API diagnostics

To investigate ChatGPT API behavior, open a signed-in ChatGPT tab, choose
**Open** in the extension, expand **Developer diagnostics**, and select
**Probe ChatGPT API**. It makes bounded read-only requests and records a
sanitized report in
`%LOCALAPPDATA%\ChatGPTBackup\logs\host.log`. Review only the `API_PROBE`
entries when sharing probe results. Failed sync runs add a sanitized
`SYNC_RUN_FAILURE` category summary to the same log; it excludes chat IDs and
failure text.

All-chat and latest-10 sync read list pages until an empty page confirms the
end. ChatGPT's `total` can grow with the offset (for example, 51 then 101);
it is not treated as an exact count or a consistency check. Short pages do
not stop listing. Duplicate IDs still trigger one restart, and persistent
duplicates fail explicitly. Listing progress shows the number read without
an assumed total.

Sync also writes full conversation-list and conversation-detail HTTP response
bodies to `%LOCALAPPDATA%\ChatGPTBackup\logs\api-debug.jsonl`, including
non-success responses and invalid JSON before validation. This private local
debug log includes chat titles, IDs, message contents, request URLs, HTTP status,
attempt numbers, and pagination checks with exact rejection reasons. Session
responses, request headers, and cookies are not captured; occurrences of the
active access token in response bodies or network errors are redacted.

Each JSONL line contains `runId`, `entryId`, zero-based `part`, `parts`, and
`data`. Group by `(runId, entryId)`, sort by `part`, verify all `parts` are
present, concatenate `data`, then parse the resulting JSON to reconstruct an
event. Large bodies are chunked, not truncated. The log is append-only and
has no automatic rotation; delete it manually when debugging is finished.
**Do not share this file without reviewing and redacting private content.**
A debug-log write failure explicitly fails the affected sync operation.
Rebuild/reload the extension and restart any existing native-host connection
after updating so both sides support debug logging.

## Development checks

```powershell
corepack pnpm compile
corepack pnpm test:local-sync
node --test .\tests\messaging-bugs.test.mjs
corepack pnpm build
```
