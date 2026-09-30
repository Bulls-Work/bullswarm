// The Budget page: every pool's licence meter, its money and what still fits.
import { budgetLines } from './budget-view.js';
import { dimText, meterAnsi } from './dashboard-ansi.js';
import { pushView } from './dashboard-frame.js';

/** Budget: every pool's licence meter, its money and what still fits. */
function budgetPage(model, opts, body) {
  const { width } = opts;
  const sampled = model.budget?.sampleAgeText ? ` · sampled ${model.budget.sampleAgeText}` : '';
  if (!model.budget) {
    body.push(dimText(' reading the pool meters…', width));
    if (opts.budgetPool) body.push(dimText(` selected pool · ${opts.budgetPool}`, width));
    return ` Budget · this week${opts.budgetPool ? ` · ${opts.budgetPool}` : ''}`;
  }
  pushView(body, budgetLines(model.budget, { width, ansi: meterAnsi(), nowMs: opts.nowMs }));
  if (opts.budgetPool) body.push(dimText(` selected pool · ${opts.budgetPool}`, width));
  return ` Budget · ${model.budget.days ?? 7} days to ${model.budget.timeZone ?? 'local'}${sampled}${opts.budgetPool ? ` · ${opts.budgetPool}` : ''}`;
}

export {
  budgetPage,
};
