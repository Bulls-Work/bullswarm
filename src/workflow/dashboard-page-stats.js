// The Stats page: the four shared surfaces and the three periods.
import { statsLines } from './stats-view.js';
import { dimText, meterAnsi } from './dashboard-ansi.js';
import { pushView } from './dashboard-frame.js';
import { STATS_TABS } from './dashboard-pages.js';
import { addStatsLegendRegions, alignStatsShareRegions, boldStatsLegend } from './dashboard-stats-legend.js';

/** Stats: the four shared surfaces and the three periods. */
function statsPage(model, opts, body) {
  const { width } = opts;
  const tab = STATS_TABS.includes(opts.statsTab) ? opts.statsTab : 'spending';
  const stackBy = opts.statsStackBy === 'model' ? 'model' : 'pool';
  if (!model.stats) {
    body.push(dimText(' reading the rollup index…', width));
    return ' Stats';
  }
  const slice = opts.slice ?? null;
  const view = statsLines(model.stats, {
    width, height: opts.height, tab, period: opts.period, stackBy,
    ansi: meterAnsi(), slice,
  });
  // stat-kit deliberately keeps legend markers as presentation text.  The
  // shell adds the same durable bar action to the matching legend name so a
  // legend tap has the exact same label/pin affordance as a chart or panel
  // bar, without making the marker itself a second drawing system.
  const statsView = alignStatsShareRegions(addStatsLegendRegions(view));
  const activeSeries = slice?.payload?.series ?? slice?.series ?? null;
  if (activeSeries && meterAnsi()) boldStatsLegend(statsView, activeSeries);
  pushView(body, statsView);
  body.anchor = { tabs: 1 };
  return ` Stats · ${tab}`;
}

export {
  statsPage,
};
