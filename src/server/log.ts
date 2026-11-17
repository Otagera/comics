/**
 * Structured logging, shipped to Chatterbox (chatterbox.otagera.xyz).
 *
 * Every entry is written to stdout as one line, so `docker logs` keeps working
 * whether or not Chatterbox is configured. When CS_CHATTERBOX_APP and
 * CS_CHATTERBOX_SECRET are set, entries are also buffered and POSTed in
 * batches to /api/logs/bulk.
 *
 * Imports nothing from npm: the maintenance CLI runs straight from source with
 * no node_modules in the runtime image (see cli.ts), and it logs through here.
 *
 * Shipping is best-effort by design. A Chatterbox outage must never fail a
 * fetch or a cron run, so a failed batch is reported once on stderr and
 * dropped -- there is no on-disk retry queue to grow on a near-full disk.
 *
 * Two wire details from the Chatterbox server, both easy to get wrong:
 *  - auth is `Authorization: Bearer <secret>` plus an `appName` header; the
 *    SDK's docs also mention x-api-key, which the server does not read.
 *  - plain http:// answers 301 to https, and a redirected POST loses its body,
 *    so the URL must be https.
 */

import { hostname } from 'node:os'

export type Level = 'debug' | 'info' | 'warn' | 'error'

type Entry = {
  level: Level
  name: string
  key: string
  time: number
  appName: string
  context: Record<string, unknown>
  data?: Record<string, unknown>
  error?: { type?: string; message?: string; stack?: string }
  timeTaken?: number
}

const URL_BASE = (process.env.CS_CHATTERBOX_URL || 'https://chatterbox.otagera.xyz').replace(/\/+$/, '')
const APP = process.env.CS_CHATTERBOX_APP || ''
const SECRET = process.env.CS_CHATTERBOX_SECRET || ''
const ENABLED = APP !== '' && SECRET !== ''

const MAX_BATCH = 50
const FLUSH_MS = 5_000
const MAX_BUFFER = 1_000

const baseContext = {
  host: hostname(),
  source: process.argv[1]?.endsWith('cli.ts') ? 'cli' : 'web',
}

let buffer: Entry[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let inflight: Promise<void> = Promise.resolve()
let warned = false

export type LogFields = {
  data?: Record<string, unknown>
  error?: unknown
  timeTaken?: number
  /** Also print to stdout; default true. */
  echo?: boolean
}

/**
 * Record one event. `key` is a stable SCREAMING-KEBAB event name that
 * Chatterbox can filter on (FETCH-OK, EVICT, INDEX-REFRESH); `msg` is the
 * human sentence.
 */
export function log(level: Level, key: string, msg: string, fields: LogFields = {}): void {
  const time = Date.now()
  if (fields.echo !== false) {
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout
    stream.write(`${new Date(time).toISOString()} ${msg}\n`)
  }
  if (!ENABLED) return

  const entry: Entry = { level, name: msg, key, time, appName: APP, context: baseContext }
  if (fields.data) entry.data = fields.data
  if (fields.timeTaken !== undefined) entry.timeTaken = fields.timeTaken
  if (fields.error !== undefined) entry.error = serializeError(fields.error)

  // Bounded: if Chatterbox is unreachable for a long stretch, drop the oldest
  // rather than let a long-lived server grow without limit.
  if (buffer.length >= MAX_BUFFER) buffer.shift()
  buffer.push(entry)

  if (buffer.length >= MAX_BATCH) void flushLogs()
  else if (!timer) {
    timer = setTimeout(() => void flushLogs(), FLUSH_MS)
    // Never hold a process open just to ship logs; the CLI awaits flushLogs().
    timer.unref?.()
  }
}

/** Send everything buffered. Safe to call repeatedly; resolves when sent or dropped. */
export function flushLogs(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!ENABLED || buffer.length === 0) return inflight
  const pending = buffer
  buffer = []
  inflight = inflight.then(() => send(pending))
  return inflight
}

async function send(entries: Entry[]): Promise<void> {
  for (let i = 0; i < entries.length; i += MAX_BATCH) {
    const logs = entries.slice(i, i + MAX_BATCH)
    try {
      const res = await fetch(`${URL_BASE}/api/logs/bulk`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          appName: APP,
          authorization: `Bearer ${SECRET}`,
        },
        body: JSON.stringify({ logs }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      warned = false
    } catch (err) {
      if (!warned) {
        // Once per outage, and straight to stderr -- logging this through
        // log() would just queue another entry for the same dead endpoint.
        process.stderr.write(`chatterbox: dropped ${logs.length} log(s): ${(err as Error).message}\n`)
        warned = true
      }
    }
  }
}

function serializeError(err: unknown): Entry['error'] {
  if (err instanceof Error) return { type: err.name, message: err.message, stack: err.stack }
  return { message: String(err) }
}

/**
 * Wrap a server-side operation: logs its outcome and duration, and logs and
 * rethrows on failure. `summarize` turns the result into the logged data;
 * by default its top-level scalars are kept and arrays reduced to a count, so
 * an eviction of forty files logs `evicted: 40`, not forty objects.
 */
export async function traced<T>(
  key: string,
  data: Record<string, unknown>,
  fn: () => T | Promise<T>,
  summarize?: (r: T) => Record<string, unknown>,
): Promise<T> {
  const start = Date.now()
  try {
    const r = await fn()
    const extra = summarize ? summarize(r) : scalars(r)
    log('info', key, `${key.toLowerCase()} ok`, {
      data: { ...data, ...extra },
      timeTaken: Date.now() - start,
    })
    return r
  } catch (err) {
    log('error', `${key}-FAILED`, `${key.toLowerCase()} failed: ${(err as Error)?.message ?? err}`, {
      data,
      error: err,
      timeTaken: Date.now() - start,
    })
    throw err
  }
}

function scalars(r: unknown): Record<string, unknown> {
  if (r === null || typeof r !== 'object') return r === undefined ? {} : { result: r }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) {
    if (Array.isArray(v)) out[k] = v.length
    else if (v === null || typeof v !== 'object') out[k] = v
  }
  return out
}
