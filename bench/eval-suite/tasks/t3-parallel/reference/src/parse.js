// Part A: ledger text parser. See README.md for the format and the API.

export class ParseError extends Error {
  constructor(line, reason) {
    super(`line ${line}: ${reason}`);
    this.name = 'ParseError';
    this.line = line;
    this.reason = reason;
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ACCOUNT_RE = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*$/;
const AMOUNT_RE = /^(-?)(\d+)\.(\d{2})$/;

export function isValidDate(str) {
  if (typeof str !== 'string') return false;
  const m = DATE_RE.exec(str);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function amountToCents(token) {
  const m = AMOUNT_RE.exec(token);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number(m[3]);
  return m[1] ? -cents : cents;
}

export function parse(text) {
  const out = [];
  let cur = null; // { header line, date, description, postings, blankAt }

  function finish() {
    if (!cur) return;
    const { postings } = cur;
    if (postings.length < 2) {
      throw new ParseError(cur.line, 'transaction needs at least two postings');
    }
    let sum = 0;
    let open = null;
    for (const p of postings) {
      if (p.cents === null) open = p;
      else sum += p.cents;
    }
    if (open) open.cents = sum === 0 ? 0 : -sum;
    else if (sum !== 0) throw new ParseError(cur.line, 'unbalanced transaction');
    out.push({
      date: cur.date,
      description: cur.description,
      postings: postings.map((p) => ({ account: p.account, cents: p.cents })),
    });
    cur = null;
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    if (raw.trim() === '') {
      finish();
      continue;
    }
    const semi = raw.indexOf(';');
    const body = (semi === -1 ? raw : raw.slice(0, semi)).trimEnd();
    if (body.trim() === '') continue; // comment-only line

    if (/^\s/.test(body)) {
      if (!cur) throw new ParseError(lineNo, 'posting outside transaction');
      const tokens = body.trim().split(/\s+/);
      if (tokens.length > 2) throw new ParseError(lineNo, 'malformed posting');
      if (!ACCOUNT_RE.test(tokens[0])) throw new ParseError(lineNo, 'invalid account');
      let cents = null;
      if (tokens.length === 2) {
        cents = amountToCents(tokens[1]);
        if (cents === null) throw new ParseError(lineNo, 'invalid amount');
      } else if (cur.postings.some((p) => p.cents === null)) {
        throw new ParseError(lineNo, 'more than one posting without an amount');
      }
      cur.postings.push({ account: tokens[0], cents });
    } else {
      finish();
      const m = /^(\S+)(?:\s+(.*))?$/.exec(body);
      if (!isValidDate(m[1])) throw new ParseError(lineNo, 'invalid date');
      cur = { line: lineNo, date: m[1], description: (m[2] || '').trim(), postings: [] };
    }
  }
  finish();
  return out;
}
