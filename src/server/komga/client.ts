/**
 * Komga API client.
 *
 * Only the surface the sidecar actually needs: trigger a scan, resolve what a
 * scan produced, and read read-progress. The sidecar deliberately does not
 * wrap Komga's metadata or reader APIs -- Komga owns those.
 *
 * Auth is an API key in X-API-Key (Komga >= 1.11), created once and stored in
 * komga.env; no session or token refresh to manage.
 */

import { config } from '../config.ts'

export interface KomgaBook {
  id: string
  seriesId: string
  seriesTitle: string
  name: string
  url: string
  sizeBytes: number
  media: { status: string; pagesCount: number; mediaType: string }
  readProgress: KomgaReadProgress | null
}

export interface KomgaReadProgress {
  page: number
  completed: boolean
  readDate: string | null
  lastModified: string | null
  deviceName?: string
}

export interface KomgaSeries {
  id: string
  name: string
  url: string
  booksCount: number
  booksReadCount: number
  booksUnreadCount: number
  booksInProgressCount: number
}

interface Page<T> {
  content: T[]
  totalElements: number
}

export class KomgaError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'KomgaError'
    this.status = status
  }
}

async function call<T>(
  path: string,
  init: RequestInit & { expectEmpty?: boolean } = {},
): Promise<T> {
  if (!config.komga.apiKey) {
    throw new KomgaError('CS_KOMGA_API_KEY is not set', 0)
  }
  const { expectEmpty, ...rest } = init
  const res = await fetch(`${config.komga.baseUrl}${path}`, {
    ...rest,
    headers: {
      'X-API-Key': config.komga.apiKey,
      Accept: 'application/json',
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      ...rest.headers,
    },
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new KomgaError(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${body.slice(0, 300)}`, res.status)
  }
  if (expectEmpty || res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/** Reachability check that does not require a library to exist yet. */
export async function ping(): Promise<boolean> {
  try {
    await call('/api/v2/users/me')
    return true
  } catch {
    return false
  }
}

export async function listLibraries(): Promise<Array<{ id: string; name: string; root: string }>> {
  return call('/api/v1/libraries')
}

/**
 * Ask Komga to rescan the library.
 *
 * Returns 202: the scan is asynchronous, so a 202 means *queued*, not
 * ingested. Callers must confirm the book actually appeared -- see
 * waitForBook.
 */
export async function scanLibrary(libraryId = config.komga.libraryId, deep = false): Promise<void> {
  if (!libraryId) throw new KomgaError('CS_KOMGA_LIBRARY_ID is not set', 0)
  const q = deep ? '?deep=true' : ''
  await call(`/api/v1/libraries/${libraryId}/scan${q}`, { method: 'POST', expectEmpty: true })
}

export async function listBooks(libraryId = config.komga.libraryId): Promise<KomgaBook[]> {
  const q = new URLSearchParams({ unpaged: 'true' })
  if (libraryId) q.set('library_id', libraryId)
  const page = await call<Page<KomgaBook>>(`/api/v1/books?${q}`)
  return page.content
}

export async function listSeries(libraryId = config.komga.libraryId): Promise<KomgaSeries[]> {
  const q = new URLSearchParams({ unpaged: 'true' })
  if (libraryId) q.set('library_id', libraryId)
  const page = await call<Page<KomgaSeries>>(`/api/v1/series?${q}`)
  return page.content
}

/**
 * Find the book Komga created for a file we just placed.
 *
 * Matched on `url`, which is the book's absolute path as Komga sees it inside
 * its own container -- an exact identity, so no fuzzy title matching is ever
 * needed. This is what lets the sidecar record komga_id at fetch time.
 */
export async function findBookByPath(komgaPath: string): Promise<KomgaBook | null> {
  const books = await listBooks()
  return books.find((b) => b.url === komgaPath) ?? null
}

/**
 * Poll until the file we placed shows up as a READY book, or time out.
 *
 * A 202 from scanLibrary only means the job was queued, and a book appears
 * before its media is analysed, so both conditions are checked.
 */
export async function waitForBook(
  komgaPath: string,
  timeoutMs = config.cache.importWaitSecs * 1000,
  pollMs = 5000,
): Promise<KomgaBook | null> {
  const deadline = Date.now() + timeoutMs
  let last: KomgaBook | null = null
  while (Date.now() < deadline) {
    last = await findBookByPath(komgaPath)
    if (last && last.media.status === 'READY') return last
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return last
}

export async function getReadProgress(bookId: string): Promise<KomgaReadProgress | null> {
  const book = await call<KomgaBook>(`/api/v1/books/${bookId}`)
  return book.readProgress ?? null
}
