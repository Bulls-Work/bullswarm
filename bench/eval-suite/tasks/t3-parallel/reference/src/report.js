// Part B: balances, register and date filtering. See README.md.

export function formatCents(cents) {
  const abs = Math.abs(cents);
  const sign = cents < 0 ? '-' : '';
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function filterByDate(transactions, { from, to } = {}) {
  return transactions.filter(
    (t) => (from === undefined || t.date >= from) && (to === undefined || t.date <= to),
  );
}

export function balances(transactions, opts = {}) {
  const totals = new Map();
  for (const t of filterByDate(transactions, opts)) {
    for (const p of t.postings) {
      const parts = p.account.split(':');
      for (let n = 1; n <= parts.length; n++) {
        const name = parts.slice(0, n).join(':');
        totals.set(name, (totals.get(name) || 0) + p.cents);
      }
    }
  }
  return [...totals.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((account) => ({ account, cents: totals.get(account) }));
}

export function register(transactions, account, opts = {}) {
  const sorted = filterByDate(transactions, opts)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : a.i - b.i))
    .map((x) => x.t);
  const rows = [];
  let total = 0;
  for (const t of sorted) {
    for (const p of t.postings) {
      if (p.account === account || p.account.startsWith(account + ':')) {
        total += p.cents;
        rows.push({ date: t.date, description: t.description, cents: p.cents, total });
      }
    }
  }
  return rows;
}
