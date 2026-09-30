// The local clipboard a copied screen falls back to when a terminal will not
// take OSC 52 (writeClipboard).
import { spawnSync } from 'node:child_process';

/**
 * The local clipboard, for a terminal that will not take OSC 52: pbcopy on
 * macOS, wl-copy under Wayland. Returns which tool carried it, or why none
 * did — the message on screen names one or the other, never both.
 */
export function writeClipboard(text, { platform = process.platform, env = process.env, run = spawnSync } = {}) {
  const tools = [];
  if (platform === 'darwin') tools.push('pbcopy');
  if (env.WAYLAND_DISPLAY) tools.push('wl-copy');
  if (env.DISPLAY) tools.push('xclip');
  for (const tool of tools) {
    try {
      const result = run(tool, tool === 'xclip' ? ['-selection', 'clipboard'] : [], { input: text });
      if (!result?.error && (result?.status === 0 || result?.status == null)) return { ok: true, tool };
    } catch { /* try the next one */ }
  }
  return { ok: false, tool: null, reason: tools.length ? `${tools.join(' and ')} failed` : 'no pbcopy, wl-copy or xclip on this machine' };
}
