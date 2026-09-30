// The dashboard's keys: every binding with the words its hint uses
// (DASHBOARD_KEYS), and the hint and key-press tests built on it.

// Keep navigation wording and bindings in one place. Rendering and input use
// the same vocabulary so a hint never describes a different action.
const keyRow = (keys, label, bindings) => Object.freeze({ keys, label, bindings: Object.freeze(bindings) });

// 0.33.0 rebinds three keys the 0.32 viewer used: `r` was refresh (the 1 s
// timer already refreshes, so nothing is lost), `b` was move out (Esc and the
// left arrow still are), and `Tab` was the next workflow (Shift+Tab still
// cycles workflows, and Tab now walks a page's sub-tabs). The changelog
// records the change; the Help page names every key below.
export const DASHBOARD_KEYS = Object.freeze({
  home: keyRow('h', 'Home', ['h']),
  runs: keyRow('r', 'Runs', ['r']),
  budget: keyRow('b', 'Budget', ['b']),
  stats: keyRow('s', 'Stats', ['s']),
  history: keyRow('y', 'History', ['y']),
  fleet: keyRow('f', 'Fleet', ['f']),
  help: keyRow('?', 'Help', ['?']),
  openRun: keyRow('1\u20139', 'open that run', []),
  nextTab: keyRow('Tab', 'next sub-tab', ['\t']),
  cycleWorkflow: keyRow('Shift+Tab', 'cycle workflows', ['\x1b[Z']),
  period: keyRow('p', 'cycle the period', ['p']),
  up: keyRow('\u2191/k', 'move up', ['\x1b[A', 'k']),
  down: keyRow('\u2193/j', 'move down', ['\x1b[B', 'j']),
  in: keyRow('Enter/\u2192/l', 'open', ['\r', '\n', '\x1b[C', 'l']),
  out: keyRow('Esc/\u2190', 'move out', ['\x1b', '\x1b[D']),
  pageUp: keyRow('PgUp', 'scroll up a screen', ['\x1b[5~']),
  pageDown: keyRow('PgDn', 'scroll down a screen', ['\x1b[6~']),
  top: keyRow('Home', 'top', ['\x1b[H', '\x1b[1~', '\x1bOH']),
  end: keyRow('End', 'bottom', ['\x1b[F', '\x1b[4~', '\x1bOF']),
  copy: keyRow('ctrl+s', 'copy the screen', ['\x13']),
  detach: keyRow('q', 'quit', ['q', '\x03']),
});

function keyHint(name) {
  const action = DASHBOARD_KEYS[name];
  return `${action.keys.split('/')[0]} ${action.label}`;
}

function keyPressed(name, key) {
  return DASHBOARD_KEYS[name].bindings?.includes(key) ?? false;
}

export {
  keyHint,
  keyPressed,
};
