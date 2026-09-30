// The dashboard's pages and sub-tabs: every page, the tab row's tabs, the
// period toggle, and the Stats, Fleet and Step sub-tabs.

/** Every page the dashboard has, in the order the help page lists them. */
const DASHBOARD_PAGES = Object.freeze(['home', 'runs', 'run', 'step', 'task', 'budget', 'stats', 'history', 'fleet', 'help']);
/** The tab row above the body; `key` is the key that opens the page. */
const PAGE_TABS = Object.freeze([
  Object.freeze({ id: 'home', label: 'Home', key: 'h' }),
  Object.freeze({ id: 'runs', label: 'Runs', key: 'r' }),
  Object.freeze({ id: 'budget', label: 'Budget', key: 'b' }),
  Object.freeze({ id: 'stats', label: 'Stats', key: 's' }),
  Object.freeze({ id: 'fleet', label: 'Fleet', key: 'f' }),
]);
/** Run and Step are read as Runs: the tab row marks the page they came from. */
const TAB_OF_PAGE = Object.freeze({ run: 'runs', step: 'runs', task: 'runs', history: 'runs' });
/** The period toggle, in the order `p` cycles it. */
const PERIOD_ITEMS = Object.freeze([
  Object.freeze({ id: '7d', label: 'Last 7 days' }),
  Object.freeze({ id: '30d', label: 'Last 30 days' }),
  Object.freeze({ id: 'all', label: 'All time' }),
]);
/** Stats' sub-tabs and Fleet's, in the order Tab cycles them. */
const STATS_TABS = Object.freeze(['spending', 'pool', 'model', 'project']);
const FLEET_TABS = Object.freeze(['lane', 'provider']);

const STEP_SECTIONS = Object.freeze(['activity', 'attempts', 'outcome', 'prompt']);

export {
  DASHBOARD_PAGES,
  PAGE_TABS,
  TAB_OF_PAGE,
  PERIOD_ITEMS,
  STATS_TABS,
  FLEET_TABS,
  STEP_SECTIONS,
};
