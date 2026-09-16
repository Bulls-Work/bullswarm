/**
 * One line of the run overview as bullswarm draws it, classified for the
 * pane: a section header, a timestamped milestone, a detail line, or plain.
 */
export type OverviewLine = {
  text: string
  kind: 'header' | 'section' | 'milestone' | 'detail' | 'plain' | 'blank'
  /** The right-aligned value bullswarm put at the end, when the row has one. */
  tone: 'ok' | 'fail' | 'running' | 'none'
}

/**
 * Reads the frame `bullswarm workflow tui <id> --overview` prints: the box
 * border comes off (the pane draws its own), section titles become headers.
 */
export function parseOverview(stdout: string): OverviewLine[] {
  const lines: OverviewLine[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line) continue
    if (/^[┌├]/.test(line)) {
      const title = line.replace(/^[┌├]\s?/, '').replace(/[─┐┤]+$/, '').trim()
      if (title) lines.push({ text: title, kind: 'header', tone: 'none' })
      continue
    }
    if (/^└/.test(line)) continue
    const inner = line.replace(/^│/, '').replace(/│$/, '').replace(/\s+$/, '')
    if (!inner.trim()) {
      if (lines.length && lines[lines.length - 1]!.kind !== 'blank')
        lines.push({ text: '', kind: 'blank', tone: 'none' })
      continue
    }
    const tone: OverviewLine['tone'] = /✓|✔/.test(inner)
      ? 'ok'
      : /✗|×|failed|blocked/.test(inner)
        ? 'fail'
        : /running|∴|◐|◑|◒|◓|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/.test(inner)
          ? 'running'
          : 'none'
    const kind: OverviewLine['kind'] = /^── /.test(inner)
      ? 'section'
      : /^\d{2}:\d{2}\s/.test(inner)
      ? 'milestone'
      : /^\s{3,}/.test(inner) || /^\s*[↳↓↑]/.test(inner)
        ? 'detail'
        : 'plain'
    lines.push({ text: inner, kind, tone })
  }
  while (lines.length && lines[lines.length - 1]!.kind === 'blank') lines.pop()
  return lines
}
