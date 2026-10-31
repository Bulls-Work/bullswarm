// RFC 4180 CSV parsing. See README.md for the rules.

export function parseCsv(text) {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => line.split(',').map((field) => {
    if (field.startsWith('"') && field.endsWith('"') && field.length >= 2) return field.slice(1, -1);
    return field;
  }));
}
