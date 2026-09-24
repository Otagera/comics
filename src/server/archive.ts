/**
 * What shape is this archive?
 *
 * Not every `.zip` in the collection is a comic. Some are *bundles*: a folder
 * of individual issue archives zipped together. Komga makes a book out of one
 * and fails it with ERR_1006, so the catalogue must not offer it as a download
 * without knowing.
 *
 * The signal is free. Cover extraction already pulls the first few megabytes
 * and lists them with bsdtar; the same listing says whether the top level
 * holds images or archives. Even when an inner file's *data* is truncated, its
 * *name* is in the header, which is all the classification needs.
 */

export type ArchiveKind = 'comic' | 'bundle' | 'unknown'

const IMAGE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i
const ARCHIVE = /\.(cbz|cbr|cb7|cbt|zip|rar|7z)$/i
/** Sidecar files a release drops in beside the pages; never the deciding vote. */
const IGNORE = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)|\.(xml|txt|nfo|sfv|json|db)$/i

/**
 * Classify from a list of archive entries.
 *
 * Directories are skipped rather than counted: a bundle usually opens with one,
 * and so do plenty of ordinary comics that nest their pages in a folder.
 */
export function classifyEntries(entries: string[]): ArchiveKind {
  let images = 0
  let archives = 0

  for (const raw of entries) {
    const e = raw.trim()
    if (!e || e.endsWith('/')) continue
    if (IGNORE.test(e)) continue
    if (IMAGE.test(e)) images++
    else if (ARCHIVE.test(e)) archives++
  }

  // An archive holding other archives is a bundle even if a stray image (a
  // folder thumbnail, say) turned up alongside them.
  if (archives > 0 && archives >= images) return 'bundle'
  if (images > 0) return 'comic'
  return 'unknown'
}

/** Whether a kind is something Komga can open as a book. */
export function isReadableByKomga(kind: ArchiveKind | null): boolean {
  // `unknown` is treated as readable: it is usually a file whose first entries
  // simply did not fit the window, and refusing a download on a guess is worse
  // than letting Komga try.
  return kind !== 'bundle'
}
