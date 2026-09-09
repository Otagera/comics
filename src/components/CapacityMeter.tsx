import { bytes } from '../lib/format.ts'

/**
 * The signature element: a horizon bar showing how full the volume is, with a
 * hard tick where the eviction budget sits.
 *
 * This is the one place the design spends boldness. The sea gradient is used
 * here and on read-progress and nowhere else, so a gradient anywhere in the
 * app always means "this is a measurement". Fill and budget are deliberately
 * different shapes -- a soft gradient band versus a hard tick -- so "how full"
 * and "how full I am allowed to be" never blur together.
 */
export function CapacityMeter({
  used,
  total,
  budget,
  localTitles,
  localBytes,
  incoming = 0,
  compact = false,
}: {
  used: number
  total: number
  budget: number
  localTitles: number
  localBytes: number
  /** Bytes about to be added, previewed as a lighter segment. */
  incoming?: number
  compact?: boolean
}) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0
  const budgetPct = total > 0 ? Math.min(100, (budget / total) * 100) : 0
  const incomingPct = total > 0 ? Math.min(100 - pct, (incoming / total) * 100) : 0
  const over = used > budget
  const free = Math.max(0, budget - used)

  return (
    <div className={compact ? 'w-full' : 'w-full'}>
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <span className="tnum text-[13px] font-medium" style={{ color: 'var(--text)' }}>
            {bytes(used)}
          </span>
          <span className="text-[12px]" style={{ color: 'var(--text-3)' }}>
            of {bytes(total)} on the volume
          </span>
        </div>
        <span
          className="tnum text-[12px]"
          style={{ color: over ? 'var(--accent-deep)' : 'var(--text-3)' }}
        >
          {over ? `${bytes(used - budget)} over budget` : `${bytes(free)} before eviction`}
        </span>
      </div>

      <div
        className="meter-track mt-2"
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Volume ${pct.toFixed(0)} percent full, budget at ${budgetPct.toFixed(0)} percent`}
      >
        <div className="meter-fill" style={{ width: `${pct}%` }} />
        {incomingPct > 0 && (
          <div
            className="meter-fill"
            style={{
              left: `${pct}%`,
              width: `${incomingPct}%`,
              opacity: 0.42,
              borderRadius: 0,
            }}
          />
        )}
        <div className="meter-marker" style={{ left: `${budgetPct}%` }} title="eviction budget" />
      </div>

      {!compact && (
        <div className="mt-2 flex items-baseline justify-between text-[12px]">
          <span style={{ color: 'var(--text-2)' }}>
            <span className="tnum">{localTitles}</span> cached
            <span style={{ color: 'var(--text-3)' }}> · </span>
            <span className="tnum">{bytes(localBytes)}</span>
          </span>
          <span className="tnum" style={{ color: 'var(--text-3)' }}>
            budget {bytes(budget)}
          </span>
        </div>
      )}
    </div>
  )
}
