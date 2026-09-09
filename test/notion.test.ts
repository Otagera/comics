import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statusForComic, completedDateFor, matchScore, type VaultComic } from '../src/server/notion/sync.ts'

const base: VaultComic = {
  id: 'x', series: 'Saga', issue: null, volume: 1, year: 2024,
  notion_page_id: null, reading_status: null, completed: 0, page: null, read_date: null,
}

test('status mapping covers every Vault state', () => {
  // In Drive but untouched.
  assert.equal(statusForComic(base), 'Not started')
  // "Want to read" is a reading status on something already in Drive, so it
  // is Not started -- "Not bought" belongs only to wishlist entries.
  assert.equal(statusForComic({ ...base, reading_status: 'want' }), 'Not started')
  assert.equal(statusForComic({ ...base, reading_status: 'reading' }), 'In progress')
  assert.equal(statusForComic({ ...base, page: 40 }), 'In progress')
  assert.equal(statusForComic({ ...base, reading_status: 'finished' }), 'Done')
  assert.equal(statusForComic({ ...base, completed: 1 }), 'Done')
  assert.equal(statusForComic({ ...base, reading_status: 'abandoned' }), 'Dropped')
})

test('an explicit abandon outranks Komga progress', () => {
  assert.equal(statusForComic({ ...base, reading_status: 'abandoned', page: 80 }), 'Dropped')
})

test('completed date is only written when finished', () => {
  assert.equal(completedDateFor(base), null)
  assert.equal(completedDateFor({ ...base, reading_status: 'reading' }), null)
  assert.equal(
    completedDateFor({ ...base, completed: 1, read_date: '2026-03-04T10:00:00Z' }),
    '2026-03-04',
  )
})

test('match scoring links the obvious and refuses the vague', () => {
  assert.equal(matchScore('Saga', 'Saga'), 1)
  assert.ok(matchScore('Saga', 'Saga vol 1') >= 0.9, 'a name extending another should link')
  assert.ok(matchScore('Jessica Jones - Alias', 'Jessica Jones Alias') === 1)
  assert.equal(matchScore('Green Arrow', 'Green Lantern'), 0)
  assert.equal(matchScore('Saga', 'Berserk'), 0)
  assert.equal(matchScore('', 'Saga'), 0)
})

test('scores never reach the auto-link threshold on weak overlap', () => {
  // syncToNotion only auto-links at >= 0.9; anything softer must wait for a
  // human to confirm it in the link pass.
  assert.ok(matchScore('Detective Comics', 'Detective Comics 80 Years') >= 0.9)
  assert.ok(matchScore('Wonder Woman', 'Wonder Woman Historia') >= 0.9)
  const weak = matchScore('Lost Girls', 'Girls')
  assert.ok(weak < 0.9, `weak overlap ${weak} must not auto-link`)

  // This archive holds both "Batman" and "Absolute Batman", which are
  // different series. Auto-linking them would silently drive the wrong row's
  // status, so the score must stay under the threshold and go to a human.
  const sibling = matchScore('Absolute Batman', 'Batman')
  assert.ok(sibling < 0.9, `sibling series scored ${sibling}, would auto-link`)
  assert.ok(sibling >= 0.6, 'but it should still be offered for confirmation')
})
