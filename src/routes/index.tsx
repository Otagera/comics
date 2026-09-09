import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useMemo, useState, useTransition } from 'react'
import {
  DrawablyButton,
  DrawablyInput,
  DrawablyBadge,
  DrawablyDivider,
  DrawablyCircle,
} from 'drawably/react'

import { getVault, fetchTitle, setPin, setStatus, runIndexRefresh } from '../server/fns.ts'
import { CapacityMeter } from '../components/CapacityMeter.tsx'
import { Cover, seedFrom, type CoverItem } from '../components/Cover.tsx'
import { ThemeToggle } from '../components/ThemeToggle.tsx'
import { bytes, relativeTime } from '../lib/format.ts'

export const Route = createFileRoute('/')({
  component: Vault,
  loader: () => getVault({ data: {} }),
})

type Item = Awaited<ReturnType<typeof getVault>>['items'][number]
type BtnState = 'idle' | 'loading' | 'success' | 'error'
type Shelf = 'all' | 'local' | 'remote' | 'reading' | 'want' | 'finished' | 'abandoned'

const SHELVES: Array<{ key: Shelf; label: string }> = [
  { key: 'all', label: 'Everything' },
  { key: 'local', label: 'On disk' },
  { key: 'remote', label: 'In Drive' },
  { key: 'reading', label: 'Reading' },
  { key: 'want', label: 'Want to read' },
  { key: 'finished', label: 'Finished' },
  { key: 'abandoned', label: 'Abandoned' },
]

function Vault() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [shelf, setShelf] = useState<Shelf>('all')
  const [query, setQuery] = useState('')
  const [fetchState, setFetchState] = useState<Record<string, BtnState>>({})
  const [refreshState, setRefreshState] = useState<BtnState>('idle')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    return data.items.filter((i) => {
      if (shelf === 'local' && i.localState !== 'local') return false
      if (shelf === 'remote' && i.localState === 'local') return false
      if (['reading', 'want', 'finished', 'abandoned'].includes(shelf) && i.readingStatus !== shelf)
        return false
      if (!q) return true
      return (
        (i.series ?? '').toLowerCase().includes(q) ||
        i.fileName.toLowerCase().includes(q) ||
        (i.publisher ?? '').toLowerCase().includes(q)
      )
    })
  }, [data.items, shelf, query])

  const shown = useMemo(() => items.reduce((n, i) => n + i.sizeBytes, 0), [items])
  const selected = selectedId ? (data.items.find((i) => i.id === selectedId) ?? null) : null

  const refresh = () => startTransition(() => router.invalidate())

  async function doFetch(item: Item) {
    setFetchState((s) => ({ ...s, [item.id]: 'loading' }))
    try {
      await fetchTitle({ data: item.id })
      setFetchState((s) => ({ ...s, [item.id]: 'success' }))
      refresh()
    } catch {
      setFetchState((s) => ({ ...s, [item.id]: 'error' }))
    }
  }

  async function doPin(item: Item) {
    await setPin({ data: { id: item.id, pinned: !item.pinned } })
    refresh()
  }

  async function doStatus(item: Item, status: Item['readingStatus']) {
    await setStatus({ data: { id: item.id, status: status === item.readingStatus ? null : status } })
    refresh()
  }

  async function doRefresh() {
    setRefreshState('loading')
    try {
      await runIndexRefresh()
      setRefreshState('success')
      refresh()
      setTimeout(() => setRefreshState('idle'), 1600)
    } catch {
      setRefreshState('error')
    }
  }

  return (
    <div className="min-h-screen">
      {/* The capacity meter is persistent: it rides the header so a download
          decision is never made without the cost of it visible. */}
      <header
        className="panel sticky top-0 z-30 rounded-none border-x-0 border-t-0"
        style={{ borderRadius: 0 }}
      >
        <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex items-center justify-between gap-3 sm:justify-start">
            <div className="flex items-baseline gap-2.5">
              <span className="pen text-[26px] leading-none" style={{ color: 'var(--text)' }}>
                Vault
              </span>
              <span className="tnum text-[11px]" style={{ color: 'var(--text-3)' }}>
                {data.items.length} titles
              </span>
            </div>
            <div className="sm:hidden">
              <ThemeToggle />
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <CapacityMeter
              used={data.cache.usage.used}
              total={data.cache.usage.total}
              budget={data.cache.usage.budget}
              localTitles={data.cache.localTitles}
              localBytes={data.cache.localBytes}
              compact
            />
          </div>

          <div className="hidden items-center gap-2 sm:flex">
            <DrawablyButton
              seed={101}
              state={refreshState}
              onClick={doRefresh}
              disabled={refreshState === 'loading'}
              className="text-[13px]"
              title={`Last refreshed ${relativeTime(
                (data.lastIndexRun?.finished_at as string) ?? null,
              )}`}
            >
              {refreshState === 'loading' ? 'Refreshing' : 'Refresh'}
            </DrawablyButton>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-5 pb-20 pt-6">
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <DrawablyInput
            seed={202}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search series, publisher, filename"
            className="w-full max-w-xs text-[13px]"
          />
          <div className="flex flex-wrap gap-1.5">
            {SHELVES.map((s) => (
              <DrawablyButton
                key={`${s.key}-${shelf === s.key ? 'on' : 'off'}`}
                seed={seedFrom(s.key)}
                variant={shelf === s.key ? 'solid' : 'outline'}
                onClick={() => setShelf(s.key)}
                className="text-[13px]"
              >
                {s.label}
              </DrawablyButton>
            ))}
          </div>
          <span className="tnum ml-auto pr-2 text-[12px]" style={{ color: 'var(--text-2)' }}>
            <DrawablyCircle seed={seedFrom(shelf + items.length)}>{items.length}</DrawablyCircle>
            <span className="ml-2" style={{ color: 'var(--text-3)' }}>
              shown · {bytes(shown)}
            </span>
          </span>
        </div>

        {items.length === 0 ? (
          <p className="pen py-20 text-center text-[18px]" style={{ color: 'var(--text-3)' }}>
            Nothing on this shelf.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
            {items.map((item) => (
              <button
                key={item.id}
                className="group text-left"
                onClick={() => setSelectedId(item.id)}
              >
                <Cover
                  item={
                    {
                      ...item,
                      localState:
                        fetchState[item.id] === 'loading' ? 'fetching' : item.localState,
                    } as CoverItem
                  }
                />
                <div className="mt-2 px-0.5">
                  <div
                    className="truncate text-[13px] font-medium leading-snug"
                    style={{ color: 'var(--text)' }}
                    title={item.series ?? item.fileName}
                  >
                    {item.series ?? item.fileName}
                  </div>
                  <div
                    className="tnum mt-0.5 flex items-center gap-1.5 text-[11px]"
                    style={{ color: 'var(--text-3)' }}
                  >
                    {item.volume ? <span>v{String(item.volume).padStart(2, '0')}</span> : null}
                    {item.year ? <span>{item.year}</span> : null}
                    <span className="ml-auto">{bytes(item.sizeBytes, 0)}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>

      {selected && (
        <Detail
          item={selected}
          state={fetchState[selected.id] ?? 'idle'}
          usage={data.cache.usage}
          onClose={() => setSelectedId(null)}
          onFetch={doFetch}
          onPin={doPin}
          onStatus={doStatus}
        />
      )}

      {pending && (
        <div
          className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5"
          style={{ background: 'var(--sea)' }}
        />
      )}
    </div>
  )
}

const STATUSES: Array<{ key: NonNullable<Item['readingStatus']>; label: string }> = [
  { key: 'want', label: 'Want to read' },
  { key: 'reading', label: 'Reading' },
  { key: 'finished', label: 'Finished' },
  { key: 'abandoned', label: 'Abandoned' },
]

function Detail({
  item,
  state,
  usage,
  onClose,
  onFetch,
  onPin,
  onStatus,
}: {
  item: Item
  state: BtnState
  usage: { used: number; total: number; budget: number }
  onClose: () => void
  onFetch: (i: Item) => void
  onPin: (i: Item) => void
  onStatus: (i: Item, s: Item['readingStatus']) => void
}) {
  const isLocal = item.localState === 'local'
  const willExceed = !isLocal && usage.used + item.sizeBytes > usage.budget

  return (
    <div
      className="scrim fixed inset-0 z-40 flex items-end justify-center p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="modal max-h-[88vh] w-full max-w-lg overflow-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-4">
          <div className="w-24 shrink-0">
            <Cover
              item={
                { ...item, localState: state === 'loading' ? 'fetching' : item.localState } as CoverItem
              }
            />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold leading-tight" style={{ color: 'var(--text)' }}>
              {item.series ?? item.fileName}
            </h2>
            {item.title && (
              <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-2)' }}>
                {item.title}
              </p>
            )}
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              {item.kind && (
                <DrawablyBadge seed={seedFrom(item.id + 'k')} className="text-[11px]">
                  {item.kind}
                </DrawablyBadge>
              )}
              <span className="tnum text-[12px]" style={{ color: 'var(--text-3)' }}>
                {[
                  item.publisher,
                  item.year,
                  item.volume ? `v${String(item.volume).padStart(2, '0')}` : null,
                  bytes(item.sizeBytes),
                ]
                  .filter(Boolean)
                  .join('  ·  ')}
              </span>
            </p>
            <p
              className="tnum mt-1.5 break-all text-[11px]"
              style={{ color: 'var(--text-3)', opacity: 0.75 }}
            >
              {item.drivePath}
            </p>
          </div>
        </div>

        {item.pagesCount && item.page ? (
          <div className="mt-4">
            <div className="flex items-baseline justify-between text-[12px]">
              <span style={{ color: 'var(--text-2)' }}>
                {item.completed ? 'Finished in Komga' : 'Read progress'}
              </span>
              <span className="tnum" style={{ color: 'var(--text-3)' }}>
                {item.page} / {item.pagesCount}
                {item.readDate ? ` · ${relativeTime(item.readDate)}` : ''}
              </span>
            </div>
            {/* Still an exact bar: progress is a measurement, so it stays
                precise even though everything around it is drawn. */}
            <div className="meter-track mt-1.5" style={{ height: 4 }}>
              <div
                className="meter-fill"
                style={{ width: `${Math.min(100, (item.page / item.pagesCount) * 100)}%` }}
              />
            </div>
          </div>
        ) : null}

        <DrawablyDivider seed={seedFrom(item.id + 'd')} className="my-5" />

        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((s) => (
            <DrawablyButton
              key={`${s.key}-${item.readingStatus === s.key ? 'on' : 'off'}`}
              seed={seedFrom(item.id + s.key)}
              variant={item.readingStatus === s.key ? 'solid' : 'outline'}
              tone={s.key === 'abandoned' && item.readingStatus !== s.key ? 'neutral' : undefined}
              onClick={() => onStatus(item, s.key)}
              className="text-[12px]"
            >
              {s.label}
            </DrawablyButton>
          ))}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {isLocal ? (
            <span className="text-[13px]" style={{ color: 'var(--text-2)' }}>
              On disk and open in Komga.
            </span>
          ) : (
            <DrawablyButton
              seed={seedFrom(item.id + 'f')}
              variant="solid"
              state={state}
              disabled={state === 'loading'}
              onClick={() => onFetch(item)}
              className="text-[13px]"
            >
              {state === 'loading'
                ? 'Fetching'
                : state === 'error'
                  ? 'Failed — retry'
                  : `Download ${bytes(item.sizeBytes, 0)}`}
            </DrawablyButton>
          )}
          <DrawablyButton
            seed={seedFrom(item.id + 'p')}
            tone="neutral"
            onClick={() => onPin(item)}
            className="text-[13px]"
          >
            {item.pinned ? 'Unpin' : 'Pin'}
          </DrawablyButton>
          <span className="ml-auto">
            <DrawablyButton seed={303} tone="neutral" onClick={onClose} className="text-[13px]">
              Close
            </DrawablyButton>
          </span>
        </div>

        {willExceed && (
          <p className="mt-3 text-[12px]" style={{ color: 'var(--accent-deep)' }}>
            This will push the volume past its budget — something will be evicted to make room.
          </p>
        )}
      </div>
    </div>
  )
}
