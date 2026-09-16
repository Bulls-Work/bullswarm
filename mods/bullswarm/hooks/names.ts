/**
 * Display names for pools: a `prefix:slug` account pool shows as
 * `prefix:<first letter of slug>` unless two accounts would collide, and
 * the plugin's `poolAliases` option (`from=to,from=to`) overrides any name.
 */
export function aliasesOf(option: unknown): Map<string, string> {
  const map = new Map<string, string>()
  if (typeof option !== 'string') return map
  for (const pair of option.split(',')) {
    const [from, to] = pair.split('=').map(s => s.trim())
    if (from && to) map.set(from, to)
  }
  return map
}

export function displayNames(
  pools: readonly string[],
  aliases: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Map<string, string>()
  for (const name of pools) {
    const alias = aliases.get(name)
    if (alias) {
      out.set(name, alias)
      taken.set(alias, name)
    }
  }
  for (const name of pools) {
    if (out.has(name)) continue
    const at = name.indexOf(':')
    const slug = at >= 0 ? name.slice(at + 1) : ''
    let short = name
    if (slug.length > 1) {
      const prefix = name.slice(0, at)
      const letter = `${prefix}:${slug[0]}`
      const clash = pools.some(
        other =>
          other !== name &&
          !aliases.has(other) &&
          other.startsWith(`${prefix}:`) &&
          other.slice(at + 1)[0] === slug[0],
      )
      short = clash || taken.has(letter) ? name : letter
    }
    out.set(name, short)
    taken.set(short, name)
  }
  return out
}

/** Rewrites every full pool name in a text line to its display name. */
export function withDisplayNames(text: string, names: ReadonlyMap<string, string>): string {
  let out = text
  for (const [full, short] of [...names.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (full !== short) out = out.split(full).join(short)
  }
  return out
}
