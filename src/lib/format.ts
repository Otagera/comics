export function bytes(n: number, digits = 1): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Math.abs(n)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(digits)} ${units[i]}`
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'never'
  const secs = Math.round((Date.now() - then) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(then).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}
