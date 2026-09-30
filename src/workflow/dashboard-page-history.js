// The History notes: how many days are loaded, right above the bottom nav.
import { historyNote } from './history-view.js';
import { daysWithTasks } from './runs-view.js';
import { dimText } from './dashboard-ansi.js';

/** History's note: how many days are loaded, right above the bottom nav. */
function historyPageNotes(model, { width }, notes) {
  const days = daysWithTasks(model.days, model.tasks?.finished);
  for (const line of historyNote(days, { width })) notes.push(dimText(line, width));
}

export {
  historyPageNotes,
};
