import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseFilename, libraryRelPath, normaliseKey } from '../src/server/parse/filename.ts'

const idx = JSON.parse(readFileSync(new URL('./fixtures/drive-index.json', import.meta.url), 'utf8'))
const EXTS = ['.cbz', '.cbr', '.cb7', '.cbt']

function parsePath(p: string, name: string) {
  const segs = p.split('/')
  const bucket = segs.length > 1 ? segs[0] : null
  const folder = segs.length > 1 ? segs[segs.length - 2] : null
  return parseFilename(name, bucket, folder)
}

test('parses every comic in the real Drive index with usable confidence', () => {
  const comics = idx.filter((f: any) => EXTS.some((e) => f.Name.toLowerCase().endsWith(e)))
  assert.equal(comics.length, 21, 'fixture should hold 21 comics')
  for (const f of comics) {
    const p = parsePath(f.Path, f.Name)
    assert.ok(p.series.length > 0, `no series for ${f.Name}`)
    assert.ok(p.confidence >= 0.6, `low confidence ${p.confidence} for ${f.Name}`)
    assert.ok(p.year !== null, `no year for ${f.Name}`)
  }
})

test('an imprint folder does not collapse distinct series', () => {
  // DC/Absolute Universe/ holds three different series. Trusting the folder
  // would merge them into one.
  const names = [
    'Absolute Batman v01 - The Zoo (2025) (digital) (Son of Ultron-Empire).cbr',
    'Absolute Superman v01 - Last Dust of Krypton (2025) (digital) (Son of Ultron-Empire).cbr',
    'Absolute Wonder Woman v01 - The Last Amazon (2025) (digital) (Son of Ultron-Empire).cbr',
  ]
  const got = names.map((n) => parsePath(`DC/Absolute Universe/${n}`, n).series)
  assert.deepEqual(got, ['Absolute Batman', 'Absolute Superman', 'Absolute Wonder Woman'])
})

test('a real series folder still wins when it is more complete than the filename', () => {
  const p = parsePath('Marvel/Jessica Jones - Alias/Alias v01 (2015).cbr', 'Alias v01 (2015).cbr')
  assert.equal(p.series, 'Jessica Jones - Alias')
})

test('series splits at the earliest edition marker, not the last', () => {
  const n = 'Detective Comics - 80 Years of Batman - The Deluxe Edition (2019) (Digital) (Zone-Empire).cbr'
  const p = parsePath(`DC/${n}`, n)
  assert.equal(p.series, 'Detective Comics')
  assert.equal(p.title, '80 Years of Batman - The Deluxe Edition')
  assert.equal(p.kind, 'collection')
})

test('volume markers cover both v01 and Book N forms', () => {
  const a = parseFilename('Jessica Jones - Alias v01 (2015) (Digital) (F) (Zone-Empire).cbr', 'Marvel', 'Jessica Jones - Alias')
  assert.equal(a.volume, 1)
  const b = parseFilename('Lost Girls Book 02 - Neverlands (2006) (Digital) (K7-Empire).cbr', 'Lost Girls', 'Lost Girls')
  assert.equal(b.volume, 2)
  assert.equal(b.series, 'Lost Girls')
  assert.equal(b.title, 'Neverlands')
})

test('year survives a parenthetical with trailing text', () => {
  const p = parseFilename('Daredevil by Frank Miller Omnibus Companion (2023, 3rd edition) (Digital-Empire).cbr', 'Marvel', 'Marvel')
  assert.equal(p.year, 2023)
})

test('bare site watermarks are stripped', () => {
  const p = parseFilename('Batman - Year 100 and Other Tales Deluxe Edition (2015) GetComics.INFO.cbr', 'DC', 'DC')
  assert.ok(!p.series.includes('GetComics'))
  assert.equal(p.series, 'Batman')
})

test('library placement names the directory after the parsed series', () => {
  const n = 'Absolute Batman v01 - The Zoo (2025) (digital) (Son of Ultron-Empire).cbr'
  const p = parsePath(`DC/Absolute Universe/${n}`, n)
  assert.equal(libraryRelPath(p, n), `DC/Absolute Batman/${n}`)
})

test('normaliseKey ignores articles, case and punctuation', () => {
  assert.equal(normaliseKey('The Sandman'), 'sandman')
  assert.equal(normaliseKey('Jessica Jones - Alias'), 'jessica jones alias')
  assert.equal(normaliseKey('Batman & Robin'), 'batman and robin')
})
