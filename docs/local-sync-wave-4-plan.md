# Wave 4 — Project metadata and sync completeness

**Status:** Wave 4A implemented and automatically verified; signed-in acceptance
and endpoint workspace/continuation evidence remain pending. Wave 4B (W4.3,
W4.1) and W4.6 are planned, not delivered. Archived-chat coverage (W4.2),
scheduled sync (W4.4), and live sync (W4.5) are descoped; see
[Scope decisions 2026-10-25](#scope-decisions-2026-10-25).

This wave follows Wave 3. It starts with project/folder metadata and continues
with the existing completeness work: project conversation coverage,
reconciliation, and account handling. It also extends the
existing Wave 6A viewer. See the
[development waves](./local-sync-development-waves.md),
[Wave 3 plan](./local-sync-wave-3-plan.md), and
[Wave 6 plan](./local-sync-wave-6-plan.md).

This document owns Wave 4 implementation details and acceptance gates. The
development-waves roadmap summarizes the same task IDs, phases, and dependencies;
the feature plan describes the architectural intent. The user confirmed delivery
of 4A first while leaving evidence-gated coverage/reconciliation disabled.

There is no `.planning/STATE.md` in this repository. This document is the
requested plan; it does not initialize a separate tracked GSD workflow.

## Goals and delivery phases

Save the project's actual name and available information from ChatGPT's sidebar
response, then use it for the local viewer's existing project folders. Keep the
archive usable offline, account-scoped, and read-only from the viewer.

Metadata sync must run independently of conversation detail changes: renaming a
project must update its local label even if all conversation update tokens match.

- **4A — Project metadata:** the detailed design below; independently verifiable
  delivery of actual folder names and saved project information.
- **4B — Coverage and reconciliation:** verified project-chat coverage
  followed by safe missing-chat reconciliation. Archived coverage is descoped.
- **4C — Account handling:** explicit profile/account selection, reusing the
  same writer locks. Scheduled/live sync is descoped.

Completing 4A does not complete Wave 4. Existing task IDs W4.1–W4.6 are retained;
the metadata work is W4.0, with detailed subtasks W4.0-P1–P6.

| Phase | Tasks | Delivery gate |
|---|---|---|
| 4A | W4.0 (P1–P6) | Saved account-scoped project names/information appear offline in the existing viewer. |
| 4B | W4.3, then W4.1 (W4.2 descoped) | Verified default/project coverage supports safe manual full reconciliation. |
| 4C | W4.6 (W4.4, W4.5 descoped) | Explicit account selection; all sync remains user-started. |

## Scope decisions 2026-10-25

- **W4.2 archived-chat coverage — descoped.** Archived chats are not a current
  use case. The default list returned no `is_archived: true` items in any
  captured scan, so archived chats are not enumerated or synced. A chat
  already saved locally keeps its saved copy if it is later archived; a later
  reconciliation reports it as no longer listed (see W4.1).
- **W4.4 scheduled sync and W4.5 live sync — descoped.** Unattended API traffic
  risks rate-limiting or account blocking by the vendor. Every sync stays an
  explicit, user-started, monitored run (Latest-10, All chats, or single chat).
  No `chrome.alarms` permission, background triggers, or weekly full runs.
- Re-scoping either item requires a new plan entry; nothing is implemented or
  disabled behind a flag for them.

## Progress tracker 2026-10-25

**Overall: in progress.** 4A implementation and automated verification are
complete; its signed-in acceptance is still open. W4.3 has coverage evidence
but no code changes; W4.1 and W4.6 have not started.
“Done” below means the implementation/test gate is met, not that live endpoint
coverage or signed-in acceptance has been proven. Status is based on the
implementation checkpoint below and the acceptance evidence recorded here.

| Task | Status | Done | Remaining / next gate |
|---|---|---|---|
| W4.0-P1 — contract and fixtures | Done | Sidebar response shape and sanitized synthetic contract are documented and tested. | Live endpoint workspace selection and root-cursor continuation are unverified; record evidence during signed-in acceptance. |
| W4.0-P2 — parser and paging | Done, fail-closed | Parser, validation, bounded handling, diagnostics, and failure behavior are implemented and automatically tested. | Root continuation is deliberately unsupported: a non-null cursor reports `pagination-unverified` and retains the prior catalog. Do not describe this as full project enumeration. |
| W4.0-P3 — host storage/protocol | Done | Schema 3→4 catalog storage, run ownership, bounds, hash validation, and transaction behavior are implemented and tested. | No known implementation task remains for 4A host storage. |
| W4.0-P4 — sync integration/UI | Done | Metadata sync is integrated with Latest-10/All-chats, including no-op chat runs and separate project outcomes. | No known implementation task remains for 4A integration. |
| W4.0-P5 — offline viewer | Done | Schema 3/4 read support, account-scoped names/details, zero-chat projects, refresh, and browser checks are implemented. | No known implementation task remains for 4A viewer delivery. |
| W4.0-P6 — integration/acceptance | In progress | Automated local-sync/viewer tests, type-checks, builds, and isolated Chrome/native-host checks passed at the implementation checkpoint. | Signed-in acceptance remains: validate endpoint account/workspace context, actual labels/refresh/failure behavior, and record the still-unverified coverage limits. |
| W4.2 — archived coverage | Descoped | — | Not needed for current use; see scope decisions. |
| W4.3 — project-chat coverage | Re-scoped; evidence gathered, manual check pending | Archive evidence (below) indicates the default `/conversations` list already includes project chats. No project-chat enumerator is planned unless the manual check fails. | (1) Manually count chats in each project with more than 5 chats in ChatGPT and compare with local counts. (2) Add a regression guard: an All-chats run fails coverage if any sidebar preview ID is absent from its default-list scan. |
| W4.1 — full reconciliation | Not started | — | Start after W4.3 is closed; implement guarded `markMissing` and default-retention behavior over the default-list scope. |
| W4.6 — account chooser/mismatch UX | Not started | — | 4A has defensive session/scope checks, but the explicit profile chooser and task-level account-switch UX/tests remain. |
| W4.4 — scheduled sync | Descoped | — | Unattended sync risks vendor blocking; see scope decisions. |
| W4.5 — live sync | Descoped | — | Unattended sync risks vendor blocking; see scope decisions. |

**Next gates:** complete W4.0-P6 signed-in acceptance; close W4.3 with the
manual count check and the preview regression guard; implement W4.1 only after
that. W4.6 can proceed independently. Wave 4 is not complete until the 4A, 4B,
and W4.6 gates and the full-wave acceptance criteria below pass.

### W4.3 coverage evidence (2026-10-25)

Read-only aggregate checks of the local archive and private API-debug log (no
titles, names, or IDs recorded):

- Five complete All-chats scans each listed the same 296 conversations, 85 of
  them with a `g-p-` project `gizmo_id` across all 7 catalog projects. List
  items carry `gizmo_id`, `is_archived`, and `workspace_id`.
- All 31 sidebar previews, an independent project-side source, appeared in
  the default list. All 85 saved project chats were seen in a default-list
  response; none exist only through single-chat sync.
- 5 projects have a non-null nested cursor (more than 5 chats); their local
  counts are 10–23. Those counts come from the default list itself, so they do
  not independently prove completeness; the manual count check closes this.
- Not covered and accepted: archived chats (descoped), and chats that other
  members create in shared projects (`owned_only=false`), which are untested.
  The nested project-conversation request was never captured or followed.

Phases describe deliveries, not a mandatory serial implementation order.
W4.6 can start alongside 4A; 4A/4B use existing account identity/locking and
must not wait for the new profile chooser. The existing Wave 6A reader is a
dependency only for 4A's viewer integration, not for remote coverage.

## Evidence from the supplied capture

Source: [endpoint note](./side-bar.md) and the local
[response capture](./sidebar.json). The capture is private input, not a sanitized
test fixture; do not duplicate its names, identifiers, email addresses, or chat
titles into tests, logs, or documentation.

Observed request:

```text
GET https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=5&limit=20&owned_only=false
```

| Observation | What it establishes |
|---|---|
| Root is `{ items, cursor }`; 7 items, root `cursor: null` | This response signals the end of this sidebar result, not proven account-wide project completeness. There is no total field to rely on. |
| Each item is `{ gizmo, conversations }` | Project metadata and conversation previews are separate payloads. |
| `item.gizmo.gizmo.id` is a distinct `g-p-…` ID; `gizmo_type` is `snorlax` for all 7 | Join these records to existing conversation-root `gizmo_id` values, scoped by local account. |
| `item.gizmo.gizmo.display.name` is nonempty for all 7 | Real folder labels are available; numbered placeholders are no longer necessary for matched folders. |
| Description/instructions are empty; display emoji/theme are null | Fields exist, but populated shapes/semantics are not demonstrated by this capture. |
| `workspace_id` is null for all 7 | This field cannot supply the local account/workspace identity. |
| Creation/update/interaction timestamps, archive state, sharing and permission fields exist | Preserve these as metadata; they do not authorize remote writes or prove visibility beyond this result. |
| Wrapper includes `files`, `tools`, and feature/limit metadata; files/tools are empty here | Preserve available information without claiming asset/configuration coverage. |
| 31 distinct conversation previews: six groups of 5 and one group of 1 | These are sidebar previews, not all project chats or full conversation payloads. |
| 5 nested conversation cursors are strings; 2 are null | Nested conversation paging is independent of root project paging. A page of 5 can have either a string or null cursor. |
| Every preview's `gizmo_id` and `conversation_template_id` matches its enclosing project | Useful corroboration, not authority to overwrite membership of an already stored conversation. |

No parent-folder field or arbitrary folder hierarchy is established. In this
plan, “folder” means the existing flat project group, not a new nested tree.
The snorlax endpoint also does not establish names for custom-GPT groups.

### Unknowns to resolve or preserve explicitly

- The query parameter for continuing a **root** cursor is not demonstrated.
  Capture an actual continuation request before implementing it; never decode
  the opaque cursor to invent a URL.
- Confirm the endpoint's authenticated account/workspace selection matches the
  existing `AccountScope`, especially when switching workspaces. Null payload
  workspace IDs must not be replaced with a guessed workspace.
- `owned_only=false` is the captured request setting. Do not silently switch to
  owned-only results or assume its exact shared-project coverage.
- Sidebar results may omit archived, inaccessible, or otherwise hidden projects.
  `cursor: null` does not prove remote deletion for anything absent.
- Nonempty descriptions, instructions, icons, files, and permissions need
  synthetic tolerance tests and future live evidence, not assumptions from
  currently empty fields.

## Phase 4A scope — Project metadata

### Included

1. Fetch and validate the sidebar's project metadata through the existing client.
2. Store an account-scoped catalog, original item JSON, hash, and sync freshness.
3. Refresh the catalog on both **Latest 10** and **All chats** runs. The selected
   chat limit does not limit project metadata; do not fetch extra chat details.
4. Show saved names and basic project information in the existing viewer.
5. Report metadata failures separately and explicitly while preserving useful
   conversation sync and previously saved catalog data.
6. Reuse the current private API-debug capture, retry/pacing, cancellation, and
   native-host writer-lock mechanisms.

### Outside phase 4A

- Project-chat coverage verification and missing-conversation reconciliation.
  These belong to phase 4B: W4.3 project coverage and W4.1 reconciliation.
  Archived coverage (W4.2) is descoped. Previews alone are never imported as
  complete conversations.

### Outside Wave 4

- Project create/rename/delete/share actions or any remote mutation.
- Downloading files, images, profile pictures, or icon URLs.
- Custom-GPT name discovery through an unobserved endpoint.
- Inferring deleted projects from sidebar absence or deleting project catalog
  rows on that basis; retain older saved metadata throughout this wave.
- Inferring hierarchy, project membership from historical message metadata, or
  changing `conversations.project_id` to repurpose it as a snorlax ID.
- Rendering project instructions as HTML or exposing owner emails, permissions,
  raw JSON, or instructions in the normal folder list.

Manual current-chat sync retains its existing behavior; no live trigger is
planned (W4.5 descoped). A metadata-only action is not required for 4A.

## Phase 4A data flow

```text
Authenticated incremental run + existing account lock
  -> sidebar metadata phase (same request pacing / API debug logger)
  -> validate and collect root pages until cursor === null
  -> commit complete bounded catalog observation to host
  -> existing conversation enumeration, latest-N selection, detail sync
  -> endRun with separate project outcome and conversation counts

Read-only viewer -> account-scoped projects LEFT JOIN -> existing group IDs/counts
```

Metadata failure must not be swallowed or presented as full success. Unless the
run is cancelled or the host/auth context is unusable, conversation work can
continue; the final run is failed/partial in user wording with a distinct project
failure category. Do not miscount a metadata failure as a failed conversation.
Stop/cancellation stops both phases. A catalog committed before cancellation is
retained, just like committed chats.

## Phase 4A storage and protocol

The host alone performs a transactional **schema 3 -> 4** migration. Do not
rebuild conversation/message tables or alter existing raw conversation snapshots.

### `projects`

Composite primary key: `(account_id, id)`, where `id` is the sidebar gizmo ID.
Foreign key `account_id -> accounts.id`.

Proposed columns:

- `name TEXT NOT NULL`, `description TEXT NULL`, `gizmo_type TEXT NOT NULL`.
- `remote_created_at`, `remote_updated_at`, `remote_last_interacted_at` as
  nullable text preserving API timestamps; reject malformed required identity
  fields rather than inventing values.
- `is_archived INTEGER NULL`: distinguish unknown from an explicit false.
- `raw_json TEXT NOT NULL`: the original complete sidebar item, including its
  wrapper and conversation previews, not just the inner gizmo.
- `raw_sha256 TEXT NOT NULL`, `first_synced_at`, `last_synced_at`.
- `last_seen_run_id` referencing the run that last observed this item.

Keep advanced metadata (instructions, sharing, permissions, feature limits,
display decoration, file references) in raw JSON for now. Normalize only fields
needed for first-wave queries/UI. Raw preview changes may change the snapshot
hash without implying the project name or configuration changed.

### `project_catalog_state`

One row per account: latest attempt run/time/status, last successful completed
catalog run/time, observed project count, and a sanitized error category.
Record failed/cancelled attempts without advancing the successful freshness
marker. An empty successful result is distinct from “never synced” or “failed.”

“Successful” means all pages of this endpoint's result were consumed, not that
all remote projects/chats are known. Retain previously observed project rows
when absent from a later result; use the last-seen run versus the successful
catalog run to identify older metadata. Never mark them deleted or ungroup chats.

### Native Messaging changes

- Add one run-bound `commitProjectCatalog` request carrying validated raw items
  and their hashes. The host independently validates and derives normalized
  fields, binds the account from the active run, checks hash/size, and atomically
  commits the catalog plus its successful state.
- Require the same incremental-run ownership/account lock as chat writes.
  Reject cross-run or client-supplied account substitutions.
- Add a typed project outcome to `endRun` for failed/cancelled attempts and
  separate project counts in progress/results. Preserve existing conversation
  counts and the invariant that the result cannot be full success after a
  metadata failure. Test the existing single-chat call shape unchanged.
- Suggested initial bounds: 1 MiB per raw project item, 16 MiB for the serialized
  catalog request, and 100 root pages per attempt. Enforce measured UTF-8 bytes
  on both sides, including request-envelope overhead. These are explicit safety
  ceilings, not completeness signals. Exceeding any bound fails visibly without
  partial catalog commit; don't truncate or silently add chunking.
- Bump the host version and add a capability/minimum-version check so an old
  host receives an actionable upgrade error before starting the new flow.
  Decide the protocol-range bump from the final backwards-compatibility tests.

Collect pages in bounded memory and commit only after complete validation.
This keeps the first implementation simple and avoids half-renamed folders on
pagination failures. Existing API-debug logs remain the source for failed raw
responses; do not add a second raw-page storage subsystem.

## Phase 4A client and pagination rules

- Reuse `requestChatGpt`, the two-second serialized quiet interval,
  `fetchApiResponse`, retries/backoff, token invalidation, and `AbortSignal`.
- Start with the captured parameters exactly. Add the verified root continuation
  parameter only after observing it. Never reuse the conversation offset loop.
- Require root `items` array and `cursor` string-or-null; missing/invalid cursors
  are errors, not end-of-list. Validate the nested gizmo envelopes, nonempty IDs
  and names, type, and types of normalized optional fields. Preserve unknown
  optional fields in raw JSON; do not reject future metadata just for new keys.
- End root paging only on explicit `cursor: null`, not item count, short pages,
  preview lengths, or a fabricated total. Treat cursors as opaque values.
- Detect repeated root cursors and duplicate project IDs across pages; restart
  the metadata scan once, then fail explicitly if still unstable. An empty page
  with a new cursor may continue within the bounds.
- If a root continuation is required before its request shape is confirmed,
  report `project-pagination-unverified`; retain the old catalog and do not
  claim the first page is complete.
- Do not follow `item.conversations.cursor` in phase 4A. Validate/preserve
  previews as raw data, without invoking `upsertConversation` or modifying list
  update tokens, message rows, or current project membership.
- Confirm the endpoint request scope before committing a live capture. Payload
  `workspace_id: null` neither overrides the run account nor proves a mismatch.
  If the account/workspace cannot be established, fail rather than cross-store.

## Phase 4A logging and user feedback

- Extend the existing API-debug integration to capture each sidebar response
  **before parsing/validation**, including invalid JSON and HTTP failures.
  Keep access-token redaction and exclusion of session bodies/headers/cookies.
- Add typed root-pagination events: page index, item count, termination/restart
  reason, and completion state. Do not copy opaque cursor contents, names,
  project instructions, or chat titles into aggregate logs.
- Raw API-debug output already contains private content; this endpoint adds
  project names, author/sharing metadata, and potentially instructions/file
  references. Update the privacy notice and explain this expanded capture.
- Add a short “Syncing project information” phase and project outcome to the
  popup. Latest-10 still means at most ten selected conversation details.
- Distinguish auth/forbidden, rate-limit, malformed response, unverified paging,
  unstable paging, size limit, local-host failure, and cancellation.
  API-debug write failure remains explicit, consistent with current behavior.

## Phase 4A viewer behavior

- Keep stable IDs such as `project:<gizmo_id>`; rename only the label, never the
  filter key or cursor scope. Join using both account and project ID.
- Preserve the shared grouping expression for counts and list filters. The
  conversation-root marker remains the membership source; the sidebar only
  enriches the matching project group.
- Union saved project metadata with existing derived project groups, including
  saved projects with **zero locally stored chats**. Show an explicit empty
  local-folder state, not “empty on ChatGPT.” Group counts count local chats,
  never sidebar preview lengths or remote totals.
- Missing catalog rows retain existing numbered project labels; custom GPTs,
  unmarked, other-marked, and All conversations retain their behavior.
  Duplicate real names are allowed; identity remains the ID.
- On project selection, show available description, saved archive state,
  remote update time, and local catalog freshness in a compact details area.
  Omit absent optional fields. Mark metadata not observed in the last successful
  result as older saved information; no deletion claim.
- Render name/description as plain React text, not Markdown or raw HTML. Do not
  fetch saved icon URLs or expand CSP/network access.
- Update viewer schema guards for schema 4 and required project tables. Retain
  schema 3 read support with the existing provisional labels and an upgrade
  indication; the viewer must never migrate or open the host writer.
- Refresh archive reloads catalog labels/details/counts. Folder selection and
  conversation selection survive a label-only update when their IDs still exist.

## Phase 4A implementation sequence

See the [progress tracker](#progress-tracker-2026-10-23): P1–P5
implementation and automated checks are complete. Live workspace and
root-continuation evidence, plus P6 signed-in acceptance, remain open.

| ID | Work / likely files | Depends on | Done when |
|---|---|---|---|
| W4.0-P1 | Document sidebar contract and create sanitized synthetic shapes. `docs/side-bar.md`, API findings, `tests/fixtures`. Confirm live account scope and root continuation request if available. | Existing Wave 3 client/account context | Evidence and unknowns are separated; no private capture contents enter fixtures. |
| W4.0-P2 | Client/sidebar parser and bounded root enumerator. `lib/chatgpt-client.ts`, a focused `lib/sync/projects.ts`, `lib/sync/api-debug.ts`. | P1 | Pagination, malformed envelopes, cancellation, retries/pacing, and pre-parse logging tests pass; unknown root pagination fails explicitly. |
| W4.0-P3 | Host migration/catalog transaction and protocol contracts. `local-app/host/db.ts`, `handlers.ts`, `lib/sync/protocol.ts`, host-client validation/version checks. | P1 | v3 data survives; scoped commit/hash/size/ownership/rollback and freshness tests pass. |
| W4.0-P4 | Integrate metadata phase/outcomes into incremental sync and popup. `lib/sync/all-chat.ts`, background, popup components. | P2, P3 | Renames sync even on chat no-op; Latest-10 stays bounded; partial/cancel/error states and writer locking are tested. |
| W4.0-P5 | Viewer joins, metadata details, zero-local-chat projects, schema compatibility. `local-app/viewer/archive.ts`, `types.ts`, UI and fixtures. | P3 | Real labels, scoped counts/filtering, fallback, offline reads, and rename refresh pass API/browser checks. |
| W4.0-P6 | Integrated validation, docs/privacy update, signed-in acceptance. | P4, P5 | Checks below pass and live results are recorded without private contents; remaining Wave 2/3 gates stay explicit. |

P2 and P3 can proceed independently after P1; P5 does not need P4. This wave
does not retroactively close earlier signed-in sync acceptance gates.

## Phase 4A verification and acceptance

### Automated

- Contract fixture matching the capture's **shape**, with 7 synthetic projects,
  31 synthetic previews, null root cursor, and 5 non-null nested cursors:
  imports 7 metadata records and **zero conversations/messages from previews**.
- Multi-page root result, short/empty page with continuation, null terminal
  cursor, missing/wrong cursor type, loop, duplicate ID/restart, unknown fields,
  bad envelope/name/ID, and explicit unverified-continuation failure.
- One/two-page boundary and configured page/UTF-8 byte limits; rejection
  immediately above limits; no successful state or partial write on rejection.
- Same IDs in different accounts, null payload workspace, denied run ownership,
  shared-project metadata without cross-account contamination.
- v3 -> v4 migration preserves existing conversation/message rows, raw hashes,
  list tokens, install metadata, and run history; rollback leaves v3 usable.
- Initial catalog -> identical snapshot -> rename/config update -> complete
  empty result -> later reappearance. Older unseen records remain available;
  successful freshness advances only after a complete committed observation.
- Failure/cancel before commit retains the last catalog. Chat-detail failure
  after catalog commit does not roll back successfully saved metadata.
- Rename during an all-chat no-op still changes the viewer label, not group ID,
  membership, selected transcript, or message rows. Latest-10 makes no more than
  ten selected detail calls; sidebar previews do not expand that scope.
- Metadata-only failure is visible and distinct from conversation counts;
  unrelated chat work can finish without a success-shaped overall result.
- Viewer: account-scoped duplicate names/IDs, zero-local-chat projects, fallback
  labels and GPT groups, schema 3/4, read-only behavior, refresh, long names,
  hostile name/description text, narrow layout, and no automatic remote requests.
- Debug logs capture failed/malformed responses before parsing; aggregate logs
  omit private values and credentials. Tests use synthetic secrets only.

Run the existing smallest affected client/sync/host suites while developing,
then `corepack pnpm test:local-sync`, `corepack pnpm test:viewer`,
`corepack pnpm compile`, `corepack pnpm viewer:build`,
`corepack pnpm test:viewer:browser`, and `corepack pnpm build`.
Extend the existing isolated Chrome/native-host smoke test for the new
phase/protocol/error UX. Do not use a signed-in profile for automated fixtures.

### Signed-in acceptance

1. Confirm endpoint account/workspace context, back up the existing archive, and
   sync metadata with Latest-10. Review only aggregate outcomes in the report.
2. Confirm matched projects show the actual names from ChatGPT, including any
   project with no locally saved chats. Preview counts must not become folder
   counts. A larger catalog than previously derived groups is not itself a bug.
3. Repeat unchanged; then, if the user chooses to rename a test project in
   ChatGPT, repeat and verify the label updates without requiring chat changes.
   The extension itself never performs the rename.
4. Check failure/Stop preserves older names and reports freshness accurately.
5. Reopen the viewer without ChatGPT access: names/details remain available.
6. Record pagination/account/archived/shared coverage still unverified.
   Do not claim all project conversations are synced.

**Phase 4A exit:** actual saved folder labels and available basic information are
reliably refreshed per account; errors are explicit; existing chat sync and
offline viewing remain intact. Full project-chat completeness is task W4.3.

### Implementation checkpoint (2026-10-22)

- Host v0.5.0 advertises `project-catalog`, migrates schema 3 -> 4 transactionally,
  validates/hashes/bounds run-owned catalog writes, and persists independent
  project attempt/freshness state. Failed project sync does not inflate chat
  failure counts. Old host versions fail capability checks before starting.
- Latest-10/All-chats run a metadata phase even on chat no-ops. Fresh, unlogged
  session checks before/after the catalog fetch detect user/workspace/token
  changes; explicit workspace mismatches fail closed. This is a defensive scope
  check, not signed-in proof of the endpoint's workspace-selection semantics.
- Root continuation remains deliberately unimplemented: a non-null root cursor
  returns `pagination-unverified`, keeps the old catalog, and reports failure.
  Nested conversation cursors are preserved, never followed in 4A.
- Viewer reads schema 3/4, enriches stable project IDs with saved names/details,
  supports zero-local-chat projects, and labels older or failed-attempt metadata.
  Refresh retains a selected conversation through a label-only change.
- Production parser accepts all 7 project items in the supplied private capture;
  no private values were printed or copied into synthetic fixtures.
- Automated local-sync tests, type-check, viewer/extension builds, real-Chrome
  viewer checks, and registered-host popup smoke checks passed. Browser fixtures
  verify hostile metadata remains literal and makes no remote requests.
  Native-host smoke uses a disposable archive, not the user's archive.
- No signed-in network acceptance, real-archive migration, full project coverage,
  reconciliation, automation, or profile chooser is claimed by this checkpoint.

## Remaining Wave 4 implementation and gates

These retain the existing completeness scope rather than moving it to a later
wave. Before implementing each task, resolve its API unknowns and specify the
affected protocol/schema changes and focused fixtures. The schema 4 design
above covers metadata only; later migrations, if needed, remain host-owned.

### Phase 4B coverage and reconciliation contract

- Verify each source's request parameters, account/workspace context, and
  terminal condition before claiming coverage. The required source is the
  default list, which covers project chats per the W4.3 evidence; archived
  coverage is descoped. Keep the default list's established empty-page
  termination and do not enable early-stop without ordering evidence.
- A project-chat source is added only if the W4.3 manual check shows the
  default list misses project chats. If added, build an account-scoped union
  before manifest comparison and detail selection, deduplicate overlaps, and
  never overwrite full conversation data with a preview.
- Latest-10 validation requests only the first page of ten conversation entries;
  it does not enumerate the full list or guarantee global recency.
  All chats selects the complete default list. Neither
  scope is a full-reconciliation permission. Only an explicit full run can
  evaluate absence, with all required sources successfully enumerated and the
  W4.3 preview regression guard passing.
- Record source coverage/completion as a run-bound host-verifiable contract
  before accepting `markMissing`. A missing permission, unverified endpoint,
  source failure, cancellation, or incomplete result prevents reconciliation;
  a successful sidebar catalog alone is insufficient.
- `remote_state='missing'` means absent from the verified scope, not proof of
  remote deletion. With archived coverage descoped, a chat archived in ChatGPT
  is also reported as missing; the UI must word this as "no longer in your chat
  list (deleted or archived)". Reappearance clears missing state through the
  normal upsert path.
- Default behavior retains local data. Any removal setting remains off until
  explicitly enabled, applies only to eligible completed full runs, and cannot
  bypass coverage/account checks. Validate removal with disposable archives.

### Phase 4C account handling contract

- Expose explicit account/profile selection in the existing local-sync UI; no
  unrelated Options-page redesign is required. Runs must use the selected,
  verified account and an available session, never silently follow a browser
  account switch.
- All runs are user-started and monitored. Do not add `chrome.alarms`,
  background/scheduled triggers, finished-reply or navigation triggers, or
  weekly full runs (W4.4/W4.5 descoped to avoid unattended API traffic).

| ID / phase | Work / likely files | Dependencies | Done when |
|---|---|---|---|
| W4.2 / 4B | **Descoped 2026-10-25.** Archived-chat coverage is not needed for current use. | — | — |
| W4.3 / 4B | Confirm the default list covers project chats; add a preview regression guard to All-chats runs. A nested project-conversation enumerator is built only if the manual check fails. `lib/sync/all-chat.ts`, `lib/sync/projects.ts`. | W4.0; manual per-project count check | Manual counts for every project with more than 5 chats match local counts; an All-chats run reports incomplete coverage when any sidebar preview ID is missing from its default-list scan; preview-only snapshots never replace full raw chats. |
| W4.1 / 4B | Manual full reconciliation with `markMissing`, `remote_state`, and an optional removal setting defaulting off. Host DB/protocol, run engine, settings. | W4.3 coverage gate | Only a successful complete account-scoped full scan can mark absence. Latest-10, failed/cancelled scans, and metadata-only absence cannot mark/delete chats. Missing wording covers deleted or archived chats. Tests prove default retention, reappearance, account isolation, and explicit opt-in removal behavior. |
| W4.6 / 4C | Account-mismatch UX and profile chooser; preserve optional Edge registration. Background, popup, host-client/account checks. | Existing W3 account identity and locks | Switching accounts cannot store under the prior scope; unavailable/mismatched identities produce actionable errors; same remote IDs across scopes never overwrite another account's data. |
| W4.4 / 4C | **Descoped 2026-10-25.** No scheduled sync: unattended API traffic risks vendor blocking. | — | — |
| W4.5 / 4C | **Descoped 2026-10-25.** No live sync: unattended API traffic risks vendor blocking. | — | — |

Do not resolve a lock conflict by bypassing account ownership.

### Full-wave acceptance

- Phase 4A acceptance passes and saved project names remain usable offline.
- Default-list coverage of project chats has explicit evidence (W4.3).
  Archived and shared-project coverage are reported as not covered rather than
  declared complete.
- A full-run fixture combines project chats in the default list, a missing
  sidebar preview, and account switches; details are fetched once per selected
  ID and coverage failures prevent absence reconciliation.
- Missing/returning chats and opt-in removal are tested with disposable archives;
  no real archive deletion is required to validate the feature.
- Manual runs cannot overlap account writers; Stop, session expiry, browser
  restart, and host disconnect retain committed data and produce explicit run
  outcomes.
- Existing local-sync, viewer, type-check, production-build, and isolated Chrome
  checks pass for every affected surface. Record signed-in acceptance separately
  from synthetic test success.

**Wave 4 exit:** project metadata, verified coverage/reconciliation, and account
handling pass their respective gates. Do not mark the wave complete after
metadata delivery alone or retroactively close earlier live acceptance.
