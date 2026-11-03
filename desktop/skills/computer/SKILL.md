---
name: computer
description: Use the assigned private Chromium browser and Linux desktop to search the live web, inspect pages, click controls, fill forms, and take screenshots for the user's Telegram task.
---

# Computer

This skill runs inside the user's assigned Talisman computer. Use it for current facts, websites, tickets, shopping, travel, forms, and pages without APIs. Work in this container only. Never send the user a desktop URL, screenshot path, internal model name, or raw tool output.

Use `bash` to call the local tool:

```sh
node /opt/talisman/computer.mjs search "Jailer 2 Chennai November 9 tickets"
node /opt/talisman/computer.mjs open "https://example.com/"
node /opt/talisman/computer.mjs read "https://example.com/" 'main'
node /opt/talisman/computer.mjs inspect
node /opt/talisman/computer.mjs find "Avadi"
node /opt/talisman/computer.mjs click 'a[href*="tickets"]'
node /opt/talisman/computer.mjs fill 'input[name="search"]' "Jailer 2"
node /opt/talisman/computer.mjs press Enter
node /opt/talisman/computer.mjs screenshot
```

The browser keeps its page, cookies, and signed-in state between commands. Search results include URLs. Open the relevant results and verify the page before stating a price, availability, date, or booking status. Search alternate spellings or nearby services if the first result misses. If a site blocks automation, say what you could verify and what you could not.

For native graphical apps when browser selectors are insufficient, use `desktop-screenshot`, `desktop-click X Y`, and `desktop-type "text"`. Inspect a fresh screenshot before clicking coordinates, and verify the screen afterward.

Use prior conversation details before asking the user. For availability checking, a movie, city, and date are enough to search; theater, showtime, and ticket count can be chosen later. Ask for missing details only when they block the next actual action. Before a purchase, booking, account creation, message to another person, or other consequential action, get approval unless already authorized.
