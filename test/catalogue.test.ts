import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

// config reads the environment at import time, so it must be set before any
// module under test is loaded.
const work = mkdtempSync(join(tmpdir(), 'comics-sidecar-'))
process.env.CS_VOLUME = work
process.env.CS_DB_PATH = join(work, 'comics.db')
process.env.CS_LIBRARY_ROOT = join(work, 'library')
process.env.CS_STAGING_DIR = join(work, 'staging')
process.env.CS_TMPDIR = join(work, 'tmp')

const { applyIndex } = await import('../src/server/drive/indexSync.ts')
const { getDb, closeDb } = await import('../src/server/db/index.ts')
const { listCatalogue, listSeriesGroups, getComic } = await import('../src/server/catalogue.ts')
const { setReadingStatus } = await import('../src/server/progress.ts')
const { evictCandidates } = await import('../src/server/cache/evict.ts')
const { reconcileLocal, destinationFor } = await import('../src/server/cache/fetch.ts')
const { addWish, listWishes } = await import('../src/server/wishlist.ts')

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/drive-index.json', import.meta.url), 'utf8'),
)
const EXTS = ['.cbz', '.cbr', '.cb7', '.cbt']
const entries = fixture.filter((f: any) => EXTS.some((e) => f.Name.toLowerCase().endsWith(e)))

before(() => {
  mkdirSync(process.env.CS_LIBRARY_ROOT!, { recursive: true })
  getDb() // runs migrations
})

after(() => {
  closeDb()
  rmSync(work, { recursive: true, force: true })
})

test('migrations create the schema with the Notion seam present', () => {
  const cols = getDb()
    .prepare("SELECT name FROM pragma_table_info('comic')")
    .all()
    .map((r: any) => String(r.name))
  for (const c of ['id', 'komga_id', 'komga_series_id', 'notion_page_id', 'drive_id']) {
    assert.ok(cols.includes(c), `comic.${c} missing`)
  }
})

test('indexing the real Drive listing populates the catalogue', () => {
  const r = applyIndex(entries)
  assert.equal(r.filesSeen, 21)
  assert.equal(r.added, 21)
  assert.equal(r.updated, 0)
  assert.equal(listCatalogue().length, 21)
})

test('re-indexing is idempotent and mints no new ids', () => {
  const before = listCatalogue().map((c) => c.id).sort()
  const r = applyIndex(entries)
  assert.equal(r.added, 0)
  assert.equal(r.updated, 21)
  assert.deepEqual(listCatalogue().map((c) => c.id).sort(), before)
})

test('a file renamed in Drive keeps its internal id', () => {
  const target = entries.find((e: any) => e.Name.startsWith('Absolute Batman'))
  const before = listCatalogue().find((c) => c.fileName === target.Name)!
  const renamed = entries.map((e: any) =>
    e.ID === target.ID
      ? { ...e, Name: 'Absolute Batman v01 - The Zoo (2025) (Digital) (Renamed).cbr',
          Path: 'DC/Absolute Universe/Absolute Batman v01 - The Zoo (2025) (Digital) (Renamed).cbr' }
      : e,
  )
  const r = applyIndex(renamed)
  assert.equal(r.added, 0, 'rename must not create a second row')
  const after = getComic(before.id)!
  assert.equal(after.fileName, 'Absolute Batman v01 - The Zoo (2025) (Digital) (Renamed).cbr')
  applyIndex(entries) // restore
})

test('a file removed from Drive is flagged, not deleted', () => {
  const subset = entries.filter((e: any) => !e.Name.startsWith('Wolverine'))
  const r = applyIndex(subset)
  assert.equal(r.missing, 1)
  assert.equal(listCatalogue().length, 20, 'missing rows are hidden by default')
  assert.equal(listCatalogue({ includeMissing: true }).length, 21, 'but the row survives')
  applyIndex(entries)
  assert.equal(listCatalogue().length, 21, 'and comes back when Drive does')
})

test('series grouping keeps the three Absolute titles apart', () => {
  const groups = listSeriesGroups()
  const names = groups.map((g) => g.series)
  for (const n of ['Absolute Batman', 'Absolute Superman', 'Absolute Wonder Woman']) {
    assert.ok(names.includes(n), `missing group ${n}`)
  }
  const alias = groups.find((g) => g.series === 'Jessica Jones - Alias')!
  assert.equal(alias.count, 4, 'the four Alias volumes group together')
})

test('eviction ranks abandoned first and protects in-progress and pinned', () => {
  const db = getDb()
  const all = listCatalogue()
  const pick = (n: string) => all.find((c) => c.fileName.startsWith(n))!

  const abandoned = pick('Absolute Batman')
  const finished = pick('Absolute Superman')
  const reading = pick('Absolute Wonder Woman')
  const unread = pick('Batman - 80 Years')
  const pinned = pick('Green Arrow')

  // Everything is local and old enough to be eligible.
  const old = new Date(Date.now() - 30 * 86400_000).toISOString()
  for (const c of [abandoned, finished, reading, unread, pinned]) {
    db.prepare(
      "UPDATE comic SET local_state = 'local', local_path = ?, fetched_at = ? WHERE id = ?",
    ).run(join(process.env.CS_LIBRARY_ROOT!, c.fileName), old, c.id)
  }
  db.prepare('UPDATE comic SET pinned = 1 WHERE id = ?').run(pinned.id)

  setReadingStatus(abandoned.id, 'abandoned')
  setReadingStatus(finished.id, 'finished')

  const yesterday = new Date(Date.now() - 86400_000).toISOString()
  db.prepare(
    `INSERT INTO komga_progress (comic_id, komga_book_id, page, pages_count, completed, read_date, synced_at)
     VALUES (?, 'k1', 40, 200, 0, ?, ?)`,
  ).run(reading.id, yesterday, new Date().toISOString())

  const cands = evictCandidates()
  const ids = cands.map((c) => c.id)

  assert.ok(!ids.includes(pinned.id), 'pinned must never be a candidate')
  assert.equal(ids[0], abandoned.id, 'abandoned evicts first')
  assert.ok(
    ids.indexOf(finished.id) < ids.indexOf(unread.id),
    'finished evicts before never-opened',
  )
  assert.equal(ids[ids.length - 1], reading.id, 'actively-read evicts last')
})

test('a freshly fetched title is not immediately evictable', () => {
  const db = getDb()
  const c = listCatalogue().find((x) => x.fileName.startsWith('Green Lantern'))!
  db.prepare(
    "UPDATE comic SET local_state = 'local', local_path = ?, fetched_at = ? WHERE id = ?",
  ).run(join(process.env.CS_LIBRARY_ROOT!, c.fileName), new Date().toISOString(), c.id)
  assert.ok(!evictCandidates().some((x) => x.id === c.id), 'anti-thrash floor should exclude it')
})

test('a wish flips to available when a matching comic appears', () => {
  // Index without the Wolverine title, then wish for it.
  applyIndex(entries.filter((e: any) => !e.Name.startsWith('Wolverine')))
  const id = addWish('Wolverine')
  assert.equal(listWishes().find((w) => w.id === id)!.status, 'wanted')

  applyIndex(entries) // it shows up in Drive
  const w = listWishes().find((x) => x.id === id)!
  assert.equal(w.status, 'available')
  assert.ok(w.matched_comic_id, 'and is linked to the comic it matched')
})

test('reconcile repairs a stale local_path even when state is already local', () => {
  // Regression: moving the volume's in-container mount point left local_path
  // pointing at a path that no longer exists. Eviction deletes by that path,
  // and rmSync(force) succeeds silently on a missing path, so eviction would
  // report freeing bytes it never freed.
  const db = getDb()
  const c = listCatalogue().find((x) => x.fileName.startsWith('Wolverine'))!

  const dest = join(process.env.CS_LIBRARY_ROOT!, destinationFor({
    drive_path: c.drivePath,
    drive_bucket: c.driveBucket,
    file_name: c.fileName,
  } as never))
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, 'x')

  db.prepare(
    "UPDATE comic SET local_state = 'local', local_path = '/old/mount/does-not-exist.cbr' WHERE id = ?",
  ).run(c.id)

  const r = reconcileLocal()
  assert.ok(r.adopted >= 1, 'stale path should be repaired')
  const after = getComic(c.id)!
  assert.equal(after.localState, 'local')

  const path = db.prepare('SELECT local_path FROM comic WHERE id = ?').get(c.id) as { local_path: string }
  assert.equal(path.local_path, dest, 'local_path must point at the real file')
})
