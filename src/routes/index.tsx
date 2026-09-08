import { createFileRoute } from '@tanstack/react-router'
import { getOverview, getSeriesGroups } from '../server/fns.ts'

/**
 * Placeholder status page.
 *
 * Deliberately plain: it exists to prove the server functions, SQLite and the
 * Komga link all work end to end. The real catalogue UI is a separate piece of
 * work and will replace this entirely.
 */
export const Route = createFileRoute('/')({
  component: Status,
  loader: async () => ({
    overview: await getOverview(),
    groups: await getSeriesGroups({ data: {} }),
  }),
})

function bytes(n: number): string {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = n
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${u[i]}`
}

function Status() {
  const { overview, groups } = Route.useLoaderData()
  const { cache, lastIndexRun, komgaReachable } = overview
  const pct = Math.min(100, cache.usage.pctUsed)
  const budgetPct = (cache.usage.budget / cache.usage.total) * 100

  return (
    <div className="mx-auto max-w-4xl p-8 font-sans">
      <h1 className="text-2xl font-semibold">Comics sidecar</h1>
      <p className="mt-1 text-sm text-gray-500">
        Catalogue and cache control. Reading happens in Komga.
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-gray-500">Volume</h2>
        <div className="relative mt-2 h-6 w-full overflow-hidden rounded bg-gray-200">
          <div className="h-full bg-blue-500" style={{ width: `${pct}%` }} />
          <div
            className="absolute inset-y-0 w-px bg-red-600"
            style={{ left: `${budgetPct}%` }}
            title="eviction budget"
          />
        </div>
        <p className="mt-2 text-sm">
          {bytes(cache.usage.used)} of {bytes(cache.usage.total)} used ({pct.toFixed(1)}%), budget{' '}
          {bytes(cache.usage.budget)}
          {cache.usage.overBy > 0 ? ` — over by ${bytes(cache.usage.overBy)}` : ' — ok'}
        </p>
      </section>

      <section className="mt-8 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <Stat label="Titles in Drive" value={String(cache.totalTitles)} />
        <Stat label="Cached locally" value={`${cache.localTitles} (${bytes(cache.localBytes)})`} />
        <Stat label="Archive size" value={bytes(cache.archiveBytes)} />
        <Stat label="Komga" value={komgaReachable ? 'reachable' : 'unreachable'} />
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-gray-500">
          Last index refresh
        </h2>
        <p className="mt-1 text-sm">
          {lastIndexRun
            ? `${lastIndexRun.status} — ${lastIndexRun.files_seen} file(s), ${lastIndexRun.added} added, ${lastIndexRun.updated} updated at ${lastIndexRun.finished_at ?? lastIndexRun.started_at}`
            : 'never run'}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-gray-500">
          Series ({groups.length})
        </h2>
        <ul className="mt-2 divide-y divide-gray-200 text-sm">
          {groups.map((g) => (
            <li key={g.key} className="flex items-baseline justify-between py-1.5">
              <span>
                {g.series}
                {g.publisher ? <span className="ml-2 text-gray-400">{g.publisher}</span> : null}
              </span>
              <span className="text-gray-500">
                {g.localCount}/{g.count} local · {bytes(g.sizeBytes)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 font-medium">{value}</div>
    </div>
  )
}
