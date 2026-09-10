/**
 * Server functions -- the sidecar's entire API surface.
 *
 * TanStack Start server functions rather than a separate HTTP API: these are
 * the only entry points, they run on the server only, and the client calls
 * them as plain typed functions.
 *
 * Note what is absent by design. There is no endpoint that reads a comic's
 * pages, edits metadata, or streams a file -- Komga owns reading and
 * organisation. The sidecar's job stops at deciding what should be on disk.
 */

import { createServerFn } from '@tanstack/react-start'

import { getDb } from './db/index.ts'

import {
  listCatalogue,
  listSeriesGroups,
  getComic,
  setPinned,
  lastIndexRun,
  recentJobs,
  type CatalogueFilter,
} from './catalogue.ts'
import { refreshIndex } from './drive/indexSync.ts'
import { fetchComic, cacheSummary } from './cache/fetch.ts'
import { evict, evictCandidates } from './cache/evict.ts'
import { setReadingStatus, clearReadingStatus, syncProgress, type ReadingStatus } from './progress.ts'
import { addWish, listWishes, setWishStatus, type WishlistRow } from './wishlist.ts'
import { ping } from './komga/client.ts'
import { canonicalName } from './naming.ts'
import { proposeLinks, confirmLinks, syncToNotion, rejectLink } from './notion/sync.ts'
import { notionConfig } from './notion/client.ts'
import { cachedCoverIds, syncCovers, backfillCovers } from './covers.ts'

// ---------------------------------------------------------------- catalogue

export const getCatalogue = createServerFn({ method: 'GET' })
  .validator((f: CatalogueFilter | undefined) => f ?? {})
  .handler(({ data }) => listCatalogue(data))

/**
 * Everything the catalogue page renders, in one round trip: the header's
 * capacity figures plus the full grid. Cover availability is a filesystem
 * check, so it is resolved here once rather than per tile.
 */
export const getVault = createServerFn({ method: 'GET' })
  .validator((f: CatalogueFilter | undefined) => f ?? {})
  .handler(async ({ data }) => {
    const coverIds = cachedCoverIds()
    return {
      cache: cacheSummary(),
      lastIndexRun: lastIndexRun() ?? null,
      komgaReachable: await ping(),
      items: listCatalogue(data).map((i) => ({ ...i, hasCover: coverIds.has(i.id) })),
      wishes: listWishes(),
      notion: {
        configured: notionConfig() !== null,
        lastSync:
          (
            getDb()
              .prepare("SELECT value FROM setting WHERE key = 'notion_last_sync'")
              .get() as { value: string } | undefined
          )?.value ?? null,
      },
    }
  })

export const runCoverSync = createServerFn({ method: 'POST' }).handler(() => syncCovers())

/** Extract covers from the head of each Drive file for anything still blank. */
export const runCoverBackfill = createServerFn({ method: 'POST' }).handler(() => backfillCovers())

export const getSeriesGroups = createServerFn({ method: 'GET' })
  .validator((f: CatalogueFilter | undefined) => f ?? {})
  .handler(({ data }) => listSeriesGroups(data))

export const getComicDetail = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(({ data }) => getComic(data))

/** Everything the catalogue header needs in one round trip. */
export const getOverview = createServerFn({ method: 'GET' }).handler(async () => ({
  cache: cacheSummary(),
  lastIndexRun: lastIndexRun() ?? null,
  jobs: recentJobs(10),
  komgaReachable: await ping(),
}))

// ---------------------------------------------------------------- drive index

export const runIndexRefresh = createServerFn({ method: 'POST' }).handler(() =>
  refreshIndex('manual'),
)

// ---------------------------------------------------------------- cache

export const fetchTitle = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(({ data }) => fetchComic(data))

export const previewEviction = createServerFn({ method: 'GET' }).handler(() => ({
  candidates: evictCandidates(),
  plan: evict({ dryRun: true }),
}))

export const runEviction = createServerFn({ method: 'POST' }).handler(() => evict())

export const setPin = createServerFn({ method: 'POST' })
  .validator((d: { id: string; pinned: boolean }) => d)
  .handler(({ data }) => {
    setPinned(data.id, data.pinned)
    return { ok: true }
  })

// ---------------------------------------------------------------- reading

export const setStatus = createServerFn({ method: 'POST' })
  .validator((d: { id: string; status: ReadingStatus | null; note?: string }) => d)
  .handler(({ data }) => {
    if (data.status === null) clearReadingStatus(data.id)
    else setReadingStatus(data.id, data.status, data.note)
    return { ok: true }
  })

export const runProgressSync = createServerFn({ method: 'POST' }).handler(() => syncProgress())

// ---------------------------------------------------------------- wishlist

export const getWishlist = createServerFn({ method: 'GET' })
  .validator((s: WishlistRow['status'] | undefined) => s)
  .handler(({ data }) => listWishes(data))

export const createWish = createServerFn({ method: 'POST' })
  .validator(
    (d: {
      series: string
      issue?: string | null
      year?: number | null
      publisher?: string | null
    }) => d,
  )
  .handler(({ data }) => {
    const series = data.series.trim()
    if (!series) throw new Error('a series name is required')
    const query = canonicalName({ series, issue: data.issue, year: data.year })
    return {
      id: addWish(query, {
        series,
        issue: data.issue?.trim() || null,
        year: data.year ?? null,
        publisher: data.publisher?.trim() || null,
      }),
    }
  })

export const updateWishStatus = createServerFn({ method: 'POST' })
  .validator((d: { id: string; status: WishlistRow['status'] }) => d)
  .handler(({ data }) => {
    setWishStatus(data.id, data.status)
    return { ok: true }
  })

// ---------------------------------------------------------------- notion (v2)

export const getNotionStatus = createServerFn({ method: 'GET' }).handler(() => {
  const row = getDb()
    .prepare("SELECT value FROM setting WHERE key = 'notion_last_sync'")
    .get() as { value: string } | undefined
  return { configured: notionConfig() !== null, lastSync: row?.value ?? null }
})

/** Candidate links for the one-time pass. Reads only; writes nothing. */
export const getNotionLinkProposals = createServerFn({ method: 'GET' }).handler(() =>
  proposeLinks(),
)

export const applyNotionLinks = createServerFn({ method: 'POST' })
  .validator((pairs: Array<{ comicId: string; notionPageId: string }>) => pairs)
  .handler(({ data }) => confirmLinks(data))

export const rejectNotionLink = createServerFn({ method: 'POST' })
  .validator((d: { comicId: string; notionPageId: string }) => d)
  .handler(({ data }) => {
    rejectLink(data.comicId, data.notionPageId)
    return { ok: true }
  })

export const runNotionSync = createServerFn({ method: 'POST' }).handler(() => syncToNotion())
