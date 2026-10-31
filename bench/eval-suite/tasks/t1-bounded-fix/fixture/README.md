# acme-csv

`parseCsv(text)` in `src/csv.js` turns RFC 4180 CSV text into an array of rows, each an array of strings.

- Fields are separated by commas and records by line breaks (`\n` or `\r\n`).
- A field may be wrapped in double quotes. Inside a quoted field, commas and line breaks are part of the value, and a doubled quote (`""`) stands for one quote character.
- An empty input gives `[]`. A trailing line break at the end of the input does not add an empty row.
- An empty line in the middle of the input is a row with one empty field: `['']`.
- Unquoted fields are kept exactly as written (spaces included).
- A quote that opens a field and is never closed is an error: `parseCsv` throws an `Error` whose message starts with `unterminated quoted field`.

## The bug report

> Exporting customer notes broke our import: a note with a line break, or with a quote in it like `say "hi"`, splits the row or loses the quotes.
