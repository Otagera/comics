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
import { join } from 'node:path'
import { config } from './config.ts'
import { getDb } from './db/index.ts'

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

/** Comic ids that currently have a cached cover, for the catalogue to mark up. */
export function cachedCoverIds(): Set<string> {
  const rows = getDb()
    .prepare("SELECT id FROM comic WHERE local_state = 'local'")
    .all() as unknown as Array<{ id: string }>
  const out = new Set<string>()
  for (const r of rows) if (hasCover(r.id)) out.add(r.id)
  return out
}

/** Drop cached covers whose comic no longer exists. */
export function pruneCovers(): number {
  if (!existsSync(coversDir())) return 0
  const ids = new Set(
    (getDb().prepare('SELECT id FROM comic').all() as unknown as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  )
  let removed = 0
  for (const id of ids) {
    // Covers for comics that are no longer cached locally are dropped: the
    // book may be gone from Komga entirely.
    const row = getDb().prepare('SELECT local_state FROM comic WHERE id = ?').get(id) as
      | { local_state: string }
      | undefined
    if (row && row.local_state !== 'local' && hasCover(id)) {
      dropCover(id)
      removed++
    }
  }
  return removed
}
