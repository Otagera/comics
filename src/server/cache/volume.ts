/**
 * Volume accounting.
 *
 * The Hetzner volume is a cache over the Drive master archive, held under a
 * fraction of its capacity so a fetch never fills the disk. Measured with
 * statfs against the whole filesystem rather than by summing file sizes, so
 * anything else living on the volume counts against the same budget.
 */

import { statfsSync } from 'node:fs'
import { config } from '../config.ts'

export interface VolumeUsage {
  used: number
  total: number
  free: number
  budget: number
  overBy: number
  pctUsed: number
}

export function volumeUsage(path = config.volume): VolumeUsage {
  const st = statfsSync(path)
  const total = Number(st.blocks) * Number(st.bsize)
  const free = Number(st.bavail) * Number(st.bsize)
  // Match df semantics: measure what is used, not what is free, so reserved
  // blocks are not mistaken for headroom.
  const used = total - Number(st.bfree) * Number(st.bsize)
  const budget = Math.floor((total * config.cache.budgetPct) / 100)
  return {
    used,
    total,
    free,
    budget,
    overBy: Math.max(0, used - budget),
    pctUsed: total === 0 ? 0 : (used * 100) / total,
  }
}

/** Bytes that must be freed before `incoming` extra bytes will fit. */
export function shortfallFor(incoming: number, usage = volumeUsage()): number {
  return Math.max(0, usage.used + incoming - usage.budget)
}

export function humanBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = Math.abs(n)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const sign = n < 0 ? '-' : ''
  return i === 0 ? `${sign}${Math.round(v)} B` : `${sign}${v.toFixed(1)} ${units[i]}`
}
