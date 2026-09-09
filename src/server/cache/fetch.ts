/**
 * Fetch a title from Drive into Komga's library.
 *
 * The sequence is cxsync's, with the ComiXed three-call session dance replaced
 * by a Komga scan:
 *
 *   budget check -> evict if needed -> rclone into staging -> verify size
 *   -> atomic rename into the library -> Komga scan -> confirm the book exists
 *
 * Two properties matter and are load-bearing:
 *
 *  - Staging lives on the same filesystem as the library, so the final move is
 *    a rename. Komga's scanner never sees a partially written archive.
 *  - The destination directory is named for the *parsed* series, not Drive's
 *    folder, because Komga derives series names from directory structure.
 */

import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { config } from '../config.ts'
import { getDb } from '../db/index.ts'
import { copyFromDrive } from '../drive/rclone.ts'
import { libraryRelPath, parseFilename } from '../parse/filename.ts'
import { evict } from './evict.ts'
import { shortfallFor, humanBytes, volumeUsage } from './volume.ts'
import { scanLibrary, waitForBook } from '../komga/client.ts'

export interface FetchResult {
  comicId: string
  fileName: string
  relPath: string
  bytes: number
  komgaId: string | null
  komgaSeriesId: string | null
  evicted: string[]
  status: 'fetched' | 'already-local' | 'placed-not-confirmed'
  detail: string
}

interface ComicRow {
  id: string
  drive_path: string
  drive_bucket: string | null
  file_name: string
  size_bytes: number
  local_state: string
  local_path: string | null
  parsed_series: string | null
  parsed_publisher: string | null
}

function loadComic(id: string): ComicRow {
  const row = getDb().prepare('SELECT * FROM comic WHERE id = ?').get(id) as unknown as ComicRow | undefined
  if (!row) throw new Error(`no comic with id ${id}`)
  return row
}

/** Destination inside the library root, derived from the parsed series. */
export function destinationFor(row: ComicRow): string {
  const segs = row.drive_path.split('/')
  const folder = segs.length > 1 ? segs[segs.length - 2] : null
  const parsed = parseFilename(row.file_name, row.drive_bucket, folder)
  return libraryRelPath(parsed, row.file_name)
}

export async function fetchComic(
  comicId: string,
  opts: { allowEvict?: boolean; onProgress?: (line: string) => void } = {},
): Promise<FetchResult> {
  const { allowEvict = true, onProgress } = opts
  const db = getDb()
  const row = loadComic(comicId)
  const startedAt = new Date().toISOString()

  const relPath = destinationFor(row)
  const destPath = join(config.libraryRoot, relPath)
  const komgaPath = `${config.libraryRootInKomga}/${relPath}`
  const evictedNames: string[] = []

  const job = db
    .prepare(
      `INSERT INTO job (kind, comic_id, status, detail, started_at)
       VALUES ('fetch', ?, 'running', ?, ?)`,
    )
    .run(comicId, relPath, startedAt)
  const jobId = Number(job.lastInsertRowid)

  const finish = (status: 'ok' | 'error', detail: string, bytes = 0) => {
    db.prepare('UPDATE job SET status = ?, detail = ?, bytes = ?, finished_at = ? WHERE id = ?').run(
      status,
      detail.slice(0, 1000),
      bytes,
      new Date().toISOString(),
      jobId,
    )
  }

  try {
    let alreadyLocal = false
    try {
      alreadyLocal = statSync(destPath).size === row.size_bytes
    } catch {
      alreadyLocal = false
    }

    if (!alreadyLocal) {
      // Make room before pulling anything down.
      const shortfall = shortfallFor(row.size_bytes)
      if (shortfall > 0) {
        if (!allowEvict) {
          throw new Error(
            `need ${humanBytes(shortfall)} more room and eviction is disabled`,
          )
        }
        const ev = evict({ needBytes: row.size_bytes, protectIds: [comicId] })
        evictedNames.push(...ev.evicted.map((e) => e.file_name))
        if (ev.freed < ev.shortfall) {
          throw new Error(
            `cannot free enough space: freed ${humanBytes(ev.freed)} of ${humanBytes(ev.shortfall)} needed`,
          )
        }
      }

      db.prepare("UPDATE comic SET local_state = 'fetching' WHERE id = ?").run(comicId)

      mkdirSync(config.stagingDir, { recursive: true })
      mkdirSync(dirname(destPath), { recursive: true })
      const staged = join(config.stagingDir, `${comicId}-${row.file_name}`)

      try {
        await copyFromDrive(row.drive_path, staged, onProgress)

        const actual = statSync(staged).size
        if (actual !== row.size_bytes) {
          throw new Error(`size mismatch: Drive reported ${row.size_bytes}, got ${actual}`)
        }

        // Same filesystem, so this is atomic: the scanner cannot observe a
        // half-written file.
        renameSync(staged, destPath)
      } catch (err) {
        rmSync(staged, { force: true })
        throw err
      }
    }

    const bytes = statSync(destPath).size
    const now = new Date().toISOString()
    db.prepare(
      `UPDATE comic SET local_state = 'local', local_path = ?, fetched_at = ?, evicted_at = NULL
       WHERE id = ?`,
    ).run(destPath, now, comicId)

    // Hand it to Komga and confirm, rather than trusting the 202.
    await scanLibrary()
    const book = await waitForBook(komgaPath)

    if (book) {
      db.prepare('UPDATE comic SET komga_id = ?, komga_series_id = ? WHERE id = ?').run(
        book.id,
        book.seriesId,
        comicId,
      )
      db.prepare(
        `INSERT INTO komga_progress (comic_id, komga_book_id, page, pages_count, completed, synced_at)
         VALUES (?, ?, 0, ?, 0, ?)
         ON CONFLICT(comic_id) DO UPDATE SET
           komga_book_id = excluded.komga_book_id,
           pages_count   = excluded.pages_count,
           synced_at     = excluded.synced_at`,
      ).run(comicId, book.id, book.media.pagesCount, now)

      finish('ok', `imported as ${book.id} (${book.media.pagesCount} pages)`, bytes)
      return {
        comicId,
        fileName: row.file_name,
        relPath,
        bytes,
        komgaId: book.id,
        komgaSeriesId: book.seriesId,
        evicted: evictedNames,
        status: alreadyLocal ? 'already-local' : 'fetched',
        detail: `${humanBytes(bytes)} placed, Komga book ${book.id}`,
      }
    }

    // On disk but Komga has not surfaced it yet. Not an error: the scan is
    // asynchronous and a large archive can outlast the wait window.
    finish('ok', 'placed; Komga had not confirmed the book within the wait window', bytes)
    return {
      comicId,
      fileName: row.file_name,
      relPath,
      bytes,
      komgaId: null,
      komgaSeriesId: null,
      evicted: evictedNames,
      status: 'placed-not-confirmed',
      detail: 'file is in the library; Komga is still scanning',
    }
  } catch (err) {
    db.prepare("UPDATE comic SET local_state = 'error' WHERE id = ?").run(comicId)
    finish('error', (err as Error).message)
    throw err
  }
}

/**
 * Reconcile recorded cache state against what is actually on disk.
 *
 * Runs before every maintenance pass. It makes the database follow the
 * filesystem rather than the other way round, which covers three cases the
 * fetch path alone cannot:
 *
 *  - a file put in the library by hand, or by an earlier tool, is adopted
 *  - a file deleted outside the sidecar stops being reported as cached
 *  - a lost or rebuilt database recovers its local state from the library
 *
 * Only the comic's own expected destination is checked, so this is an exact
 * path test per row, never a scan-and-guess.
 */
export function reconcileLocal(): { adopted: number; dropped: number } {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM comic WHERE missing_from_drive = 0')
    .all() as unknown as ComicRow[]

  let adopted = 0
  let dropped = 0
  const now = new Date().toISOString()

  for (const row of rows) {
    const destPath = join(config.libraryRoot, destinationFor(row))
    let onDisk = false
    try {
      onDisk = statSync(destPath).isFile()
    } catch {
      onDisk = false
    }

    if (onDisk && (row.local_state !== 'local' || row.local_path !== destPath)) {
      // The path is corrected even when the state is already 'local'. A stale
      // local_path is not cosmetic: eviction deletes by that path, and
      // rmSync(..., {force:true}) succeeds silently on a path that does not
      // exist -- so eviction would report freeing bytes it never freed and
      // leave the file on disk while the volume filled.
      db.prepare(
        `UPDATE comic SET local_state = 'local', local_path = ?, fetched_at = COALESCE(fetched_at, ?)
          WHERE id = ?`,
      ).run(destPath, now, row.id)
      adopted++
    } else if (!onDisk && row.local_state === 'local') {
      db.prepare(
        "UPDATE comic SET local_state = 'remote', local_path = NULL WHERE id = ?",
      ).run(row.id)
      dropped++
    }
  }

  return { adopted, dropped }
}

/** Volume + library summary for the catalogue's space visualisation. */
export function cacheSummary() {
  const db = getDb()
  const usage = volumeUsage()
  const agg = db
    .prepare(
      `SELECT
         COUNT(*)                                                   AS total,
         SUM(CASE WHEN local_state = 'local' THEN 1 ELSE 0 END)     AS local_count,
         COALESCE(SUM(CASE WHEN local_state = 'local' THEN size_bytes ELSE 0 END), 0) AS local_bytes,
         COALESCE(SUM(size_bytes), 0)                               AS archive_bytes,
         SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END)                AS pinned_count
       FROM comic
      WHERE missing_from_drive = 0`,
    )
    .get() as unknown as Record<string, number>

  return {
    usage,
    totalTitles: Number(agg.total ?? 0),
    localTitles: Number(agg.local_count ?? 0),
    localBytes: Number(agg.local_bytes ?? 0),
    archiveBytes: Number(agg.archive_bytes ?? 0),
    pinnedTitles: Number(agg.pinned_count ?? 0),
  }
}
