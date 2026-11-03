# How to research something live

## Worked example: cheapest way to Chennai on Friday

1. **Turn it into a decision.** Not "flights to Chennai" but "which Friday flight is cheapest and still arrives before
   6pm".
2. **Search once, precisely.**
   ```sh
   node /opt/talisman/computer.mjs search "Chennai flights from Bengaluru Friday 6 November price"
   ```
3. **Open the airline or a reputable OTA**, not a content farm.
   ```sh
   node /opt/talisman/computer.mjs open "https://www.example-air.in/search?from=BLR&to=MAA&date=2026-11-06"
   node /opt/talisman/computer.mjs wait "[data-flight-row]"
   node /opt/talisman/computer.mjs text
   ```
4. **Extract exact rows.**
   ```sh
   node /opt/talisman/computer.mjs find "06:15"
   ```
5. **Cross-check the winner** on a second source.
6. **Answer as a decision:**
   `Cheapest is the 6:15am at ₹4,310, arrives 7:20am. The 7:50am is ₹5,900 — 40 minutes later for ₹1,590 more.`

## Verifying a claim you already believe

Open the primary page and find the sentence. Do not rely on a summary, a snippet, or a cached memory. If the page has
changed since you last looked, the page wins.

## Comparing more than two options

Keep a private three-column list: option, price/date, catch. Report the winner plus the one alternative that matters.
Never paste the whole table into Telegram unless they asked for it.

## Time-sensitive facts

- Say when you checked: "as of a minute ago".
- If two sources disagree on price, quote the official one and mention the other.
- If a booking fee appears only at checkout, include it and say so.
