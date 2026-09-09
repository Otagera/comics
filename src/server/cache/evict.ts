/**
 * Smart eviction.
 *
 * Replaces cxsync's atime heuristic. cxsync had to rank by file atime because
 * ComiXed records *that* a comic was read but never *when*. Komga exposes
 * readDate and lastModified on read progress, so the scorer can use real
 * reading state instead of guessing from filesystem metadata.
 *
 * Ranking, worst-to-keep first:
 *   abandoned  -- the user gave up on it; evict first
 *   finished   -- read to the end; unlikely to be reopened soon
 *   unread     -- fetched but never opened
 *   in progress-- actively being read; protect, more strongly the more recent
 *   pinned     -- never evicted, at any score
 *
 * Deleting a local file is safe: Drive holds the master, and because the Komga
 * library has emptyTrashAfterScan disabled, Komga keeps the book row and its
 * read history and simply marks it unavailable. Re-fetching restores it.
 */

import { rmSync, statSync } from 'node:fs'
import { getDb } from '../db/index.ts'
import { config } from '../config.ts'
import { volumeUsage, shortfallFor, humanBytes, type VolumeUsage } from './volume.ts'

export interface EvictCandidate {
  id: string
  file_name: string
  local_path: string
  size_bytes: number
  score: number
  reason: string
  status: string | null
  completed: number
  read_date: string | null
  fetched_at: string | null
}

/** Higher score = evict sooner. */
const BASE_SCORE: Record<string, number> = {
  abandoned: 1000,
  finished: 800,
  unread: 500,
  reading: 100,
  want: 400,
}

const DAY_MS = 86_400_000

/**
 * Candidates ordered most-evictable first.
 *
 * Pinned rows and anything fetched within minAgeHours are excluded outright --
 * the age floor is the anti-thrash guard carried over from cxsync, so a title
 * fetched minutes ago is never immediately reclaimed to make room for the next.
 */
export function evictCandidates(protectIds: string[] = []): EvictCandidate[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT c.id, c.file_name, c.local_path, c.size_bytes, c.fetched_at,
              rs.status            AS status,
              kp.completed         AS completed,
              kp.page              AS page,
              kp.pages_count       AS pages_count,
              kp.read_date         AS read_date
         FROM comic c
         LEFT JOIN reading_status rs ON rs.comic_id = c.id
         LEFT JOIN komga_progress kp ON kp.comic_id = c.id
        WHERE c.local_state = 'local'
          AND c.pinned = 0
          AND c.local_path IS NOT NULL`,
    )
    .all() as unknown as Array<Record<string, unknown>>

  const protect = new Set(protectIds)
  const now = Date.now()
  const minAgeMs = config.cache.minAgeHours * 3600_000

  const out: EvictCandidate[] = []

  for (const r of rows) {
    const id = String(r.id)
    if (protect.has(id)) continue

    const fetchedAt = r.fetched_at ? Date.parse(String(r.fetched_at)) : 0
    if (fetchedAt && now - fetchedAt < minAgeMs) continue // too fresh; would thrash

    const status = r.status ? String(r.status) : null
    const completed = Number(r.completed ?? 0)
    const page = Number(r.page ?? 0)
    const readDate = r.read_date ? String(r.read_date) : null

    // Derive an effective state: the user's explicit status wins, otherwise
    // infer from Komga's progress.
    let state: string
    if (status === 'abandoned' || status === 'finished') state = status
    else if (completed === 1) state = 'finished'
    else if (page > 0) state = 'reading'
    else if (status === 'reading') state = 'reading'
    else if (status === 'want') state = 'want'
    else state = 'unread'

    let score = BASE_SCORE[state] ?? 500
    const bits: string[] = [state]

    // Recency only protects things actually being read. A finished book read
    // yesterday is still a fine eviction target; an in-progress one is not.
    if (state === 'reading' && readDate) {
      const days = (now - Date.parse(readDate)) / DAY_MS
      if (Number.isFinite(days)) {
        // Read today -> -90; a month ago -> ~0. Never pushes score negative.
        const protection = Math.max(0, 90 - days * 3)
        score -= protection
        bits.push(`read ${days.toFixed(0)}d ago`)
      }
    } else if (readDate) {
      bits.push(`read ${((now - Date.parse(readDate)) / DAY_MS).toFixed(0)}d ago`)
    } else {
      // Never opened at all: nudge above an equally-scored title that was.
      score += 25
      bits.push('never opened')
    }

    // Break ties toward reclaiming more space per deletion.
    score += Math.min(50, Number(r.size_bytes) / (1024 * 1024 * 100))

    out.push({
      id,
      file_name: String(r.file_name),
      local_path: String(r.local_path),
      size_bytes: Number(r.size_bytes),
      score: Number(score.toFixed(2)),
      reason: bits.join(', '),
      status,
      completed,
      read_date: readDate,
      fetched_at: r.fetched_at ? String(r.fetched_at) : null,
    })
  }

  return out.sort((a, b) => b.score - a.score)
}

export interface EvictResult {
  freed: number
  evicted: EvictCandidate[]
  shortfall: number
  dryRun: boolean
  usage: VolumeUsage
}

/**
 * Free space until the volume is under budget and `needBytes` will fit.
 *
 * `needBytes` is the size of an incoming fetch; pass 0 for the routine
 * cron-driven trim.
 */
export function evict(
  opts: { needBytes?: number; protectIds?: string[]; dryRun?: boolean } = {},
): EvictResult {
  const { needBytes = 0, protectIds = [], dryRun = false } = opts
  const db = getDb()
  const usage = volumeUsage()
  const shortfall = shortfallFor(needBytes, usage)

  if (shortfall <= 0) {
    return { freed: 0, evicted: [], shortfall: 0, dryRun, usage }
  }

  const candidates = evictCandidates(protectIds)
  const chosen: EvictCandidate[] = []
  let freed = 0
  for (const c of candidates) {
    if (freed >= shortfall) break
    chosen.push(c)
    freed += c.size_bytes
  }

  if (dryRun) return { freed, evicted: chosen, shortfall, dryRun, usage }

  const now = new Date().toISOString()
  let actuallyFreed = 0
  const done: EvictCandidate[] = []

  for (const c of chosen) {
    try {
      // Trust the filesystem for the real size: the indexed size is Drive's.
      // If the file is not there, count zero bytes freed rather than the
      // indexed size -- rmSync(force) succeeds silently on a missing path, so
      // crediting Drive's size here would report space that was never
      // reclaimed and let the volume fill while eviction looked healthy.
      let realSize = 0
      try {
        realSize = statSync(c.local_path).size
      } catch {
        // Already gone, or local_path is stale. The row is still reconciled
        // below so the catalogue stops claiming the comic is cached.
      }
      rmSync(c.local_path, { force: true })
      db.prepare(
        `UPDATE comic
            SET local_state = 'remote', local_path = NULL, evicted_at = ?,
                evict_count = evict_count + 1
          WHERE id = ?`,
      ).run(now, c.id)
      db.prepare(
        `INSERT INTO job (kind, comic_id, status, detail, bytes, started_at, finished_at)
         VALUES ('evict', ?, 'ok', ?, ?, ?, ?)`,
      ).run(c.id, c.reason, realSize, now, now)
      actuallyFreed += realSize
      done.push(c)
    } catch (err) {
      db.prepare(
        `INSERT INTO job (kind, comic_id, status, detail, started_at, finished_at)
         VALUES ('evict', ?, 'error', ?, ?, ?)`,
      ).run(c.id, (err as Error).message.slice(0, 500), now, new Date().toISOString())
    }
  }

  return { freed: actuallyFreed, evicted: done, shortfall, dryRun, usage }
}

export function describeEviction(r: EvictResult): string {
  if (r.shortfall === 0) return 'under budget; nothing to evict'
  const verb = r.dryRun ? 'would free' : 'freed'
  return `${verb} ${humanBytes(r.freed)} of ${humanBytes(r.shortfall)} needed across ${r.evicted.length} title(s)`
}
