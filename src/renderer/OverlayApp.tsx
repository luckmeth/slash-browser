import { useEffect, useState } from 'react'
import type { AppInfo, DbStatus } from '@shared/ipc/contracts'

/**
 * The overlay surface. Phase 0 renders the spike report here.
 *
 * Its presence over live web content IS Spike A's result: if this card is legible
 * above example.com and the page shows through the scrim, a transparent
 * `WebContentsView` composites correctly and the command bar, dialogs and
 * permission prompts of later phases have a home.
 */
export function OverlayApp(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [db, setDb] = useState<DbStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const [infoResult, dbResult] = await Promise.all([
        window.browser.invoke('app:info', undefined),
        window.browser.invoke('diagnostics:dbStatus', undefined)
      ])
      if (infoResult.ok) setInfo(infoResult.value)
      else setError(infoResult.error.message)
      if (dbResult.ok) setDb(dbResult.value)
      else setError(dbResult.error.message)
    })()
  }, [])

  async function close(): Promise<void> {
    await window.browser.invoke('overlay:setState', { visible: false, surface: 'none' })
  }

  return (
    // Scrim: semi-transparent, so the page beneath is visibly showing through.
    <div className="flex h-full w-full items-center justify-center bg-black/45 p-8">
      <div className="w-[560px] max-w-full rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/95 p-6 shadow-2xl backdrop-blur-md">
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h1 className="text-lg font-semibold">Phase 0 spike report</h1>
            <p className="text-xs text-[var(--color-text-muted)]">
              You are reading this over a live web page.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void close()}
            className="cursor-pointer rounded-lg border border-[var(--color-border-subtle)] px-3 py-1.5 text-sm transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Close
          </button>
        </div>

        {error && <p className="mb-4 text-sm text-[var(--color-bad)]">{error}</p>}

        <Section title="Spike A — transparent overlay above page content">
          <Row label="Result" value="PASS — this card is composited over the page" good />
        </Section>

        <Section title="Spike B — SQLite from the running app">
          {db ? (
            <>
              <Row label="SQLite" value={db.sqliteVersion} />
              <Row label="Schema version" value={`v${db.schemaVersion}`} />
              <Row label="WAL" value={db.walEnabled ? 'enabled' : 'off'} good={db.walEnabled} />
              <Row
                label="Foreign keys"
                value={db.foreignKeysEnabled ? 'enabled' : 'off'}
                good={db.foreignKeysEnabled}
              />
              <Row
                label="Write/read round trip"
                value={db.roundTripOk ? 'PASS' : 'FAIL'}
                good={db.roundTripOk}
              />
              <Row label="Path" value={db.path} mono />
            </>
          ) : (
            <Row label="Status" value="loading…" />
          )}
        </Section>

        <Section title="Runtime">
          {info ? (
            <>
              <Row label="Electron" value={info.electron} />
              <Row label="Chromium" value={info.chrome} />
              <Row label="Node" value={info.node} />
              <Row label="Platform" value={info.platform} />
            </>
          ) : (
            <Row label="Status" value="loading…" />
          )}
        </Section>
      </div>
    </div>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-4 last:mb-0">
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase">
        {title}
      </h2>
      <dl className="space-y-1">{children}</dl>
    </section>
  )
}

function Row({
  label,
  value,
  good,
  mono
}: {
  label: string
  value: string
  good?: boolean
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <dt className="shrink-0 text-[var(--color-text-muted)]">{label}</dt>
      <dd
        className={[
          'truncate text-right',
          mono ? 'font-mono text-xs' : '',
          good === true ? 'text-[var(--color-good)]' : '',
          good === false ? 'text-[var(--color-bad)]' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}
