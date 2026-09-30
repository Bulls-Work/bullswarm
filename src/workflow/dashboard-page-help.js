// The Help page: every key and every click, grouped by what it is for.
import { cut, rule } from './dash-kit.js';
import { tint, strong, truncate, visibleLength } from './dashboard-ansi.js';
import { integrationLines } from './dashboard-integration.js';
import { DASHBOARD_KEYS } from './dashboard-keys.js';

/**
 * Help: every key and every click, grouped by what it is for.
 *
 * Keys that do the same kind of thing share a row — `r b s y f → Runs ·
 * Budget · Stats · History · Fleet` — so the page is about thirty rows rather
 * than one row per binding, and every row still fits the 54 columns the phone
 * frame paints. The key names are bold; the sentence beside them is not.
 *
 * Nothing here claims a key the shell does not run: the rows are built from
 * DASHBOARD_KEYS, so a rebinding moves the page with it.
 */
function helpPage(model, opts, body) {
  const { width } = opts;
  const narrow = width < 60;
  const keyWidth = narrow ? 12 : 16;
  const row = (keys, text) => {
    const label = ` ${strong(String(keys))}`;
    const pad = ' '.repeat(Math.max(1, keyWidth - visibleLength(String(keys))));
    body.push(cut(`${label}${pad}${text}`, width));
  };
  /** One row from several key names, the way the shell groups them. */
  const grouped = (names, text) => row(names.map((name) => DASHBOARD_KEYS[name].keys).join(' '), text);

  body.push(tint(truncate(narrow ? ' keys and clicks' : ' every key and click on this dashboard', width), 'dim'));
  body.push(rule('pages', null, width));
    grouped(['runs', 'budget', 'stats', 'fleet'], 'Runs · Budget · Stats · Fleet');
  row(DASHBOARD_KEYS.home.keys, 'Home');
  // History is the day table inside Runs now, so `y` is a jump, not a page.
  row(DASHBOARD_KEYS.history.keys, narrow ? 'the first day of Runs' : 'Runs, at the first day of its history');
  row(DASHBOARD_KEYS.help.keys, 'this help');
  row(DASHBOARD_KEYS.out.keys, narrow ? 'back, then Home' : 'back from a step, otherwise Home');
  row(DASHBOARD_KEYS.openRun.keys, 'open the numbered run in the nav');
  row(DASHBOARD_KEYS.in.keys, 'open the run, its steps, then one step');
  // Budget has no sub-tabs; Stats and Fleet do, and this says only that.
  row(DASHBOARD_KEYS.nextTab.keys, 'next sub-tab on Stats and Fleet');
  row(DASHBOARD_KEYS.cycleWorkflow.keys, 'cycle workflows');
  row(DASHBOARD_KEYS.period.keys, narrow ? 'period: 7 days · 30 days · all' : 'cycle the period: 7 days · 30 days · all time');

  body.push('');
  body.push(rule('moving', null, width));
  grouped(['up', 'down'], 'scroll one line');
  grouped(['pageUp', 'pageDown'], 'scroll a screen');
  grouped(['top', 'end'], 'top · bottom');
  row('wheel', 'scrolls the body under the sticky header');

  body.push('');
  body.push(rule('clicks', null, width));
  row('tab · period', 'the tab row opens a page · the toggle sets the period');
  row('tile', narrow ? 'a today number opens its chart' : "a today number opens its chart in Stats › Trends");
  row('bar', 'a breakdown bar opens its Stats tab · a trend bar opens its day');
  row('pool', 'a pool name or meter opens Budget on it');
  row('step', 'a plan glyph or step row opens the step');
  row('view', narrow ? 'overview · detail in the Step activity rule' : 'overview · detail after the Step activity heading switches the view');
  row('turn', narrow ? 'a turn head opens it · click for detail' : 'a Step turn head opens the turn · the `click for detail` line opens detail');
  row('run', 'a run row or nav button opens the run');

  body.push('');
  body.push(rule('other', null, width));
  row('e · c · y', 'edit the fleet · stop this workflow · y confirms it');
  row('/ · a · i', 'filter · active/all · install (on Runs)');
  row('o · v · t', 'planner · technical · phases (on Run) · Stats By Pool/By Model');
  row('v · t · f', narrow ? 'Step: overview · detail · filter · follow' : 'Step: overview · detail (the activity-rule toggle) · filter · follow');
  row(DASHBOARD_KEYS.copy.keys, 'copy the screen · OSC 52, else pbcopy/wl-copy');
  row(DASHBOARD_KEYS.detach.keys, 'quit to the shell; workflows keep running');
  row('under 100', 'Fleet leaves the tab row until f opens it');
  row('under 100', 'the nav tail is [Top] [End] [?.Help]');
  row('rebound', 'r was refresh · b was back · Tab was workflows');
  integrationLines(model, opts, body);
  return ' bullswarm · help';
}

export {
  helpPage,
};
