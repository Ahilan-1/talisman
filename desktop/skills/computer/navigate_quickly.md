# Browser navigation playbook

Use this with the assigned computer for current prices, availability, forms, and seat maps. `inspect` reads the page structure. It does not open Chromium DevTools or put the browser into a mode. The numbered `ref=` controls it returns are valid for the current page observation.

## Observe → act → verify

1. Run `tabs`, then `inspect` on the relevant live tab. Read its URL, visible text, `elements`, and `overlays`.
2. Choose a visible control from `elements`, preferably by its current `ref=` number or accessible label. Use a CSS selector only when it is grounded in the observed page.
3. After a click, fill, or submit, run `inspect` or `text` again. Check the expected change. A successful tool response only proves an action was attempted.
4. If a price or availability matters, verify the exact date, route, passenger count, currency, and fare conditions on the resulting page. A monthly starting fare is not a date-specific quote.

```sh
node /opt/talisman/computer.mjs tabs
node /opt/talisman/computer.mjs inspect
node /opt/talisman/computer.mjs click 'ref=12'
node /opt/talisman/computer.mjs inspect
```

## When an action fails

The error output includes the current tabs, visible controls, overlay hints, and page text. Treat it as a new observation. Never repeat the identical failing action without a change in page state.

1. If the page is dimmed, a consent banner or dialog may cover it. Run `dismiss`, then `inspect`. Prefer a visible **Reject** or **Close** choice when available. An `inspect` call itself never blocks the browser.
2. If the ref vanished, inspect again and use the new ref. Refs change after navigation or a dynamic rerender.
3. If the control is off screen, scroll, inspect, then click the observed control.
   A fare comparison panel may have its own scrollbar. The fare title is often a label, while its **Continue**, **Select**, or **Book** button is below the visible fold. Scroll that panel and inspect again before choosing a fresh ref. Do not treat a click on the fare name as progression to the seat map.
4. If the target changed, use another visible path, such as its label, a search form, or a different provider. Do not invent a destination URL or guess a CSS class.
5. Take a screenshot for canvas controls, complex widgets, or when the visible page conflicts with the text map. Judge the screenshot before the next action.

The computer automatically attempts to close common popups on a blocked click. If it still reports failure, the click did not complete. Never report that the date was selected or the search submitted until the page confirms it.
Browser notification permission prompts are browser chrome, not page elements. The assigned browser disables those prompts; if an existing prompt remains, close it before interacting with the website.

## Date pickers

First inspect the form. Set origin and destination if needed. Look for a departure date input or button. For an ordinary date input, `fill 'ref=N' '2026-12-24'` and press Tab. For a calendar, click the month/year control or its next-month control, inspect again, and choose the day with the full date label. Verify the form now displays the intended date before searching. If a site refuses the picker after a popup is closed and one alternate control is tried, use another source.

Do not click a bare number such as `24` if the calendar displays multiple months. Inspect the day cell's accessible name or surrounding month first.

## Flights and seat maps

Compare live date-specific results from more than one source when possible. A search result or a route landing page is a lead until the specific flight and fare are visible. Navigate to a provider through an observed link or a known official homepage, then use its own form.

A seat map usually appears after choosing a flight and fare. Inspect each step and take a screenshot when seats are graphical. A seat listed in a marketing page is not confirmed availability. If login or passenger data is required before the map appears, ask the user for the missing information. Never claim to have seen the map when the site stopped earlier.

If one provider fails, change source. Try an aggregator and a direct airline path before concluding that date-specific fares are unavailable. Public page extraction can verify a general fare claim; it cannot prove live seat availability.

## Tabs, blockers, and consequential actions

Use `tabs` and `switch` when a link opens another tab. Close a failed tab if it steals focus. A CAPTCHA or site access challenge is a blocker; use public extraction or another source, and describe the limit honestly. Never bypass a challenge.

Purchases, bookings, account creation, outbound messages, and deletions use the consequential action path and its Telegram approval. Read the exact price and terms before asking for approval. After approval, verify a confirmation or receipt before saying the action is complete.
