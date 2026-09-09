/**
 * Serves cached cover thumbnails at /covers/<comicId>.jpg
 *
 * Registered as a Nitro handler (see vite.config.ts) because the files are
 * written at runtime onto the volume, so they cannot be build-time public
 * assets. Reading straight off disk keeps Komga and its API key out of the
 * request path entirely.
 */

import { defineEventHandler } from 'h3'
import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { coverPath } from './covers.ts'

export default defineEventHandler((event) => {
  const url = new URL(event.req.url)
  const file = url.pathname.split('/').pop() ?? ''
  const id = file.replace(/\.jpg$/i, '')

  // Ids are ULID-shaped; refuse anything else rather than touching the path.
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
    return new Response('not found', { status: 404 })
  }

  const path = coverPath(id)
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return new Response('not found', { status: 404 })
  }

  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream
  return new Response(stream, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(size),
      // Covers are immutable per comic id; a refetch writes a new file only
      // when the book itself changed, so a short cache is safe and keeps the
      // grid snappy on repeat visits.
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400',
    },
  })
})
