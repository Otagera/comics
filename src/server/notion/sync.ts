/**
 * One-way sync: Vault -> Notion. Nothing is ever read back into Vault.
 *
 * Vault writes exactly four properties -- Name (on creation only), Type,
 * Status and Completed Date. Author, Rating, Description and Link are the
 * user's and are never included in any payload this module builds.
 *
 * Identity is `notion_page_id`. Once a row is linked, that id is the only
 * thing used to find it again, which is what lets the user rename a row in
 * Notion without the sync reverting the name or creating a duplicate. Fuzzy
 * name matching exists solely to adopt *unlinked* rows the first time.
 */

import { getDb } from '../db/index.ts'
import { normaliseKey } from '../parse/filename.ts'
import { canonicalName } from '../naming.ts'
import {
  notionConfig,
  listRows,
  describeDatabase,
  createRow,
  updateRow,
  type NotionRow,
  type NotionConfig,
} from './client.ts'

export const NOTION_TYPE = 'Comics'

export type NotionStatus = 'Not bought' | 'Not started' | 'In progress' | 'Done' | 'Dropped'

/** Rows whose Type we are willing to adopt. Never a book or an article. */
function isAdoptable(row: NotionRow): boolean {
  const t = (row.type ?? '').trim().toLowerCase()
  // Untyped rows are fair game -- a hand-kept read log often has no Type set --
  // but anything explicitly typed as something else is left alone.
  return t === '' || t === NOTION_TYPE.toLowerCase()
}

export interface VaultComic {
  id: string
  series: string | null
  issue: string | null
  volume: number | null
  year: number | null
  notion_page_id: string | null
  reading_status: string | null
  completed: number
  page: number | null
  read_date: string | null
}

/**
 * Vault state -> Notion status.
 *
 * Everything in this table is "in Drive", so the floor is "Not started";
 * "Not bought" belongs only to wishlist entries, which have no file at all.
 */
export function statusForComic(c: VaultComic): NotionStatus {
  if (c.reading_status === 'finished' || c.completed === 1) return 'Done'
  if (c.reading_status === 'abandoned') return 'Dropped'
  if (c.reading_status === 'reading' || (c.page ?? 0) > 0) return 'In progress'
  return 'Not started' // includes an explicit want-to-read: it is in Drive
}

/** The date to write into Completed Date, or null when not finished. */
export function completedDateFor(c: VaultComic): string | null {
  if (statusForComic(c) !== 'Done') return null
  const d = c.read_date ? new Date(c.read_date) : new Date()
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

export interface MatchCandidate {
  comicId: string
  comicName: string
  notionPageId: string
  notionName: string
  notionStatus: string | null
  score: number
}

/**
 * Score an unlinked Notion row against a Vault title.
 *
 * Conservative on purpose: the read log is hand-typed, and a wrong link is
 * worse than no link because it silently rewrites the wrong row's status.
 * Returns 0 when the two should not be considered a pair at all.
 */
export function matchScore(vaultSeries: string, notionName: string): number {
  const a = normaliseKey(vaultSeries)
  const b = normaliseKey(notionName)
  if (!a || !b) return 0
  if (a === b) return 1

  const aw = new Set(a.split(' ').filter(Boolean))
  const bw = new Set(b.split(' ').filter(Boolean))
  if (aw.size === 0 || bw.size === 0) return 0

  // One name containing the other is the common real case:
  // "Saga" vs "Saga vol 1", "Jessica Jones - Alias" vs "Alias".
  if (b.startsWith(a + ' ') || a.startsWith(b + ' ')) return 0.9

  let shared = 0
  for (const w of aw) if (bw.has(w)) shared++
  const overlap = shared / Math.min(aw.size, bw.size)

  // A single shared common word is not a match; demand real overlap.
  if (shared === 0 || overlap < 0.6) return 0
  return Math.min(0.85, 0.5 + overlap * 0.35)
}

function loadComics(): VaultComic[] {
  return getDb()
    .prepare(
      `SELECT c.id, c.parsed_series AS series, c.parsed_issue AS issue,
              c.parsed_volume AS volume, c.parsed_year AS year,
              c.notion_page_id, rs.status AS reading_status,
              COALESCE(kp.completed, 0) AS completed, kp.page, kp.read_date
         FROM comic c
         LEFT JOIN reading_status rs ON rs.comic_id = c.id
         LEFT JOIN komga_progress kp ON kp.comic_id = c.id
        WHERE c.missing_from_drive = 0`,
    )
    .all() as unknown as VaultComic[]
}

/**
 * Propose links between unlinked Vault titles and unlinked Notion rows.
 *
 * Nothing is written. The read log is human, so the pairs are shown for
 * confirmation rather than applied automatically.
 */
export async function proposeLinks(minScore = 0.6): Promise<MatchCandidate[]> {
  const cfg = notionConfig()
  if (!cfg) throw new Error('NOTION_TOKEN / NOTION_DATABASE_ID are not set')

  const rows = (await listRows(cfg)).filter(isAdoptable)
  const linked = new Set(
    (getDb().prepare('SELECT notion_page_id FROM comic WHERE notion_page_id IS NOT NULL').all() as
      unknown as Array<{ notion_page_id: string }>).map((r) => r.notion_page_id),
  )
  const free = rows.filter((r) => !linked.has(r.id))

  const out: MatchCandidate[] = []
  for (const c of loadComics()) {
    if (c.notion_page_id) continue
    const name = canonicalName(c)
    let best: { row: NotionRow; score: number } | null = null
    for (const r of free) {
      const score = matchScore(c.series ?? name, r.name)
      if (score >= minScore && (!best || score > best.score)) best = { row: r, score }
    }
    if (best) {
      out.push({
        comicId: c.id,
        comicName: name,
        notionPageId: best.row.id,
        notionName: best.row.name,
        notionStatus: best.row.status,
        score: Number(best.score.toFixed(2)),
      })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}

/** Store confirmed links. Never renames the Notion row. */
export function confirmLinks(pairs: Array<{ comicId: string; notionPageId: string }>): number {
  const db = getDb()
  const stmt = db.prepare('UPDATE comic SET notion_page_id = ? WHERE id = ?')
  let n = 0
  db.exec('BEGIN')
  try {
    for (const p of pairs) {
      stmt.run(p.notionPageId, p.comicId)
      n++
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return n
}

export interface SyncResult {
  linked: number
  created: number
  updated: number
  wishesSynced: number
  skipped: number
}

/**
 * Push current Vault state into Notion.
 *
 * Order matters. For anything not yet linked we look for an adoptable,
 * unlinked row that fuzzy-matches *before* creating anything -- that is the
 * rule that stops the read log filling with duplicates as files arrive.
 *
 * Notion rows with no corresponding file are left completely alone. A row
 * marked Done with nothing in Drive is a book the user read and does not
 * currently hold; it is valid data, not an error to reconcile away.
 */
export async function syncToNotion(opts: { autoLink?: boolean } = {}): Promise<SyncResult> {
  const { autoLink = true } = opts
  const cfg = notionConfig()
  if (!cfg) throw new Error('NOTION_TOKEN / NOTION_DATABASE_ID are not set')

  const db = getDb()
  const schema = await describeDatabase(cfg)
  const rows = await listRows(cfg)
  const byId = new Map(rows.map((r) => [r.id, r]))

  const claimed = new Set<string>()
  for (const r of db
    .prepare('SELECT notion_page_id FROM comic WHERE notion_page_id IS NOT NULL')
    .all() as unknown as Array<{ notion_page_id: string }>) {
    claimed.add(r.notion_page_id)
  }
  for (const r of db
    .prepare('SELECT notion_page_id FROM wishlist WHERE notion_page_id IS NOT NULL')
    .all() as unknown as Array<{ notion_page_id: string }>) {
    claimed.add(r.notion_page_id)
  }

  const result: SyncResult = { linked: 0, created: 0, updated: 0, wishesSynced: 0, skipped: 0 }

  // ---- wishlist first, so a wish that just became available hands its page
  // id to the comic instead of the comic creating a second row.
  const wishes = db
    .prepare(
      `SELECT id, query, series, issue, year, status, matched_comic_id, notion_page_id
         FROM wishlist WHERE status IN ('wanted','available')`,
    )
    .all() as unknown as Array<Record<string, any>>

  for (const w of wishes) {
    let pageId: string | null = w.notion_page_id
    const name = w.query || canonicalName({ series: w.series, issue: w.issue, year: w.year })

    if (!pageId && autoLink) {
      const cand = rows
        .filter((r) => isAdoptable(r) && !claimed.has(r.id))
        .map((r) => ({ r, s: matchScore(w.series ?? name, r.name) }))
        .filter((x) => x.s >= 0.9)
        .sort((a, b) => b.s - a.s)[0]
      if (cand) {
        pageId = cand.r.id
        claimed.add(pageId)
        result.linked++
      }
    }

    if (!pageId) {
      const created = await createRow(cfg, schema, {
        name,
        type: NOTION_TYPE,
        status: 'Not bought',
      })
      pageId = created.id
      claimed.add(pageId)
      result.created++
    } else if (w.status === 'wanted') {
      await updateRow(cfg, schema, pageId, { type: NOTION_TYPE, status: 'Not bought' })
      result.updated++
    }

    db.prepare('UPDATE wishlist SET notion_page_id = ? WHERE id = ?').run(pageId, w.id)

    // The file arrived: the comic inherits this row rather than making a new one.
    if (w.matched_comic_id) {
      db.prepare(
        'UPDATE comic SET notion_page_id = ? WHERE id = ? AND notion_page_id IS NULL',
      ).run(pageId, w.matched_comic_id)
    }
    result.wishesSynced++
  }

  // ---- comics
  for (const c of loadComics()) {
    let pageId = (db.prepare('SELECT notion_page_id FROM comic WHERE id = ?').get(c.id) as any)
      ?.notion_page_id as string | null

    if (!pageId && autoLink) {
      const cand = rows
        .filter((r) => isAdoptable(r) && !claimed.has(r.id))
        .map((r) => ({ r, s: matchScore(c.series ?? '', r.name) }))
        .filter((x) => x.s >= 0.9)
        .sort((a, b) => b.s - a.s)[0]
      if (cand) {
        pageId = cand.r.id
        claimed.add(pageId)
        db.prepare('UPDATE comic SET notion_page_id = ? WHERE id = ?').run(pageId, c.id)
        result.linked++
      }
    }

    const status = statusForComic(c)
    const completedDate = completedDateFor(c)

    if (!pageId) {
      const created = await createRow(cfg, schema, {
        name: canonicalName(c),
        type: NOTION_TYPE,
        status,
        completedDate,
      })
      db.prepare('UPDATE comic SET notion_page_id = ? WHERE id = ?').run(created.id, c.id)
      claimed.add(created.id)
      result.created++
      continue
    }

    if (!byId.has(pageId)) {
      // Linked to a row that no longer exists, or is not shared with the
      // integration. Leave the id in place rather than guessing at a new one.
      result.skipped++
      continue
    }

    // Name is deliberately absent: a rename made in Notion must survive.
    await updateRow(cfg, schema, pageId, { type: NOTION_TYPE, status, completedDate })
    result.updated++
  }

  db.prepare(
    `INSERT INTO setting (key, value) VALUES ('notion_last_sync', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(new Date().toISOString())

  return result
}
