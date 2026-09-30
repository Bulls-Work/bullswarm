// The status glyph and label a run or step is shown with, and a step's role
// label (statusIcon, stepStatusLabel, actionRoleLabel).
import { glyphs, spinnerGlyph } from '../lib/glyphs.js';

// A step the caller accepted (stage-3 D22) reads `accepted`, never as proven
// work; its glyph stays the succeeded one. A check's requirement acceptance
// changes no step label.
export function stepStatusLabel(action) {
  const status = action?.status ?? 'pending';
  const acceptance = action?.acceptance;
  return status === 'succeeded' && acceptance && typeof acceptance === 'object' && !Array.isArray(acceptance.requirements) ? 'accepted' : status;
}

export function actionRoleLabel(action) {
  if (action.kind) return action.kind;
  if (action.role) return action.role;
  if (Array.isArray(action.evidenceFor) && action.evidenceFor.length) return 'evidence';
  if (action.lane || action.prompt) return 'work';
  return 'action';
}

// Workflow-level glyph for a terminal run.
function workflowStatusIcon(state, spinnerFrame = 0) {
  return statusIcon(state?.status, spinnerFrame);
}

export function statusIcon(status, spinnerFrame = 0) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'completed' || value.startsWith('succeeded')) return glyphs().ok;
  if (value === 'completed_with_concerns') return '!'; // legacy runs
  if (value === 'dependency_blocked') return glyphs().blocked;
  if (value.startsWith('failed') || value === 'cancelled' || value === 'interrupted') return glyphs().fail;
  if (value === 'running' || value === 'active' || value === 'planning') {
    return spinnerGlyph(spinnerFrame);
  }
  if (value.includes('waiting') || value === 'queued' || value === 'paused'
    || value === 'blocked' || value === 'starting' || value === 'reviewing evidence'
    || value === 'directing execution') return glyphs().waiting;
  if (value === 'skipped' || value === 'removed' || value === 'superseded') return '–';
  return glyphs().pending;
}

export {
  workflowStatusIcon,
};
