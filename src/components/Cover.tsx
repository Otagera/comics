/**
 * A cover tile, carrying the whole status language.
 *
 *   local     real thumbnail from Komga, full colour, lifted
 *   remote    typographic placeholder, desaturated and stepped back to ~55%
 *   fetching  teal "develops" up the tile like a print coming up in a tray
 *   progress  a thin sea-gradient line, only when actually part-read
 *
 * Remote titles genuinely have no cover art -- they are filenames in Drive
 * that nothing has opened -- so the placeholder is drawn from the parsed
 * metadata rather than faked. That is also what makes remote read as
 * "not here yet" without needing a badge to say so.
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

/** Stable per-title tint, kept inside the cool half of the wheel. */
function tintFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  // 168-232deg: teal through to blue-grey. Never warm -- warm was rejected.
  const hue = 168 + (h % 64)
  return `hsl(${hue} 22% 46%)`
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
      {isLocal && item.hasCover ? (
        <img
          src={`/covers/${item.id}.jpg`}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      ) : (
        <Placeholder title={title} item={item} />
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

function Placeholder({ title, item }: { title: string; item: CoverItem }) {
  const tint = tintFor(title)
  const initial = title.replace(/^(the|a|an)\s+/i, '').charAt(0).toUpperCase()

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ background: `color-mix(in srgb, ${tint} 16%, var(--panel-strong))` }}
    >
      {/* An oversized initial as quiet texture, so the grid is not a wall of
          identical rectangles. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-6 -right-3 select-none leading-none"
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: '9rem',
          color: tint,
          opacity: 0.16,
        }}
      >
        {initial}
      </span>

      <div className="relative flex h-full flex-col justify-between p-3">
        <div
          className="text-[13px] font-semibold leading-tight"
          style={{
            color: 'var(--text)',
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {title}
        </div>
        <div className="tnum text-[10px]" style={{ color: 'var(--text-2)' }}>
          {[item.volume ? `v${String(item.volume).padStart(2, '0')}` : null, item.year]
            .filter(Boolean)
            .join('  ')}
          {item.publisher ? <div className="mt-0.5">{item.publisher}</div> : null}
        </div>
      </div>
    </div>
  )
}
