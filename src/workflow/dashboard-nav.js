// Navigation chrome: the page tab row at the top and the sticky bottom nav
// with its run buttons and the page's own hints.
import { glyphs } from '../lib/glyphs.js';
import { cut, tabsRow } from './dash-kit.js';
import { stepFooterText } from './step-view.js';
import { dimText, visibleLength } from './dashboard-ansi.js';
import { PAGE_TABS, TAB_OF_PAGE } from './dashboard-pages.js';

/** `text` underlined, so a key hint reads as one. */
const underline = (text) => `\x1b[4m${text}\x1b[24m`;

/**
 * The page tab row: the active tab inverted with its key letter underlined.
 * Fleet is dropped while the terminal is narrow unless it is the page being
 * read. Help remains available from the bottom nav and the `?` key, but is
 * intentionally not a top-level tab.
 */
function pageTabs(page, width) {
  const active = TAB_OF_PAGE[page] ?? (page === 'help' ? null : page);
  const hidden = [];
  if (width < 38) hidden.push('fleet');
  return tabsRow(PAGE_TABS, { active, width, hidden });
}

/**
 * The bottom nav: one button per ongoing run, then the page's tail.
 *
 * A run's digit sits inside its button (`[ 1.aaa111 ]`) and a label's key
 * letter is underlined, so the keys read off the nav. Below 100 columns the
 * tail is the phone layout's `[Top] [End] [? Help]`; the run buttons keep the
 * left and drop from the end when they do not fit.
 */
function navParts(model, { page, width, selectedRunId, stepView = 'overview', stepDetail = false }) {
  const narrow = width < 100;
  const button = (item) => {
    const mark = item.mark ? `${glyphs().ongoing} ` : '';
    // A digit is never a label's key, however the run id spells itself, and a
    // capitalised label ([Help]) still underlines the lower-case key that
    // presses it.
    const at = /^[a-z]$/.test(item.key ?? '') ? item.label.toLowerCase().indexOf(item.key) : -1;
    const label = at >= 0
      ? `${item.label.slice(0, at)}${underline(item.label[at])}${item.label.slice(at + 1)}`
      // A run's digit joins its id (`1.aaa111`); a symbol key stands apart
      // from its word (`? help`), where `?.help` read as a typo.
      : item.key ? `${underline(item.key)}${/^\d$/.test(item.key) ? '.' : ' '}${item.label}` : item.label;
    return item.tight ? `[${mark}${label}]` : `[ ${mark}${label} ]`;
  };
  // Colour rules: the footer hints are meta, so their prose is dim; the
  // buttons before them keep their own faces.
  const hintText = (hint, room) => {
    const text = cut(hint, room);
    return text ? dimText(text, Math.max(1, visibleLength(text))) : text;
  };
  // The Run page owns its compact footer: navigation back to the catalogue,
  // the selected run chip, and the page-local plan/follow controls. Keeping it
  // in the shell means it is painted once, below the scrollable body, and the
  // same hints are available at every terminal width.
  if (page === 'run') {
    const selected = model.runs.find((run) => run.runId === selectedRunId) ?? model.runs[0] ?? null;
    const items = [];
    items.push({ key: null, label: 'back', action: { kind: 'back' } });
    if (selected) items.push({ key: null, label: `1.${selected.shortId ?? '------'}`, mark: true, tight: false, action: { kind: 'run', runId: selected.runId } });
    const prefix = items.map((item) => button(item)).join(' ');
    const hint = width < 100
      ? ' Enter open · p plan · ? help'
      : ' Enter open step · p plan boxes · Space follow · ? help';
    const available = Math.max(1, width - prefix.length - 2);
    const parts = [{ text: ' ' }];
    items.forEach((item, index) => {
      if (index) parts.push({ text: ' ' });
      parts.push({ text: button(item), action: item.action });
    });
    parts.push({ text: ` ${hintText(hint, available)}` });
    return parts;
  }
  if (page === 'step' || page === 'task') {
    const selected = page === 'step'
      ? model.runs.find((run) => run.runId === selectedRunId) ?? model.runs[0] ?? null
      : null;
    const items = [{ key: null, label: 'back', action: { kind: 'back' } }];
    // The phone keeps only its back control and the short hints; the selected
    // run chip is the desktop context marker, matching the Run page footer.
    if (!narrow && selected) {
      items.push({ key: null, label: `1.${selected.shortId ?? '------'}`, mark: true, tight: false, action: { kind: 'run', runId: selected.runId } });
    }
    const prefix = items.map((item) => button(item)).join(' ');
    // `stepDetail` is the open row under the cursor now; the view is the toggle's.
    const view = stepView === 'detail' || (stepDetail === true && stepView == null) ? 'detail' : 'overview';
    const hint = stepFooterText(null, { phone: narrow, view });
    const available = Math.max(1, width - prefix.length - 2);
    const parts = [{ text: ' ' }];
    items.forEach((item) => {
      parts.push({ text: button(item), action: item.action });
      parts.push({ text: ' ' });
    });
    // Desktop separates the button group from the prose hint by one extra
    // cell; the phone keeps the compact two-cell gap from the approved frame.
    parts.push({ text: `${narrow ? ' ' : '  '}${hintText(hint, available)}` });
    return parts;
  }
  const back = page === 'step' || page === 'task' ? [{ key: null, label: 'back', action: { kind: 'back' } }] : [];
  // The run the reader is on is marked wherever a run is what they are
  // reading; the other pages mark themselves in the tab row instead.
  const onRunPage = page === 'home' || page === 'run' || page === 'step' || page === 'runs';
  const runs = model.runs.map((run, index) => ({
    key: index < 9 ? String(index + 1) : null,
    label: run.shortId ?? '------',
    mark: onRunPage && run.runId === selectedRunId,
    action: { kind: 'run', runId: run.runId },
  }));
  const tail = narrow
    ? [
      { key: null, label: 'Top', tight: true, action: { kind: 'top' } },
      { key: null, label: 'End', tight: true, action: { kind: 'end' } },
      { key: '?', label: 'Help', tight: true, mark: page === 'help', action: { kind: 'page', page: 'help' } },
    ]
    : [
      { key: '?', label: 'help', mark: page === 'help', action: { kind: 'page', page: 'help' } },
      { key: 'q', label: 'quit', action: { kind: 'quit' } },
    ];
  // The way out is the last thing to go: the tail is kept whole and the run
  // buttons fill whatever the terminal has left for them. A terminal too
  // narrow for the whole tail still gets its last button.
  const lineLength = (items) => 1 + items.reduce((sum, item) => sum + visibleLength(button(item)) + 1, 0);
  const moreButton = (count) => ({
    key: null,
    label: `+${count} more`,
    action: { kind: 'page', page: 'runs' },
  });
  // Keep the fixed hints together whenever they fit. If the terminal is too
  // narrow even for those hints, retain the existing fallback of dropping
  // their leftmost entries until at least one remains.
  const fittedTail = [...tail];
  while (fittedTail.length > 1 && lineLength([...back, ...fittedTail]) > width) fittedTail.shift();

  let shown = [...runs];
  let more = null;
  if (lineLength([...back, ...shown, ...fittedTail]) > width) {
    // Once there is overflow, the reader's current run is the useful thing
    // to keep on the phone. Preserve each item's Runs-page digit while
    // moving that selected chip to the front; the remaining visible chips
    // continue in Runs-page order.
    const selected = runs.find((run) => run.mark) ?? runs[0] ?? null;
    const ordered = selected ? [selected, ...runs.filter((run) => run !== selected)] : [];
    shown = ordered.length ? [ordered[0]] : [];
    for (const run of ordered.slice(1)) {
      const hidden = runs.length - (shown.length + 1);
      if (lineLength([...back, ...shown, run, moreButton(hidden), ...fittedTail]) > width) break;
      shown.push(run);
    }
    const hidden = runs.length - shown.length;
    if (hidden > 0) more = moreButton(hidden);
  }

  const parts = [{ text: ' ' }];
  for (const item of [...back, ...shown, ...(more ? [more] : []), ...fittedTail]) {
    parts.push({ text: button(item), action: item.action });
    parts.push({ text: ' ' });
  }
  return parts;
}

export {
  pageTabs,
  navParts,
};
