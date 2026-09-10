import { DrawablyCard } from 'drawably/react'

/**
 * A cover tile, carrying the whole status language.
 *
 *   local     real cover, full colour, lifted
 *   remote    the same cover, desaturated and stepped back to ~55%; or a
 *             hand-drawn card when no cover could be extracted at all
 *   fetching  teal "develops" up the tile like a print coming up in a tray
 *   progress  a thin sea-gradient line, only when actually part-read
 *
 * Covers come from Komga for cached titles and, for the rest, from the first
 * few megabytes of the Drive file itself -- so a remote title shows its own
 * real cover rather than art guessed from a title match. The sketch remains
 * for anything no cover could be pulled from; desaturation, not the presence
 * of art, is what says "not downloaded".
 */

export interface CoverItem {
  id: string
  series: string | null
  fileName: string
  volume: number | null
  year: number | null
  publisher: string | null
  localState: string
  hasCover: boolean
  page: number | null
  pagesCount: number | null
  completed: boolean
  pinned: boolean
}

/** Stable seed per title, so a comic's sketch is its own and never re-rolls. */
export function seedFrom(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function Cover({ item }: { item: CoverItem }) {
  const isLocal = item.localState === 'local'
  const isFetching = item.localState === 'fetching'
  const title = item.series ?? item.fileName
  const progress =
    item.pagesCount && item.page && item.page > 0 && !item.completed
      ? Math.min(100, (item.page / item.pagesCount) * 100)
      : 0

  return (
    <div
      className={[
        'cover',
        !isLocal && !isFetching ? 'cover-remote' : '',
        isFetching ? 'cover-developing' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {item.hasCover ? (
        <img
          src={`/covers/${item.id}.jpg`}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      ) : (
        <Sketched title={title} item={item} />
      )}

      {item.pinned && (
        <div
          className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full"
          style={{ background: 'var(--panel-strong)', border: '1px solid var(--hairline)' }}
          title="Pinned — never evicted"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--accent)' }}>
            <path d="M9 2h6l-1 6 4 3v2h-5v7l-1 2-1-2v-7H6v-2l4-3-1-6Z" />
          </svg>
        </div>
      )}

      {progress > 0 && (
        <div className="absolute inset-x-0 bottom-0 p-1.5">
          <div className="progress-line" style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  )
}

function Sketched({ title, item }: { title: string; item: CoverItem }) {
  const seed = seedFrom(item.id)

  return (
    // boil is off in the grid: twenty-odd tiles all wobbling at once is noise,
    // not charm. The interactive controls keep their boil.
    <DrawablyCard seed={seed} boil={0} roughness={1.1} className="h-full w-full">
      <div className="sketch-tile">
        <div
          className="pen text-[15px] leading-tight"
          style={{
            color: 'var(--text)',
            display: '-webkit-box',
            WebkitLineClamp: 5,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {title}
        </div>
        <div className="pen text-[12px]" style={{ color: 'var(--text-2)' }}>
          {[item.volume ? `v${String(item.volume).padStart(2, '0')}` : null, item.year]
            .filter(Boolean)
            .join('  ')}
          {item.publisher ? <div>{item.publisher}</div> : null}
        </div>
      </div>
    </DrawablyCard>
  )
}
