/**
 * Scene-release filename parser.
 *
 * Turns names like
 *   "Jessica Jones - Alias v01 (2015) (Digital) (F) (Zone-Empire).cbr"
 * into structured fields. Built against the actual archive (see
 * test/fixtures/drive-index.json), not against a general grammar -- scene
 * naming has no spec, so this targets the conventions this collection uses and
 * reports a confidence score rather than pretending to be exhaustive.
 *
 * The parsed series also decides where a fetched file is placed inside Komga's
 * library, because Komga derives series names from directory structure.
 * Drive's folders are a mix of publishers ("DC", "Marvel"), catch-alls
 * ("Others") and genuine series folders ("Jessica Jones - Alias"), so
 * mirroring Drive blindly would produce a series literally called "DC".
 */

export type ComicKind = 'issue' | 'volume' | 'collection' | 'oneshot' | 'unknown'

export interface ParsedName {
  series: string
  title: string | null
  issue: string | null
  volume: number | null
  year: number | null
  publisher: string | null
  kind: ComicKind
  tags: string[]
  confidence: number
  sortKey: string
}

/** Release-group and format tags that must never leak into the series name. */
const TAG_WORDS = [
  'digital', 'digital-sd', 'digital-hd', 'webrip', 'scan', 'c2c', 'f', 'fixed',
  'repack', 'covers only', 'covers', 'collection', 'complete', 'nodrm', 'hd',
]

const TAG_SUFFIXES = ['-empire', '-dcp', 'scanning', 'empire', ' scan']

/** Publishers recognisable from a parenthetical tag or a Drive bucket. */
const PUBLISHERS = [
  'DC', 'Marvel', 'Image', 'Dark Horse', 'IDW', 'BOOM! Studios', 'Boom',
  'Valiant', 'Vertigo', 'Dynamite', 'Oni Press', 'Oni', 'Titan', 'Aftershock',
  'Archie', 'Fantagraphics', 'Abstract Studio', 'Black Mask',
]

/** Buckets that are organisational, not a real series or publisher. */
const NON_SERIES_BUCKETS = new Set([
  'others', 'other', 'misc', 'miscellaneous', 'unsorted', 'comics',
])

/** Words marking a collected edition rather than a single issue. */
const COLLECTION_WORDS = [
  'omnibus', 'deluxe edition', 'complete collection', 'gallery edition',
  'compendium', 'treasury', 'anthology', 'collected', 'years of',
  'graphic novel',
]

/** Site watermarks appended outside parentheses. */
const SITE_TAGS = [/\bGetComics\.INFO\b/gi, /\bcomicsw\b/gi]

const ARTICLES = /^(the|a|an)\s+/i

function yearOf(s: string): number | null {
  const m = /^(19|20)\d{2}/.exec(s.trim())
  return m ? Number(m[0]) : null
}

function looksLikeTag(raw: string): boolean {
  const s = raw.trim().toLowerCase()
  if (!s) return true
  if (TAG_WORDS.includes(s)) return true
  if (TAG_SUFFIXES.some((suf) => s.endsWith(suf))) return true
  // Single short token that is not a number: "(F)", "(c2c)".
  if (s.length <= 3 && !/^\d+$/.test(s)) return true
  return false
}

function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Strip trailing separators left behind after removing a marker. */
function trimEdges(s: string): string {
  return tidy(s).replace(/^[\s._:-]+/, '').replace(/[\s._:-]+$/, '')
}

export function normaliseKey(s: string): string {
  return s
    .toLowerCase()
    .replace(ARTICLES, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * @param fileName basename including extension
 * @param bucket   top-level Drive folder, used as a publisher hint
 * @param folder   immediate parent folder, used as a series hint when it is a
 *                 real series directory rather than a bucket
 */
export function parseFilename(
  fileName: string,
  bucket?: string | null,
  folder?: string | null,
): ParsedName {
  let stem = fileName.replace(/\.(cbz|cbr|cb7|cbt|zip|rar|7z)$/i, '')
  for (const re of SITE_TAGS) stem = stem.replace(re, ' ')

  // Pull out every parenthetical group; whatever is left is the name proper.
  const groups: string[] = []
  const head = stem.replace(/\(([^()]*)\)/g, (_m, inner: string) => {
    groups.push(inner)
    return ' '
  })

  let year: number | null = null
  let publisher: string | null = null
  const rawTags: string[] = []

  for (const g of groups) {
    const y = yearOf(g)
    if (y !== null && year === null) {
      year = y // "(2023, 3rd edition)" -> 2023
      continue
    }
    const pub = PUBLISHERS.find((p) => p.toLowerCase() === g.trim().toLowerCase())
    if (pub && !publisher) {
      publisher = pub
      continue
    }
    rawTags.push(g.trim())
  }

  let rest = trimEdges(head)
  let volume: number | null = null
  let issue: string | null = null

  // Volume markers: "v01", "Vol. 2", "Book 03". The text after the marker is
  // the subtitle ("Absolute Batman v01 - The Zoo").
  let seriesPart = rest
  let subtitlePart: string | null = null

  const vol = /\b(?:v|vol\.?|volume|book)\s*(\d{1,3})\b/i.exec(rest)
  if (vol) {
    volume = Number(vol[1])
    seriesPart = rest.slice(0, vol.index)
    subtitlePart = rest.slice(vol.index + vol[0].length)
  }

  const iss = /#\s*(\d{1,4})\b/.exec(seriesPart)
  if (iss) {
    issue = String(Number(iss[1]))
    seriesPart = seriesPart.replace(iss[0], ' ')
  }

  let series = trimEdges(seriesPart)
  let title: string | null = subtitlePart ? trimEdges(subtitlePart) || null : null

  // With no volume marker, split a trailing edition name off the series.
  // Split at the *earliest* descriptor segment, not the last: in
  // "Detective Comics - 80 Years of Batman - The Deluxe Edition" the series is
  // "Detective Comics", so everything from "80 Years of..." onward is title.
  if (volume === null) {
    const parts = series.split(/\s+-\s+/)
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i].toLowerCase()
      if (COLLECTION_WORDS.some((w) => seg.includes(w))) {
        title = trimEdges(parts.slice(i).join(' - '))
        series = trimEdges(parts.slice(0, i).join(' - '))
        break
      }
    }
  }

  // A parent folder is only a better series name than the filename when it is
  // a *superset* of it -- "Jessica Jones - Alias" over a file called
  // "Alias v01". A folder that merely groups related series must not win:
  // "DC/Absolute Universe" holds Absolute Batman, Superman and Wonder Woman,
  // which are three series, not one.
  const seriesNorm = normaliseKey(series)
  const folderNorm = folder ? normaliseKey(folder) : ''
  const folderIsSeries =
    !!folder &&
    !!seriesNorm &&
    !NON_SERIES_BUCKETS.has(folder.toLowerCase()) &&
    !PUBLISHERS.some((p) => p.toLowerCase() === folder.toLowerCase()) &&
    folderNorm.includes(seriesNorm)

  if (folderIsSeries && folder) series = tidy(folder)

  if (!publisher && bucket) {
    const pub = PUBLISHERS.find((p) => p.toLowerCase() === bucket.toLowerCase())
    if (pub) publisher = pub
  }

  const haystack = stem.toLowerCase()
  let kind: ComicKind
  if (COLLECTION_WORDS.some((w) => haystack.includes(w))) kind = 'collection'
  else if (volume !== null) kind = 'volume'
  else if (issue !== null) kind = 'issue'
  else if (series) kind = 'oneshot'
  else kind = 'unknown'

  let confidence = 0
  if (series) {
    confidence += 0.4
    if (year !== null) confidence += 0.25
    if (volume !== null || issue !== null) confidence += 0.2
    if (publisher) confidence += 0.1
    if (folderIsSeries) confidence += 0.05
  }

  return {
    series: series || trimEdges(stem),
    title,
    issue,
    volume,
    year,
    publisher,
    kind,
    tags: rawTags.filter((t) => !looksLikeTag(t)),
    confidence: Math.min(1, Number(confidence.toFixed(2))),
    sortKey: normaliseKey(series || stem),
  }
}

/**
 * Where a fetched file goes inside Komga's library root.
 *
 * Komga names a series after its containing directory, so every comic gets a
 * directory named for its parsed series. Publisher, when known, is the top
 * level purely so the tree stays browsable on disk.
 */
export function libraryRelPath(parsed: ParsedName, fileName: string): string {
  const safe = (s: string) =>
    s.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim() || 'Unknown'
  const top = parsed.publisher ? safe(parsed.publisher) : 'Unsorted'
  return `${top}/${safe(parsed.series)}/${fileName}`
}
