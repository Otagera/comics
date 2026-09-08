/**
 * SQLite connection and migration runner.
 *
 * Uses node:sqlite (built in since Node 22, stable in 24) rather than
 * better-sqlite3 so the Docker image needs no native toolchain -- the host's
 * root disk has no room to spare for one.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from '../config.ts'
import { migrations } from './migrations.ts'

let db: DatabaseSync | undefined

export function getDb(): DatabaseSync {
  if (db) return db

  mkdirSync(dirname(config.dbPath), { recursive: true })
  const conn = new DatabaseSync(config.dbPath)

  // WAL keeps the hourly cron's writes from blocking page reads. NORMAL sync
  // is the right trade here: the database is a rebuildable cache over Drive,
  // and a refresh restores anything a crash loses.
  conn.exec('PRAGMA journal_mode = WAL')
  conn.exec('PRAGMA synchronous = NORMAL')
  conn.exec('PRAGMA foreign_keys = ON')
  conn.exec('PRAGMA busy_timeout = 5000')

  migrate(conn)
  db = conn
  return db
}

/** Apply any migration not yet recorded, in declaration order. */
export function migrate(conn: DatabaseSync): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)

  const applied = new Set(
    conn.prepare('SELECT name FROM schema_migration').all().map((r) => String(r.name)),
  )

  for (const m of migrations) {
    if (applied.has(m.name)) continue
    conn.exec('BEGIN')
    try {
      conn.exec(m.sql)
      conn
        .prepare('INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)')
        .run(m.name, new Date().toISOString())
      conn.exec('COMMIT')
    } catch (err) {
      conn.exec('ROLLBACK')
      throw new Error(`migration ${m.name} failed: ${(err as Error).message}`)
    }
  }
}

/** Run `fn` inside a transaction, rolling back on throw. */
export function tx<T>(fn: (conn: DatabaseSync) => T): T {
  const conn = getDb()
  conn.exec('BEGIN')
  try {
    const out = fn(conn)
    conn.exec('COMMIT')
    return out
  } catch (err) {
    conn.exec('ROLLBACK')
    throw err
  }
}

export function closeDb(): void {
  db?.close()
  db = undefined
}
