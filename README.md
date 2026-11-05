# Talisman

> **Testing phase.** Talisman is an early MVP. It is not commercially launched and the architecture is not yet hardened for paying users. See [documentation.md](documentation.md) for the full architecture, known limitations, and roadmap.

Talisman is a Telegram-first personal agent. A private Telegram message creates one account and queues one dedicated Webtop container. That container runs OpenCode and the Talisman worker. The dashboard shows the assigned computer and model connection status; conversations happen only in Telegram.

## Run locally

Requirements: Docker Desktop with Linux containers, enough free disk space for a Webtop image, and a Telegram bot token. Put `TELEGRAM_BOT_TOKEN=...` in a local `.env` file. The file is ignored by Git and excluded from Docker builds. Keep the token private.

```sh
docker compose --profile build build desktop-image
docker compose up -d --build talisman provisioner
```

Open `http://127.0.0.1:3000`. Open the bot in Telegram and send `/start`. The bot creates your account, assigns a computer, and displays a unique 12-character pairing code. Enter that code in the dashboard to link your browser. Each code works once and expires after 10 minutes. One Telegram identity maps to one Talisman account and one computer. To view a different account in the same browser, log out first.

If you have a dashboard account from the earlier local-worker version, stay signed in, send `/start` to the bot, and choose **Enter pairing code** in the dashboard. This links your existing account and transfers its pending tasks to the new assigned computer.

`PUBLIC_URL` may be set in `.env` to a dashboard URL reachable from the device running Telegram. For local use on the same computer, open the dashboard directly at `http://127.0.0.1:3000`. The server binds to localhost by default.

To enable Arlong search, page extraction, and on-demand screening, add `arlong=YOUR_ARLONG_API_KEY` to `.env` (or use `ARLONG_API_KEY=...`) and restart `talisman` with `docker compose up -d --build talisman provisioner`. The key stays in the control service; assigned computers call its authenticated worker endpoints. Arlong Search supplies screened index excerpts for source discovery. Talisman uses Extract for a selected public URL when browser access is challenged and offers Screen when the agent suspects a page is trying to instruct it. Search snippets are not verified page details, and neither Arlong nor Chromium can guarantee access through CAPTCHA, login, or a site's bot policy. Arlong calls consume account credits; see [Arlong's API docs](https://arlong.org/docs).

There is no `worker.mjs` command for end users. Docker starts a fresh, Talisman-owned OpenCode installation inside each assigned computer. It does not use the host user's personal OpenCode files. To enable inference, configure a Talisman service credential in `.env` as `OPENCODE_API_KEY=...` before provisioning; use an account with available OpenCode usage. This key is passed only to Talisman-created containers. Rebuilding OpenCode or changing network location does not reset provider usage limits. Model discovery, selection, and performance history stay inside the worker and are not shown in the dashboard or Telegram.

For local testing, pair your Telegram account, open **Models**, and select **Continue with ChatGPT**. This uses OpenAI's documented local open-source OAuth flow. It requires no OpenAI API key. A browser callback listens only on `127.0.0.1:1455`; open the dashboard on the same computer at `http://127.0.0.1:3000`. Each Talisman account authorizes its own ChatGPT account. Credentials are encrypted at rest in the local data volume. Talisman discovers the account's model catalog and uses only its economical and balanced tiers. The Models tab offers **Automatic**, **Free models**, and **OpenAI**. Free models are restricted to OpenCode entries reporting zero input and output cost; their usage limits still apply. Connected OpenAI requests use a bounded tool loop: the model decides whether to use the account's assigned browser on every turn. The free model receives the computer skill and makes the same decision through OpenCode. This local flow is not the approved commercial website sign-in path for a remotely hosted paid service.

## Telegram commands

- `/start` — get a new dashboard pairing code.
- `/setup` — revisit the optional personal introduction. New accounts are asked a few questions during onboarding.
- `/mode auto`, `/mode free`, `/mode openai` — change the same model choice shown in the dashboard.
- `/status` — check the assigned computer.
- `/kill` — stop the current task only. Queued and running work is canceled and pending replies are dropped; saved memory, reminders, schedules, and past conversation are kept.
- `/remind 10m text`, `/reminders` — schedule and list reminders.
- `/every 1h task`, `/schedule`, `/stop ID` — run recurring agent tasks and follow-ups.
- `/watch 30m https://example.com`, `/watches`, `/unwatch ID` — check a public webpage with the assigned browser and alert only when its content changes. An optional CSS selector after the URL narrows the watched region.
- Forward a PDF, XLSX, CSV, TSV, text, or Markdown file up to 10 MB — extract and save readable text in your account. Use `/documents` and `/document ID` to retrieve it.
- `/remember key: value`, `/memories`, `/memory search words`, `/forget key` — manage saved memory. Facts you state in passing are saved automatically.
- `/at 09:00 text`, `/at tomorrow 9am text`, `/at 2026-11-05 18:00 text` — run a one-off task at that time.
- `/daily 08:30 text`, `/scheduled`, `/cancel ID` — a task every day at a fixed time, and the list of everything scheduled.
- `/timezone Asia/Kolkata`, `/brief 08:30`, `/proactive off` — your clock, your morning brief time, and whether Talisman may message you first.
- Any other text — send a task to Talisman through the selected model route.

The model can also set a reminder, schedule a future task, start a website change watch, list those commitments, or cancel one when you ask in ordinary language. It confirms each change only after the account-scoped tool returns an ID. Use an exact time and timezone for reliable scheduling. A website watch sets a baseline on its first successful read and alerts only on later text changes; a focused CSS selector helps avoid alerts from unrelated page updates.

Each account has its own `SOUL.md` and `MEMORY.md` in the private control volume under `/data/users/<account-id>/`. The introduction and explicit `/remember` and `/forget` commands update these files. Their contents are included as account-specific context in the agent's requests.

## Architecture and current scope

Telegram bot → Talisman server and SQLite → account-scoped durable job queue → dedicated Webtop container with OpenCode and worker. The selected provider receives conversation context and available computer tools on every turn. The model plans tool use, executes through the assigned computer, and verifies live findings before replying. The dashboard shows connection status and account settings. It does not expose the computer screen, browser job submission, or model identifiers. The provisioner alone has access to the Docker socket. The control-plane container does not need OpenCode; OpenCode is installed in the desktop image.

The current implementation is a local prototype. Webtop containers have weaker tenant isolation than dedicated VMs. Telegram commands, reminders, recurring agent tasks, scheduled website change alerts, memory, document text extraction, and per-account browser and basic desktop control are implemented. The assigned computer runs Playwright over its own Chromium, with search, page inspection, selectors, forms, and screenshots; xdotool provides a desktop fallback. When configured, Arlong provides search, screened extraction, and on-demand screening. Search and browsing depend on each site's access controls, and blocked pages are reported as such. Calendar and email connectors, voice calling, full travel booking, and interception of messages outside the bot are not implemented. Telegram bots cannot read a user's unrelated private conversations. Those capabilities require separate integrations and explicit user authorization.
