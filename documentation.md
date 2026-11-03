# Talisman — Developer Documentation

Status: **early MVP, testing phase.** Not commercially launched, not multi-tenant hardened, not production SLA.
Last reviewed: 2026-11-03.

This document is for developers working on the repository. It explains how the infrastructure actually works, what
is deliberately unfinished, why web browsing and memory are unreliable today, what is missing in the prompt and tool
layer, how the security model looks after the current hardening pass, and what has to change before the product can
be sold.

---

## 1. What Talisman is

Talisman is a Telegram-first personal agent. One private Telegram identity maps to one Talisman account and one
dedicated Linux "computer" (a Webtop container) that runs OpenCode and the Talisman worker. The dashboard
(`public/`) is only a control panel: it links the browser to the Telegram account, shows the assigned computer,
and sets the model route. All conversation happens in Telegram.

```
Telegram user
    │  (private message / file)
    ▼
Telegram Bot API  ◄──── long poll ────┐
                                      │
                          ┌───────────┴───────────┐
                          │  talisman (control)   │
                          │  node:http, :3000     │
                          │  OAuth callback :1455 │
                          │  SQLite (WAL)         │
                          └───────────┬───────────┘
                                      │  SQLite job queue (poll)
                                      ▼
                          ┌───────────────────────┐
                          │  provisioner          │
                          │  Docker API over      │
                          │  /var/run/docker.sock │
                          └───────────┬───────────┘
                                      │ creates/starts
                                      ▼
                ┌──────────────────────────────────────┐
                │ talisman-<computerId>                │
                │ linuxserver/webtop:ubuntu-xfce       │
                │  • worker.mjs      (queue consumer)  │
                │  • computer-service.mjs (:4150)      │
                │  • opencode serve  (:4096)           │
                │  • Chromium via playwright-core      │
                │  • 2 GiB RAM / 2 CPU / 512 pids      │
                └──────────────────────────────────────┘
```

### Components

| File | Role | Runs where |
| --- | --- | --- |
| `server.mjs` | HTTP API, dashboard session auth, pairing, job queue, OAuth callback listener, stale-job reaper | control container |
| `telegram.mjs` | Long-poll bot loop, command router, reminders, recurring tasks, page watches, result delivery | control container |
| `provisioner.mjs` | Watches `computer_provisioning`, creates and starts one container per account through the Docker API | control container (separate process) |
| `worker.mjs` | Pairs the container, polls for jobs, runs document/watch/model/message jobs, drives OpenCode and the OpenAI tool loop | user container |
| `computer-service.mjs` | Loopback HTTP service on `127.0.0.1:4150` exposing browser and X11 actions to the worker | user container |
| `computer.mjs` | Thin CLI wrapper around `computer-service.mjs` for OpenCode's bash tool | user container |
| `openai-connection.mjs` | ChatGPT OAuth (PKCE), sealed credential storage, token refresh, model catalogue, streaming tool calls | control container |
| `document-tools.mjs` | PDF/XLSX/CSV/TXT/MD text extraction | user container |
| `user-profile.mjs` | `SOUL.md` / `MEMORY.md` generation and onboarding state machine | control container |
| `public/` | Dashboard SPA (vanilla JS, no build step) | control container |
| `prompts/talisman.md` | System prompt for the OpenCode (free model) path | user container |
| `desktop/` | Desktop image, s6 service definitions, computer skill, Dockerfile | build time |

Legacy/dead code: `desktop-proxy.mjs` is not copied into either Docker image and is not referenced by
`compose.yml`. Do not build new features on it.

### Data model (SQLite, `node:sqlite`)

`users`, `sessions`, `computers`, `jobs`, `chat_sessions`, `telegram_accounts`, `dashboard_pairs`,
`computer_provisioning`, `telegram_sessions`, `telegram_requests`, `conversation_messages`, `reminders`,
`recurring_tasks`, `web_watches`, `documents`, `memories`, `model_preferences`, `user_profiles`, `app_state`,
plus `openai_connections` and `openai_auth_attempts` created by `openai-connection.mjs`.

Notes that matter operationally:

- There is **no migration framework.** Schema is created with `CREATE TABLE IF NOT EXISTS` at boot, and the
  OpenAI tables are created on import. Any real schema change needs a hand-written migration or a fresh volume.
- `PRAGMA journal_mode=WAL` is set, but there is no backup, no checkpoint policy, and no replication.
- `users.password_hash` exists for historical reasons. Password registration is gone; the API returns 401 for
  `/api/register`. Telegram accounts get a random, unusable scrypt hash.
- Jobs carry `status` in `queued | running | done | failed | canceled`. There is no `retry` state, no attempt
  counter, and no dead-letter queue.

---

## 2. Request lifecycle (message path)

1. **Telegram → server.** `startTelegramBot` long-polls `getUpdates` (25 s timeout) and serialises handling per chat
   id. `telegram_requests` rows track which job still owes the user a reply.
2. **Account resolution.** `ensureTelegramAccount` creates `users` + `telegram_accounts` + `computers` +
   `computer_provisioning(status='pending')` on the first private message and starts onboarding.
3. **Command routing.** Slash commands (`/start`, `/mode`, `/remind`, `/every`, `/watch`, `/documents`,
   `/remember`, `/kill`, `/status`, …) are handled inline; anything else becomes a `message` job.
4. **Enqueue.** `enqueue()` snapshots the 20 most recently updated `memories` and the rendered `SOUL.md` into the
   job payload. The user text is also written to `conversation_messages`.
5. **Provisioning.** The provisioner sees `pending`, creates `talisman-<computerId>`, hashes the freshly minted
   worker key into `computers.worker_key_hash`, starts the container, marks `running`.
6. **Worker poll.** `worker.mjs` calls `GET /api/worker/jobs` every 2 s. The server returns the oldest `queued` job
   for that computer, flips it to `running`, and attaches a 16-message history window plus the current OpenCode
   session id for `message` jobs.
7. **Execution.**
   - `document` → `extractDocument`, text returned and stored.
   - `watch` → single `read` action, hash comparison in the server, silent when unchanged.
   - `models` / `sessions` → OpenCode introspection.
   - `message` → either the **OpenAI tool loop** (when connected and preference is not `free`) or **OpenCode** with
     the free-model scorer.
8. **Completion.** The worker POSTs `{result,error}` to `/api/worker/jobs/:id`. The server writes the reply,
   records the OpenCode session id, and marks the job done/failed.
9. **Delivery.** A 2 s loop sends undelivered results to Telegram, mapping internal errors to friendly text and
   stripping provider/model identifiers.

Watchdog behaviour: any job stuck in `running` for 5 minutes is force-failed by a 30 s reaper in `server.mjs`.
The worker has its own cancellation watcher that polls job status every second while a step runs.

### Model routing

| Mode | Reply path | Computer actions |
| --- | --- | --- |
| `automatic` (default) | OpenAI when connected, else OpenCode free models | OpenAI tool loop if connected, else OpenCode + computer skill |
| `free` | OpenCode only, zero-cost models only | OpenCode + computer skill |
| `openai` | OpenAI only (409 if not connected) | OpenAI tool loop |

`worker.mjs` scores free models by default flag, tool-call capability, reasoning capability, context size and an
in-memory success/failure/latency table. That table is lost on container restart. `TALISMAN_INTERNAL_MODEL`
can pin `provider/model`.

The OpenAI path is an **unofficial local flow**: it uses the ChatGPT desktop OAuth client
(`dynamic_agent_client`), a loopback callback on `127.0.0.1:1455`, and the Codex-style `responses` API with
namespaced tools. It is explicitly not the approved commercial integration path.

---

## 3. Why this is still unfinished

The MVP proves the loop: message in, container created, model plans, browser acts, answer out. Everything around
that loop is thin.

**Compute and orchestration**

- One container per account, kept `unless-stopped`. There is no idle suspension, no scale-to-zero, no warm pool.
  A Webtop image is large and each idle user holds 2 GiB RAM and 2 vCPU reservations. Cost per dormant account is
  the single biggest blocker to consumer pricing.
- A single control-plane process with a SQLite file is the queue, the session store, the schedule store and the
  document store. No HA, no failover, no read replicas.
- The provisioner needs the Docker socket, which is root-equivalent on the host. That is acceptable on a laptop
  and unacceptable in a hosted product.
- No image pinning by digest, no registry scanning, no supply-chain verification, no automatic base-image patching.
- No CI, no lint, no type checking, no staging environment. Tests are a single integration test that runs the real
  server plus a stubbed OpenCode.

**Product surface**

- The dashboard has four read-mostly views. There is **no live browser view, no task composer, no job history, no
  memory editor, no document browser, and no billing page.** The `/desktop/<id>/` route is not implemented in
  `server.mjs` (the integration test asserts it 404s), so the Webtop GUI is not reachable through the dashboard and
  the desktop containers publish no ports in `compose.yml`.
- Telegram is the only conversation channel. No web chat, no mobile app, no email.
- No admin tooling: no account lookup, no quota override, no refund/kill switch, no support transcript view.

**Reliability**

- Queue polling with no lease/ack timeout beyond the 5-minute reaper means a slow-but-alive job can be killed
  mid-flight, and a worker restart silently loses an in-flight reply.
- Result delivery is at-least-once by intent but deduplicated only by `delivered_at`; a Telegram send failure
  retries the whole batch.
- Errors are collapsed into friendly Telegram text, so operators cannot see which tenant hit which failure without
  reading container logs.
- No structured logging, no request ids, no metrics, no traces, no alerting, no uptime checks.

**Commercial readiness**

- No terms, privacy policy, data-retention policy, export, or deletion flow. Deleting a Talisman account does not
  remove the `talisman-home-<id>` volume.
- No abuse controls for what an autonomous browser agent may do on a user's behalf, and no legal review of
  automated browsing against target site terms.
- Model access is a per-user ChatGPT OAuth connection, not a resale agreement. That cannot be the paid offering.
- No multi-region, no data residency, no DPA, no subprocessor list, no incident process.

---

## 4. Why web-browser tasks still fail to load

This is the most reported symptom: "I asked it to check a site and nothing came back / the page did not load."
The causes are concrete and mostly in `computer-service.mjs` and `worker.mjs`.

1. **Navigation returns before content exists.** Every navigation uses
   `waitUntil: 'domcontentloaded'`. On a JS-rendered site (travel, ticketing, e-commerce) the DOM is empty at that
   point, so `innerText` returns navigation chrome and "loading…" placeholders. There is no wait for a selector,
   no network-idle wait, and no retry with a longer budget.
2. **A 12-second default page timeout.** `page.setDefaultTimeout(12_000)` is shorter than a cold Chromium start,
   a consent interstitial, or a first-paint on a slow site. Failures look like "computer failed" to the user.
3. **A single global `busy` lock.** `computer-service.mjs` rejects any concurrent request with HTTP 429
   "Computer is busy". A `/watch` check running at the same time as a message job is enough to fail one of them,
   and the failure surfaces as a generic error.
4. **One page, shared across steps.** `browser()` reuses one persistent context and one page. `search` navigates
   that page to Google, so any previously opened page is lost. There is no tab model, no back/forward, no scroll,
   and no hover, so multi-step flows dead-end.
5. **Search is scraped, not API-backed.** `search` reads `a:has(h3)` from Google and `li.b_algo` from Bing. Consent
   walls, "unusual traffic" interstitials, and CAPTCHA pages return zero results. The fallback is the note
   "Search results were unavailable", which the model can then talk around.
6. **Datacenter IP reputation.** Many retail, ticketing and news sites serve a Cloudflare/Akamai challenge to
   container IPs. The `publicUrl()` allowlist only blocks private ranges; it does not help with blocks. The watch
   path detects three block strings, but interactive browsing has no equivalent detection or alternate-source
   strategy.
7. **Tool surface is too small for the OpenAI path.** The loop in `worker.mjs` allows only
   `search, open, read, find, inspect, click, fill, press`. Missing: `screenshot`, `wait`, `scroll`, `back`,
   `select`, `hover`, `upload`, `download`, `new_tab`, `network`. There is also no vision path, so the model can
   never see the page it is interacting with.
8. **Every tool schema forces every field.** `tool()` marks all properties required with
   `additionalProperties: false` and `strict: true`, so the model must send `selector: ""` for `read` and
   `value: ""` for `fill`. Field-level ambiguity like this causes malformed calls and "Unsupported computer action".
9. **Budget exhaustion.** 18 rounds, 4 minutes wall clock, 140 s per model step, 45 s per action. A real booking
   flow (search → results → detail → date picker → seat map) does not fit, and the user sees a step-limit message.
10. **Output is truncated.** Page text is cut at 14 000 chars in `summary()` and 20 000 in `read`; tool output is
    cut at 10 000 chars. Price tables and result lists are frequently past the cut.
11. **`read` re-navigates and throws on a missing selector.** `locator(selector).first().innerText()` fails if the
    selector no longer exists, turning a partial success into a hard error.
12. **The dashboard cannot show the browser.** There is no screenshot streaming and no desktop proxy. Users expect
    to watch the task; the MVP cannot show it, which reads as "not loading".

What this means for contributors: treat "browser reliability" as a subsystem, not a bug. The minimum credible fix
is a dedicated browser layer with navigation profiles (selector wait + network idle + retry), per-job page
isolation, a screenshot tool with vision input, a real search API behind a paid key, block detection with alternates,
and an explicit "what I could and could not verify" reply contract.

---

## 5. Why memory is not good yet

> Memory v2 below (§11) replaces this. The limits in this section are the historical reason for the rewrite and still
describe what the system cannot do (no embeddings, no per-topic retrieval).

Memory today is a flat key/value table injected as text. It is honest, auditable and cheap — and it does not scale.

- **Fixed, unordered budget.** `enqueue()` takes `ORDER BY updated_at DESC LIMIT 20` memories. Anything written
  earlier silently disappears from context. There is no relevance ranking, no embeddings, no per-topic retrieval.
- **Writing is manual.** Memory is created only by `/remember key: value` or a "remember that …" regex. Nothing is
  distilled from conversation, so the agent never learns preferences the user did not explicitly dictate.
- **Conversation history is a 16-message window.** `worker.mjs` sends the last 16 rows, each truncated to
  1 000–2 000 chars. Long-running projects lose their beginning. There is no summarisation or rolling compaction.
- **`/kill` deletes history.** The command clears `conversation_messages` and the OpenCode session to give the user
  a clean slate. That is the documented escape hatch, but it also destroys usable context with no export.
- **Documents are write-only in practice.** Up to 100 000 chars per file are stored, but retrieval is
  `/document <8 hex>` only. No search, no chunking, no citations into answers.
- **The profile is three answers.** `user_profiles` keeps preferred name, goals and preferences (500 chars each).
  `SOUL.md` renders them into prose. Running `/setup` again overwrites them.
- **`MEMORY.md` is a mirror, not a store.** It is regenerated from `memories` on every change; editing it has no
  effect.
- **The natural-language remember path keys by hash.** Slight rewordings create duplicate notes instead of
  updating one memory.
- **No memory for task outcomes.** A completed booking or a discovered preference is not fed back, so the next
  similar task starts from zero.
- **Two copies of context.** The OpenAI path receives `context` + `soul`; the OpenCode path additionally receives
  history inside the system prompt. The two paths can see different memories for the same account.

The intended direction: an append-only memory log with typed entries (fact, preference, entity, task outcome),
embedding-based retrieval for a token budget, LLM extraction after each successful task, user-visible review and
forget controls, and a summariser that keeps a rolling project state per account.

---

## 6. Why the prompt is not good yet

> The prompt layer was consolidated into `prompt.mjs` plus `prompts/voice.md`, `prompts/policy.md` and
> `prompts/talisman.md` (§11). This section records why the rewrite was necessary.

Four prompt surfaces had drifted apart:

| Location | Used by |
| --- | --- |
| `prompts/talisman.md` | OpenCode free path |
| `computerGuide` string in `worker.mjs` | OpenCode free path (appended) |
| `generate()` instructions in `openai-connection.mjs` | plain OpenAI replies |
| `step()` instructions in `openai-connection.mjs` | OpenAI tool loop |
| `userSoul()` in `user-profile.mjs` | persona block injected into all of the above |

Concrete problems:

- **Duplication and contradiction.** "Ask only for details that remain necessary" competes with a long list of
  behaviours in the same paragraph. The persona is described three times in slightly different words, so tone
  drifts between routes and between model tiers.
- **No structure.** Rules are one dense paragraph each. There is no priority order, no definition of done, no
  output contract, no tool-by-tool guidance, no failure playbook ("if blocked, try X then report Y").
- **No examples.** Zero few-shot turns for the two hardest behaviours: deciding when to browse, and reporting a
  partial verification honestly.
- **Hardcoded locale.** Date and time are formatted with `Asia/Kolkata` in both `worker.mjs` and
  `openai-connection.mjs`. Every user sees Indian time.
- **No budget awareness.** The model is never told how many tool rounds, seconds or characters it has, so it plans
  work it cannot finish.
- **No self-check.** Nothing asks the model to verify that each factual claim came from a tool result, so
  confident-sounding unsourced answers still appear.
- **Tool descriptions carry behaviour.** Long behavioural instructions live in JSON schema strings, which are the
  worst place to maintain policy.
- **No evaluation.** There is no golden-task set, no regression run, no scoring, no A/B. Prompt changes are
  unmeasured.

The intended direction: one versioned prompt module with a persona block, a policy block, route-specific tool
policy, an output contract, an explicit budget, and 2–3 few-shot examples; locale from the account; and a
golden-task evaluation harness run before any prompt change ships.

---

## 7. Tools that do not exist yet

> Implemented in this pass (§11): browser screenshot with vision, scroll, hover, select, back/forward, tabs, explicit
> wait, whole-page text, and block detection. Still missing is the list below.

Browser layer (both paths): file upload, file download and read, cookie/consent handling, iframe support, network
inspection, structured extraction (tables, JSON-LD), PDF reading from a URL, and a vision pass over a full-page
screenshot (only viewport screenshots are sent today).

Beyond the browser: shell/filesystem tools on the OpenAI path (the free path has them via OpenCode only), code
execution sandbox, calendar read/write, email read/draft (send requires explicit approval), contacts, maps and
directions, travel and ticketing APIs, payments (strictly gated), image generation and analysis, speech-to-text and
voice replies, spreadsheets as first-class objects, a document search tool, connector framework with per-user
scoped credentials, and a per-user audit log of every action taken.

The tool allowlist in `worker.mjs` is a hard gate. Adding a tool means: implement in `computer-service.mjs`,
expose in the OpenAI namespace in `openai-connection.mjs`, add to `allowed` in `worker.mjs`, document in
`desktop/skills/computer/SKILL.md`, and add a policy line to the prompt module.

---

## 8. Security model

### What exists

- **No password authentication.** Dashboard access requires a single-use pairing code issued through Telegram
  (12 hex chars, SHA-256 hashed at rest, 10-minute expiry, one active code per account).
- **Session cookies** are `HttpOnly`, `SameSite=Lax`, `Path=/`, 30-day expiry, stored as SHA-256 hashes in
  `sessions`. `Secure` is added when `COOKIE_SECURE=1`.
- **Worker authentication** uses a 32-byte random bearer key, stored only as a hash, scoped to one computer row.
- **Per-IP pairing throttle**: 8 attempts per 10 minutes, in memory.
- **Account scoping**: every dashboard query filters by the session's `user_id`; computer lookups require
  `id AND user_id`; worker calls require the bearer key's own computer row.
- **OpenAI credentials** are sealed with AES-256-GCM using a key file created with mode `0600` outside the
  database. ID tokens are verified against the issuer JWKS (RS256, `aud`, `nonce`, `iss`, `exp`, subject pinning).
  PKCE with S256 and a 10-minute state row.
- **Browser egress allowlist**: `publicUrl()` rejects non-HTTP(S), credentials in URL, `localhost`, `.local`,
  `.internal`, loopback, and RFC1918/link-local ranges.
- **Consequential-action guard**: `click` refuses labels matching pay/order/confirm booking/buy/purchase/
  send message/create account unless the model is explicitly instructed otherwise; the prompt also requires
  approval before purchases, bookings, account creation and messaging third parties.
- **Prompt-injection stance**: web content, documents and tool output are declared to be data, not instructions.
- **Container limits**: 2 GiB memory, 2 CPUs, 512 pids, 1 GiB `/dev/shm`, `no-new-privileges`, per-account home
  volume, no host mounts, no published ports.
- **Secrets**: `.env` is git-ignored and excluded from Docker builds; no credentials in client assets.

### Hardening added in this pass (`server.mjs`)

- Security headers on **every** response: `Content-Security-Policy` (`default-src 'self'`, no inline script/style,
  `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy` disabling geolocation/camera/microphone, and
  `Strict-Transport-Security` when cookies are marked secure.
- Same-origin enforcement on all state-changing API requests (`Origin` compare, `Sec-Fetch-Site: cross-site`
  rejected) as defence in depth behind `SameSite=Lax`.
- JSON-only request bodies for mutations that carry a body (`415` otherwise), which blocks cross-site form posts.
- Global per-IP API rate limit (300 requests/minute) in addition to the pairing throttle.
- Bearer token shape validation before hashing, so oversized or empty tokens cannot be used as a hash amplifier.
- Session pruning on login and on the reaper tick; expired pairing codes pruned on the same tick.
- Internal error details are no longer returned to browsers; worker-authenticated routes keep a short, sanitised
  message for debugging.
- HTTP server timeouts (`headersTimeout`, `requestTimeout`, `keepAliveTimeout`) to resist slow-header stalls.

### Known gaps (must close before commercial launch)

| Gap | Impact | Direction |
| --- | --- | --- |
| No TLS in `compose.yml` | Credentials and session cookies in clear on the LAN | Terminate TLS at a proxy; require `COOKIE_SECURE=1`; HSTS already emitted |
| Provisioner holds the Docker socket | Container escape on the control host is game over | Move to a narrow daemon API / orchestrator with scoped credentials |
| Webtop shared kernel | Weaker isolation than a VM per tenant | Firecracker/gVisor microVM per account, or hardened runtime + egress policy |
| No egress policy | A prompt-injected page can make the browser call internal services | Deny-by-default egress via proxy, allowlist public internet only |
| No audit log | No forensics for "what did the agent do for this user" | Append-only per-account action log, exportable |
| No session revocation UI | A stolen session lives 30 days | List and revoke sessions in the dashboard |
| Single shared rate-limit map | Restart clears counters | Move limits to SQLite/Redis |
| Prompt injection | Web content can still steer the agent | Spotlighting, tool-level capability limits, approval gates on writes |
| No dependency pinning/scanning | Supply-chain risk | Lockfile audit + `npm audit` in CI, image digest pinning |
| Secrets in environment | Visible to anyone with Docker inspect | Secret manager or mounted files, per-environment keys |
| Document text stored in plaintext | Sensitive uploads in the SQLite file | Encrypt at rest with a per-account key |

---

## 9. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Control-plane bind (compose sets `0.0.0.0`) |
| `PUBLIC_URL` | empty | Dashboard URL shown in Telegram pairing messages |
| `TALISMAN_DATA_DIR` | `./data` | SQLite file and per-user `SOUL.md` / `MEMORY.md` |
| `TELEGRAM_BOT_TOKEN` | empty | Bot token; bot disabled when empty or `TELEGRAM_ENABLED=0` |
| `TELEGRAM_BOT_USERNAME` | from `getMe` | Fallback for the dashboard link |
| `COOKIE_SECURE` | `0` | Set to `1` behind HTTPS |
| `OPENAI_LOCAL_SIGNIN` | `1` | `0` disables the `:1455` callback listener (tests) |
| `OPENCODE_API_KEY` | empty | Service credential passed only into provisioned containers |
| `TALISMAN_INTERNAL_MODEL` | empty | Pin `provider/model` for the free path |
| `TALISMAN_DESKTOP_IMAGE` | `talisman-desktop:local` | Image used by the provisioner |
| `TALISMAN_DOCKER_NETWORK` | `talisman_default` | Network attached to user containers |
| `TALISMAN_INTERNAL_URL` | `http://talisman:3000` | Control URL used by containers |

Local run (see `README.md`): build the desktop image, `docker compose up -d --build talisman provisioner`, open
`http://127.0.0.1:3000`, send `/start` to the bot, enter the code.

Tests: `npm test` runs `test/integration.test.mjs` and `test/units.test.mjs` (Node 22+, no Docker required — the integration test stubs OpenCode with a local HTTP server; the unit test covers memory retention and schedule parsing). `test/manual-browser-smoke.mjs` is a manual script that must run inside a paired computer and is deliberately not part of `npm test`.

---

## 10. Roadmap

**Phase 0 — stability (now).** Browser layer rewrite with waits and retries, screenshot+vision tool, per-job page
isolation, structured logs with request ids, job retries with attempt counters, real error surfaces in the
dashboard, dashboard session revocation, migrations.

**Phase 1 — trust.** TLS everywhere, orchestrator without raw Docker socket, per-tenant egress policy, audit log,
account export/delete including the home volume, encrypted documents, dependency and image scanning in CI,
golden-task prompt evaluations.

**Phase 2 — capability.** Memory v2 with embeddings and extraction, tool expansion (calendar, email, files,
spreadsheets, documents search), proper citation contract, live browser view in the dashboard, quota-aware
planning.

**Phase 3 — commercial.** Official model provider agreements, billing and metering per task, plan limits and abuse
controls, terms/privacy/subprocessors, support tooling, SLA and status page, regional deployment, SOC2-style
controls if selling to teams.

Until Phase 3 lands, documentation, pricing pages and marketing must describe Talisman as a **testing preview**,
not a product. Do not onboard paying users on this architecture.

---

## 11. Agent brain v2

This pass replaced the ad-hoc prompt, memory and scheduling code with four modules that both routes share.

### Prompt module

| File | Purpose |
| --- | --- |
| `prompts/voice.md` | Who Talisman is, how it speaks, good/bad reply examples, anti-patterns |
| `prompts/policy.md` | The task loop, complex-task rules, memory contract, honesty contract, safety gates, budget, proactivity |
| `prompts/talisman.md` | Facts about the computer (skills, browser, shell, privacy) |
| `prompt.mjs` | `buildReplyPrompt`, `buildTaskPrompt`, `buildToolPrompt`, timezone stamp, memory and history rendering |

`worker.mjs` (OpenCode route) and `openai-connection.mjs` (OpenAI routes) both call the same builder, so voice and
policy can no longer drift between providers. The prompt is assembled in a fixed order: voice → policy → runtime →
local time → skills → known profile → memory → history → task contract. Both images copy `prompt.mjs` and `prompts/`.

### Memory v2 (`memory.mjs`)

- Columns added in place: `kind` (fact, preference, entity, task, goal), `importance` 1–5, `hits`, `source`,
  `last_used_at`. Existing installs are upgraded with guarded `ALTER TABLE` statements.
- `extractFromMessage` captures durable facts from ordinary messages (name, timezone, city, explicit preferences,
  contact details, "my X is Y", explicit remember requests) and stores them with `source='auto'`. Slash commands are
  never extracted. The rules are deliberately conservative — better to miss a fact than to store a wrong one.
- `selectMemoryContext` ranks every saved fact by importance, explicitness, recency, reuse and keyword overlap with the
  current message, then fills a character budget. **Facts that do not fit are still listed by key** in the prompt, so the
  agent knows they exist and can ask instead of pretending they were never saved.
- `upsertMemory` deduplicates by value, so "dark mode" and "Dark mode" are one memory instead of two.
- `/memory <words>` searches saved facts; `/memories` lists the most useful ones with a total count; `/forget` still
  removes one.
- Retention is measured, not asserted: `test/units.test.mjs` saves 80 facts, selects with a tight budget, and requires
  **≥ 90 %** of them to be reachable (present in context or listed in the index). The current implementation returns
  100 % of keys.

`SOUL.md` and `MEMORY.md` remain a human-readable mirror under `/data/users/<id>/`; the database is the source of truth.

### `/kill` semantics

`/kill` now cancels only queued and running jobs, drops their unanswered conversation rows, and clears the OpenCode
session id. Memories, reminders, recurring tasks, scheduled tasks and completed conversation history survive. Earlier
versions deleted the whole conversation, which read as "it forgot everything".

### Proactive engine (`proactive.mjs`)

Talisman now starts conversations. A 60-second tick evaluates each account and sends at most one message per six hours,
never inside quiet hours (default 22:00–08:00 local), never while a request is still undelivered, and only when the
assigned computer is online.

1. **Morning brief** — at the user's brief time (default 09:00 local), composed from reminders, scheduled tasks and
   recurring tasks due in the next 24 hours. No model call, so it cannot hallucinate a bill.
2. **Open-loop nudge** — if the last assistant message was a question and the user has not replied for three hours, one
   reminder of that question, at most once per 20 hours.
3. **Failed-task follow-up** — a job that failed in the last 24 hours gets one "want me to try again?" with the task text.

Controls: `/proactive on|off`, `/brief HH:MM`, `/status`. Every send is recorded in `proactive_log` for auditing.

### Scheduling (`schedule.mjs`)

Timezone-aware, wall-clock arithmetic (no fixed UTC offsets), so DST and Indian half-hour zones behave.

| Command | Behaviour |
| --- | --- |
| `/at 09:00 task` | One-off at that local time today, or tomorrow if it has passed |
| `/at tomorrow 9am task` | Natural day plus clock |
| `/at 2026-11-05 18:00 task` | Explicit date |
| `/at mon 10:00 task` | Next matching weekday |
| `/at in 2h task` | Relative |
| `/daily 08:30 task` | Recurring at a fixed local time (`daily_time` column keeps it anchored) |
| `/every 2h task` | Interval, as before |
| `/scheduled`, `/cancel ID` | List and cancel |

`/timezone Asia/Kolkata` stores the zone on `proactive_settings` and saves it as a memory, so the same fact is not asked
again. `parseWhenPrefix` and `nextDailyAt` are unit-tested.

### Skills with worked examples

OpenCode now receives every skill, not only the computer one. The OpenCode service copies `/opt/talisman/skills/.` into
`/config/.opencode/skills/` at start.

| Skill | Recipe file |
| --- | --- |
| `computer` | `how_to_browse.md` — wait/read/act/verify, empty pages, bot walls, tables |
| `booking` | `how_to_book.md` — seat maps, totals, approval gates, payment stop |
| `research` | `how_to_research.md` — decision framing, two-source rule, timestamping |
| `documents` | `how_to_documents.md` — invoices, spreadsheets, thin extraction |
| `planning` | `how_to_plan.md` — private plan, running steps, ending a complex task |

The prompt lists installed skills with their paths, so a model that was trained to look for skills can find them
without a hardcoded list.

### Browser tools and vision

`computer-service.mjs` gained `text`, `wait` (selector, text, or network idle), `scroll`, `select`, `hover`,
`back`, `forward`, `newtab`, `switch`, and a `blocked` flag on every read. The default page timeout rose to 20 s, and
navigation now settles on network idle where possible. Search falls back to DuckDuckGo after Google and Bing, and the
result selector covers all three. The single `busy` lock now waits up to 20 s for the current action instead of failing
immediately.

The OpenAI route exposes all of these plus `screenshot`. A screenshot is returned as an image the model can actually
see (base64 `input_image`, viewport only, capped at 2.5 MB), not just a file path. Tool schemas now mark optional
parameters as optional instead of forcing empty strings.

### What is still true after this pass

- Proactive messages need an online computer; a suspended container gets no brief.
- Memory retrieval is lexical, not semantic. There is still no embeddings index, so paraphrased recall depends on the
  ranked scan.
- `/daily` is anchored by local time, but a DST transition can shift one run by an hour.
- The OpenAI path still has no shell or file tools; only the browser namespace.
- Vision covers a single viewport screenshot per call; no full-page or multi-frame reasoning yet.

## 12. Working on this repo

- Node 22+ (`node:sqlite` is used directly). No bundler, no TypeScript.
- Keep the control plane free of OpenCode dependencies; only the desktop image installs OpenCode.
- Never log Telegram tokens, worker keys, OpenAI credentials or full page contents.
- Any new endpoint must: authenticate, scope by `user_id`, return `no-store`, and be safe under the CSRF and
  content-type rules above.
- Any new browser tool must be added in all four places listed in §7 and documented in the computer skill.
- Run `npm test` before committing. Add cases to `test/integration.test.mjs` for new server behaviour.
- The dashboard is dependency-free vanilla JS with `innerHTML` templates; every interpolated value must pass
  through `escapeHtml`.

## 13. Open questions

1. Do we keep one container per user, or move to a pooled browser service with per-session isolation?
2. Is ChatGPT OAuth acceptable for a paid product in any form, or must the OpenAI path be replaced outright?
3. What is the honest retention default for conversation history, documents and screenshots?
4. Which browser actions require per-action user approval once the agent is commercially available?
5. How much of the "minimal, black and white" interface survives the addition of job history and live browser views?
