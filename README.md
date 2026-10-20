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

## API diagnostics

To investigate ChatGPT API behavior, open a signed-in ChatGPT tab, choose
**Open** in the extension, expand **Developer diagnostics**, and select
**Probe ChatGPT API**. It makes bounded read-only requests and records a
sanitized report in
`%LOCALAPPDATA%\ChatGPTBackup\logs\host.log`. Review only the `API_PROBE`
entries when sharing probe results. Failed sync runs add a sanitized
`SYNC_RUN_FAILURE` category summary to the same log; it excludes chat IDs and
failure text.

## Development checks

```powershell
corepack pnpm compile
corepack pnpm test:local-sync
node --test .\tests\messaging-bugs.test.mjs
corepack pnpm build
```
