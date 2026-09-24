/**
 * Reading state.
 *
 * Two distinct things live here and are deliberately not merged:
 *
 *  - `reading_status` is the user's own intent (want / reading / finished /
 *    abandoned). Komga has no notion of "abandoned", and giving up on a book
 *    is a decision, not a page count.
 *  - `komga_progress` mirrors what Komga observed: page, completed, readDate.
 *
 * The eviction scorer reads both, preferring the explicit status when set.
 */

import { getDb } from './db/index.ts'
import { listBooks, listSeries } from './komga/client.ts'
import { config } from './config.ts'

export type ReadingStatus = 'want' | 'reading' | 'finished' | 'abandoned'

export function setReadingStatus(comicId: string, status: ReadingStatus, note?: string): void {
  getDb()
    .prepare(
      `INSERT INTO reading_status (comic_id, status, set_at, note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(comic_id) DO UPDATE SET
         status = excluded.status, set_at = excluded.set_at, note = excluded.note`,
    )
    .run(comicId, status, new Date().toISOString(), note ?? null)
}

export function clearReadingStatus(comicId: string): void {
  getDb().prepare('DELETE FROM reading_status WHERE comic_id = ?').run(comicId)
}

export interface ProgressSyncResult {
  booksSeen: number
  linked: number
  updated: number
}

/**
 * Pull read progress for every book Komga knows about.
 *
 * Books are matched to catalogue rows by komga_id, which was recorded at fetch
 * time. Rows whose komga_id is missing -- a book imported into Komga by some
 * other route -- are linked by absolute path, still an exact match, never a
 * fuzzy title comparison.
 */
export async function syncProgress(): Promise<ProgressSyncResult> {
  const db = getDb()
  const books = await listBooks()
  const now = new Date().toISOString()

  const byKomgaId = db.prepare('SELECT id FROM comic WHERE komga_id = ?')
  const byLocalPath = db.prepare('SELECT id FROM comic WHERE local_path = ?')

  const upsert = db.prepare(
    `INSERT INTO komga_progress
       (comic_id, komga_book_id, page, pages_count, completed, read_date, last_modified, synced_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(comic_id) DO UPDATE SET
       komga_book_id = excluded.komga_book_id,
       page          = excluded.page,
       pages_count   = excluded.pages_count,
       completed     = excluded.completed,
       read_date     = excluded.read_date,
       last_modified = excluded.last_modified,
       synced_at     = excluded.synced_at`,
  )

  let linked = 0
  let updated = 0

  db.exec('BEGIN')
  try {
    for (const b of books) {
      let row = byKomgaId.get(b.id) as { id: string } | undefined

      if (!row) {
        // Fall back to the file path. b.url is absolute as Komga sees it
        // inside its own container; translating its library root to ours
        // yields the exact host path, so this is still an identity match and
        // never a fuzzy title comparison.
        const hostPath = b.url.startsWith(config.libraryRootInKomga)
          ? config.libraryRoot + b.url.slice(config.libraryRootInKomga.length)
          : null
        row = hostPath ? (byLocalPath.get(hostPath) as { id: string } | undefined) : undefined
        if (row) {
          db.prepare('UPDATE comic SET komga_id = ?, komga_series_id = ? WHERE id = ?').run(
            b.id,
            b.seriesId,
            row.id,
          )
          linked++
        }
      }

      if (!row) continue

      const p = b.readProgress
      upsert.run(
        row.id,
        b.id,
        p?.page ?? 0,
        b.media.pagesCount,
        p?.completed ? 1 : 0,
        p?.readDate ?? null,
        p?.lastModified ?? null,
        now,
      )
      updated++
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  // ---- bundles
  //
  // An unpacked bundle is a directory of issues, so no single Komga book
  // matches its catalogue row. Komga does make a *series* from that directory,
  // and its per-series counts are exactly the roll-up we need.
  const bundles = db
    .prepare(
      `SELECT id, komga_series_id, local_path FROM comic
        WHERE archive_kind = 'bundle' AND local_state = 'local'`,
    )
    .all() as unknown as Array<{ id: string; komga_series_id: string | null; local_path: string }>

  if (bundles.length) {
    let series: Awaited<ReturnType<typeof listSeries>> = []
    try {
      series = await listSeries()
    } catch {
      series = []
    }
    const byId = new Map(series.map((s) => [s.id, s]))
    const byUrl = new Map(series.map((s) => [s.url, s]))

    for (const b of bundles) {
      let s = b.komga_series_id ? byId.get(b.komga_series_id) : undefined
      if (!s && b.local_path?.startsWith(config.libraryRoot)) {
        // Not linked yet: translate the on-disk directory to Komga's view.
        const url = config.libraryRootInKomga + b.local_path.slice(config.libraryRoot.length)
        s = byUrl.get(url)
        if (s) {
          db.prepare('UPDATE comic SET komga_series_id = ? WHERE id = ?').run(s.id, b.id)
          linked++
        }
      }
      if (!s) continue

      // Issues read stands in for pages: it is what "how far through" means
      // for a run, and it drives the same Done / In progress / unread logic.
      const done = s.booksCount > 0 && s.booksReadCount === s.booksCount
      const page =
        s.booksReadCount > 0 ? s.booksReadCount : s.booksInProgressCount > 0 ? 1 : 0

      upsert.run(
        b.id,
        // No single book id applies; the series is the unit here.
        s.id,
        page,
        s.booksCount,
        done ? 1 : 0,
        null,
        null,
        now,
      )
      updated++
    }
  }

  db.prepare(
    `INSERT INTO job (kind, status, detail, started_at, finished_at)
     VALUES ('progress_sync', 'ok', ?, ?, ?)`,
  ).run(`${updated} book(s), ${linked} newly linked`, now, new Date().toISOString())

  return { booksSeen: books.length, linked, updated }
}
