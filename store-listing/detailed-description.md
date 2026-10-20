# ChatGPT Local Sync

ChatGPT Local Sync stores the currently open saved ChatGPT conversation in a
local SQLite database through a Native Messaging host installed on the same
computer.

## Features

- Sync the current conversation on demand.
- Preserve message branches and identify the active branch.
- Refresh safe-URL metadata without rewriting message rows when that is the
  only change.
- Open the popup's local connection status and diagnostics.
- Keep ChatGPT credentials in the extension; they are not sent to the local
  host.

All-chat, project, and automatic sync are not currently available. This
extension does not provide conversation downloads or file exports.
