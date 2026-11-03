# How to book, end to end

## Worked example: two cinema seats in Chennai

Them: *"Jailer 2, Chennai, Nov 9, two tickets."*

1. **Search availability, not the user's memory.**
   ```sh
   node /opt/talisman/computer.mjs search "Jailer 2 Chennai November 9 tickets"
   ```
2. **Open the official listing**, wait for showtimes, then read the date row.
   ```sh
   node /opt/talisman/computer.mjs open "https://example-cinema.in/jailer-2"
   node /opt/talisman/computer.mjs wait "#showtimes"
   node /opt/talisman/computer.mjs find "9 Nov"
   ```
3. **Choose a screening and read the seat map.** Use a screenshot when the map is graphical.
   ```sh
   node /opt/talisman/computer.mjs click 'a[data-showtime="21:40"]'
   node /opt/talisman/computer.mjs wait ".seat-map"
   node /opt/talisman/computer.mjs screenshot
   ```
4. **Select exactly two adjacent seats.** Fill the count, then click seats that the legend marks available.
5. **Read the total before asking.** `text` on the summary panel. Never estimate.
6. **Ask for approval in one line:**
   `2 seats, Sat 9 Nov 9:40pm at Palazzo, ₹840 total. Confirm and I'll book it?`
7. **Only after a clear yes**, continue to payment. `click 'button:has-text("Proceed")'`.
8. **Stop at the payment form** if it needs a card you do not hold. Give them the checkout link and the remaining time
   on the hold.
9. **Verify and close the loop:** `Confirmed — booking ref ABC123, sent to your email. Want me to add it to your
   calendar?`

## Rules learned the hard way

- The first "Book" click often only opens a login wall. Detect it (`find "sign in"`) and ask for the credential route
  instead of silently failing.
- A price that changes between the list and the summary is a red flag — quote the summary, not the list.
- Never book a different date or time "close enough" to what was asked.
- If the payment page blocks automation, that is a normal ending, not a failure. Report the exact total and link.
