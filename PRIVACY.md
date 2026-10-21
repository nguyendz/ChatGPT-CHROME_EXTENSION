# Privacy Policy — ChatGPT Local Sync

ChatGPT Local Sync is a Chrome extension that stores the currently open saved
ChatGPT conversation in a local database managed by the user's Native Messaging
host.

## Data accessed

After the user chooses **Sync this chat**, the extension accesses the active
ChatGPT conversation URL, the user's ChatGPT session response, and the
conversation payload (including title, message content, metadata, and branches).
The optional API diagnostic makes bounded read-only requests and records
sanitized response-shape summaries; it does not store message content.

## Data use and storage

The extension sends the selected conversation payload and account scope to the
user's local Native Messaging host. The host stores the raw payload, normalized
message rows, and sync-run metadata in SQLite under
`%LOCALAPPDATA%\ChatGPTBackup`. The extension does not send conversation data
to the developer or an analytics service.

The extension does not persist the ChatGPT access token. It is held in
service-worker memory only while making ChatGPT requests and is never sent to
the local host.

Sync debugging additionally stores full conversation-list and conversation-detail
response bodies, request URLs, HTTP status/attempt information, network errors,
and pagination decisions in `logs\api-debug.jsonl` under the same local data
directory. This includes private chat titles, IDs, messages, and metadata,
including responses rejected by validation. It does not capture session
responses, request headers, or cookies, and redacts the active access token
from response bodies and network errors. The debug log stays local, is
append-only without automatic rotation, and can be deleted manually. Review
and redact it before sharing; the separate sanitized API probe is unchanged.

## Network requests

The optional local archive viewer is a separate, user-started process bound
only to `127.0.0.1` on an OS-selected port. Its UI and API read the local SQLite
archive without contacting ChatGPT, a CDN, or an analytics service. Access to
archive data requires the per-process token in the private launch URL; the
browser removes that token from its address bar and keeps it only in tab
memory. The viewer does not use authentication cookies or persist that token.
Do not share the launch URL or screenshots containing it.

The viewer does not modify archive rows, migrate the database, or start syncs.
It treats saved messages as untrusted content: Markdown and raw HTML pass
through an allowlist sanitizer before React rendering. HTML code-block previews
are opt-in; code itself remains escaped. Scripts, event handlers, inline styles,
forms, and embedded pages are disabled. Images are replaced with text
placeholders, and remote images/attachments are not downloaded or displayed.
External links require an explicit click and open without opener/referrer access.
Viewer request logs exclude
chat content, account identifiers, and the launch token; only the explicit
startup URL printed to the user's terminal contains the token.

The extension makes requests to `https://chatgpt.com/*` to read the current
session and conversation after a user action. Conversation data is sent only
over Native Messaging to the user's local host.

## Permissions

- `activeTab` — identify the currently active ChatGPT conversation.
- `nativeMessaging` — send sync data to the locally registered host.
- `https://chatgpt.com/*` — request the user's session and conversation data.

## User control

Sync and API diagnostics run only when started by the user from the extension
popup. All-chat, project, and automatic sync are not currently available.
Conversation file downloads and exports are not provided.

## Contact and support

- GitHub repository: https://github.com/FredySandoval/ChatGPT-CHROME_EXTENSION
- Support / issues: https://github.com/FredySandoval/ChatGPT-CHROME_EXTENSION/issues
