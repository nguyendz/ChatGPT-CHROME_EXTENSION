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

## Network requests

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
