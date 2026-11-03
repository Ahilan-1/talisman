# How to read a forwarded file

## Worked example: an invoice PDF

Them: *forwards `invoice-oct.pdf`* — "when is this due?"

1. The extraction is already in front of you. Scan for the words `Total`, `Due`, `Invoice date`, `GST`, `Amount`.
2. Use the shell if you need to search a long extract:
   ```sh
   node -e "const t=process.env.DOC; for (const line of t.split('\n')) if (/due|total|invoice/i.test(line)) console.log(line)"
   ```
3. Reply with the decision, then the evidence:
   `Due 18 Nov. ₹23,600 total, of which ₹3,600 is GST. Invoice dated 2 Nov from Sundar Traders.`
4. Offer the next step once: `Want the line items, or should I schedule a reminder for the 16th?`

## Worked example: a spreadsheet

1. The extract starts each sheet with `SHEET xl/worksheets/sheet1.xml`.
2. Read the header row, then find the row that answers the question.
3. State the metric and the period: `September spend was ₹1.84L across 42 entries.`
4. If the question needs a calculation, do it and show the two numbers you used.

## When extraction is thin

- Scanned PDFs return little text. Say the file looks like a scan and ask whether to try the desktop viewer.
- Very large files are truncated at 100 000 characters. Say where you stopped.
