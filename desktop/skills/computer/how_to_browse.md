# How to browse a live page

## The five-step loop

1. **Search or open.** `search "query"` when you do not have a URL. `open "url"` when you do.
2. **Wait.** Never read immediately after a navigation on a modern site:
   `wait "main, #content, article"` or `wait "" "Book now"`. If you do not know a selector, run `inspect`.
3. **Read.** `text` for the current page, `read "url" "css"` for a specific region, `find "term"` for a word that
   matters (price, date, seat, status).
4. **Act.** `click`, `fill`, `select`, `press`. One action at a time, then `text` again to confirm the new state.
5. **Verify.** Re-read the confirmation line, the price, or the date. Only then answer.

## Example: is a show still available?

```sh
node /opt/talisman/computer.mjs search "Jailer 2 Chennai 9 November showtimes"
# open the result that is the cinema or ticketing site, not a blog
node /opt/talisman/computer.mjs open "https://example-cinema.in/jailer-2"
node /opt/talisman/computer.mjs wait "#showtimes"
node /opt/talisman/computer.mjs find "9 Nov"
node /opt/talisman/computer.mjs text
```

Answer with the time and the source, and say plainly when a seat map would not load.

## Example: a page looks empty

1. `text` shows navigation only → the app has not rendered.
2. `wait "main" 12000`
3. `scroll down 1000` — result lists often lazy-load.
4. `text` again.
5. Still empty → `inspect` to see whether a consent dialog or a "Continue" button is blocking the view, click it, then
   `wait "main"` again.

## Example: a bot wall

`blocked: true` means the site refused automation. Do not retry more than once. Move to the venue's own page, an
official listing, or the site's mobile endpoint, and tell the user which part you could verify.

## Reading tables and prices

- `find "₹"` returns the surrounding lines.
- If the text is truncated, `read "url" "table.prices"` scopes the scrape.
- Never infer a price from a range; quote the exact line you saw.
