# Local Sync — Wave 2.1 API Probe Plan

Companion to the [Wave 2 implementation plan](./local-sync-wave-2-plan.md)
and [API findings](./local-sync-api-findings.md).

**Status: implemented and reviewed from signed-in regular and project
conversations. The tested project conversation appeared in the sampled default
list; this does not establish full project coverage. The ordering-parameter
effect and archive behavior remain inconclusive and are recorded as such.**
The existing account adapter, single-chat sync, host connection diagnostics,
and 10 MB echo are not API-shape probes.

## Goal

Add an explicit **Probe ChatGPT API** button under the popup's Developer
diagnostics. When the user clicks it from a signed-in ChatGPT tab, the extension
performs a small, read-only sequence of API checks, constructs a sanitized
report, and sends that report over Native Messaging. The host validates it and
appends one clearly tagged line to:

```text
%LOCALAPPDATA%\ChatGPTBackup\logs\host.log
```

The user can then provide only the `API_PROBE` line(s) for review. This probe
does not sync or persist conversations.

## Scope and safety boundaries

- Require an explicit button click; do not run on popup open, on a timer, or as
  part of **Sync this chat**.
- Make only bounded `GET` requests to the existing ChatGPT origin. No writes,
  downloads, or conversation-detail requests are needed.
- Keep the access token in the extension and use it only for ChatGPT requests.
  Never include it, cookies, headers, account IDs, email addresses, conversation
  IDs, titles, message text, raw response bodies, or timestamps from ChatGPT in
  the host report.
- Report field paths and JSON types, plus categorical outcomes calculated in
  memory. Do not report field values. Collapse arrays to `[]` paths, sort and
  cap field lists, and omit arbitrary/dynamic object keys.
- Compare identifiers and timestamps only in memory when needed to classify a
  result; discard them before constructing the report.
- Cap the run at six ChatGPT requests: one session request, two default list
  pages, two candidate ordered-list pages, and one archived-list page. Use the
  existing 50-item page size, a request timeout, and no retry loop. Stop or mark
  a step inconclusive on an authentication, rate-limit, server, or shape error.
- The host accepts only the typed report schema, validates its enums, paths,
  field counts, string lengths, and total payload size, then writes a single
  structured line through the existing host logger. Never log arbitrary
  extension payloads.
- Preserve current behavior when the probe is unused. A probe failure must not
  alter local sync data or suppress its error from the popup.

## Probe sequence

1. **Preflight**
   - Confirm the sender is the extension popup and the active tab is on
     `chatgpt.com`. Determine only the route category: `conversation`,
     `project-conversation`, or `other`; do not send the URL or its IDs.
   - If the user is not signed in or the active tab is not ChatGPT, show an
     actionable message and do not send a report that claims the probe passed.

2. **Session shape**
   - Fetch `/api/auth/session` using the extension's existing session handling.
   - Emit sorted key paths and JSON types only, with array indices collapsed.
     Include presence/type for the candidate user and workspace/account fields
     consumed by the account adapter. The `accessToken` value and all other
     values are discarded.
   - Do not send the account scope used by normal sync to the host.

3. **Default conversation-list shape and ordering**
   - Fetch `GET /backend-api/conversations?offset=0&limit=50` and, when a
     second page is available, `offset=50&limit=50`.
   - Report response status, top-level field paths/types, item field paths/
     types, and the type/presence of `update_time`. Do not report item values,
     titles, IDs, or the list's `total` value.
   - Check descending `update_time` order locally for each page and across the
     page boundary. Report only `descending`, `not-descending`, or
     `inconclusive` (for example, missing or incomparable timestamps).

4. **Candidate updated-order parameter**
   - Repeat the same bounded page checks with `order=updated`.
   - Compare only the local order classifications and whether the returned ID
     sequence differs from the default sequence. Report categorical outcomes;
     discard the IDs and timestamps.
   - A successful HTTP response alone does not prove the parameter is honored.
     Mark the finding inconclusive unless response ordering provides evidence.

5. **Archived-list behavior**
   - Fetch the first page with `is_archived=true`.
   - Report whether the response is valid, whether an archive flag is present
     and its type, and the in-memory relationship to the default first page as
     `same`, `subset`, `overlap`, `disjoint`, or `inconclusive`.
   - Do not infer parameter support when there is no distinguishing evidence
     (for example, no archived chats are present). Do not send IDs or counts.

6. **Project-chat evidence**
   - Report only the active route category, whether the active conversation
     appears in the default list (boolean), and the presence/type of any
     project/gizmo-related list fields from a fixed safe field-name allowlist.
   - To test project representation, the user should run the button once while
     a project conversation is open. If no project conversation is available,
     report `not-tested`; do not claim the endpoint is complete.

7. **Report and feedback**
   - Generate a random probe ID with no user/account information.
   - Send the sanitized report through one typed Native Messaging request.
   - The host validates the schema and appends a line prefixed `API_PROBE`
     through `configureLogging()`. The host response confirms the report was
     logged; the popup displays success or a clear failure.
   - If a probe step fails, include only its step name, a bounded status code
     where applicable, and a safe error category. Never forward raw exception
     messages, URLs, response bodies, or headers.

## Proposed report contract

Add one typed request, for example `recordApiProbe`, to
`lib/sync/protocol.ts`. The report should be a versioned, allowlisted object
containing:

- random `probeId` and report schema version;
- route category enum;
- a fixed list of step names and result enums;
- HTTP status codes only where useful;
- sanitized field-path/type entries with strict count and length limits;
- ordering and archive relationship enums;
- project/list membership as booleans or `not-tested`.

It must not accept raw JSON, arbitrary strings, URLs, headers, identifiers,
free-form errors, or account scope. Keep the complete report comfortably below
the Native Messaging frame limit (proposed maximum: 16 KiB).

## Implementation sequence

1. Define the report type and pure sanitizer/classifiers in
   `lib/chatgpt-client.ts` or a focused `lib/chatgpt-api-probe.ts`. Unit-test
   with synthetic fixtures containing secret sentinel values; assert no
   sentinel or raw value can appear in the report.
2. Add the typed `recordApiProbe` request/reply and strict host-side validation
   in `lib/sync/protocol.ts` and `local-app/host/handlers.ts`. Write only the
   validated report through `local-app/host/log.ts`'s existing console logger.
3. Add a popup-only background message in `entrypoints/background.ts`, enforcing
   the existing extension-page sender check. Keep credentials and ChatGPT
   response objects within the extension.
4. Add **Probe ChatGPT API** under Developer diagnostics in
   `entrypoints/popup/LocalSyncPanel.tsx`, with a busy state, progress/failure
   feedback, and no raw report displayed in the popup.
5. Add client/sanitizer, protocol/host, sender-boundary, and popup tests. Verify
   malformed and oversized reports are rejected and no credentials or raw
   response values reach `host.log`. Run compile, local-sync tests, regressions,
   production build, and the disposable Chrome/native-host integration test.
6. In the user's signed-in profile, click the button from a regular chat and,
   if available, again from a project chat. Review only the tagged report lines
   in `host.log`. Update the findings document with verified outcomes and
   unknowns; add synthetic sanitized fixtures, never copies of the real log.

## Completion criteria

- The explicit button runs the bounded probe and gives a clear logged/not-logged
  result.
- The host log contains a validated `API_PROBE` line with no credentials,
  identifying values, titles, or message content.
- Automated tests prove the extension-to-host report boundary is sanitized and
  rejects malformed/oversized reports.
- The signed-in run establishes only the behaviors supported by its evidence.
  Missing, ambiguous, or unavailable cases remain explicitly unknown.
- `docs/local-sync-api-findings.md` records the reviewed evidence and synthetic
  fixtures; no actual identifiers or user data are committed.

The implementation, automated checks, and signed-in reviews from a regular
conversation and one project conversation are complete. The project run found
that tested conversation in the sampled default list, but does not establish
complete project coverage. Neither run established the effect of
`order=updated` or archive-list behavior. Those unresolved findings are
documented for follow-up; the first-chat insert likewise does not establish
them.

## Implementation status

- The popup button, background sender check, bounded read-only probe, report
  sanitizer, typed Native Messaging request, and strict host-log validation
  are implemented.
- Automated tests use synthetic response values and verify that only field
  paths/types and aggregate outcomes reach the host log.
- Signed-in regular-conversation and project-conversation runs have been
  reviewed. One sampled project conversation was found in the default list;
  full coverage, ordering-parameter support, and archive behavior remain
  unverified. Share only sanitized report lines for any additional review.
