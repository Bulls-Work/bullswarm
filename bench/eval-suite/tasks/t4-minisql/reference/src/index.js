// In-memory SQL engine: tokenizer, parser, evaluator.

function fail(msg) {
  throw new Error('SQL error: ' + msg);
}

const RESERVED = new Set(
  ('CREATE TABLE INSERT INTO VALUES SELECT DISTINCT FROM WHERE GROUP BY HAVING ORDER ASC DESC ' +
    'LIMIT OFFSET UPDATE SET DELETE AND OR NOT IS NULL IN BETWEEN LIKE AS PRIMARY KEY').split(' '),
);
const AGGS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

function tokenize(sql) {
  const toks = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    const s = i;
    if (/[A-Za-z_]/.test(c)) {
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i++;
      toks.push({ t: 'word', v: sql.slice(s, i), s, e: i });
    } else if (/[0-9]/.test(c)) {
      while (i < sql.length && /[0-9]/.test(sql[i])) i++;
      if (sql[i] === '.' && /[0-9]/.test(sql[i + 1] || '')) {
        i++;
        while (i < sql.length && /[0-9]/.test(sql[i])) i++;
      }
      if (i < sql.length && /[A-Za-z_.]/.test(sql[i])) fail('malformed number');
      toks.push({ t: 'num', v: Number(sql.slice(s, i)), s, e: i });
    } else if (c === "'") {
      i++;
      let str = '';
      for (;;) {
        if (i >= sql.length) fail('unterminated string');
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { str += "'"; i += 2; continue; }
          i++;
          break;
        }
        str += sql[i++];
      }
      toks.push({ t: 'str', v: str, s, e: i });
    } else {
      const two = sql.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '<>' || two === '!=') {
        i += 2;
        toks.push({ t: 'op', v: two, s, e: i });
      } else if ('=<>+-*/%(),;'.includes(c)) {
        i++;
        toks.push({ t: 'op', v: c, s, e: i });
      } else {
        fail('unexpected character ' + c);
      }
    }
  }
  toks.push({ t: 'eof', v: '', s: sql.length, e: sql.length });
  return toks;
}

class Parser {
  constructor(sql) {
    this.sql = sql;
    this.toks = tokenize(sql);
    this.p = 0;
  }
  peek(n = 0) { return this.toks[Math.min(this.p + n, this.toks.length - 1)]; }
  next() { return this.toks[this.p++]; }
  isKw(w, n = 0) {
    const t = this.peek(n);
    return t.t === 'word' && t.v.toUpperCase() === w;
  }
  isOp(o, n = 0) {
    const t = this.peek(n);
    return t.t === 'op' && t.v === o;
  }
  acceptKw(w) { if (this.isKw(w)) { this.p++; return true; } return false; }
  acceptOp(o) { if (this.isOp(o)) { this.p++; return true; } return false; }
  expectKw(w) { if (!this.acceptKw(w)) fail(`expected ${w}`); }
  expectOp(o) { if (!this.acceptOp(o)) fail(`expected ${o}`); }
  ident() {
    const t = this.next();
    if (t.t !== 'word' || RESERVED.has(t.v.toUpperCase())) fail('expected identifier');
    return t.v;
  }

  statement() {
    let st;
    if (this.isKw('CREATE')) st = this.create();
    else if (this.isKw('INSERT')) st = this.insert();
    else if (this.isKw('SELECT')) st = this.select();
    else if (this.isKw('UPDATE')) st = this.update();
    else if (this.isKw('DELETE')) st = this.del();
    else fail('unsupported or empty statement');
    this.acceptOp(';');
    if (this.peek().t !== 'eof') fail('unexpected text after statement: ' + this.peek().v);
    return st;
  }

  create() {
    this.expectKw('CREATE');
    this.expectKw('TABLE');
    const name = this.ident();
    this.expectOp('(');
    const cols = [];
    do {
      const cname = this.ident();
      const tt = this.next();
      const type = tt.t === 'word' ? tt.v.toUpperCase() : '';
      if (!['INTEGER', 'TEXT', 'REAL'].includes(type)) fail('unknown column type');
      let pk = false;
      if (this.acceptKw('PRIMARY')) { this.expectKw('KEY'); pk = true; }
      cols.push({ name: cname, type, pk });
    } while (this.acceptOp(','));
    this.expectOp(')');
    return { k: 'create', name, cols };
  }

  insert() {
    this.expectKw('INSERT');
    this.expectKw('INTO');
    const table = this.ident();
    let cols = null;
    if (this.acceptOp('(')) {
      cols = [];
      do cols.push(this.ident()); while (this.acceptOp(','));
      this.expectOp(')');
    }
    this.expectKw('VALUES');
    const rows = [];
    do {
      this.expectOp('(');
      const row = [];
      do row.push(this.expr()); while (this.acceptOp(','));
      this.expectOp(')');
      rows.push(row);
    } while (this.acceptOp(','));
    return { k: 'insert', table, cols, rows };
  }

  select() {
    this.expectKw('SELECT');
    const distinct = this.acceptKw('DISTINCT');
    const items = [];
    do {
      if (this.isOp('*')) {
        this.next();
        items.push({ star: true });
      } else {
        const start = this.peek().s;
        const e = this.expr();
        const text = this.sql.slice(start, this.toks[this.p - 1].e);
        let alias = null;
        if (this.acceptKw('AS')) alias = this.ident();
        items.push({ e, text, alias });
      }
    } while (this.acceptOp(','));
    let table = null;
    if (this.acceptKw('FROM')) table = this.ident();
    const st = { k: 'select', distinct, items, table, where: null, group: [], having: null, order: [], limit: null, offset: null };
    if (this.acceptKw('WHERE')) st.where = this.expr();
    if (this.acceptKw('GROUP')) {
      this.expectKw('BY');
      do st.group.push(this.ident()); while (this.acceptOp(','));
    }
    if (this.acceptKw('HAVING')) st.having = this.expr();
    if (this.acceptKw('ORDER')) {
      this.expectKw('BY');
      do {
        const e = this.expr();
        let desc = false;
        if (this.acceptKw('DESC')) desc = true;
        else this.acceptKw('ASC');
        st.order.push({ e, desc });
      } while (this.acceptOp(','));
    }
    if (this.acceptKw('LIMIT')) {
      st.limit = this.count();
      if (this.acceptKw('OFFSET')) st.offset = this.count();
    }
    return st;
  }

  count() {
    const t = this.next();
    if (t.t !== 'num' || !Number.isInteger(t.v)) fail('LIMIT/OFFSET needs a non-negative integer');
    return t.v;
  }

  update() {
    this.expectKw('UPDATE');
    const table = this.ident();
    this.expectKw('SET');
    const sets = [];
    do {
      const col = this.ident();
      this.expectOp('=');
      sets.push({ col, e: this.expr() });
    } while (this.acceptOp(','));
    const where = this.acceptKw('WHERE') ? this.expr() : null;
    return { k: 'update', table, sets, where };
  }

  del() {
    this.expectKw('DELETE');
    this.expectKw('FROM');
    const table = this.ident();
    const where = this.acceptKw('WHERE') ? this.expr() : null;
    return { k: 'delete', table, where };
  }

  expr() { return this.orExpr(); }
  orExpr() {
    let l = this.andExpr();
    while (this.acceptKw('OR')) l = { k: 'or', l, r: this.andExpr() };
    return l;
  }
  andExpr() {
    let l = this.notExpr();
    while (this.acceptKw('AND')) l = { k: 'and', l, r: this.notExpr() };
    return l;
  }
  notExpr() {
    if (this.acceptKw('NOT')) return { k: 'not', x: this.notExpr() };
    return this.cmpExpr();
  }
  cmpExpr() {
    let l = this.addExpr();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && ['=', '!=', '<>', '<', '<=', '>', '>='].includes(t.v)) {
        this.next();
        l = { k: 'cmp', op: t.v, l, r: this.addExpr() };
      } else if (this.isKw('IS')) {
        this.next();
        const neg = this.acceptKw('NOT');
        this.expectKw('NULL');
        l = { k: 'isnull', x: l, neg };
      } else {
        let neg = false;
        if (this.isKw('NOT') && (this.isKw('IN', 1) || this.isKw('BETWEEN', 1) || this.isKw('LIKE', 1))) {
          this.next();
          neg = true;
        }
        if (this.acceptKw('IN')) {
          this.expectOp('(');
          const list = [];
          do list.push(this.expr()); while (this.acceptOp(','));
          this.expectOp(')');
          l = { k: 'in', x: l, list, neg };
        } else if (this.acceptKw('BETWEEN')) {
          const lo = this.addExpr();
          this.expectKw('AND');
          const hi = this.addExpr();
          l = { k: 'between', x: l, lo, hi, neg };
        } else if (this.acceptKw('LIKE')) {
          l = { k: 'like', x: l, pat: this.addExpr(), neg };
        } else {
          if (neg) fail('syntax error near NOT');
          return l;
        }
      }
    }
  }
  addExpr() {
    let l = this.mulExpr();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().v;
      l = { k: 'arith', op, l, r: this.mulExpr() };
    }
    return l;
  }
  mulExpr() {
    let l = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().v;
      l = { k: 'arith', op, l, r: this.unary() };
    }
    return l;
  }
  unary() {
    if (this.acceptOp('-')) return { k: 'neg', x: this.unary() };
    if (this.acceptOp('+')) return this.unary();
    return this.primary();
  }
  primary() {
    const t = this.next();
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'op' && t.v === '(') {
      const e = this.expr();
      this.expectOp(')');
      return e;
    }
    if (t.t === 'word') {
      const up = t.v.toUpperCase();
      if (up === 'NULL') return { k: 'lit', v: null };
      if (this.isOp('(') && !RESERVED.has(up)) {
        if (!AGGS.has(up)) fail('unknown function ' + t.v);
        this.next();
        let arg = null;
        if (this.isOp('*')) {
          if (up !== 'COUNT') fail('* is only valid in COUNT(*)');
          this.next();
        } else {
          arg = this.expr();
        }
        this.expectOp(')');
        return { k: 'agg', fn: up, arg };
      }
      if (RESERVED.has(up)) fail('unexpected keyword ' + t.v);
      return { k: 'col', name: t.v };
    }
    fail('syntax error near ' + (t.t === 'eof' ? 'end of input' : t.v));
  }
}

function hasAgg(e) {
  if (!e) return false;
  switch (e.k) {
    case 'agg': return true;
    case 'lit': case 'col': return false;
    case 'or': case 'and': case 'cmp': case 'arith': return hasAgg(e.l) || hasAgg(e.r);
    case 'not': case 'neg': case 'isnull': return hasAgg(e.x);
    case 'in': return hasAgg(e.x) || e.list.some(hasAgg);
    case 'between': return hasAgg(e.x) || hasAgg(e.lo) || hasAgg(e.hi);
    case 'like': return hasAgg(e.x) || hasAgg(e.pat);
    default: return false;
  }
}

// Walk an expression; `onCol(name)` for column refs; `onAgg(node)` for aggregates (it decides whether to descend).
function walk(e, onCol, onAgg) {
  switch (e.k) {
    case 'lit': return;
    case 'col': onCol(e.name); return;
    case 'agg': onAgg(e); return;
    case 'or': case 'and': case 'cmp': case 'arith': walk(e.l, onCol, onAgg); walk(e.r, onCol, onAgg); return;
    case 'not': case 'neg': case 'isnull': walk(e.x, onCol, onAgg); return;
    case 'in': walk(e.x, onCol, onAgg); e.list.forEach((x) => walk(x, onCol, onAgg)); return;
    case 'between': walk(e.x, onCol, onAgg); walk(e.lo, onCol, onAgg); walk(e.hi, onCol, onAgg); return;
    case 'like': walk(e.x, onCol, onAgg); walk(e.pat, onCol, onAgg); return;
  }
}

function tri(v) {
  if (v === null) return null;
  if (typeof v !== 'number') fail('a string cannot be used as a condition');
  return v !== 0 ? 1 : 0;
}

function compare(a, b) {
  if (typeof a !== typeof b) fail('cannot compare a number with a string');
  return a < b ? -1 : a > b ? 1 : 0;
}

function likeToRegex(p) {
  let re = '^';
  for (const ch of p) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
  }
  return new RegExp(re + '$');
}

const likeCache = new Map();

// ctx: { cols: Map name->index, row: array|null, group: array of rows|null }
function evalE(e, ctx) {
  switch (e.k) {
    case 'lit': return e.v;
    case 'col': {
      const i = ctx.cols.get(e.name);
      if (i === undefined) fail('no such column: ' + e.name);
      return ctx.row[i];
    }
    case 'neg': {
      const v = evalE(e.x, ctx);
      if (v === null) return null;
      if (typeof v !== 'number') fail('arithmetic on a string');
      return 0 - v;
    }
    case 'arith': {
      const a = evalE(e.l, ctx);
      const b = evalE(e.r, ctx);
      if (a === null || b === null) return null;
      if (typeof a !== 'number' || typeof b !== 'number') fail('arithmetic on a string');
      switch (e.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/':
          if (b === 0) return null;
          return Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) + 0 : a / b;
        default:
          if (b === 0) return null;
          return (a % b) + 0;
      }
    }
    case 'cmp': {
      const a = evalE(e.l, ctx);
      const b = evalE(e.r, ctx);
      if (a === null || b === null) return null;
      const c = compare(a, b);
      switch (e.op) {
        case '=': return c === 0 ? 1 : 0;
        case '!=': case '<>': return c !== 0 ? 1 : 0;
        case '<': return c < 0 ? 1 : 0;
        case '<=': return c <= 0 ? 1 : 0;
        case '>': return c > 0 ? 1 : 0;
        default: return c >= 0 ? 1 : 0;
      }
    }
    case 'and': {
      const a = tri(evalE(e.l, ctx));
      if (a === 0) { tri(evalE(e.r, ctx)); return 0; }
      const b = tri(evalE(e.r, ctx));
      if (b === 0) return 0;
      return a === null || b === null ? null : 1;
    }
    case 'or': {
      const a = tri(evalE(e.l, ctx));
      if (a === 1) { tri(evalE(e.r, ctx)); return 1; }
      const b = tri(evalE(e.r, ctx));
      if (b === 1) return 1;
      return a === null || b === null ? null : 0;
    }
    case 'not': {
      const a = tri(evalE(e.x, ctx));
      return a === null ? null : 1 - a;
    }
    case 'isnull': {
      const v = evalE(e.x, ctx);
      return (v === null) !== e.neg ? 1 : 0;
    }
    case 'in': {
      const v = evalE(e.x, ctx);
      let sawNull = v === null;
      let found = false;
      for (const item of e.list) {
        const w = evalE(item, ctx);
        if (v === null || w === null) { sawNull = true; continue; }
        if (compare(v, w) === 0) found = true;
      }
      const r = found ? 1 : sawNull ? null : 0;
      return r === null ? null : e.neg ? 1 - r : r;
    }
    case 'between': {
      const v = evalE(e.x, ctx);
      const lo = evalE(e.lo, ctx);
      const hi = evalE(e.hi, ctx);
      const a = v === null || lo === null ? null : compare(v, lo) >= 0 ? 1 : 0;
      const b = v === null || hi === null ? null : compare(v, hi) <= 0 ? 1 : 0;
      let r;
      if (a === 0 || b === 0) r = 0;
      else if (a === null || b === null) r = null;
      else r = 1;
      return r === null ? null : e.neg ? 1 - r : r;
    }
    case 'like': {
      const v = evalE(e.x, ctx);
      const p = evalE(e.pat, ctx);
      if (v === null || p === null) return null;
      if (typeof v !== 'string' || typeof p !== 'string') fail('LIKE needs strings');
      let re = likeCache.get(p);
      if (!re) { re = likeToRegex(p); likeCache.set(p, re); }
      const r = re.test(v) ? 1 : 0;
      return e.neg ? 1 - r : r;
    }
    case 'agg': {
      if (!ctx.group) fail('aggregate not allowed here');
      return aggregate(e, ctx);
    }
  }
  fail('bad expression');
}

function aggregate(e, ctx) {
  if (e.fn === 'COUNT' && e.arg === null) return ctx.group.length;
  const vals = [];
  for (const row of ctx.group) {
    const v = evalE(e.arg, { cols: ctx.cols, row, group: null });
    if (v !== null) vals.push(v);
  }
  if (e.fn === 'COUNT') return vals.length;
  if (vals.length === 0) return null;
  if (e.fn === 'SUM' || e.fn === 'AVG') {
    let s = 0;
    for (const v of vals) {
      if (typeof v !== 'number') fail(e.fn + ' needs numbers');
      s += v;
    }
    return e.fn === 'SUM' ? s : s / vals.length;
  }
  let best = vals[0];
  for (const v of vals) {
    const c = compare(v, best);
    if (e.fn === 'MIN' ? c < 0 : c > 0) best = v;
  }
  return best;
}

function keyOf(vals) { return JSON.stringify(vals); }

function sortCompare(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a !== typeof b) return typeof a === 'number' ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

class Database {
  constructor() { this.tables = new Map(); }

  getTable(name) {
    const t = this.tables.get(name);
    if (!t) fail('no such table: ' + name);
    return t;
  }

  exec(sql) {
    try {
      if (typeof sql !== 'string') fail('statement must be a string');
      const st = new Parser(sql).statement();
      switch (st.k) {
        case 'create': return this.doCreate(st);
        case 'insert': return this.doInsert(st);
        case 'select': return this.doSelect(st);
        case 'update': return this.doUpdate(st);
        default: return this.doDelete(st);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('SQL error:')) throw err;
      throw new Error('SQL error: ' + (err && err.message ? err.message : String(err)));
    }
  }

  checkCols(e, table) {
    walk(e, (n) => { if (!table.colIndex.has(n)) fail('no such column: ' + n); }, (a) => {
      if (a.arg) {
        if (hasAgg(a.arg)) fail('nested aggregate');
        this.checkCols(a.arg, table);
      }
    });
  }

  doCreate(st) {
    if (this.tables.has(st.name)) fail('table already exists: ' + st.name);
    const colIndex = new Map();
    let pk = -1;
    st.cols.forEach((c, i) => {
      if (colIndex.has(c.name)) fail('duplicate column: ' + c.name);
      colIndex.set(c.name, i);
      if (c.pk) {
        if (pk >= 0) fail('more than one primary key');
        pk = i;
      }
    });
    this.tables.set(st.name, { name: st.name, cols: st.cols, colIndex, pk, rows: [], pkMap: new Map() });
    return { changes: 0 };
  }

  coerce(table, i, v) {
    const c = table.cols[i];
    if (v === null) {
      if (i === table.pk) fail('primary key cannot be NULL: ' + c.name);
      return v;
    }
    const ok = c.type === 'TEXT' ? typeof v === 'string'
      : typeof v === 'number' && (c.type === 'REAL' || Number.isInteger(v));
    if (!ok) fail(`type mismatch for column ${c.name} (${c.type})`);
    return v;
  }

  doInsert(st) {
    const table = this.getTable(st.table);
    let idx;
    if (st.cols) {
      idx = st.cols.map((n) => {
        const i = table.colIndex.get(n);
        if (i === undefined) fail('no such column: ' + n);
        return i;
      });
      if (new Set(idx).size !== idx.length) fail('column listed twice');
    } else {
      idx = table.cols.map((_, i) => i);
    }
    const noCols = { cols: new Map(), row: [], group: null };
    const newRows = [];
    const seen = new Set();
    for (const exprs of st.rows) {
      if (exprs.length !== idx.length) fail('wrong number of values');
      const row = new Array(table.cols.length).fill(null);
      exprs.forEach((e, j) => {
        if (hasAgg(e)) fail('aggregate not allowed here');
        walk(e, (n) => fail('no such column: ' + n), () => {});
        row[idx[j]] = this.coerce(table, idx[j], evalE(e, noCols));
      });
      if (table.pk >= 0) {
        this.coerce(table, table.pk, row[table.pk]);
        const k = row[table.pk];
        if (table.pkMap.has(k) || seen.has(k)) fail('duplicate primary key: ' + k);
        seen.add(k);
      }
      newRows.push(row);
    }
    for (const row of newRows) {
      table.rows.push(row);
      if (table.pk >= 0) table.pkMap.set(row[table.pk], row);
    }
    return { changes: newRows.length };
  }

  doSelect(st) {
    const table = st.table ? this.getTable(st.table) : null;
    const cols = table ? table.colIndex : new Map();
    const rows = table ? table.rows : [[]];
    const aggMode = st.group.length > 0 || st.items.some((it) => !it.star && hasAgg(it.e)) ||
      hasAgg(st.having) || st.order.some((o) => hasAgg(o.e));
    for (const g of st.group) if (!cols.has(g)) fail('no such column: ' + g);
    if (st.where && hasAgg(st.where)) fail('aggregate not allowed in WHERE');
    if (st.having && !aggMode) fail('HAVING needs aggregates or GROUP BY');

    // Output columns.
    const outCols = [];
    const outItems = [];
    for (const it of st.items) {
      if (it.star) {
        if (!table) fail('* needs a FROM clause');
        if (aggMode) fail('* cannot be used with aggregates or GROUP BY');
        table.cols.forEach((c) => { outCols.push(c.name); outItems.push({ e: { k: 'col', name: c.name } }); });
      } else {
        outCols.push(it.alias !== null ? it.alias : it.e.k === 'col' ? it.e.name : it.text);
        outItems.push(it);
      }
    }
    const aliasIdx = new Map();
    outItems.forEach((it, i) => { if (it.alias) aliasIdx.set(it.alias, i); });

    const orderTerms = st.order.map((o) => {
      if (o.e.k === 'col' && aliasIdx.has(o.e.name)) return { alias: aliasIdx.get(o.e.name), desc: o.desc };
      return { e: o.e, desc: o.desc };
    });
    const allExprs = [...outItems.map((i) => i.e), ...orderTerms.filter((t) => t.e).map((t) => t.e)];
    if (st.where) allExprs.push(st.where);
    if (st.having) allExprs.push(st.having);
    const tableForCheck = { colIndex: cols };
    for (const e of allExprs) {
      this.checkCols(e, tableForCheck);
      walk(e, () => {}, (a) => { if (a.arg && hasAgg(a.arg)) fail('nested aggregate'); });
    }

    let srcRows = rows;
    if (st.where) {
      srcRows = rows.filter((row) => tri(evalE(st.where, { cols, row, group: null })) === 1);
    }

    let produced; // [{ out, keys }]
    if (aggMode) {
      const groupSet = new Set(st.group);
      const grouped = (e) => walk(e, (n) => {
        if (!groupSet.has(n)) fail('column must appear in GROUP BY or inside an aggregate: ' + n);
      }, () => {});
      allExprs.forEach((e) => { if (e !== st.where) grouped(e); });
      let groups;
      if (st.group.length) {
        const gi = st.group.map((g) => cols.get(g));
        const map = new Map();
        for (const row of srcRows) {
          const k = keyOf(gi.map((i) => row[i]));
          let g = map.get(k);
          if (!g) { g = []; map.set(k, g); }
          g.push(row);
        }
        groups = [...map.values()];
      } else {
        groups = [srcRows];
      }
      produced = [];
      for (const g of groups) {
        const ctx = { cols, row: g[0] || null, group: g };
        if (st.having && tri(evalE(st.having, ctx)) !== 1) continue;
        const out = outItems.map((it) => evalE(it.e, ctx));
        const keys = orderTerms.map((t) => (t.e ? evalE(t.e, ctx) : out[t.alias]));
        produced.push({ out, keys });
      }
    } else {
      produced = srcRows.map((row) => {
        const ctx = { cols, row, group: null };
        const out = outItems.map((it) => evalE(it.e, ctx));
        const keys = orderTerms.map((t) => (t.e ? evalE(t.e, ctx) : out[t.alias]));
        return { out, keys };
      });
    }

    if (st.distinct) {
      const seen = new Set();
      produced = produced.filter((p) => {
        const k = keyOf(p.out);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    if (orderTerms.length) {
      produced = produced
        .map((p, i) => ({ p, i }))
        .sort((x, y) => {
          for (let j = 0; j < orderTerms.length; j++) {
            let c = sortCompare(x.p.keys[j], y.p.keys[j]);
            if (orderTerms[j].desc) c = -c;
            if (c !== 0) return c;
          }
          return x.i - y.i;
        })
        .map((x) => x.p);
    }
    const start = st.offset || 0;
    if (st.limit !== null) produced = produced.slice(start, start + st.limit);
    else produced = produced.slice(start);
    return { columns: outCols, rows: produced.map((p) => p.out) };
  }

  doUpdate(st) {
    const table = this.getTable(st.table);
    const idx = st.sets.map((s) => {
      const i = table.colIndex.get(s.col);
      if (i === undefined) fail('no such column: ' + s.col);
      return i;
    });
    for (const e of [...st.sets.map((s) => s.e), ...(st.where ? [st.where] : [])]) {
      if (hasAgg(e)) fail('aggregate not allowed here');
      this.checkCols(e, table);
    }
    const updates = []; // [rowIndex, newRow]
    table.rows.forEach((row, ri) => {
      const ctx = { cols: table.colIndex, row, group: null };
      if (st.where && tri(evalE(st.where, ctx)) !== 1) return;
      const nr = row.slice();
      st.sets.forEach((s, j) => { nr[idx[j]] = this.coerce(table, idx[j], evalE(s.e, ctx)); });
      updates.push([ri, nr]);
    });
    if (table.pk >= 0 && idx.includes(table.pk)) {
      const next = new Map(table.pkMap);
      for (const [ri] of updates) next.delete(table.rows[ri][table.pk]);
      for (const [, nr] of updates) {
        const k = nr[table.pk];
        if (next.has(k)) fail('duplicate primary key: ' + k);
        next.set(k, nr);
      }
      for (const [ri, nr] of updates) table.rows[ri] = nr;
      table.pkMap = next;
    } else {
      for (const [ri, nr] of updates) {
        table.rows[ri] = nr;
        if (table.pk >= 0) table.pkMap.set(nr[table.pk], nr);
      }
    }
    return { changes: updates.length };
  }

  doDelete(st) {
    const table = this.getTable(st.table);
    if (st.where) {
      if (hasAgg(st.where)) fail('aggregate not allowed here');
      this.checkCols(st.where, table);
    }
    const keep = [];
    let n = 0;
    for (const row of table.rows) {
      if (!st.where || tri(evalE(st.where, { cols: table.colIndex, row, group: null })) === 1) n++;
      else keep.push(row);
    }
    table.rows = keep;
    if (table.pk >= 0) table.pkMap = new Map(keep.map((r) => [r[table.pk], r]));
    return { changes: n };
  }
}

export function createDatabase() {
  const db = new Database();
  return { exec: (sql) => db.exec(sql) };
}
