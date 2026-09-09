/**
 * Canonical display name for a comic or a wish.
 *
 * One function, because two callers must agree: the wishlist stores it as the
 * entry's display text, and the Notion sync writes it as the Name of rows it
 * creates. If they drifted, a wish and the row it later syncs to would carry
 * different names for the same thing.
 *
 * Shape is `{Series} #{Issue} ({Year})`, with the issue and year parts dropped
 * when unknown -- most of this archive is collected editions with a volume
 * rather than an issue number.
 */

export interface Nameable {
  series: string | null
  issue?: string | null
  volume?: number | null
  year?: number | null
}

export function canonicalName(x: Nameable): string {
  const parts: string[] = []
  const series = (x.series ?? '').trim()
  if (series) parts.push(series)

  if (x.issue) parts.push(`#${String(x.issue).trim()}`)
  else if (x.volume != null) parts.push(`v${String(x.volume).padStart(2, '0')}`)

  const base = parts.join(' ').trim()
  return x.year ? `${base} (${x.year})`.trim() : base
}
