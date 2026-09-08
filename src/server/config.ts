/**
 * Runtime configuration.
 *
 * Every path defaults onto the Hetzner volume. The root disk on lumina-1 runs
 * near full, so nothing that grows -- SQLite, staging, rclone's cache, TMPDIR --
 * may default to a root-disk location.
 */

function env(key: string, fallback: string): string {
  const v = process.env[key]
  return v === undefined || v === '' ? fallback : v
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got: ${v}`)
  return n
}

const VOLUME = env('CS_VOLUME', '/mnt/HC_Volume_106816620')

export const config = {
  volume: VOLUME,

  /** SQLite database file. */
  dbPath: env('CS_DB_PATH', `${VOLUME}/sidecar-data/comics.db`),

  /** Where fetched files land; this is Komga's library root on the host. */
  libraryRoot: env('CS_LIBRARY_ROOT', `${VOLUME}/komga-library`),

  /** Same directory as Komga sees it from inside its own container. */
  libraryRootInKomga: env('CS_LIBRARY_ROOT_KOMGA', '/data'),

  /** Downloads land here first, then move atomically into libraryRoot. */
  stagingDir: env('CS_STAGING_DIR', `${VOLUME}/sidecar-data/staging`),

  tmpDir: env('CS_TMPDIR', `${VOLUME}/tmp`),

  drive: {
    remote: env('CS_DRIVE_REMOTE', 'gdrive:Comics'),
    rcloneBin: env('CS_RCLONE_BIN', 'rclone'),
    configPath: env('CS_RCLONE_CONFIG', '/config/rclone.conf'),
  },

  komga: {
    baseUrl: env('CS_KOMGA_URL', 'http://komga:25600').replace(/\/+$/, ''),
    apiKey: env('CS_KOMGA_API_KEY', ''),
    libraryId: env('CS_KOMGA_LIBRARY_ID', ''),
  },

  cache: {
    /** Keep the volume at or below this fraction of capacity. */
    budgetPct: envNum('CS_BUDGET_PCT', 80),
    /** Never evict something fetched within this many hours (anti-thrash). */
    minAgeHours: envNum('CS_MIN_AGE_HOURS', 6),
    /** How long to wait for Komga to finish scanning a newly placed file. */
    importWaitSecs: envNum('CS_IMPORT_WAIT', 180),
  },

  /** Comic archive extensions we consider part of the collection. */
  comicExts: ['.cbz', '.cbr', '.cb7', '.cbt'] as const,
} as const

export type Config = typeof config
