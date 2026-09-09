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
import { cachedCoverIds, syncCovers } from './covers.ts'

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
    }
  })

export const runCoverSync = createServerFn({ method: 'POST' }).handler(() => syncCovers())

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
  .validator((d: { query: string; series?: string; year?: number; publisher?: string }) => d)
  .handler(({ data }) => ({ id: addWish(data.query, data) }))

export const updateWishStatus = createServerFn({ method: 'POST' })
  .validator((d: { id: string; status: WishlistRow['status'] }) => d)
  .handler(({ data }) => {
    setWishStatus(data.id, data.status)
    return { ok: true }
  })
