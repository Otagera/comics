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
  title?: string | null
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

const REJECTED_KEY = 'notion_rejected_links'

/**
 * Pairs a human has explicitly said are not the same thing.
 *
 * Persisted, because the link pass is run again every time new files land:
 * a rejection that only lived for one session would resurface the same wrong
 * suggestion forever. Stored in `setting` rather than a table -- it is a small
 * list of decisions, not a domain entity.
 */
function rejectedPairs(): Set<string> {
  const row = getDb().prepare('SELECT value FROM setting WHERE key = ?').get(REJECTED_KEY) as
    | { value: string }
    | undefined
  if (!row) return new Set()
  try {
    return new Set(JSON.parse(row.value) as string[])
  } catch {
    return new Set()
  }
}

export function rejectLink(comicId: string, notionPageId: string): void {
  const set = rejectedPairs()
  set.add(`${comicId}:${notionPageId}`)
  getDb()
    .prepare(
      `INSERT INTO setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(REJECTED_KEY, JSON.stringify([...set]))
}

export interface MatchCandidate {
  comicId: string
  comicName: string
  notionPageId: string
  notionName: string
  notionStatus: string | null
  score: number
  /** How many Vault titles wanted this same row. >1 means it is ambiguous. */
  contenders: number
}

/** Auto-linking during a sync demands near-certainty; the rest goes to a human. */
export const AUTO_LINK_MIN = 0.95

/**
 * How far along the reading journey each status sits.
 *
 * Notion is the user's read log and predates Vault, so it frequently knows
 * things Vault cannot: a title read years ago, or read on paper. Vault must
 * never move a row *backwards* -- it has no reading history for most rows and
 * would assert "Not started" over a "Done" the user typed themselves. Only
 * forward progress is written.
 */
const RANK: Record<string, number> = {
  'Not bought': 0,
  'Not started': 1,
  Paused: 2,
  'In progress': 3,
  Dropped: 4,
  Done: 5,
}

/**
 * The status to actually write, given what Notion already holds.
 *
 * Returns null when Vault has nothing to add, so the row is left untouched
 * rather than rewritten with the same value.
 */
export function statusToWrite(current: string | null, desired: NotionStatus): NotionStatus | null {
  if (!current) return desired
  if (current === desired) return null
  // Dropped is a deliberate decision either way round; only an explicit Vault
  // abandon sets it, and only the user can clear it.
  if (current === 'Dropped') return desired === 'Done' ? 'Done' : null
  const from = RANK[current]
  const to = RANK[desired]
  if (from === undefined) return null // an option this sync does not manage
  return to > from ? desired : null
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

/**
 * The key that decides what counts as one tracked thing.
 *
 * A numbered volume belongs to its series -- reading "Lost Girls" is one act,
 * not three -- while an unnumbered collected edition stands alone. That second
 * half matters: this archive holds two different Batman collections that share
 * the series name "Batman" and are separated only by their subtitles.
 */
export function workKey(c: VaultComic): string {
  const series = (c.series ?? '').trim().toLowerCase()
  if (c.volume != null) return `s:${series}`
  return `w:${series}|${(c.title ?? '').trim().toLowerCase()}|${c.year ?? ''}`
}

/** Display name for a work's row. Volumes are dropped; a subtitle is kept. */
export function workName(members: VaultComic[]): string {
  const first = members[0]
  const years = members.map((m) => m.year).filter((y): y is number => y != null)
  const year = years.length ? Math.min(...years) : null
  const series = (first.series ?? '').trim()
  if (first.volume != null) {
    // A series row: no volume number, because later volumes join this row.
    return year ? `${series} (${year})` : series
  }
  const title = (first.title ?? '').trim()
  const base = title ? `${series}: ${title}` : series
  return year ? `${base} (${year})` : base
}

export interface Work {
  key: string
  name: string
  members: VaultComic[]
  status: NotionStatus
  completedDate: string | null
  notionPageId: string | null
}

/**
 * Roll a work's volumes up into one status.
 *
 * Finished only when every volume is; any real engagement with any volume
 * makes the whole work "In progress", which is what a reader means when they
 * are three volumes into a five-volume run.
 */
export function rollUp(members: VaultComic[]): NotionStatus {
  const each = members.map(statusForComic)
  if (each.every((s) => s === 'Done')) return 'Done'
  if (each.some((s) => s === 'Done' || s === 'In progress')) return 'In progress'
  if (each.some((s) => s === 'Dropped')) return 'Dropped'
  return 'Not started'
}

export function loadWorks(): Work[] {
  const byKey = new Map<string, VaultComic[]>()
  for (const c of loadComics()) {
    const k = workKey(c)
    byKey.set(k, [...(byKey.get(k) ?? []), c])
  }
  const out: Work[] = []
  for (const [key, members] of byKey) {
    members.sort((a, b) => (a.volume ?? 0) - (b.volume ?? 0))
    const status = rollUp(members)
    const finished = members.filter((m) => statusForComic(m) === 'Done')
    const dates = finished.map(completedDateFor).filter((d): d is string => d != null)
    out.push({
      key,
      name: workName(members),
      members,
      status,
      // The work is finished when its last volume is.
      completedDate: status === 'Done' && dates.length ? dates.sort().at(-1)! : null,
      notionPageId: members.find((m) => m.notion_page_id)?.notion_page_id ?? null,
    })
  }
  return out
}

function loadComics(): VaultComic[] {
  return getDb()
    .prepare(
      `SELECT c.id, c.parsed_series AS series, c.parsed_title AS title,
              c.parsed_issue AS issue,
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
  const rejected = rejectedPairs()

  const out: MatchCandidate[] = []
  for (const w of loadWorks()) {
    if (w.notionPageId) continue
    // The representative carries the link for the whole work; confirmLinks
    // then writes the page id onto every volume in it.
    const rep = w.members[0]
    let best: { row: NotionRow; score: number } | null = null
    for (const r of free) {
      if (rejected.has(`${rep.id}:${r.id}`)) continue
      const score = matchScore(rep.series ?? w.name, r.name)
      if (score >= minScore && (!best || score > best.score)) best = { row: r, score }
    }
    if (best) {
      out.push({
        comicId: rep.id,
        comicName: w.members.length > 1 ? `${w.name}  (${w.members.length} volumes)` : w.name,
        notionPageId: best.row.id,
        notionName: best.row.name,
        notionStatus: best.row.status,
        score: Number(best.score.toFixed(2)),
        contenders: 1,
      })
    }
  }

  // A Notion row stands for one tracked thing, so it may be claimed by at most
  // one work. The best-scoring claimant keeps it; the rest are dropped and
  // will either match something else or wait for a human.
  const byPage = new Map<string, MatchCandidate[]>()
  for (const c of out) {
    byPage.set(c.notionPageId, [...(byPage.get(c.notionPageId) ?? []), c])
  }
  const resolved: MatchCandidate[] = []
  for (const [, list] of byPage) {
    list.sort((a, b) => b.score - a.score)
    list[0].contenders = list.length
    resolved.push(list[0])
  }
  return resolved.sort((a, b) => b.score - a.score || a.comicName.localeCompare(b.comicName))
}

/** Store confirmed links. Never renames the Notion row. */
export function confirmLinks(
  pairs: Array<{ comicId: string; notionPageId: string }>,
): { linked: number; refused: number } {
  const db = getDb()
  const works = loadWorks()
  const taken = db.prepare('SELECT id FROM comic WHERE notion_page_id = ? AND id <> ?')
  const set = db.prepare('UPDATE comic SET notion_page_id = ? WHERE id = ?')

  let linked = 0
  let refused = 0
  db.exec('BEGIN')
  try {
    for (const p of pairs) {
      const work = works.find((w) => w.members.some((m) => m.id === p.comicId))
      const members = work ? work.members : []
      if (!members.length) {
        refused++
        continue
      }
      // Refused rather than stolen: two works sharing a row means whichever
      // syncs last decides its status.
      const ids = new Set(members.map((m) => m.id))
      const other = taken.get(p.notionPageId, p.comicId) as { id: string } | undefined
      if (other && !ids.has(other.id)) {
        refused++
        continue
      }
      // Every volume of the work carries the same page id.
      for (const m of members) set.run(p.notionPageId, m.id)
      linked++
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { linked, refused }
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

  const rejected = rejectedPairs()
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
        .filter((x) => x.s >= AUTO_LINK_MIN)
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
      const cur = byId.get(pageId)?.status ?? null
      const next = statusToWrite(cur, 'Not bought')
      if (next) {
        await updateRow(cfg, schema, pageId, { type: NOTION_TYPE, status: next })
        result.updated++
      } else {
        result.skipped++
      }
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

  // ---- works (a series of volumes, or a standalone collected edition)
  for (const w of loadWorks()) {
    let pageId = w.notionPageId

    if (!pageId && autoLink) {
      const rep = w.members[0]
      const cand = rows
        .filter((r) => isAdoptable(r) && !claimed.has(r.id))
        .filter((r) => !rejected.has(`${rep.id}:${r.id}`))
        .map((r) => ({ r, s: matchScore(rep.series ?? '', r.name) }))
        .filter((x) => x.s >= AUTO_LINK_MIN)
        .sort((a, b) => b.s - a.s)[0]
      if (cand) {
        pageId = cand.r.id
        claimed.add(pageId)
        for (const m of w.members) {
          db.prepare('UPDATE comic SET notion_page_id = ? WHERE id = ?').run(pageId, m.id)
        }
        result.linked++
      }
    }

    if (!pageId) {
      // The tracker is a record of what has been read, not an inventory of
      // what is on disk. A work nobody has opened gets no row; it stays in
      // Vault until it is actually started, finished or abandoned.
      if (w.status === 'Not started') {
        result.skipped++
        continue
      }
      const created = await createRow(cfg, schema, {
        name: w.name,
        type: NOTION_TYPE,
        status: w.status,
        completedDate: w.completedDate,
      })
      for (const m of w.members) {
        db.prepare('UPDATE comic SET notion_page_id = ? WHERE id = ?').run(created.id, m.id)
      }
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
    const next = statusToWrite(byId.get(pageId)?.status ?? null, w.status)
    if (!next) {
      // Notion is already at or ahead of what Vault knows. Leave it alone --
      // overwriting here is what wiped hand-kept "Done" rows once already.
      result.skipped++
      continue
    }
    await updateRow(cfg, schema, pageId, {
      type: NOTION_TYPE,
      status: next,
      ...(next === 'Done' ? { completedDate: w.completedDate } : {}),
    })
    result.updated++
  }

  db.prepare(
    `INSERT INTO setting (key, value) VALUES ('notion_last_sync', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(new Date().toISOString())

  return result
}
