# Chrome Web Store Privacy Declarations Draft

Keep this draft aligned with `PRIVACY.md` and the actual implementation.

## Single purpose

Sync the currently open saved ChatGPT conversation to a local SQLite database
owned by the user's Native Messaging host.

## Data accessed and used

After the user starts a sync, the extension accesses the active ChatGPT
conversation URL, the ChatGPT session response, and the current conversation
payload. It sends the conversation payload and account scope over Native
Messaging to the local host. Optional API diagnostics save sanitized
response-shape summaries, not conversation content.

The local host stores the raw conversation, normalized message rows, and
sync-run metadata on the user's device. The ChatGPT access token remains in
extension service-worker memory and is never sent to the host.

## Data sharing

- No conversation data is sent to the developer or analytics services.
- Conversation data is transferred only to the user's locally registered
  Native Messaging host for local database storage.
- No data is sold or used for advertising, creditworthiness, or lending.

## Remote code and analytics

- All executable code is packaged with the extension.
- No analytics tracking is included.

## Permissions

- `activeTab` — identify the active ChatGPT conversation.
- `nativeMessaging` — communicate with the user's local host.
- `https://chatgpt.com/*` — request the user's session and conversation after
  a user action.

There is no downloads permission and no conversation file export.
