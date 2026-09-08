/**
 * Drive -> SQLite index refresh.
 *
 * The catalogue UI reads SQLite only. Drive is contacted here and nowhere
 * else, on an hourly cron plus manual refresh, so browsing can never burn
 * Drive API quota no matter how the UI behaves.
 *
 * Identity: a file is matched by its Drive file id first, because that
 * survives renames and moves within Drive. Path is only a fallback for the
 * first sighting, or for a remote that does not report ids.
 */

import { listDrive, type DriveEntry } from './rclone.ts'
import { parseFilename } from '../parse/filename.ts'
import { getDb } from '../db/index.ts'
import { newId } from '../ids.ts'
import { matchWishlist } from '../wishlist.ts'

export interface IndexResult {
  runId: number
  filesSeen: number
  added: number
  updated: number
  missing: number
  bytesTotal: number
  wishlistMatched: number
}

function splitPath(p: string): { bucket: string | null; folder: string | null } {
  const segs = p.split('/')
  if (segs.length === 1) return { bucket: null, folder: null }
  return { bucket: segs[0], folder: segs[segs.length - 2] }
}

export async function refreshIndex(trigger: 'cron' | 'manual' | 'startup' = 'manual'): Promise<IndexResult> {
  const db = getDb()
  const now = new Date().toISOString()

  const run = db
    .prepare(`INSERT INTO index_run (trigger, started_at, status) VALUES (?, ?, 'running')`)
    .run(trigger, now)
  const runId = Number(run.lastInsertRowid)

  try {
    const entries = await listDrive()
    const result = applyIndex(entries, now)

    db.prepare(
      `UPDATE index_run SET finished_at = ?, status = 'ok', files_seen = ?,
         added = ?, updated = ?, missing = ?, bytes_total = ?
       WHERE id = ?`,
    ).run(
      new Date().toISOString(),
      result.filesSeen,
      result.added,
      result.updated,
      result.missing,
      result.bytesTotal,
      runId,
    )

    return { runId, ...result }
  } catch (err) {
    db.prepare(`UPDATE index_run SET finished_at = ?, status = 'error', error = ? WHERE id = ?`).run(
      new Date().toISOString(),
      (err as Error).message.slice(0, 1000),
      runId,
    )
    throw err
  }
}

/** Reconcile one Drive listing against the comic table. Exported for tests. */
export function applyIndex(entries: DriveEntry[], now = new Date().toISOString()) {
  const db = getDb()

  const byDriveId = db.prepare('SELECT id, drive_path FROM comic WHERE drive_id = ?')
  const byPath = db.prepare('SELECT id, drive_id FROM comic WHERE drive_path = ?')

  const insert = db.prepare(`
    INSERT INTO comic (
      id, drive_id, drive_path, drive_bucket, file_name, ext, size_bytes,
      drive_modified_at, parsed_series, parsed_title, parsed_issue,
      parsed_volume, parsed_year, parsed_publisher, parsed_kind,
      parsed_confidence, sort_key, first_seen_at, last_seen_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `)

  const update = db.prepare(`
    UPDATE comic SET
      drive_id = ?, drive_path = ?, drive_bucket = ?, file_name = ?, ext = ?,
      size_bytes = ?, drive_modified_at = ?, parsed_series = ?, parsed_title = ?,
      parsed_issue = ?, parsed_volume = ?, parsed_year = ?, parsed_publisher = ?,
      parsed_kind = ?, parsed_confidence = ?, sort_key = ?,
      last_seen_at = ?, missing_from_drive = 0
    WHERE id = ?
  `)

  let added = 0
  let updated = 0
  let bytesTotal = 0

  // Presence is tracked by collecting the ids this run touched, not by
  // comparing last_seen_at against the run timestamp: ISO timestamps are
  // millisecond-precision, so two refreshes in the same millisecond would
  // compare equal and silently mark nothing missing.
  db.exec('CREATE TEMP TABLE IF NOT EXISTS seen_this_run (id TEXT PRIMARY KEY)')
  db.exec('DELETE FROM seen_this_run')
  const markSeen = db.prepare('INSERT OR IGNORE INTO seen_this_run (id) VALUES (?)')

  db.exec('BEGIN')
  try {
    for (const e of entries) {
      bytesTotal += e.Size
      const { bucket, folder } = splitPath(e.Path)
      const p = parseFilename(e.Name, bucket, folder)
      const ext = e.Name.slice(e.Name.lastIndexOf('.')).toLowerCase()

      const existing =
        (e.ID ? (byDriveId.get(e.ID) as { id: string } | undefined) : undefined) ??
        (byPath.get(e.Path) as { id: string } | undefined)

      const fields = [
        e.ID ?? null,
        e.Path,
        bucket,
        e.Name,
        ext,
        e.Size,
        e.ModTime ?? null,
        p.series,
        p.title,
        p.issue,
        p.volume,
        p.year,
        p.publisher,
        p.kind,
        p.confidence,
        p.sortKey,
      ] as const

      if (existing) {
        update.run(...fields, now, existing.id)
        markSeen.run(existing.id)
        updated++
      } else {
        const id = newId()
        insert.run(id, ...fields, now, now)
        markSeen.run(id)
        added++
      }
    }

    // Anything not touched by this run is gone from Drive. The row is kept --
    // it may hold reading history and a Notion id -- and only flagged.
    const missingRes = db
      .prepare(
        `UPDATE comic SET missing_from_drive = 1
          WHERE missing_from_drive = 0
            AND id NOT IN (SELECT id FROM seen_this_run)`,
      )
      .run()

    db.exec('COMMIT')

    // Runs here rather than in refreshIndex so the invariant holds for every
    // entry point: after any reconciliation, the wishlist reflects the
    // catalogue.
    const wishlistMatched = matchWishlist()

    return {
      filesSeen: entries.length,
      added,
      updated,
      missing: Number(missingRes.changes ?? 0),
      bytesTotal,
      wishlistMatched,
    }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
