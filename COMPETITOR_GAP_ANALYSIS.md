# Talisman competitor gap analysis

Reviewed 5 November 2026. This compares public first-party product pages with the current Talisman repository. Competitor pages describe their own products; availability and performance have not been independently verified. “Gap” means absent from the inspected Talisman code, not impossible with its existing browser tools.

## Current baseline

Talisman has Telegram account pairing and messaging; one assigned Webtop computer per account; Playwright and desktop control; OpenCode or connected ChatGPT model selection; Arlong search, extraction and optional screening; reminders, recurring tasks, website watches and a morning brief; per-user memory files; and text extraction from forwarded PDF, spreadsheet and text documents. The dashboard handles account and model setup, without a web chat. These are documented in [README.md](README.md) and implemented across `telegram.mjs`, `worker.mjs`, `computer-service.mjs` and `proactive.mjs`.

## Competitor evidence

| Product | Publicly described capabilities | Sources |
| --- | --- | --- |
| Instinct AI | Text and call interface; assistant uses phone and computer to handle errands such as orders and travel. Its policies describe connected apps, delegated actions, credentials and payment information. The user-provided dashboard references also show a vault and connector catalog. | [Homepage](https://instinct.com/), [privacy](https://instinct.com/privacy-policy), [terms](https://instinct.com/terms) |
| Tab | iMessage and WhatsApp, group chats, outbound calls, shopping, flight and restaurant tasks, media edits, monitoring and connected email/calendar. Its updates describe recovery from changed pages, verification handoff, task receipts, recurring work and notifications. Some payment capabilities are limited beta. | [Homepage](https://tab.bot/), [updates](https://tab.bot/updates), [privacy](https://tab.bot/privacy), [terms](https://tab.bot/terms) |
| Hark Pro | Persistent personal context, Projects, cloud computer and browser handoff, encrypted vault, Google/Microsoft connections, proactive suggestions, Action Buttons, custom Panels and mobile/web clients. The six-browser figure is Hark's own claim. | [Pro introduction](https://hark.com/articles/introducing-hark-pro), [Handoff](https://hark.com/articles/introducing-hark-handoff), [FAQ](https://hark.com/using-hark), [homepage](https://hark.com/) |

## Gaps to build

| Priority | Capability | Talisman gap | Testable outcome |
| --- | --- | --- | --- |
| P0 | Durable task execution | Jobs run through a bounded agent loop, but no persisted step graph, checkpointed browser state, per-step retries, or side-effect idempotency. | Interrupt a multi-site task, restart services, resume safely, and show a truthful action log and final receipt in Telegram. |
| P0 | Approval and handoff | No Telegram callback-button flow to approve, reject or take over a pending sensitive action. Browser restrictions prevent some actions without a continuation path. | User gets an exact action summary, price/recipient when relevant, expiration and Approve/Reject controls; execution resumes once, with an audit record. |
| P0 | Connector platform | No account-scoped OAuth integrations for the user's email, calendar, contacts or files. | Connect, refresh, revoke and audit a scoped provider account without exposing credentials to the model or other users. |
| P1 | Google and Microsoft productivity | No direct Gmail/Google Calendar/Drive or Outlook/Microsoft 365 access. | Search both inboxes, detect a calendar conflict, draft a reply or event, ask approval for sending, and cite source messages. |
| P1 | Event-driven proactivity | Existing morning brief and reminders are scheduled; no cross-source triggers for travel, delivery, inbox or calendar changes. | Detect a meaningful event, deduplicate it, deliver one useful Telegram suggestion and record user response. |
| P1 | Full transaction workflow | Browser can research and navigate, but cannot reliably carry booking/shopping through login, approval, payment and receipt verification. | Compare live options, hold or prepare the choice, obtain approval, complete only authorized steps, and return a verified confirmation or precise blocker. |
| P1 | Private vault | No account-scoped encrypted credential/card vault with origin-bound browser filling and explicit delegation. | Store a login securely, fill only on its allowed origin, never show the secret to the model, and let the user revoke it. Payment methods should follow a separate design review. |
| P1 | Multimodal Telegram | Bot handles text and forwarded documents, but not voice notes, photos, video or rich file output. | A user sends a screenshot or voice note and receives a grounded answer, with extracted file data and source context. |
| P1 | Project and memory context | Per-user `SOUL.md`/`MEMORY.md` exist, but there is no user-visible project scope, searchable history or durable outcome memory. | Keep separate project contexts, retrieve relevant prior facts with provenance, and allow correction/deletion. |
| P2 | Phone calls and verification handoff | Telegram is the sole communication channel; no outbound calling, live transcription or user handoff. | Place a user-approved call, summarize it, and transfer control when authentication or a human decision is needed. |
| P2 | Group collaboration | Bot polls private messages only; no group-specific permissions or privacy boundaries. | Join a Telegram group with explicit consent, answer shared requests, and keep private account data inaccessible to group members. |
| P2 | Generated artifacts | Document support currently extracts text; no polished spreadsheet, slide, image or video creation flow. | Produce and deliver an editable artifact from a Telegram request with a clear preview and provenance. |
| P2 | Personalized quick actions | Dashboard is setup/status focused; no Hark-like personalized action cards or one-tap task continuations. | Show suggested actions from verified events and let the user act from Telegram inline buttons or a non-chat dashboard. |
| P3 | Additional channels and delegated identity | No iMessage/WhatsApp, dedicated assistant email/number, or autonomous account creation. | Add each channel only with its own consent, delivery, identity and abuse controls. Never imply a Telegram bot can read unrelated private chats. |

## Recommended sequence

1. **Reliability foundation:** persisted task steps, checkpoints, idempotency, accurate status and receipts. Add approval and human handoff before any irreversible action.
2. **Connected assistant:** secure connector framework, then Gmail/Calendar and Microsoft Graph. Add inbox/calendar synthesis and event-driven suggestions with user controls.
3. **Complete errands:** improve browser recovery and verification, add vault-backed login, then bookings and shopping with explicit approvals and receipts.
4. **Richer interaction:** voice/photo input, calling, project contexts and group collaboration. Add artifact creation and personalized quick actions once the underlying tasks work reliably.

The first demonstration should be: “Check my two inboxes and calendars for tomorrow, tell me if my trip conflicts with class, find two alternatives, and prepare the change.” It exercises retrieval, synthesis, browser research, memory, approval and a truthful receipt without requiring an unauthorized purchase.
