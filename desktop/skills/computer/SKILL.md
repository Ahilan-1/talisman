---
name: computer
description: Use the assigned private Chromium browser and Linux desktop to search, read, wait, scroll, click, fill forms, manage tabs and take screenshots for the user's Telegram task.
---

# Computer

You are operating this person's own computer. They never see its screen, so everything you report must come from what
you actually observed here.

Read `how_to_browse.md` in this folder for the full playbook. The short version:

```sh
node /opt/talisman/computer.mjs search "Jailer 2 Chennai November 9 tickets"
node /opt/talisman/computer.mjs open "https://example.com/"
node /opt/talisman/computer.mjs wait "main"          # wait for a selector
node /opt/talisman/computer.mjs wait "" "Sold out"   # wait for visible text
node /opt/talisman/computer.mjs read "https://example.com/" "main"
node /opt/talisman/computer.mjs text                 # current page, no navigation
node /opt/talisman/computer.mjs find "Avadi"
node /opt/talisman/computer.mjs scroll down 900
node /opt/talisman/computer.mjs click 'a[href*="tickets"]'
node /opt/talisman/computer.mjs fill 'input[name="search"]' "Jailer 2"
node /opt/talisman/computer.mjs select '#city' "Chennai"
node /opt/talisman/computer.mjs press Enter
node /opt/talisman/computer.mjs screenshot
node /opt/talisman/computer.mjs back
```

## Rules that keep you out of trouble

- **Wait before you read.** JavaScript pages paint after `domcontentloaded`. If the text looks like navigation or
  "loading", run `wait` on a selector you can see in `inspect`, then `text`.
- **Never reuse a dead page.** After `search`, the previous page is gone. Re-open the URL you need.
- **`blocked: true`** in a read result means a bot wall or CAPTCHA. Try one alternate source, then report exactly what
  you verified.
- **Truncated text** means there was more page. `find` on the term, or `read` with a narrower selector.
- **Screenshots** go to a private path. Never give that path to the user; describe what you see instead.
- **Approval gates:** never click pay, place order, confirm booking, buy now, purchase, send message, or create
  account unless the user already asked for that exact action.

## Desktop fallback

Only when selectors cannot reach a native app:

```sh
node /opt/talisman/computer.mjs desktop-screenshot
node /opt/talisman/computer.mjs desktop-click 640 420
node /opt/talisman/computer.mjs desktop-type "hello"
```

Take a fresh screenshot before every coordinate click, and verify the screen afterwards.
