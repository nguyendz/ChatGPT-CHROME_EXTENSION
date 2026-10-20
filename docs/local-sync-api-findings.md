# Local Sync — ChatGPT API Findings (Wave 2)

**Status: reviewed — the sanitized API probe is implemented, and signed-in
regular-conversation and project-conversation reports have been reviewed. The
tested project conversation appeared in the sampled default list. The effect
of `order=updated`, archived-list behavior, and full project-list coverage
remain unconfirmed.**

After implementation, the user reported a successful first single-chat sync;
the popup showed that the current chat was inserted with 366 messages. This
confirms that session/account resolution and the conversation-detail request
worked for that profile. That sync did not capture response shapes or verify
list semantics. Two sanitized probe reports reviewed below provide additional
evidence, but do not establish ordering-parameter support, archive behavior, or
complete project-list coverage. The disposable Chrome integration test has no
ChatGPT login. This document
intentionally contains no account identifiers, titles, conversation contents,
cookies, or access tokens. Do not treat untested assumptions below as confirmed
API behavior.

## Confirmed from the existing extension code

| Request | Current behavior |
|---|---|
| `GET /api/auth/session` | The legacy client reads `accessToken`. It does not previously use user or workspace IDs. |
| `GET /backend-api/conversations?offset=<n>&limit=50` | Existing backups consume `total` and `items`; each item must have an `id`. `title` is used for exported filenames/progress. |
| `GET /backend-api/conversation/<id>` | Existing backups expect a conversation object with a `mapping`; parsing uses `conversation_id`, `title`, `create_time`, `current_node`, and mapping messages. |

The extension sends the access token only in the authorization header to
`chatgpt.com`. The extracted client does not log response bodies or list items.
Its account adapter accepts candidate user/workspace ID fields but fails closed
if it cannot find both.

## Still unknown after the reviewed probes

- Whether `order=updated` is honored. Both reports returned the same ID
  sequence as the default query; the default may already be ordered.
- Whether an archived-conversation list parameter is honored. Both archived
  queries returned HTTP 200 without items to distinguish the behavior.
- The exact meaning and stability of the observed session identity paths
  across account or workspace changes. The extension must not guess a
  workspace or silently use a default, because that could mix personal and
  managed-account data.
- Whether the main list contains all project conversations or how project
  membership is represented. One tested project conversation appeared in the
  sampled default list, but that is not evidence of complete coverage.

## Reviewed live probe observation — regular conversation

The reviewed signed-in report had route kind `conversation`. All requested
session and list calls returned HTTP 200. Only the sanitized field paths/types
and categorical results are recorded here; no report ID or account/chat values
are retained.

| Question | Observed in this profile | Interpretation |
|---|---|---|
| Session identity paths | `session.user.id` and `session.account.id` were strings. | These candidate paths work for this profile and match the account adapter's fallback. Their meaning/stability across account or workspace changes is not established. |
| List shape | Sampled items had string `id` and string `update_time`; `is_archived` was boolean. `gizmo_id` appeared as null or string; `workspace_id` appeared as null in the sampled items. | These are observations for the returned sample, not a guarantee that every item has the same optional fields. |
| Default ordering | The two sampled pages were descending by `update_time`. | Supports the observed ordering for this one run only. |
| `order=updated` | Its two sampled pages were also descending, but the returned ID sequence was unchanged from the default query. | The parameter's effect is **not confirmed**; the default may already have been ordered. Do not rely on it as a verified sort control. |
| Archived query | `is_archived=true` returned HTTP 200, but the report had no archived item shape and the comparison was inconclusive. | This run did not establish whether the parameter is honored or whether archived chats were available to distinguish the result. |
| Project behavior | The active route was a regular conversation and that conversation was found in the default list sample. | This says nothing about project-conversation coverage. `gizmo_id` presence alone does not prove project chats are included. |

The report field `projectListMembership` checks whether the active route's
conversation ID appeared in the sampled default list (up to the two requested
pages). The regular-conversation run found its chat; the project-conversation
run below found its tested project chat.

## Reviewed live probe observation — project conversation

The later signed-in report had route kind `project-conversation`. The session
request and both default-list pages returned HTTP 200. Only sanitized field
paths/types and categorical outcomes are recorded; no report ID or
account/chat values are retained.

| Question | Observed in this profile | Interpretation |
|---|---|---|
| Project route membership | `projectListMembership` was `found`. | This tested project conversation appeared in the sampled default list. It does not establish that every project conversation is listed or that the list is complete. |
| Project-related list fields | `gizmo_id` appeared as null or string; `workspace_id` appeared as null. | These types do not establish project membership semantics or a complete project identifier model. |
| Default and `order=updated` ordering | Both were classified as descending; their ID sequence was unchanged. | As in the regular-chat run, this does not confirm the ordering parameter's effect. |
| Archived query | HTTP 200, with no item shape; the relationship was inconclusive. | No evidence here that the archive parameter is honored; the response contained no items to compare. |

This is positive evidence for one project conversation in the sampled default
list only. Project enumeration and completeness remain separate follow-up work.

## Planned safe live verification

The click-to-run probe, bounded request sequence, sanitization rules, host-log
contract, and acceptance checks are implemented as specified in the
[Wave 2.1 API probe plan](./local-sync-wave-2.1-probe-plan.md). The signed-in
regular and project-conversation reports have both been reviewed. Further
probing is useful only if a known archived chat can distinguish archive-list
behavior or if broader project-list coverage is specifically needed. Review
only `API_PROBE` line(s) in the local host log, and commit synthetic fixtures
rather than actual log content.

Until these checks are completed, the single-chat flow will refuse to sync
when stable user and workspace IDs are unavailable.
