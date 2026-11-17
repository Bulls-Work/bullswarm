// RFC 4180 CSV parsing. See README.md for the rules.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let started = false;
  const endField = () => { row.push(field); field = ''; started = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && !started && field === '') { quoted = true; started = true; i += 1; continue; }
    if (ch === ',') { endField(); i += 1; continue; }
    if (ch === '\r' && text[i + 1] === '\n') { endRow(); i += 2; continue; }
    if (ch === '\n') { endRow(); i += 1; continue; }
    field += ch; started = true; i += 1;
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (field !== '' || started || row.length) endRow();
  return rows;
}
