/**
 * Catalogue queries.
 *
 * Everything the UI browses comes from here, and every query hits SQLite only.
 * No code path from a page render reaches Drive -- that is what keeps the
 * Drive API quota safe regardless of how the UI is written.
 */

import { getDb } from './db/index.ts'
import type { ReadingStatus } from './progress.ts'

export interface CatalogueItem {
  id: string
  drivePath: string
  driveBucket: string | null
  fileName: string
  ext: string
  sizeBytes: number
  series: string | null
  title: string | null
  issue: string | null
  volume: number | null
  year: number | null
  publisher: string | null
  kind: string | null
  confidence: number
  sortKey: string | null
  komgaId: string | null
  komgaSeriesId: string | null
  notionPageId: string | null
  localState: string
  pinned: boolean
  fetchedAt: string | null
  missingFromDrive: boolean
  readingStatus: ReadingStatus | null
  page: number | null
  pagesCount: number | null
  completed: boolean
  readDate: string | null
}

const SELECT = `
  SELECT c.id, c.drive_path, c.drive_bucket, c.file_name, c.ext, c.size_bytes,
         c.parsed_series, c.parsed_title, c.parsed_issue, c.parsed_volume,
         c.parsed_year, c.parsed_publisher, c.parsed_kind, c.parsed_confidence,
         c.sort_key, c.komga_id, c.komga_series_id, c.notion_page_id,
         c.local_state, c.pinned, c.fetched_at, c.missing_from_drive,
         rs.status      AS reading_status,
         kp.page        AS page,
         kp.pages_count AS pages_count,
         kp.completed   AS completed,
         kp.read_date   AS read_date
    FROM comic c
    LEFT JOIN reading_status rs ON rs.comic_id = c.id
    LEFT JOIN komga_progress kp ON kp.comic_id = c.id
`

function toItem(r: Record<string, unknown>): CatalogueItem {
  return {
    id: String(r.id),
    drivePath: String(r.drive_path),
    driveBucket: r.drive_bucket as string | null,
    fileName: String(r.file_name),
    ext: String(r.ext),
    sizeBytes: Number(r.size_bytes),
    series: r.parsed_series as string | null,
    title: r.parsed_title as string | null,
    issue: r.parsed_issue as string | null,
    volume: r.parsed_volume as number | null,
    year: r.parsed_year as number | null,
    publisher: r.parsed_publisher as string | null,
    kind: r.parsed_kind as string | null,
    confidence: Number(r.parsed_confidence ?? 0),
    sortKey: r.sort_key as string | null,
    komgaId: r.komga_id as string | null,
    komgaSeriesId: r.komga_series_id as string | null,
    notionPageId: r.notion_page_id as string | null,
    localState: String(r.local_state),
    pinned: Number(r.pinned) === 1,
    fetchedAt: r.fetched_at as string | null,
    missingFromDrive: Number(r.missing_from_drive) === 1,
    readingStatus: (r.reading_status as ReadingStatus | null) ?? null,
    page: r.page as number | null,
    pagesCount: r.pages_count as number | null,
    completed: Number(r.completed ?? 0) === 1,
    readDate: r.read_date as string | null,
  }
}

export interface CatalogueFilter {
  search?: string
  bucket?: string
  publisher?: string
  localState?: 'local' | 'remote'
  readingStatus?: ReadingStatus
  includeMissing?: boolean
}

export function listCatalogue(filter: CatalogueFilter = {}): CatalogueItem[] {
  const where: string[] = []
  const params: unknown[] = []

  if (!filter.includeMissing) where.push('c.missing_from_drive = 0')
  if (filter.bucket) {
    where.push('c.drive_bucket = ?')
    params.push(filter.bucket)
  }
  if (filter.publisher) {
    where.push('c.parsed_publisher = ?')
    params.push(filter.publisher)
  }
  if (filter.localState === 'local') where.push("c.local_state = 'local'")
  if (filter.localState === 'remote') where.push("c.local_state <> 'local'")
  if (filter.readingStatus) {
    where.push('rs.status = ?')
    params.push(filter.readingStatus)
  }
  if (filter.search) {
    where.push('(c.parsed_series LIKE ? OR c.file_name LIKE ?)')
    params.push(`%${filter.search}%`, `%${filter.search}%`)
  }

  const sql =
    SELECT +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY c.parsed_series COLLATE NOCASE, c.parsed_volume, c.parsed_year'

  const rows = getDb().prepare(sql).all(...(params as never[])) as unknown as Array<Record<string, unknown>>
  return rows.map(toItem)
}

export function getComic(id: string): CatalogueItem | null {
  const row = getDb().prepare(`${SELECT} WHERE c.id = ?`).get(id) as unknown as Record<string, unknown> | undefined
  return row ? toItem(row) : null
}

/** Catalogue grouped by parsed series -- the shape a grid of titles wants. */
export function listSeriesGroups(filter: CatalogueFilter = {}) {
  const items = listCatalogue(filter)
  const groups = new Map<string, { key: string; series: string; publisher: string | null; items: CatalogueItem[] }>()
  for (const it of items) {
    const key = it.sortKey ?? it.fileName
    let g = groups.get(key)
    if (!g) {
      g = { key, series: it.series ?? it.fileName, publisher: it.publisher, items: [] }
      groups.set(key, g)
    }
    g.items.push(it)
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      sizeBytes: g.items.reduce((n, i) => n + i.sizeBytes, 0),
      localCount: g.items.filter((i) => i.localState === 'local').length,
      count: g.items.length,
    }))
    .sort((a, b) => a.series.localeCompare(b.series))
}

export function setPinned(comicId: string, pinned: boolean): void {
  getDb().prepare('UPDATE comic SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, comicId)
}

export function lastIndexRun() {
  return getDb()
    .prepare('SELECT * FROM index_run ORDER BY id DESC LIMIT 1')
    .get() as unknown as Record<string, unknown> | undefined
}

export function recentJobs(limit = 25) {
  return getDb()
    .prepare('SELECT * FROM job ORDER BY id DESC LIMIT ?')
    .all(limit) as unknown as Array<Record<string, unknown>>
}
