// The one number helper the dashboard's windows and cursors share (clamp).

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export {
  clamp,
};
