#!/usr/bin/env node
// Build a presentation-safe Bullswarm home from a read-only snapshot.
//
//   node scripts/build-demo-home.mjs <snapshot> <dest> [--seed N] [--deny-list FILE ...]

// The first pass deliberately uses the fixture scrubber: it has the exhaustive
// knowledge of which recorded fields contain authored prose and paths.  A
// second pass gives that anonymous data a small, coherent fictional story.

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateWords, Scrubber } from './build-test-home.mjs';

const PROJECTS = ['storefront', 'billing-api', 'mobile-app', 'design-system', 'data-pipeline', 'docs-site'];
const ACTION_NAMES = [
  'schema', 'api', 'ui', 'tests', 'docs', 'migrate', 'webhooks', 'retry-policy',
  'notices', 'contract-tests', 'checkout-flow', 'address-validation', 'search-index',
  'facets', 'stock-badges', 'cart-sync', 'refund-ledger', 'invoice-export',
  'usage-rollup', 'focus-tokens', 'modal-a11y', 'theme-contrast',
  'import-checkpoints', 'drift-alerts', 'backfill-runner', 'release-notes',
  'tutorials', 'reference-tables', 'integration', 'rollout',
];
const PROJECT_PATHS = {
  storefront: '/home/dev/projects/storefront',
  'billing-api': '/home/dev/projects/billing-api',
  'mobile-app': '/home/dev/projects/mobile-app',
  'design-system': '/home/dev/projects/design-system',
  'data-pipeline': '/home/dev/projects/data-pipeline',
  'docs-site': '/home/dev/projects/docs-site',
};
const PROJECT_FEATURES = {
  storefront: [
    ['Checkout', 'one-page checkout with saved addresses', ['src/checkout/address-book.ts', 'src/checkout/CheckoutPage.tsx', 'tests/checkout/address-book.test.ts']],
    ['Search', 'typo-tolerant product search with facets', ['src/search/facets.ts', 'src/search/query.ts', 'tests/search/facets.test.ts']],
    ['Returns', 'self-service returns with printable labels', ['src/returns/return-label.ts', 'src/returns/ReturnsPortal.tsx', 'tests/returns/portal.test.ts']],
    ['Inventory', 'live stock badges on product cards', ['src/catalog/inventory.ts', 'src/catalog/StockBadge.tsx', 'tests/catalog/stock-badge.test.tsx']],
    ['Cart', 'recovery across signed-in devices', ['src/cart/sync.ts', 'src/cart/CartRecovery.tsx', 'tests/cart/sync.test.ts']],
    ['Promotions', 'stacking rules with clear customer feedback', ['src/promotions/rules.ts', 'src/promotions/PromoBanner.tsx', 'tests/promotions/rules.test.ts']],
  ],
  'billing-api': [
    ['Billing', 'webhooks v2 with idempotent retries', ['src/billing/webhooks.ts', 'src/billing/idempotency.ts', 'tests/billing/webhooks.test.ts']],
    ['Invoices', 'tax-safe invoice exports', ['src/invoices/export.ts', 'src/invoices/rounding.ts', 'tests/invoices/export.test.ts']],
    ['Refunds', 'ledger reconciliation for partial refunds', ['src/refunds/reconcile.ts', 'src/refunds/ledger.ts', 'tests/refunds/reconcile.test.ts']],
    ['Dunning', 'grace-period retries with customer notices', ['src/dunning/retry-policy.ts', 'src/dunning/notices.ts', 'tests/dunning/retry-policy.test.ts']],
    ['Usage', 'auditable metered-billing rollups', ['src/usage/rollup.ts', 'src/usage/ledger.ts', 'tests/usage/rollup.test.ts']],
    ['Payouts', 'settlement reports with currency rounding', ['src/payouts/settlement.ts', 'src/payouts/currency.ts', 'tests/payouts/settlement.test.ts']],
  ],
  'mobile-app': [
    ['Orders', 'accessible live delivery status', ['app/orders/OrderStatus.tsx', 'app/orders/useOrderUpdates.ts', 'tests/orders/order-status.test.tsx']],
    ['Cart', 'offline edits that reconcile after reconnect', ['app/cart/offline-sync.ts', 'app/cart/CartScreen.tsx', 'tests/cart/offline-sync.test.ts']],
    ['Notifications', 'per-order push preferences', ['app/settings/push-preferences.ts', 'app/settings/PushPreferences.tsx', 'tests/settings/push-preferences.test.tsx']],
    ['Account', 'passkey sign-in with device recovery', ['app/auth/passkeys.ts', 'app/auth/SignInScreen.tsx', 'tests/auth/passkeys.test.ts']],
    ['Checkout', 'wallet payments with address validation', ['app/checkout/wallet.ts', 'app/checkout/CheckoutScreen.tsx', 'tests/checkout/wallet.test.tsx']],
    ['Receipts', 'downloadable receipts with share actions', ['app/orders/receipts.ts', 'app/orders/ReceiptSheet.tsx', 'tests/orders/receipts.test.tsx']],
  ],
  'design-system': [
    ['Forms', 'accessible controls and validation states', ['packages/ui/src/FormField.tsx', 'packages/ui/src/form-tokens.ts', 'packages/ui/tests/form-field.test.tsx']],
    ['Focus', 'consistent keyboard focus tokens', ['packages/tokens/src/focus.ts', 'packages/ui/src/FocusRing.tsx', 'packages/ui/tests/focus-ring.test.tsx']],
    ['Modals', 'screen-reader-safe dialog semantics', ['packages/ui/src/Modal.tsx', 'packages/ui/src/focus-trap.ts', 'packages/ui/tests/modal.test.tsx']],
    ['Themes', 'high-contrast color pairs', ['packages/tokens/src/colors.ts', 'packages/ui/src/ThemeProvider.tsx', 'packages/ui/tests/theme.test.tsx']],
    ['Tables', 'responsive density and row actions', ['packages/ui/src/DataTable.tsx', 'packages/ui/src/table-tokens.ts', 'packages/ui/tests/data-table.test.tsx']],
    ['Navigation', 'keyboard-first command menus', ['packages/ui/src/CommandMenu.tsx', 'packages/ui/src/roving-focus.ts', 'packages/ui/tests/command-menu.test.tsx']],
  ],
  'data-pipeline': [
    ['Imports', 'validated daily loads with partial-batch retries', ['pipeline/imports/daily.py', 'pipeline/imports/checkpoint.py', 'tests/pipeline/test_daily_import.py']],
    ['Schemas', 'drift alerts before warehouse writes', ['pipeline/schema/drift.py', 'pipeline/schema/contracts.py', 'tests/pipeline/test_schema_drift.py']],
    ['Backfills', 'resumable warehouse backfills', ['pipeline/backfills/runner.py', 'pipeline/backfills/checkpoint.py', 'tests/pipeline/test_backfill.py']],
    ['Quality', 'quarantine rules for malformed events', ['pipeline/quality/quarantine.py', 'pipeline/quality/rules.py', 'tests/pipeline/test_quarantine.py']],
    ['Exports', 'incremental partner feeds with checkpoints', ['pipeline/exports/partner_feed.py', 'pipeline/exports/checkpoint.py', 'tests/pipeline/test_partner_feed.py']],
    ['Lineage', 'column-level lineage for transformed datasets', ['pipeline/lineage/graph.py', 'pipeline/lineage/catalog.py', 'tests/pipeline/test_lineage.py']],
  ],
  'docs-site': [
    ['Search', 'task-oriented navigation with keyboard search', ['docs/search/index.ts', 'docs/search/SearchDialog.tsx', 'tests/docs/search-dialog.test.tsx']],
    ['API', 'copy-ready examples for common integrations', ['docs/api/examples.ts', 'docs/api/ExampleTabs.tsx', 'tests/docs/api-examples.test.ts']],
    ['Upgrades', 'versioned migration checklists', ['docs/guide/upgrading.md', 'docs/components/UpgradeChecklist.tsx', 'tests/docs/upgrade-checklist.test.tsx']],
    ['Releases', 'filterable notes with stable anchors', ['docs/releases/index.ts', 'docs/releases/ReleaseFilters.tsx', 'tests/docs/release-filters.test.tsx']],
    ['Tutorials', 'progressive quickstarts with verified commands', ['docs/tutorials/quickstart.md', 'docs/components/CommandBlock.tsx', 'tests/docs/command-block.test.tsx']],
    ['Reference', 'generated option tables with source links', ['docs/reference/generate.ts', 'docs/reference/OptionTable.tsx', 'tests/docs/reference.test.ts']],
  ],
};
const EXTRA_GOALS = {
  storefront: [
    ['Catalog', 'variant filters with shareable URLs'], ['Wishlist', 'guest lists that merge after sign-in'],
    ['Delivery', 'postcode estimates on product pages'], ['Reviews', 'verified-buyer badges and photo uploads'],
    ['Accounts', 'email changes with session confirmation'], ['Pricing', 'localized totals with transparent rounding'],
    ['Gifts', 'scheduled delivery and personal messages'], ['Bundles', 'inventory-aware product kits'],
    ['Tracking', 'carrier updates in the order timeline'], ['Accessibility', 'keyboard navigation across the catalog'],
    ['Recommendations', 'recently viewed product suggestions'], ['Pickup', 'store availability and collection windows'],
  ],
  'billing-api': [
    ['Credits', 'expiring balances with audit history'], ['Taxes', 'jurisdiction rules with effective dates'],
    ['Plans', 'scheduled subscription changes'], ['Trials', 'conversion reminders and grace windows'],
    ['Coupons', 'eligibility rules for recurring discounts'], ['Disputes', 'evidence packets from ledger events'],
    ['Currencies', 'daily rate snapshots for reporting'], ['Statements', 'monthly account summaries'],
    ['Receipts', 'localized payment confirmations'], ['Limits', 'spend controls with threshold alerts'],
    ['Reconciliation', 'processor settlements matched to payouts'], ['Proration', 'predictable mid-cycle adjustments'],
  ],
  'mobile-app': [
    ['Search', 'recent queries and offline suggestions'], ['Profile', 'avatar editing with safe cropping'],
    ['Delivery', 'map updates with accessible summaries'], ['Favorites', 'synced lists with optimistic updates'],
    ['Support', 'order context in help conversations'], ['Security', 'device history and remote sign-out'],
    ['Onboarding', 'resumable setup across devices'], ['Accessibility', 'dynamic type across checkout'],
    ['Localization', 'regional formats and plural rules'], ['Deep links', 'reliable routing from notifications'],
    ['Updates', 'release prompts with deferral controls'], ['Analytics', 'consent-aware journey events'],
    ['Returns', 'guided drop-off choices and label storage'], ['Payments', 'wallet selection with clear fallback states'],
    ['History', 'searchable orders with status filters'], ['Connectivity', 'queued actions during network changes'],
    ['Privacy', 'granular sharing controls for diagnostics'], ['Widgets', 'glanceable delivery updates'],
    ['Images', 'responsive product galleries with caching'], ['Sessions', 'reauthentication before sensitive changes'],
  ],
  'design-system': [
    ['Buttons', 'loading states with stable dimensions'], ['Tooltips', 'touch and keyboard interaction parity'],
    ['Icons', 'consistent sizing and accessible labels'], ['Spacing', 'responsive layout tokens'],
    ['Typography', 'fluid scales with readable defaults'], ['Menus', 'nested navigation with roving focus'],
    ['Toasts', 'queued announcements for assistive tech'], ['Dates', 'locale-aware calendar controls'],
    ['Charts', 'color-safe palettes and text summaries'], ['Motion', 'reduced-motion component variants'],
    ['Avatars', 'fallback initials and image states'], ['Pagination', 'compact navigation for narrow screens'],
  ],
  'data-pipeline': [
    ['Ingestion', 'deduplicated event batches'], ['Retention', 'policy-driven archive jobs'],
    ['Monitoring', 'freshness alerts for critical tables'], ['Recovery', 'replayable failed partitions'],
    ['Scheduling', 'dependency-aware daily jobs'], ['Validation', 'source contracts at ingestion time'],
    ['Sampling', 'stable datasets for quality checks'], ['Privacy', 'field redaction before warehouse loads'],
    ['Compaction', 'small-file cleanup for daily partitions'], ['Metrics', 'late-arrival rates by source'],
    ['Catalog', 'ownership metadata for shared datasets'], ['Replication', 'checkpointed cross-region copies'],
  ],
  'docs-site': [
    ['Navigation', 'audience-based guide collections'], ['Snippets', 'tested examples from source files'],
    ['Links', 'scheduled checks for external references'], ['Feedback', 'page ratings with optional notes'],
    ['Versions', 'switchable docs for supported releases'], ['Glossary', 'linked definitions for product terms'],
    ['Playground', 'editable request examples'], ['Accessibility', 'landmarks and skip navigation'],
    ['Performance', 'smaller search and code bundles'], ['Sitemaps', 'stable canonical URLs'],
    ['Contributing', 'preview steps for documentation changes'], ['Troubleshooting', 'symptom-first diagnostic guides'],
  ],
};
const ROUTING_REASONS = [
  'most spare weekly quota',
  'build lane incumbent',
  'best fit for the requested effort',
  'lowest in-flight load',
  'verification lane incumbent',
];
const REPORTS = [
  'Facet counts now come from one query; the focused tests and integration check pass.',
  'Retry handling is idempotent and the webhook contract tests pass.',
  'The accessible status flow is wired end to end and the mobile checks pass.',
  'The component behavior and tokens are aligned; the visual and unit checks pass.',
  'Partial batches resume safely and the import validation suite passes.',
  'The documentation examples match the shipped interface and the docs build passes.',
];
const TASK_TITLES = [
  'Add saved-address validation', 'Harden webhook retry coverage', 'Audit invoice export rounding',
  'Fix offline cart reconciliation', 'Test accessible order updates', 'Polish push preference controls',
  'Document focus token migration', 'Verify modal keyboard behavior', 'Add schema drift alerts',
  'Test partial-batch recovery', 'Refresh API search examples', 'Clarify the upgrade checklist',
];
const COMMANDS = ['npm test', 'pnpm lint', 'rg "addressBook" src', 'npm run build', 'node --test tests/checkout.test.js'];
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const WORKFLOW_BARE = /^[a-z0-9]{8}-[0-9a-f]{6}$/i;
const SHORT_ID = /^(?=[23456789abcdefghijkmnpqrstuvwxyz]{6}$)(?=.*\d)(?=.*[a-z])[23456789abcdefghijkmnpqrstuvwxyz]{6}$/i;
const SOURCE_ID_PATTERN = /wf-[a-z0-9]{8}-[0-9a-f]{6}|(?<![a-z0-9-])[a-z0-9]{8}-[0-9a-f]{6}(?![a-z0-9-])|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{13}-[a-z0-9]{5}|(?<![a-z0-9])(?!\d+h\d+m(?![a-z0-9]))(?=[23456789abcdefghijkmnpqrstuvwxyz]{6}(?![a-z0-9]))(?=[23456789abcdefghijkmnpqrstuvwxyz]*\d)(?=[23456789abcdefghijkmnpqrstuvwxyz]*[a-z])[23456789abcdefghijkmnpqrstuvwxyz]{6}(?![a-z0-9])/gi;

function hash(text, seed) {
  let h = seed >>> 0;
  const source = String(text);
  // Provider payloads can contain multi-megabyte captured tool results. Their
  // full contents are discarded in the demo, so sample both ends plus the
  // length instead of spending minutes hashing prose that will not survive.
  const sampled = source.length > 256
    ? `${source.slice(0, 128)}:${source.length}:${source.slice(-128)}`
    : source;
  for (const ch of sampled) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h >>> 0;
}

function filesUnder(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name !== 'pool-labels.json') out.push(relative(root, path));
    }
  };
  visit(root);
  return out;
}

function walk(value, fn, key = '', parent = null, mapKey = (name) => name, mapObject = (item) => item) {
  if (Array.isArray(value)) return value.map((item) => walk(item, fn, key, value, mapKey, mapObject));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, child] of Object.entries(value)) out[mapKey(childKey)] = walk(child, fn, childKey, value, mapKey, mapObject);
    return mapObject(out, value);
  }
  return fn(value, key, parent);
}

function fakeChars(value, alphabet, seed, salt = 0) {
  return [...String(value)].map((ch, index) => /[a-z0-9]/i.test(ch)
    ? alphabet[hash(`id:${salt}:${value}:${index}`, seed) % alphabet.length]
    : ch).join('');
}

function fakeId(value, seed, salt = 0) {
  const source = String(value);
  const shortAlphabet = '23456789abcdefghijkmnpqrstuvwxyz';
  if (SHORT_ID.test(source)) return fakeChars(source, shortAlphabet, seed, salt);
  if (WORKFLOW_BARE.test(source)) {
    const [clock, suffix] = source.split('-');
    return `${fakeChars(clock, '0123456789abcdefghijklmnopqrstuvwxyz', seed, salt)}-${fakeChars(suffix, '0123456789abcdef', seed, salt + 1)}`;
  }
  if (/^\d{13}-[a-z0-9]{5}$/i.test(source)) {
    const [clock, suffix] = source.split('-');
    return `${fakeChars(clock, '0123456789', seed, salt)}-${fakeChars(suffix, '0123456789abcdefghijklmnopqrstuvwxyz', seed, salt + 1)}`;
  }
  const hexOnly = /^[0-9a-f-]+$/i.test(source);
  return [...source].map((ch, index) => {
    if (!/[a-z0-9]/i.test(ch)) return ch;
    const n = hash(`id:${salt}:${source}:${index}`, seed);
    if (/\d/.test(ch)) return String(n % 10);
    const alphabet = hexOnly ? 'abcdef' : 'abcdefghijklmnopqrstuvwxyz';
    const next = alphabet[n % alphabet.length];
    return ch === ch.toUpperCase() ? next.toUpperCase() : next;
  }).join('');
}

function featureFor(id, project, seed, offset = 0) {
  const name = PROJECTS.includes(project) ? project : PROJECTS[hash(id, seed) % PROJECTS.length];
  const features = PROJECT_FEATURES[name];
  const goals = [...features.map(([label, outcome]) => [label, outcome]), ...EXTRA_GOALS[name]];
  const index = (hash(`feature:${id}`, seed) + offset) % goals.length;
  const [label, outcome] = goals[index];
  const files = features[index % features.length][2];
  return {
    label,
    outcome,
    files,
    goal: `${label}: ${outcome}`,
  };
}

function goalFor(id, project, seed, offset = 0) {
  return featureFor(id, project, seed, offset).goal;
}

function maxTimestamp(files, source) {
  let newest = 0;
  const history = files.includes('history/runs.jsonl') ? readFileSync(join(source, 'history/runs.jsonl'), 'utf8') : '';
  for (const line of history.split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    for (const value of [row.startedAt, row.finishedAt]) if (value) newest = Math.max(newest, Date.parse(value));
  }
  return newest;
}

function kernelStep(id) {
  const value = String(id).toLowerCase();
  if (/^integrate(?:$|-)/.test(value)) return 'integrate';
  if (/^verify(?:$|-)/.test(value)) return 'verify';
  if (/^accept(?:$|-)/.test(value)) return 'accept';
  if (/^digest(?:$|-)/.test(value)) return 'digest';
  if (/(?:^|-)repair(?:-|$)/.test(value)) return 'repair';
  return null;
}

export function buildDemoHome(snapshot, dest, { seed = 351, now = Date.now(), denied = [] } = {}) {
  const source = resolve(snapshot);
  const target = resolve(dest);
  if (!existsSync(join(source, 'history', 'runs.jsonl'))) throw new Error(`not a Bullswarm home snapshot: ${source}`);
  if (source === target) throw new Error('source and destination must differ');

  const files = filesUnder(source);
  const scrubber = new Scrubber(source);
  // Snapshot-derived owner, checkout and project tokens are always denied, so
  // invoking the builder directly is safe. Callers may add machine-local
  // tokens for opaque provider payloads via --deny-list.
  const deniedTerms = [...new Set([
    ...privateWords(scrubber),
    ...denied.map((term) => String(term).trim()).filter(Boolean),
  ])].sort((a, b) => b.length - a.length);
  const deniedPattern = deniedTerms.length
    ? new RegExp(deniedTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')
    : null;
  const sanitize = (value) => deniedPattern ? String(value).replace(deniedPattern, 'demo') : String(value);
  const authored = files.filter((name) => /\/(?:task|out)-[^/]+\.(?:md|json)$/.test(name));
  scrubber.learnFileLines(authored.map((name) => readFileSync(join(source, name), 'utf8')));
  const projectMap = new Map([...scrubber.projects.keys()].map((name, i) => [name, PROJECTS[i % PROJECTS.length]]));
  const projectAliases = new Map([...scrubber.projects.values()].map((name, i) => [name, PROJECTS[i % PROJECTS.length]]));
  const actionMap = new Map();
  const actionRoleMap = new Map();
  const usedActionAliases = new Map();
  const accountMap = new Map();
  const idMap = new Map();
  const usedShortIds = new Set();
  const usedGeneratedIds = new Set();
  const sourceIdTokens = new Set();
  for (const name of files) {
    const raw = readFileSync(join(source, name), 'utf8');
    for (const match of `${name}\n${raw}`.matchAll(new RegExp(SOURCE_ID_PATTERN.source, SOURCE_ID_PATTERN.flags))) {
      sourceIdTokens.add(match[0]);
      if (/^wf-/i.test(match[0])) sourceIdTokens.add(match[0].slice(3));
    }
  }
  const runFeatureMap = new Map();
  const taskFeatureMap = new Map();
  const taskProjectMap = new Map();
  const newest = maxTimestamp(files, source);
  // Flooring makes repeated builds in the same minute byte-identical while
  // keeping the visible activity approximately twenty minutes old.
  const anchor = Math.floor(now / 60_000) * 60_000 - 20 * 60_000;
  const shift = newest ? anchor - newest : 0;
  const costFactor = 0.6 + (hash(`cost:${seed}`, seed) % 3001) / 10_000;

  const mapPool = (pool) => {
    if (['claude-code', 'codex', 'grok', 'opencode', 'command-code'].includes(pool)) return pool;
    if (!String(pool).includes(':')) return pool;
    if (String(pool).startsWith('claude-code:')) return 'claude-code:team';
    if (!accountMap.has(pool)) {
      const names = ['claude-code:team', 'claude-code:alt', 'claude-code:studio', 'claude-code:backup'];
      accountMap.set(pool, names[Math.min(accountMap.size, names.length - 1)]);
    }
    return accountMap.get(pool);
  };
  const actionKey = (id, scope) => `${scope}\0${id}`;
  const mapAction = (id, scope = 'shared') => {
    if (typeof id !== 'string' || !id) return id;
    const used = usedActionAliases.get(scope) ?? new Set();
    usedActionAliases.set(scope, used);
    const key = actionKey(id, scope);
    if (!actionMap.has(key)) {
      const base = kernelStep(id);
      let alias = base ?? ACTION_NAMES.find((candidate) => !used.has(candidate)) ?? 'implementation';
      let suffix = 2;
      while (used.has(alias)) alias = `${base ?? 'implementation'}-${suffix++}`;
      actionMap.set(key, alias);
      used.add(alias);
    } else {
      used.add(actionMap.get(key));
    }
    return actionMap.get(key);
  };
  const hasAction = (id, scope) => actionMap.has(actionKey(id, scope));
  const actionPairs = (scope) => [...actionMap.entries()]
    .filter(([key]) => key.startsWith(`${scope}\0`))
    .map(([key, alias]) => [key.slice(key.indexOf('\0') + 1), alias]);
  const learnActionRole = (item, scope) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.purpose !== 'string') return;
    const semantic = `${item.kind ?? ''} ${item.lane ?? ''}`.toLowerCase();
    const role = /accept/.test(semantic) ? 'accept'
      : /adversarial|verif|evidence|analy[sz]e/.test(semantic) || (item.evidenceFor?.length ?? 0) > 0 ? 'verify'
      : /repair|fix|patch|retry/.test(semantic) ? 'repair' : 'build';
    if (role !== 'build' && !kernelStep(item.id)) {
      const key = actionKey(item.id, scope);
      const oldAlias = actionMap.get(key);
      const used = usedActionAliases.get(scope) ?? new Set();
      if (oldAlias) used.delete(oldAlias);
      let alias = role;
      let suffix = 2;
      while (used.has(alias)) alias = `${role}-${suffix++}`;
      actionMap.set(key, alias);
      used.add(alias);
      usedActionAliases.set(scope, used);
    }
    actionRoleMap.set(mapAction(item.id, scope), role);
  };
  const mapId = (id, uniqueShort = false) => {
    if (typeof id !== 'string' || !id) return id;
    if (/^wf-/i.test(id) && WORKFLOW_BARE.test(id.slice(3))) {
      if (!idMap.has(id)) {
        const candidate = `wf-${mapId(id.slice(3))}`;
        idMap.set(id, candidate);
        usedGeneratedIds.add(candidate);
      }
      return idMap.get(id);
    }
    if (!idMap.has(id)) {
      let candidate;
      if (uniqueShort) {
        const alphabet = '23456789abcdefghijkmnpqrstuvwxyz';
        let bits = hash(`short:${id}`, seed) & 0x3fffffff;
        do {
          let value = bits;
          candidate = Array.from({ length: 6 }, () => {
            const ch = alphabet[value & 31];
            value >>>= 5;
            return ch;
          }).join('');
          bits = (bits + 1) & 0x3fffffff;
        } while (usedShortIds.has(candidate) || sourceIdTokens.has(candidate) || usedGeneratedIds.has(candidate));
      } else {
        let salt = 0;
        do candidate = fakeId(id, seed, salt++);
        while (sourceIdTokens.has(candidate) || usedGeneratedIds.has(candidate));
      }
      idMap.set(id, candidate);
      usedGeneratedIds.add(candidate);
      if (uniqueShort) usedShortIds.add(candidate);
    }
    return idMap.get(id);
  };
  const mapModel = (model) => String(model).replace(
    /^[^/]+(?=\/(?:gpt|claude|grok|gemini|deepseek|qwen|kimi|llama|mistral)[\w.-]*$)/i,
    'demo',
  );
  const demoProject = (value) => PROJECTS.includes(value) ? value : projectMap.get(value) ?? projectAliases.get(value)
    ?? (/^project-[a-z]+$/.test(value) ? PROJECTS[hash(value, seed) % PROJECTS.length] : value);
  const mapObjectKey = (key) => {
    if (projectMap.has(key) || projectAliases.has(key)) return demoProject(key);
    if (key.includes(':')) return mapPool(key);
    if (key.includes('/')) return mapModel(key);
    return key;
  };

  const ID_KEYS = /^(?:runId|shortId|taskId|sessionId|attemptId|intentId|eventId|toolCallId|steeringId|revisionId)$/i;
  const ID_ARRAY_KEYS = /^(?:runIds|taskIds|sessionIds|attemptIds|intentIds|eventIds|toolCallIds|steeringIds|artifactIds)$/i;

  // Standalone task cards get their project from the decision record that
  // owns the task/output pair. Assign a different coherent feature in each
  // project so the Runs page never reads like repeated generator filler.
  try {
    const sourceState = JSON.parse(readFileSync(join(source, 'state.json'), 'utf8'));
    const seenByProject = new Map();
    for (const entry of sourceState.decisionLog ?? []) {
      const out = basename(entry?.outFile ?? '');
      if (!out.startsWith('out-') || !out.endsWith('.md')) continue;
      const project = demoProject(entry.project);
      if (!PROJECTS.includes(project)) continue;
      const task = `task-${out.slice(4)}`;
      const offset = seenByProject.get(project) ?? 0;
      seenByProject.set(project, offset + 1);
      const feature = featureFor(task, project, seed, offset);
      for (const file of [`runs/${task}`, `runs/${out}`]) {
        taskProjectMap.set(file, project);
        taskFeatureMap.set(file, feature);
      }
    }
  } catch { /* a snapshot without state still gets deterministic fallback copy */ }

  // Learn every identifier-shaped token from every source byte before
  // writing anything. This includes references embedded only in agent prose,
  // not merely ids that also occur as directories or structured JSON fields.
  const learnIds = (value, key = '') => {
    if (Array.isArray(value)) {
      if (ID_ARRAY_KEYS.test(key)) value.forEach((item) => typeof item === 'string' && mapId(item));
      else value.forEach((item) => learnIds(item, key));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [childKey, child] of Object.entries(value)) {
      if (ID_KEYS.test(childKey) && typeof child === 'string') mapId(child, childKey.toLowerCase() === 'shortid');
      else learnIds(child, childKey);
    }
  };
  for (const name of files) {
    const raw = readFileSync(join(source, name), 'utf8');
    for (const match of `${name}\n${raw}`.matchAll(new RegExp(SOURCE_ID_PATTERN.source, SOURCE_ID_PATTERN.flags))) {
      mapId(match[0], SHORT_ID.test(match[0]));
    }
    if (!/jsonl?$/.test(name)) continue;
    try {
      const rows = name.endsWith('.jsonl') ? raw.split('\n').filter(Boolean).map(JSON.parse) : [JSON.parse(raw)];
      rows.forEach((row) => learnIds(row));
    } catch { /* report artifacts may carry a JSON suffix */ }
  }

  // Stabilize aliases before rewriting object keys and artifact filenames.
  const structuredFiles = files.filter((file) => /jsonl?$/.test(file))
    .sort((a, b) => Number(b.startsWith('workflows/')) - Number(a.startsWith('workflows/')) || a.localeCompare(b));
  for (const name of structuredFiles) {
    const text = readFileSync(join(source, name), 'utf8');
    const scope = name.match(/^workflows\/([^/]+)\//)?.[1] ?? name;
    for (const match of text.matchAll(/"(?:actionId|sourceAction|stepId)"\s*:\s*"([^"]+)"/g)) mapAction(match[1], scope);
    for (const match of text.matchAll(/"(?:pool|picked|poolId)"\s*:\s*"([^"]+)"/g)) mapPool(match[1]);
    try {
      const rows = name.endsWith('.jsonl') ? text.split('\n').filter(Boolean).map(JSON.parse) : [JSON.parse(text)];
      const collect = (item) => {
        if (Array.isArray(item)) return item.forEach(collect);
        if (!item || typeof item !== 'object') return;
        if (typeof item.id === 'string' && typeof item.purpose === 'string') learnActionRole(item, scope);
        Object.values(item).forEach(collect);
      };
      rows.forEach(collect);
    } catch { /* some report artifacts have a .json suffix */ }
  }

  const runProjectMap = new Map();
  const runGoalMap = new Map();
  const usedGoals = new Set();
  for (const line of readFileSync(join(source, 'history', 'runs.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    if (!row.runId) continue;
    if (runGoalMap.has(row.runId)) continue;
    const project = demoProject(row.project);
    runProjectMap.set(row.runId, project);
    let offset = 0;
    let feature = featureFor(row.runId, project, seed, offset);
    const goalCount = PROJECT_FEATURES[project].length + EXTRA_GOALS[project].length;
    while (usedGoals.has(feature.goal) && offset < goalCount) {
      feature = featureFor(row.runId, project, seed, ++offset);
    }
    usedGoals.add(feature.goal);
    runGoalMap.set(row.runId, feature.goal);
    runFeatureMap.set(row.runId, feature);
  }
  let activeProject = null;
  let activeRunId = null;
  const activeFeature = () => runFeatureMap.get(activeRunId) ?? taskFeatureMap.get(activeName)
    ?? featureFor(activeRunId ?? activeName, activeProject ?? 'storefront', seed);
  const stepRole = (id = activeName) => {
    const value = String(id ?? '').toLowerCase();
    if (actionRoleMap.has(value)) return actionRoleMap.get(value);
    if (/verify|accept/.test(value)) return 'verify';
    if (/repair|fix/.test(value)) return 'repair';
    return 'build';
  };
  const actionFiles = (actionId) => {
    const files = activeFeature().files;
    if (stepRole(actionId) !== 'build') return [];
    const start = hash(`${activeRunId}:${actionId}:files`, seed) % files.length;
    return [files[start], files[(start + 1) % files.length]];
  };
  const taskTitle = (actionId) => {
    const feature = activeFeature();
    const role = stepRole(actionId);
    if (role === 'verify') return `Verify ${feature.label.toLowerCase()} acceptance criteria`;
    if (role === 'repair') return `Fix the ${feature.label.toLowerCase()} recovery defect`;
    return `Implement ${feature.outcome}`;
  };
  const taskDescription = (actionId) => {
    const feature = activeFeature();
    const role = stepRole(actionId);
    if (role === 'verify') return `Check the named ${feature.label.toLowerCase()} requirements, exercise failure cases, and record a clear pass or fail verdict.`;
    if (role === 'repair') return `Correct the failed ${feature.label.toLowerCase()} behavior, add a regression case, and rerun the focused checks.`;
    return `Update ${actionFiles(actionId).join(' and ')} to deliver ${feature.outcome}, with focused coverage for the changed behavior.`;
  };
  const genericProse = (key, value) => {
    const feature = activeFeature();
    if (key === 'evidence') return `The focused ${feature.label.toLowerCase()} checks exercise the named requirement.`;
    if (key === 'concerns') return `No unresolved ${feature.label.toLowerCase()} risk remains in the checked scope.`;
    if (key === 'report') return `${feature.label} behavior is implemented and the focused verification passes.`;
    return `Progress is recorded for ${feature.outcome}.`;
  };

  const transform = (value, key, parent) => {
    if (typeof value === 'number' && value > 1_000_000_000_000 && /(?:^at$|At$|timestamp|timeMs)/i.test(key)) return value + shift;
    if (typeof value === 'number' && /(cost|usd|spend|price(?!d))/i.test(key) && Number.isFinite(value)) {
      return Number((value * costFactor).toFixed(6));
    }
    if (typeof value !== 'string') return value;
    if (ID_KEYS.test(key) || (ID_ARRAY_KEYS.test(key) && idMap.has(value))) return mapId(value, key.toLowerCase() === 'shortid');
    if (/^(?:task|output|stream|diff|result)File$/.test(key)) {
      let artifact = basename(value);
      for (const [from, to] of actionPairs(activeRunId ?? activeName)) artifact = artifact.replaceAll(from, to);
      return sanitize(replaceIds(artifact));
    }
    if (ISO.test(value)) return new Date(Date.parse(value) + shift).toISOString();
    if (/^claude-code:.+/.test(value)) return mapPool(value);
    if (projectMap.has(value) || projectAliases.has(value)) return demoProject(value);
    if (/At$|Timestamp$|^timestamp$|^time$/.test(key) && Number.isFinite(Date.parse(value))) return new Date(Date.parse(value) + shift).toISOString();
    if (/^(pool|picked|poolId|sourcePool|targetPool)$/.test(key)) return mapPool(value);
    const actionScope = activeRunId ?? activeName;
    if (/^(actionId|sourceAction|stepId)$/.test(key)) return mapAction(value, actionScope);
    if ((key === 'id' && (hasAction(value, actionScope) || (parent && ('actionId' in parent || 'dependencies' in parent || 'purpose' in parent))))
      || /^(dependsOn|actionIds)$/.test(key)) return mapAction(value, actionScope);
    if (/^(project|projectName)$/.test(key)) return activeProject ?? demoProject(value);
    if (key === 'cwd' && activeProject) return PROJECT_PATHS[activeProject];
    if (/^[^/\s]+\/(?:gpt|claude|grok|gemini|deepseek|qwen|kimi|llama|mistral)[\w.-]*$/i.test(value)) return mapModel(value);
    if (key === 'name' && parent?.schemaVersion === 'bullswarm.workflow.project.v1') return PROJECTS[hash(value, seed) % PROJECTS.length];
    if (key === 'remote' && parent?.schemaVersion === 'bullswarm.workflow.project.v1') return `https://example.invalid/${PROJECTS[hash(value, seed) % PROJECTS.length]}.git`;
    if (/^(goal|title)$/.test(key)) {
      const sourceRunId = activeRunId ?? parent?.runId;
      return runGoalMap.get(sourceRunId)
        ?? goalFor(sourceRunId ?? parent?.id ?? value, activeProject ?? demoProject(parent?.project), seed);
    }
    if (/^(why|routeWhy|routeReason|routingReason)$/.test(key)) return ROUTING_REASONS[hash(value, seed) % ROUTING_REASONS.length];
    if (key === 'reason' && (parent?.candidates || parent?.picked || parent?.pool)) return ROUTING_REASONS[hash(value, seed) % ROUTING_REASONS.length];
    if (/^(prompt|purpose|text|evidence|concerns|lastResponse|lastSaid|summary|reason|report|authorPrompt)$/.test(key)) {
      return genericProse(key, value);
    }
    if (/command/i.test(key)) return COMMANDS[hash(value, seed) % COMMANDS.length];
    if (/(branch|revision|commit)/i.test(key)) return `demo-${(hash(value, seed) % 9999).toString().padStart(4, '0')}`;
    if (/^(ownedFiles|changedFiles|baselineChangedFiles)$/.test(key)) {
      const files = activeFeature().files;
      return files[hash(`${activeRunId}:${value}`, seed) % files.length];
    }
    if (key === 'id' && new RegExp(`^(?:${SOURCE_ID_PATTERN.source})$`, 'i').test(value)) return mapId(value);
    const embeddedIds = [...value.matchAll(new RegExp(SOURCE_ID_PATTERN.source, SOURCE_ID_PATTERN.flags))]
      .map((match) => mapId(match[0], SHORT_ID.test(match[0])));
    if (embeddedIds.length) return `Related demo references: ${embeddedIds.join(', ')}.`;
    let out = value;
    if (/^\/Users\/[^/]+\/\.bullswarm(?=\/|$)/.test(out)) out = out.replace(/^\/Users\/[^/]+\/\.bullswarm/, '/home/dev/.bullswarm');
    else if (/^\/Users\/[^/]+(?=\/|$)/.test(out)) out = `/home/dev/projects/${PROJECTS[hash(out, seed) % PROJECTS.length]}`;
    out = out.replace(/\/home\/dev\/(project-[a-z])(?=\/|$)/g, (_, alias) => `/home/dev/projects/${projectAliases.get(alias) ?? 'storefront'}`);
    if (/^\/home\/dev\/(?!\.)/.test(out)) out = `/home/dev/projects/${PROJECTS[hash(out, seed) % PROJECTS.length]}`;
    if (/\s/.test(out) && out.length > 12 && !/^https?:\/\//.test(out)) return genericProse(key, out);
    return out;
  };

  let activeName = '';
  const transformObject = (out) => {
    const project = activeProject ?? demoProject(out.project ?? out.projectName ?? out.name);
    if (PROJECTS.includes(project)) {
      if (Object.hasOwn(out, 'project')) out.project = project;
      if (Object.hasOwn(out, 'projectName')) out.projectName = project;
      if (Object.hasOwn(out, 'cwd')) out.cwd = PROJECT_PATHS[project];
      if (out.schemaVersion === 'bullswarm.workflow.project.v1') {
        out.name = project;
        out.cwd = PROJECT_PATHS[project];
        out.toplevel = PROJECT_PATHS[project];
        out.remote = `https://example.invalid/${project}.git`;
      }
    }
    if (typeof out.runId === 'string' && typeof out.goal === 'string') {
      out.goal = runGoalMap.get(activeRunId) ?? out.goal;
      if (out.status === 'running') {
        out.status = 'completed';
        out.finishedAt ??= new Date(anchor - 2 * 60_000).toISOString();
        out.verified ??= false;
      }
    }
    if (typeof out.id === 'string' && typeof out.purpose === 'string' && Array.isArray(out.ownedFiles)) {
      out.purpose = taskTitle(out.id);
      out.prompt = taskDescription(out.id);
      out.ownedFiles = actionFiles(out.id);
    }
    if (typeof out.actionId === 'string' && Array.isArray(out.changedFiles)) {
      out.changedFiles = actionFiles(out.actionId).slice(0, Math.max(1, Math.min(out.changedFiles.length, 2)));
    }
    return out;
  };

  // Opaque event/tool identifiers are transformed as whole JSON fields. Only
  // identifiers that can appear inside paths or prose need substring
  // replacement; keeping this recognizer structural avoids a giant regex over
  // thousands of event ids for every captured string.
  const replaceIds = (value) => String(value).replace(
    new RegExp(SOURCE_ID_PATTERN.source, SOURCE_ID_PATTERN.flags),
    (match) => idMap.get(match) ?? match,
  );
  const turnMessages = (actionId, count) => {
    const feature = activeFeature();
    const role = stepRole(actionId);
    const file = actionFiles(actionId)[0] ?? feature.files[0];
    const opening = role === 'verify'
      ? `I'll map the named ${feature.label.toLowerCase()} requirements to focused checks first.`
      : role === 'repair'
        ? `I'll reproduce the ${feature.label.toLowerCase()} recovery defect and inspect ${file} first.`
        : `I'll inspect ${file} and its focused tests before changing the implementation.`;
    const middle = role === 'verify' ? [
      `The requirement map is complete; I am exercising the primary ${feature.label.toLowerCase()} path now.`,
      `The primary behavior passes; I am checking invalid input and retry handling next.`,
      `Failure recovery behaves as specified, so I am checking the integration boundary.`,
      `The integration evidence is consistent with the named requirements; I am reviewing coverage gaps.`,
      `No unchecked clause remains; I am running the final focused suite.`,
    ] : role === 'repair' ? [
      `The defect is isolated to the ${feature.label.toLowerCase()} recovery branch.`,
      `The recovery branch now preserves state correctly; I am adding the regression case.`,
      `The regression case fails on the old behavior and passes with the fix.`,
      `Focused checks are clean; I am verifying the surrounding integration.`,
    ] : [
      `The existing ${feature.label.toLowerCase()} flow is clear; I am updating the shared behavior next.`,
      `The main ${feature.outcome} path is implemented; I am covering invalid input now.`,
      `Edge cases are covered; I am running the focused tests next.`,
      `The focused suite passes; I am checking the integration boundary.`,
      `The integration check is clean; I am reviewing the final diff for scope.`,
    ];
    const last = role === 'verify'
      ? `Verdict: all named ${feature.label.toLowerCase()} requirements pass, including failure recovery.`
      : role === 'repair'
        ? `The ${feature.label.toLowerCase()} recovery defect is fixed and the regression checks pass.`
        : `The ${feature.outcome} change is complete; focused tests and integration checks pass.`;
    if (count <= 1) return [last];
    return Array.from({ length: count }, (_unused, index) => {
      if (index === 0) return opening;
      if (index === count - 1) return last;
      return middle[index - 1] ?? `Progress checkpoint ${index}: ${feature.label.toLowerCase()} behavior remains clean under the expanded checks.`;
    });
  };

  rmSync(target, { recursive: true, force: true });
  let written = 0;
  for (const name of files) {
    activeName = name;
    activeRunId = [...runProjectMap.keys()].find((runId) => name === `workflows/${runId}` || name.startsWith(`workflows/${runId}/`)) ?? null;
    activeProject = activeRunId ? runProjectMap.get(activeRunId) : (taskProjectMap.get(name) ?? null);
    const original = readFileSync(join(source, name), 'utf8');
    let scrubbed;
    try { scrubbed = scrubber.file(name); } catch { scrubbed = original; }
    let output;
    if (name.endsWith('.json')) {
      try {
        output = `${JSON.stringify(walk(JSON.parse(scrubbed), transform, '', null, mapObjectKey, transformObject))}${scrubbed.endsWith('\n') ? '\n' : ''}`;
      } catch {
        const sentence = `The ${activeFeature().label.toLowerCase()} artifact is intentionally summarized for this demo.`;
        output = original.split('\n').map((line) => line.trim() ? sentence : '').join('\n');
      }
    } else if (name.endsWith('.jsonl')) {
      const sourceRows = original.split('\n').filter(Boolean);
      const rows = scrubbed.split('\n').filter(Boolean)
        .map((line) => walk(JSON.parse(line), transform, '', null, mapObjectKey, transformObject));
      rows.forEach((row, index) => {
        const references = [...(sourceRows[index] ?? '').matchAll(new RegExp(SOURCE_ID_PATTERN.source, SOURCE_ID_PATTERN.flags))]
          .map((match) => mapId(match[0], SHORT_ID.test(match[0])));
        if (references.length) row.idReferences = [...new Set(references)];
      });
      if (/\/stream-[^/]+\.jsonl$/.test(`/${name}`)) {
        const responses = rows.filter((row) => String(row?.kind).toLowerCase() === 'response' && row.summary != null);
        const action = mapAction(name.match(/\/stream-(.+)-attempt-\d+\.jsonl$/)?.[1] ?? 'build', activeRunId ?? activeName);
        const messages = turnMessages(action, responses.length);
        responses.forEach((row, index) => { row.summary = messages[index]; });
      }
      if (name === 'history/runs.jsonl') {
        const seen = new Set();
        output = `${rows.filter((row) => {
          if (!row.runId || seen.has(row.runId)) return false;
          seen.add(row.runId);
          return true;
        }).map((row) => JSON.stringify(row)).join('\n')}\n`;
      } else {
      output = `${rows.map((row) => JSON.stringify(row)).join('\n')}${scrubbed.endsWith('\n') ? '\n' : ''}`;
      }
    } else {
      if (/\/out-[^/]+\.md$/.test(`/${name}`)) {
        const action = mapAction(name.match(/\/out-(.+)-attempt-\d+\.md$/)?.[1] ?? 'build', activeRunId ?? activeName);
        const files = actionFiles(action);
        output = `# Result\n\n${activeFeature().label} behavior is complete and the focused checks pass.\n\nFiles changed:\n${files.map((file) => `- ${file}`).join('\n')}\n`;
      } else if (/\/diff-[^/]+\.txt$/.test(`/${name}`)) {
        const action = mapAction(name.match(/\/diff-(.+)-attempt-\d+\.txt$/)?.[1] ?? 'build', activeRunId ?? activeName);
        const files = actionFiles(action);
        output = files.length
          ? `${files.map((file, index) => `${file} | ${index ? '18 +++++++++---' : '42 ++++++++++++++++++++++------'}`).join('\n')}\n`
          : '';
      } else if (/\/task-[^/]+\.md$/.test(`/${name}`)) {
        const action = mapAction(name.match(/\/task-(.+)-attempt-\d+\.md$/)?.[1] ?? 'build', activeRunId ?? activeName);
        output = `# ${taskTitle(action)}\n\n${taskDescription(action)}\n`;
      } else if (/^runs\/task-[^/]+\.md$/.test(name)) {
        output = `# ${TASK_TITLES[hash(name, seed) % TASK_TITLES.length]}\n`;
      } else {
        const sentence = `The ${activeFeature().label.toLowerCase()} artifact is intentionally summarized for this demo.`;
        output = original.split('\n').map((line) => line.trim() ? sentence : '').join('\n');
      }
    }
    let outputName = name;
    if (name.startsWith('workflows/')) {
      const parts = outputName.split('/');
      let leaf = parts.pop();
      for (const [from, to] of actionPairs(activeRunId ?? activeName)) leaf = leaf.replaceAll(from, to);
      for (const [from, to] of accountMap) leaf = leaf.replaceAll(from, to);
      outputName = [...parts, leaf].join('/');
    } else {
      for (const [from, to] of accountMap) outputName = outputName.replaceAll(from, to);
    }
    outputName = replaceIds(outputName);
    outputName = sanitize(outputName);
    const path = join(target, outputName);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, sanitize(replaceIds(output)));
    written += 1;
  }

  // The demo has exactly one scoped Claude account. Snapshot ordering can
  // otherwise leave that synthetic account disabled even though its cache is
  // present, which makes a healthy reading disappear from Budget.
  const statePath = join(target, 'state.json');
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.pools ??= {};
    state.pools['claude-code:team'] = { ...(state.pools['claude-code:team'] ?? {}), enabled: true };
    delete state.pools['claude-code:alt'];
    delete state.pools['claude-code:studio'];
    delete state.pools['claude-code:backup'];
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  }

  // Snapshot meter files are structurally useful but personally identifying
  // account history is not. Replace the cache with a small synthetic set.
  const meters = [
    ['claude-code', 58, 31, 3, 4],
    ['claude-code:team', 82, 64, 2, 7],
    ['codex', 37, 24, 5, 6],
    ['grok', 91, 77, 1, 9],
    ['command-code', 46, 69, 4, 3],
  ];
  rmSync(join(target, 'meters'), { recursive: true, force: true });
  mkdirSync(join(target, 'meters'), { recursive: true });
  mkdirSync(join(target, 'meters', 'history'), { recursive: true });
  for (const [pool, weeklyUsed, monthlyUsed, days, todayUsed] of meters) {
    const resetsAt = new Date(now + days * 86_400_000).toISOString();
    const reading = {
      captured_at: new Date(now - 30_000).toISOString(),
      five_hour: { utilization: Math.max(12, weeklyUsed - 18), resets_at: new Date(now + 2 * 3_600_000).toISOString() },
      seven_day: { utilization: weeklyUsed, resets_at: resetsAt },
      monthly: { utilization: monthlyUsed, resets_at: new Date(now + (days + 12) * 86_400_000).toISOString() },
    };
    writeFileSync(join(target, 'meters', `${pool}.json`), `${JSON.stringify(reading)}\n`);
    const history = [
      {
        captured_at: new Date(now - 12 * 3_600_000).toISOString(),
        seven_day: { utilization: weeklyUsed - todayUsed, resets_at: resetsAt },
      },
      {
        captured_at: reading.captured_at,
        seven_day: { utilization: weeklyUsed, resets_at: resetsAt },
      },
    ];
    writeFileSync(join(target, 'meters', 'history', `${pool}.jsonl`), `${history.map((row) => JSON.stringify(row)).join('\n')}\n`);
  }
  // Home's `weekly quota` column prefers run-attributed calibration samples.
  // Replace the snapshot ledger with a tiny fictional one whose per-run drops
  // add up to the same modest today share represented by meter history.
  rmSync(join(target, 'calibration'), { recursive: true, force: true });
  mkdirSync(join(target, 'calibration'), { recursive: true });
  const generatedRuns = readFileSync(join(target, 'history', 'runs.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
  const todayKey = new Date(now).toLocaleDateString('en-CA');
  const todayRuns = generatedRuns.filter((row) => row.finishedAt
    && new Date(row.finishedAt).toLocaleDateString('en-CA') === todayKey);
  const demoModels = {
    'claude-code': 'claude-opus-5',
    'claude-code:team': 'claude-opus-5',
    codex: 'gpt-5.6-luna',
    grok: 'grok-4.6',
    'command-code': 'demo/deepseek-v4.1-flash',
  };
  // A Budget row without any work today cannot appear in Home's licence
  // table. Give each such pool one small fictional attempt on a different
  // same-day run so all meter-to-today comparisons are visible and honest.
  for (const [index, [pool]] of meters.entries()) {
    if (!todayRuns.length || todayRuns.some((row) => row.pools && Object.hasOwn(row.pools, pool))) continue;
    const row = todayRuns[index % todayRuns.length];
    const minutes = Number((8.5 + index * 1.3).toFixed(1));
    const apiUsd = Number((0.35 + index * 0.27).toFixed(2));
    row.pools ??= {};
    row.pools[pool] = {
      attempts: 1, minutes, tokens: 1_200_000 + index * 125_000,
      cacheRead: 900_000 + index * 100_000, cacheWrite: 0, reasoning: 12_000 + index * 500,
      apiUsd, apiKnownSubtotalUsd: apiUsd, subscriptionUsd: null, subscriptionKnownSubtotalUsd: null,
      measuredAttempts: 1, pricedAttempts: 1, subscriptionPricedAttempts: 0,
      tokenSource: 'provider-reported', subscriptionBasis: 'unknown:no-meter',
      subscriptionDeltaPct: null, subscriptionWindow: null, subscriptionWindows: {}, costUsd: apiUsd,
    };
    row.models ??= {};
    row.models[demoModels[pool]] = { attempts: 1, minutes };
    row.minutes ??= {};
    row.minutes.agent = Number(((row.minutes.agent ?? 0) + minutes).toFixed(2));
  }
  writeFileSync(join(target, 'history', 'runs.jsonl'), `${generatedRuns.map((row) => JSON.stringify(row)).join('\n')}\n`);
  for (const [pool, _weeklyUsed, _monthlyUsed, _days, todayUsed] of meters) {
    const runIds = [...new Set(generatedRuns
      .filter((row) => row.finishedAt && new Date(row.finishedAt).toLocaleDateString('en-CA') === todayKey)
      .filter((row) => row.pools && Object.hasOwn(row.pools, pool))
      .map((row) => row.runId).filter(Boolean))];
    const samples = runIds.map((runId, index) => ({
      at: new Date(now - (runIds.length - index) * 60_000).toISOString(),
      apiUsd: Number((1 + index / 10).toFixed(2)),
      deltaPct: Number((todayUsed / runIds.length).toFixed(6)),
      runId,
      attemptId: `demo-attempt-${index + 1}`,
    }));
    const totalApi = samples.reduce((sum, sample) => sum + sample.apiUsd, 0);
    const totalPct = samples.reduce((sum, sample) => sum + sample.deltaPct, 0);
    const ledger = {
      schema: 'bullswarm.calibration.v1',
      pool,
      window: pool === 'command-code' ? 'monthly' : 'weekly',
      samples,
      usdPerPct: samples.length >= 3 && totalPct > 0 ? totalApi / totalPct : null,
      sampleCount: samples.length,
      updatedAt: new Date(now - 30_000).toISOString(),
    };
    writeFileSync(join(target, 'calibration', `${pool}.json`), `${JSON.stringify(ledger)}\n`);
  }
  rmSync(join(target, 'assignments'), { recursive: true, force: true });
  rmSync(join(target, 'pool-labels.json'), { force: true });
  return { files: written + meters.length, projects: Object.fromEntries(projectMap), costFactor, shiftMs: shift };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const positional = [];
  const denyLists = [];
  let seed = 351;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--seed') seed = Number(args[++i]);
    else if (args[i] === '--deny-list') denyLists.push(args[++i]);
    else positional.push(args[i]);
  }
  if (positional.length !== 2 || !Number.isFinite(seed)) {
    process.stderr.write('usage: node scripts/build-demo-home.mjs <snapshot> <dest> [--seed N] [--deny-list FILE ...]\n');
    process.exit(2);
  }
  if (denyLists.some((file) => !file)) {
    process.stderr.write('--deny-list requires a file path\n');
    process.exit(2);
  }
  const denied = denyLists.flatMap((file) => readFileSync(file, 'utf8').split(/\r?\n/));
  const result = buildDemoHome(positional[0], positional[1], { seed, denied });
  process.stdout.write(`wrote ${result.files} sanitized demo files to ${positional[1]} (cost factor ${result.costFactor.toFixed(4)})\n`);
}
