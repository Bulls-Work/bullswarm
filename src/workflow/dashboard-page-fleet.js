// The Fleet page: the rungs by lane or by provider, read-only.
import { fleetLines } from './fleet-view.js';
import { meterAnsi } from './dashboard-ansi.js';
import { pushView } from './dashboard-frame.js';
import { FLEET_TABS } from './dashboard-pages.js';

/** Fleet: the rungs by lane or by provider, read-only. */
function fleetPage(model, opts, body) {
  const { width } = opts;
  const by = FLEET_TABS.includes(opts.fleetBy) ? opts.fleetBy : 'lane';
  const view = fleetLines(model.pools, model.rungs, { width, by, nowMs: opts.nowMs, ansi: meterAnsi(), picks: model.picks ?? {} });
  const before = body.lines.length;
  pushView(body, view);
  // fleet-view records its own sub-tab and `[ edit ]` regions, so the shell
  // only has to remember which row they were painted on for the scroll.
  const tabs = (view?.regions ?? []).find((region) => region?.action?.kind === 'tab');
  if (tabs?.y) body.anchor = { tabs: before + Number(tabs.y) };
  return ` Fleet · by ${by}`;
}

export {
  fleetPage,
};
