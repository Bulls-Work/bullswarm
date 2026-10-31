#!/usr/bin/env node
// Command line entry point. See README.md.
import { readFileSync } from 'node:fs';
import { parse, isValidDate, ParseError } from '../src/parse.js';
import { balances, register, formatCents } from '../src/report.js';

const USAGE =
  'usage: ledger balance <file> [--from D] [--to D]\n       ledger register <file> <account>\n';

function usage(msg) {
  process.stderr.write(msg ? `ledger: ${msg}\n${USAGE}` : USAGE);
  process.exit(2);
}

const args = process.argv.slice(2);
const cmd = args.shift();
const positional = [];
const opts = {};
if (cmd !== 'balance' && cmd !== 'register') usage();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (cmd === 'balance' && (a === '--from' || a === '--to')) {
    const v = args[++i];
    if (v === undefined) usage(`missing value for ${a}`);
    if (!isValidDate(v)) usage(`invalid date "${v}"`);
    opts[a.slice(2)] = v;
  } else if (a.startsWith('--')) {
    usage(`unknown option ${a}`);
  } else {
    positional.push(a);
  }
}
if (positional.length !== (cmd === 'balance' ? 1 : 2)) usage();

let txs;
try {
  txs = parse(readFileSync(positional[0], 'utf8'));
} catch (e) {
  if (e instanceof ParseError) {
    process.stderr.write(`ledger: ${e.message}\n`);
  } else {
    process.stderr.write(`ledger: cannot read ${positional[0]}\n`);
  }
  process.exit(1);
}

let out = '';
if (cmd === 'balance') {
  const rows = balances(txs, opts).map((r) => [formatCents(r.cents), r.account]);
  const w = Math.max(0, ...rows.map((r) => r[0].length));
  for (const [amt, acct] of rows) out += `${amt.padStart(w)}  ${acct}\n`;
} else {
  for (const r of register(txs, positional[1])) {
    out +=
      `${r.date}  ${r.description.slice(0, 30).padEnd(30)}  ` +
      `${formatCents(r.cents).padStart(10)}  ${formatCents(r.total).padStart(10)}\n`;
  }
}
process.stdout.write(out);
