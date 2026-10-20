# Permission Justifications

## `activeTab`

Used to identify the currently active saved ChatGPT conversation when the user
starts a sync.

## `nativeMessaging`

Used to send the selected conversation to the user's registered local host for
storage in SQLite.

## Host permission: `https://chatgpt.com/*`

Used to read the ChatGPT session and conversation data after the user initiates
a sync, and to run the optional bounded API diagnostic.
