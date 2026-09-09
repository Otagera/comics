#!/usr/bin/env node --experimental-strip-types
/**
 * Maintenance CLI.
 *
 * Runs inside the sidecar container via `docker exec`, driven by host cron.
 * Deliberately imports nothing from npm -- only node: builtins and sibling
 * modules -- so it runs straight from the TypeScript source with Node's type
 * stripping and needs no node_modules in the runtime image.
 *
 *   cli.ts index        refresh the Drive index into SQLite
 *   cli.ts sync         pull read progress from Komga and cache covers
 *   cli.ts evict        enforce the volume budget
 *   cli.ts maintenance  all three, in the order that matters
 *   cli.ts status       print a summary
 *   cli.ts fetch <id>   fetch one comic by internal id
 *   cli.ts list [query] list the catalogue
 */

import { refreshIndex } from './drive/indexSync.ts'
import { syncProgress } from './progress.ts'
import { evict, describeEviction, evictCandidates } from './cache/evict.ts'
import { fetchComic, cacheSummary, reconcileLocal } from './cache/fetch.ts'
import { listCatalogue } from './catalogue.ts'
import { syncCovers } from './covers.ts'
import { humanBytes } from './cache/volume.ts'
import { closeDb } from './db/index.ts'

function log(msg: string): void {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`)
}

function cmdReconcile(): void {
  const r = reconcileLocal()
  if (r.adopted || r.dropped) {
    log(`reconcile: ${r.adopted} adopted from disk, ${r.dropped} no longer present`)
  }
}

async function cmdIndex(): Promise<void> {
  const r = await refreshIndex('cron')
  log(
    `index: ${r.filesSeen} file(s), +${r.added} new, ${r.updated} updated, ` +
      `${r.missing} missing, ${humanBytes(r.bytesTotal)} in Drive` +
      (r.wishlistMatched ? `, ${r.wishlistMatched} wish(es) now available` : ''),
  )
}

async function cmdSync(): Promise<void> {
  try {
    const r = await syncProgress()
    log(`progress: ${r.booksSeen} book(s) from Komga, ${r.updated} updated, ${r.linked} newly linked`)
  } catch (err) {
    // Komga being down must not abort the rest of maintenance.
    log(`progress: skipped (${(err as Error).message})`)
  }
  try {
    const c = await syncCovers()
    if (c.fetched || c.failed) log(`covers: ${c.fetched} cached, ${c.failed} failed`)
  } catch (err) {
    log(`covers: skipped (${(err as Error).message})`)
  }
}

function cmdEvict(dryRun: boolean): void {
  const r = evict({ dryRun })
  log(`evict: ${describeEviction(r)}`)
  for (const e of r.evicted) {
    log(`  ${dryRun ? 'would evict' : 'evicted'} ${e.file_name} (${humanBytes(e.size_bytes)}; ${e.reason})`)
  }
}

function cmdStatus(): void {
  const s = cacheSummary()
  log(
    `volume: ${humanBytes(s.usage.used)} / ${humanBytes(s.usage.total)} ` +
      `(${s.usage.pctUsed.toFixed(1)}%), budget ${humanBytes(s.usage.budget)}` +
      (s.usage.overBy > 0 ? `, OVER by ${humanBytes(s.usage.overBy)}` : ', ok'),
  )
  log(
    `catalogue: ${s.totalTitles} title(s) in Drive (${humanBytes(s.archiveBytes)}), ` +
      `${s.localTitles} cached locally (${humanBytes(s.localBytes)}), ${s.pinnedTitles} pinned`,
  )
  const next = evictCandidates().slice(0, 5)
  if (next.length) {
    log('next to evict:')
    for (const c of next) log(`  ${c.score.toFixed(0).padStart(5)}  ${c.file_name} (${c.reason})`)
  }
}

function cmdList(query?: string): void {
  const items = listCatalogue(query ? { search: query } : {})
  for (const i of items) {
    const mark = i.localState === 'local' ? '*' : ' '
    const pin = i.pinned ? 'P' : ' '
    process.stdout.write(
      `${mark}${pin} ${humanBytes(i.sizeBytes).padStart(10)}  ${i.id}  ${i.series}` +
        `${i.volume ? ` v${i.volume}` : ''}${i.year ? ` (${i.year})` : ''}\n`,
    )
  }
  process.stdout.write(`\n${items.length} title(s)   (* = cached locally, P = pinned)\n`)
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'index':
      await cmdIndex()
      return 0
    case 'sync':
      await cmdSync()
      return 0
    case 'evict':
      cmdEvict(rest.includes('--dry-run'))
      return 0
    case 'maintenance':
      // Order matters: refresh the catalogue, learn what has been read, then
      // decide what to drop using that fresh reading state.
      await cmdIndex()
      cmdReconcile()
      await cmdSync()
      cmdEvict(false)
      return 0
    case 'reconcile':
      cmdReconcile()
      return 0
    case 'status':
      cmdReconcile()
      cmdStatus()
      return 0
    case 'list':
      cmdList(rest[0])
      return 0
    case 'fetch': {
      if (!rest[0]) {
        process.stderr.write('usage: cli.ts fetch <comic-id>\n')
        return 2
      }
      const r = await fetchComic(rest[0], { onProgress: (l) => process.stderr.write(l) })
      log(`fetch: ${r.status} — ${r.detail}`)
      if (r.evicted.length) log(`  evicted to make room: ${r.evicted.join(', ')}`)
      return 0
    }
    default:
      process.stderr.write(
        'usage: cli.ts <index|sync|evict|reconcile|maintenance|status|list|fetch>\n',
      )
      return 2
  }
}

main()
  .then((code) => {
    closeDb()
    process.exit(code)
  })
  .catch((err) => {
    process.stderr.write(`error: ${err?.stack ?? err}\n`)
    closeDb()
    process.exit(1)
  })
