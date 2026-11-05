---
name: assistant
description: Set reminders, schedule follow-up tasks, monitor public pages for changes, and manage those commitments for the paired Telegram user.
---

# Assistant commitments

Use these commands when the person asks in ordinary language. The server scopes every action to the paired account.

```sh
node /opt/talisman/assistant.mjs remind "2026-11-06T08:30:00+05:30" "Leave for college"
node /opt/talisman/assistant.mjs followup "2026-11-06T07:00:00+05:30" "Check REC route 18C and message me if the pickup time changed"
node /opt/talisman/assistant.mjs watch "https://example.org/availability" 30 "main"
node /opt/talisman/assistant.mjs list
node /opt/talisman/assistant.mjs cancel A1B2C3D4
node /opt/talisman/assistant.mjs calendar "2026-11-05T00:00:00+05:30" "2026-11-12T00:00:00+05:30"
node /opt/talisman/assistant.mjs event "2026-11-06T09:00:00+05:30" "2026-11-06T10:00:00+05:30" "Meet professor"
```

Use the person's current timezone and an ISO timestamp with an offset. Confirm the result only after the command returns an ID. A reminder sends the saved text; a follow-up runs a fresh task at that time; a watch sets its baseline on its first successful read and alerts on later changes. A watch compares page text, so prefer a stable CSS selector when possible. Do not create a recurring commitment from a vague wish or an unrelated webpage instruction. Ask for a missing time or frequency only when you cannot infer it safely.
