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
import { listBooks } from './komga/client.ts'

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
  const byPath = db.prepare('SELECT id FROM comic WHERE local_path IS NOT NULL AND local_path LIKE ?')

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
        // Fall back to the file path. b.url is absolute inside Komga's
        // container; our local_path is the host path. Compare the tail, which
        // is the part both agree on.
        const tail = b.url.replace(/^.*?\/data\//, '')
        row = byPath.get(`%/${tail}`) as { id: string } | undefined
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

  db.prepare(
    `INSERT INTO job (kind, status, detail, started_at, finished_at)
     VALUES ('progress_sync', 'ok', ?, ?, ?)`,
  ).run(`${updated} book(s), ${linked} newly linked`, now, new Date().toISOString())

  return { booksSeen: books.length, linked, updated }
}
