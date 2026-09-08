/**
 * Wishlist: titles the user wants that are not in Drive yet.
 *
 * Matching runs after every index refresh. A wishlist entry flips to
 * 'available' as soon as a comic whose normalised series key matches appears
 * in the catalogue -- the user never has to re-check by hand.
 */

import { getDb } from './db/index.ts'
import { newId } from './ids.ts'
import { normaliseKey } from './parse/filename.ts'

export interface WishlistRow {
  id: string
  query: string
  norm_key: string
  series: string | null
  issue: string | null
  year: number | null
  publisher: string | null
  status: 'wanted' | 'available' | 'fulfilled' | 'dropped'
  matched_comic_id: string | null
  notion_page_id: string | null
  created_at: string
  matched_at: string | null
}

export function addWish(query: string, extra: Partial<Pick<WishlistRow, 'series' | 'issue' | 'year' | 'publisher'>> = {}): string {
  const db = getDb()
  const id = newId()
  db.prepare(
    `INSERT INTO wishlist (id, query, norm_key, series, issue, year, publisher, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    query,
    normaliseKey(extra.series ?? query),
    extra.series ?? null,
    extra.issue ?? null,
    extra.year ?? null,
    extra.publisher ?? null,
    new Date().toISOString(),
  )
  matchWishlist()
  return id
}

export function listWishes(status?: WishlistRow['status']): WishlistRow[] {
  const db = getDb()
  const sql = status
    ? 'SELECT * FROM wishlist WHERE status = ? ORDER BY created_at DESC'
    : 'SELECT * FROM wishlist ORDER BY created_at DESC'
  return (status ? db.prepare(sql).all(status) : db.prepare(sql).all()) as unknown as WishlistRow[]
}

export function setWishStatus(id: string, status: WishlistRow['status']): void {
  getDb().prepare('UPDATE wishlist SET status = ? WHERE id = ?').run(status, id)
}

/**
 * Flip every 'wanted' entry whose key now exists in the catalogue.
 *
 * Only entries still in 'wanted' are considered, so a user who explicitly
 * dropped or fulfilled something is never second-guessed by a later refresh.
 * Returns the number newly marked available.
 */
export function matchWishlist(): number {
  const db = getDb()
  const res = db
    .prepare(
      `UPDATE wishlist
          SET status = 'available',
              matched_at = ?,
              matched_comic_id = (
                SELECT c.id FROM comic c
                 WHERE c.sort_key = wishlist.norm_key
                   AND c.missing_from_drive = 0
                 ORDER BY c.parsed_year IS NULL, c.parsed_year, c.id
                 LIMIT 1
              )
        WHERE status = 'wanted'
          AND EXISTS (
                SELECT 1 FROM comic c
                 WHERE c.sort_key = wishlist.norm_key
                   AND c.missing_from_drive = 0
              )`,
    )
    .run(new Date().toISOString())
  return Number(res.changes ?? 0)
}
