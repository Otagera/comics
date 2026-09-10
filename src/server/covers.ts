/**
 * Cover thumbnails.
 *
 * Komga renders a thumbnail for every book it has, but the API needs an
 * X-API-Key the browser cannot send. Rather than proxying every <img> request
 * through the sidecar, each cover is fetched once and cached on the volume,
 * then served as a plain file. Covers therefore keep working while Komga is
 * restarting or down.
 *
 * Only *local* comics have a cover at all -- a remote title is a filename in
 * Drive, and nothing has ever opened it. The grid draws those as typographic
 * placeholders instead, which is also what carries the local/remote status
 * language in the UI.
 */

import { mkdirSync, existsSync, renameSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { config } from './config.ts'
import { getDb } from './db/index.ts'
import { rclone } from './drive/rclone.ts'

const exec = promisify(execFile)

export function coversDir(): string {
  return join(config.volume, 'sidecar-data', 'covers')
}

export function coverPath(comicId: string): string {
  return join(coversDir(), `${comicId}.jpg`)
}

export function hasCover(comicId: string): boolean {
  try {
    return statSync(coverPath(comicId)).size > 0
  } catch {
    return false
  }
}

/**
 * Fetch one book's thumbnail from Komga into the cache.
 *
 * Written to a temporary name and renamed into place so a half-downloaded
 * file is never served.
 */
export async function cacheCover(comicId: string, komgaBookId: string): Promise<boolean> {
  if (!config.komga.apiKey) return false
  const dir = coversDir()
  mkdirSync(dir, { recursive: true })

  const res = await fetch(`${config.komga.baseUrl}/api/v1/books/${komgaBookId}/thumbnail`, {
    headers: { 'X-API-Key': config.komga.apiKey },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) return false

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength === 0) return false

  const tmp = join(dir, `.${comicId}.tmp`)
  writeFileSync(tmp, buf)
  renameSync(tmp, coverPath(comicId))
  return true
}

export function dropCover(comicId: string): void {
  rmSync(coverPath(comicId), { force: true })
}

/**
 * Ensure every comic Komga knows about has a cached cover.
 *
 * Skips anything already cached, so the steady-state cost is one query and no
 * network calls at all.
 */
export async function syncCovers(force = false): Promise<{ fetched: number; failed: number }> {
  const rows = getDb()
    .prepare("SELECT id, komga_id FROM comic WHERE komga_id IS NOT NULL AND local_state = 'local'")
    .all() as unknown as Array<{ id: string; komga_id: string }>

  let fetched = 0
  let failed = 0
  for (const r of rows) {
    if (!force && hasCover(r.id)) continue
    try {
      if (await cacheCover(r.id, r.komga_id)) fetched++
      else failed++
    } catch {
      failed++
    }
  }
  return { fetched, failed }
}

/**
 * Comic ids that currently have a cached cover.
 *
 * Not restricted to cached comics: covers are now extracted from the head of
 * the Drive file too, so a remote title can have real art.
 */
export function cachedCoverIds(): Set<string> {
  const rows = getDb()
    .prepare('SELECT id FROM comic WHERE missing_from_drive = 0')
    .all() as unknown as Array<{ id: string }>
  const out = new Set<string>()
  for (const r of rows) if (hasCover(r.id)) out.add(r.id)
  return out
}

/**
 * Drop covers for comics that have gone from Drive entirely.
 *
 * Evicting a comic no longer drops its cover: the catalogue still shows every
 * title whether or not the file is cached, and re-extracting would mean
 * fetching from Drive again for no reason.
 */
export function pruneCovers(): number {
  if (!existsSync(coversDir())) return 0
  const gone = getDb()
    .prepare('SELECT id FROM comic WHERE missing_from_drive = 1')
    .all() as unknown as Array<{ id: string }>
  let removed = 0
  for (const r of gone) {
    if (hasCover(r.id)) {
      dropCover(r.id)
      removed++
    }
  }
  return removed
}


// -------------------------------------------------------- covers from Drive

const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i

/** Windows to try, in bytes. Most archives put the cover first; a few do not. */
const HEAD_WINDOWS = [4 * 1024 * 1024, 16 * 1024 * 1024]

/**
 * Pull a cover out of the archive itself, without downloading it.
 *
 * A comic's cover is already inside the file in Drive, so there is no need to
 * ask a third-party catalogue what this book looks like -- and no risk of
 * showing the wrong art, which is the failure mode of any fuzzy title match
 * against an external database.
 *
 * Only the first few megabytes are fetched. bsdtar (libarchive) reads RAR and
 * ZIP alike, so .cbr and .cbz take the same path, and it happily lists and
 * extracts entries from a truncated archive as long as the entry is complete
 * within the bytes we have.
 */
export async function coverFromDrive(comicId: string): Promise<boolean> {
  const row = getDb()
    .prepare('SELECT drive_path, file_name FROM comic WHERE id = ?')
    .get(comicId) as { drive_path: string; file_name: string } | undefined
  if (!row) return false

  mkdirSync(coversDir(), { recursive: true })
  const head = join(config.tmpDir, `cover-${comicId}.head`)

  try {
    for (const window of HEAD_WINDOWS) {
      await rclone(
        ['cat', '--count', String(window), `${config.drive.remote}/${row.drive_path}`],
        { timeoutMs: 5 * 60_000, outFile: head },
      )

      let entries: string[] = []
      try {
        const { stdout: listing } = await exec('bsdtar', ['-tf', head], {
          maxBuffer: 8 * 1024 * 1024,
        })
        entries = listing.split('\n').map((l) => l.trim()).filter((l) => IMAGE_EXT.test(l))
      } catch {
        entries = []
      }
      if (!entries.length) continue

      // Archive order is not page order, so take the lowest-numbered page
      // present rather than whichever entry happens to come first.
      entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      const first = entries[0]

      try {
        const { stdout: bytes } = await exec('bsdtar', ['-xOf', head, first], {
          maxBuffer: 64 * 1024 * 1024,
          encoding: 'buffer',
        } as never)
        const buf = bytes as unknown as Buffer
        if (!buf?.length) continue
        // Refuse anything that is not actually an image.
        const magic = buf.subarray(0, 4).toString('hex')
        const looksRight =
          magic.startsWith('ffd8ff') || magic.startsWith('89504e47') ||
          magic.startsWith('52494646') || magic.startsWith('47494638')
        if (!looksRight) continue

        const tmp = join(coversDir(), `.${comicId}.tmp`)
        writeFileSync(tmp, buf)
        renameSync(tmp, coverPath(comicId))
        return true
      } catch {
        continue
      }
    }
    return false
  } finally {
    rmSync(head, { force: true })
  }
}

export interface CoverBackfill {
  attempted: number
  extracted: number
  failed: number
}

/**
 * Fill in covers for everything that has none.
 *
 * Komga's own thumbnail is preferred when the comic is cached locally -- it is
 * already generated and costs nothing -- so this only reaches for Drive when
 * there is no other source.
 */
export async function backfillCovers(limit = 500): Promise<CoverBackfill> {
  const rows = getDb()
    .prepare('SELECT id FROM comic WHERE missing_from_drive = 0 ORDER BY parsed_series')
    .all() as unknown as Array<{ id: string }>

  const out: CoverBackfill = { attempted: 0, extracted: 0, failed: 0 }
  for (const r of rows) {
    if (out.attempted >= limit) break
    if (hasCover(r.id)) continue
    out.attempted++
    try {
      if (await coverFromDrive(r.id)) out.extracted++
      else out.failed++
    } catch {
      out.failed++
    }
  }
  return out
}
