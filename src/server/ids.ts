/**
 * Stable internal identifiers.
 *
 * ULID-shaped: 48-bit millisecond timestamp + 80 bits of randomness, Crockford
 * base32. Lexicographically sortable by creation time, which makes "newest
 * first" a plain ORDER BY and keeps ids readable in logs.
 */

import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford: no I, L, O, U

function encode(value: bigint, length: number): string {
  let out = ''
  let v = value
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(v & 31n)] + out
    v >>= 5n
  }
  return out
}

export function newId(now: number = Date.now()): string {
  const time = encode(BigInt(now), 10)
  const rand = encode(BigInt('0x' + randomBytes(10).toString('hex')), 16)
  return time + rand
}
