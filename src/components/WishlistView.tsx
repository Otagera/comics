import { useState } from 'react'
import { DrawablyButton, DrawablyInput, DrawablyBadge } from 'drawably/react'

import { seedFrom } from './Cover.tsx'
import { relativeTime } from '../lib/format.ts'

/**
 * The wishlist: titles that are not in Drive at all yet.
 *
 * Deliberately a separate view rather than another shelf chip. "Want to read"
 * is a reading status on a comic you already hold; a wish is a thing you do
 * not have. Putting them in the same row of filters would blur exactly the
 * distinction that makes each useful.
 *
 * Capture is structured -- series, issue, year, publisher as separate fields --
 * because the whole point is that a file arriving in Drive later has to match
 * it automatically. A single free-text blob cannot be matched reliably. There
 * is nothing to validate against (no canonical comics database exists), so
 * this records intent; it does not verify it.
 */

export interface Wish {
  id: string
  query: string
  series: string | null
  issue: string | null
  year: number | null
  publisher: string | null
  status: 'wanted' | 'available' | 'fulfilled' | 'dropped'
  matched_comic_id: string | null
  created_at: string
  matched_at: string | null
}

const STATUS_LABEL: Record<Wish['status'], string> = {
  wanted: 'Wanted',
  available: 'In Drive now',
  fulfilled: 'Fulfilled',
  dropped: 'Dropped',
}

export function WishlistView({
  wishes,
  busy,
  onAdd,
  onStatus,
  onOpenMatch,
}: {
  wishes: Wish[]
  busy: boolean
  onAdd: (w: { series: string; issue?: string; year?: number; publisher?: string }) => void
  onStatus: (id: string, status: Wish['status']) => void
  onOpenMatch: (comicId: string) => void
}) {
  const [series, setSeries] = useState('')
  const [issue, setIssue] = useState('')
  const [year, setYear] = useState('')
  const [publisher, setPublisher] = useState('')

  const available = wishes.filter((w) => w.status === 'available')
  const wanted = wishes.filter((w) => w.status === 'wanted')
  const rest = wishes.filter((w) => w.status === 'fulfilled' || w.status === 'dropped')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const s = series.trim()
    if (!s) return
    const y = Number(year)
    onAdd({
      series: s,
      issue: issue.trim() || undefined,
      year: Number.isFinite(y) && year.trim() ? y : undefined,
      publisher: publisher.trim() || undefined,
    })
    setSeries('')
    setIssue('')
    setYear('')
    setPublisher('')
  }

  return (
    <div className="mx-auto max-w-3xl">
      <form onSubmit={submit} className="modal mb-8 p-5">
        <h2 className="pen mb-1 text-[20px]" style={{ color: 'var(--text)' }}>
          Add to the wishlist
        </h2>
        <p className="mb-4 text-[12px]" style={{ color: 'var(--text-3)' }}>
          Something you want that is not in Drive yet. When a matching file
          appears, this flips to <em>In Drive now</em> on its own.
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
          <label className="sm:col-span-3">
            <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-2)' }}>
              Series
            </span>
            <DrawablyInput
              seed={411}
              value={series}
              onChange={(e) => setSeries(e.currentTarget.value)}
              placeholder="Saga"
              className="w-full text-[13px]"
              required
            />
          </label>
          <label className="sm:col-span-1">
            <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-2)' }}>
              Issue
            </span>
            <DrawablyInput
              seed={412}
              value={issue}
              onChange={(e) => setIssue(e.currentTarget.value)}
              placeholder="12"
              className="w-full text-[13px]"
            />
          </label>
          <label className="sm:col-span-1">
            <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-2)' }}>
              Year
            </span>
            <DrawablyInput
              seed={413}
              value={year}
              onChange={(e) => setYear(e.currentTarget.value)}
              inputMode="numeric"
              placeholder="2024"
              className="w-full text-[13px]"
            />
          </label>
          <label className="sm:col-span-1">
            <span className="mb-1 block text-[12px]" style={{ color: 'var(--text-2)' }}>
              Publisher
            </span>
            <DrawablyInput
              seed={414}
              value={publisher}
              onChange={(e) => setPublisher(e.currentTarget.value)}
              placeholder="Image"
              className="w-full text-[13px]"
            />
          </label>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <DrawablyButton
            seed={415}
            variant="solid"
            state={busy ? 'loading' : 'idle'}
            disabled={busy || !series.trim()}
            className="text-[13px]"
          >
            {busy ? 'Adding' : 'Add wish'}
          </DrawablyButton>
          <span className="text-[12px]" style={{ color: 'var(--text-3)' }}>
            Only the series is required.
          </span>
        </div>
      </form>

      {available.length > 0 && (
        <Section title="Arrived in Drive" tone="accent">
          {available.map((w) => (
            <Row key={w.id} wish={w} onStatus={onStatus} onOpenMatch={onOpenMatch} />
          ))}
        </Section>
      )}

      <Section title={`Wanted (${wanted.length})`}>
        {wanted.length === 0 ? (
          <p className="pen py-8 text-center text-[16px]" style={{ color: 'var(--text-3)' }}>
            Nothing on the wishlist.
          </p>
        ) : (
          wanted.map((w) => (
            <Row key={w.id} wish={w} onStatus={onStatus} onOpenMatch={onOpenMatch} />
          ))
        )}
      </Section>

      {rest.length > 0 && (
        <Section title="Closed">
          {rest.map((w) => (
            <Row key={w.id} wish={w} onStatus={onStatus} onOpenMatch={onOpenMatch} />
          ))}
        </Section>
      )}
    </div>
  )
}

function Section({
  title,
  tone,
  children,
}: {
  title: string
  tone?: 'accent'
  children: React.ReactNode
}) {
  return (
    <section className="mb-8">
      <h3
        className="mb-2 text-[13px] font-medium"
        style={{ color: tone === 'accent' ? 'var(--accent)' : 'var(--text-2)' }}
      >
        {title}
      </h3>
      <div className="divide-y" style={{ borderColor: 'var(--hairline)' }}>
        {children}
      </div>
    </section>
  )
}

function Row({
  wish,
  onStatus,
  onOpenMatch,
}: {
  wish: Wish
  onStatus: (id: string, status: Wish['status']) => void
  onOpenMatch: (comicId: string) => void
}) {
  const meta = [wish.publisher, wish.year, wish.issue ? `#${wish.issue}` : null]
    .filter(Boolean)
    .join('  ·  ')

  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium" style={{ color: 'var(--text)' }}>
          {wish.series ?? wish.query}
        </div>
        <div className="tnum text-[11px]" style={{ color: 'var(--text-3)' }}>
          {meta || 'no other details'}
          <span> · added {relativeTime(wish.created_at)}</span>
        </div>
      </div>

      {wish.status === 'available' ? (
        <DrawablyBadge seed={seedFrom(wish.id)} className="text-[11px]" style={{ color: 'var(--accent)' }}>
          {STATUS_LABEL[wish.status]}
        </DrawablyBadge>
      ) : (
        <span className="text-[12px]" style={{ color: 'var(--text-3)' }}>
          {STATUS_LABEL[wish.status]}
        </span>
      )}

      {wish.status === 'available' && wish.matched_comic_id && (
        <DrawablyButton
          seed={seedFrom(wish.id + 'open')}
          variant="solid"
          onClick={() => onOpenMatch(wish.matched_comic_id!)}
          className="text-[12px]"
        >
          Open
        </DrawablyButton>
      )}

      {(wish.status === 'wanted' || wish.status === 'available') && (
        <>
          <DrawablyButton
            seed={seedFrom(wish.id + 'ful')}
            tone="neutral"
            onClick={() => onStatus(wish.id, 'fulfilled')}
            className="text-[12px]"
          >
            Got it
          </DrawablyButton>
          <DrawablyButton
            seed={seedFrom(wish.id + 'drop')}
            tone="neutral"
            onClick={() => onStatus(wish.id, 'dropped')}
            className="text-[12px]"
          >
            Drop
          </DrawablyButton>
        </>
      )}
    </div>
  )
}
