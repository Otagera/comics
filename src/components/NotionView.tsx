import { useState } from 'react'
import { DrawablyButton, DrawablyBadge, DrawablyDivider } from 'drawably/react'

import { seedFrom } from './Cover.tsx'
import { relativeTime } from '../lib/format.ts'

/**
 * The Notion link pass and one-way sync.
 *
 * Matches are proposed, never applied silently. The read log is hand-typed,
 * and a wrong link is worse than no link: it would quietly drive the wrong
 * row's status from then on. So every pair is shown with its score and waits
 * for a decision, and a rejection is remembered so the same wrong suggestion
 * does not come back on the next pass.
 *
 * Proposals are fetched on demand rather than in the route loader -- they
 * call the Notion API, and the catalogue must still render when Notion is
 * unconfigured or unreachable.
 */

export interface Proposal {
  comicId: string
  comicName: string
  notionPageId: string
  notionName: string
  notionStatus: string | null
  score: number
}

export interface SyncSummary {
  linked: number
  created: number
  updated: number
  wishesSynced: number
  skipped: number
}

export function NotionView({
  configured,
  lastSync,
  onPropose,
  onLink,
  onReject,
  onSync,
}: {
  configured: boolean
  lastSync: string | null
  onPropose: () => Promise<Proposal[]>
  onLink: (p: Proposal) => Promise<void>
  onReject: (p: Proposal) => Promise<void>
  onSync: () => Promise<SyncSummary>
}) {
  const [proposals, setProposals] = useState<Proposal[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [summary, setSummary] = useState<SyncSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(key)
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (!configured) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="modal p-6">
          <h2 className="pen mb-2 text-[22px]" style={{ color: 'var(--text)' }}>
            Notion is not connected
          </h2>
          <p className="mb-4 text-[13px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
            Vault can push what it knows into your Book / Content Tracker: the
            title on rows it creates, the type, the status and a completed
            date. It never writes Author, Rating, Description or Link — those
            stay yours — and it never reads anything back.
          </p>
          <ol className="mb-4 list-decimal space-y-1.5 pl-5 text-[13px]" style={{ color: 'var(--text-2)' }}>
            <li>Create an internal integration at notion.so/my-integrations.</li>
            <li>Open the tracker database → ⋯ → Connections → add it.</li>
            <li>
              Set <code className="tnum">NOTION_TOKEN</code> and{' '}
              <code className="tnum">NOTION_DATABASE_ID</code> and redeploy.
            </li>
          </ol>
          <p className="text-[12px]" style={{ color: 'var(--text-3)' }}>
            The database id is the 32-character chunk in the database URL,
            before the <code className="tnum">?v=</code>.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="modal mb-6 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="pen text-[20px]" style={{ color: 'var(--text)' }}>
              Notion
            </h2>
            <p className="text-[12px]" style={{ color: 'var(--text-3)' }}>
              One-way. Last sync {lastSync ? relativeTime(lastSync) : 'never'}.
            </p>
          </div>
          <DrawablyButton
            seed={501}
            onClick={() => run('propose', async () => setProposals(await onPropose()))}
            disabled={busy !== null}
            className="text-[13px]"
          >
            {busy === 'propose' ? 'Looking' : 'Find matches'}
          </DrawablyButton>
          <DrawablyButton
            seed={502}
            variant="solid"
            state={busy === 'sync' ? 'loading' : 'idle'}
            onClick={() => run('sync', async () => setSummary(await onSync()))}
            disabled={busy !== null}
            className="text-[13px]"
          >
            {busy === 'sync' ? 'Syncing' : 'Sync now'}
          </DrawablyButton>
        </div>

        {summary && (
          <p className="tnum mt-3 text-[12px]" style={{ color: 'var(--accent)' }}>
            {summary.created} created · {summary.updated} updated · {summary.linked} newly
            linked · {summary.wishesSynced} wishes
            {summary.skipped > 0 ? ` · ${summary.skipped} skipped` : ''}
          </p>
        )}
        {error && (
          <p className="mt-3 text-[12px]" style={{ color: 'var(--drawably-error, #b4443c)' }}>
            {error}
          </p>
        )}
      </div>

      {proposals !== null && (
        <>
          <DrawablyDivider seed={503} className="my-5" />
          <h3 className="mb-1 text-[13px] font-medium" style={{ color: 'var(--text-2)' }}>
            Proposed links ({proposals.length})
          </h3>
          <p className="mb-4 text-[12px]" style={{ color: 'var(--text-3)' }}>
            Linking stores the page id and never renames the row. Rejecting is
            remembered, so the pair is not suggested again.
          </p>

          {proposals.length === 0 ? (
            <p className="pen py-10 text-center text-[16px]" style={{ color: 'var(--text-3)' }}>
              Nothing left to match.
            </p>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--hairline)' }}>
              {proposals.map((p) => (
                <div key={p.comicId + p.notionPageId} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium" style={{ color: 'var(--text)' }}>
                      {p.comicName}
                    </div>
                    <div className="text-[12px]" style={{ color: 'var(--text-2)' }}>
                      → “{p.notionName}”
                      {p.notionStatus ? (
                        <span style={{ color: 'var(--text-3)' }}> · {p.notionStatus}</span>
                      ) : null}
                    </div>
                  </div>

                  <DrawablyBadge
                    seed={seedFrom(p.comicId + p.notionPageId)}
                    className="tnum text-[11px]"
                    style={{ color: p.score >= 0.9 ? 'var(--accent)' : 'var(--text-2)' }}
                  >
                    {p.score.toFixed(2)}
                  </DrawablyBadge>

                  <DrawablyButton
                    seed={seedFrom(p.comicId + 'link')}
                    variant="solid"
                    disabled={busy !== null}
                    onClick={() =>
                      run(p.comicId, async () => {
                        await onLink(p)
                        setProposals((cur) => (cur ?? []).filter((x) => x.comicId !== p.comicId))
                      })
                    }
                    className="text-[12px]"
                  >
                    Link
                  </DrawablyButton>
                  <DrawablyButton
                    seed={seedFrom(p.comicId + 'no')}
                    tone="neutral"
                    disabled={busy !== null}
                    onClick={() =>
                      run(p.comicId, async () => {
                        await onReject(p)
                        setProposals((cur) =>
                          (cur ?? []).filter(
                            (x) => !(x.comicId === p.comicId && x.notionPageId === p.notionPageId),
                          ),
                        )
                      })
                    }
                    className="text-[12px]"
                  >
                    Not this
                  </DrawablyButton>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
