'use client'

/**
 * What a crashed page says.
 *
 * Without this, a page that throws in a production build renders Next's own
 * blank "Application error" — no message, no clue, and the only trace is a
 * line in a log file an operator does not know exists. That is exactly how a
 * broken settings page was reported three times as "not working" while the
 * server log had the answer in it the whole time.
 *
 * The digest is the important part. It is the only identifier that ties what
 * is on screen to the stack trace in `operations.log`, and it is what makes
 * "it does not work" into something answerable.
 */
export default function Error({
  error,
  reset
}: {
  error: Error & { digest?: string }
  reset: () => void
}): React.JSX.Element {
  return (
    <main>
      <h1>This page did not load</h1>
      <p className="lede">
        Something threw while the page was being built on the server. The rest of the application is
        unaffected — the navigation above still works.
      </p>

      <div className="card" style={{ borderColor: 'var(--bad)' }}>
        <h3 style={{ marginTop: 0 }}>{error.message || 'No message was given.'}</h3>
        {error.digest && (
          <p className="note">
            Digest <code>{error.digest}</code> — search for it in{' '}
            <code>%APPDATA%\Slash Operations\operations.log</code>, where the full stack trace is.
          </p>
        )}
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  )
}
