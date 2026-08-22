import { useCallback, useEffect, useState } from 'react'
import { acceleratorFromEvent, prettifyAccelerator } from '@shared/keys'

interface Row {
  id: string
  group: string
  label: string
  accelerator: string
  defaultAccelerator: string
}

/**
 * Remapping keyboard shortcuts.
 *
 * Recording happens on `keydown` in this document, which works because the
 * editor only records while a row is armed — the rest of the time focus is
 * wherever the user put it and the browser's own accelerators keep working.
 *
 * Two keys are deliberately not recordable. **Escape** cancels, because it is
 * the one press that must always mean "stop" — binding it would leave a user
 * unable to back out of a screen they are stuck in. **Enter/Tab alone** are left
 * to the browser so the editor stays reachable without a mouse.
 */
export function ShortcutEditor(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [recording, setRecording] = useState<string | null>(null)
  const [problem, setProblem] = useState<string>('')
  const [conflict, setConflict] = useState<string>('')

  const load = useCallback((): void => {
    void window.browser.invoke('shortcuts:list', undefined).then((result) => {
      if (result.ok) setRows(result.value)
    })
  }, [])

  useEffect(load, [load])

  const apply = useCallback(
    (id: string, accelerator: string | null): void => {
      setProblem('')
      setConflict('')
      void window.browser.invoke('shortcuts:set', { id, accelerator }).then((result) => {
        if (!result.ok) {
          setProblem('That could not be saved.')
          return
        }
        if (!result.value.ok) {
          setProblem(result.value.problem ?? 'That combination cannot be used.')
          return
        }
        if (result.value.conflictsWith.length > 0) {
          const names = result.value.conflictsWith
            .map((other) => rows.find((row) => row.id === other)?.label ?? other)
            .join(', ')
          setConflict(`Also bound to ${names}. Only one of them will fire.`)
        }
        load()
      })
    },
    [load, rows]
  )

  useEffect(() => {
    if (recording === null) return

    const onKey = (event: KeyboardEvent): void => {
      // Escape always means "stop", so it is never recorded — a user who bound
      // it would have no way out of the next screen that traps them.
      if (event.key === 'Escape') {
        event.preventDefault()
        setRecording(null)
        return
      }
      const accelerator = acceleratorFromEvent(event)
      if (accelerator === null) return

      event.preventDefault()
      event.stopPropagation()
      apply(recording, accelerator)
      setRecording(null)
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, apply])

  const grouped = rows.reduce<Record<string, Row[]>>((acc, row) => {
    ;(acc[row.group] ??= []).push(row)
    return acc
  }, {})

  const customised = rows.filter((row) => row.accelerator !== row.defaultAccelerator).length

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Click a shortcut, then press the keys you want. {customised > 0 && `${customised} changed.`}
        </p>
        {customised > 0 && (
          <button
            type="button"
            onClick={() => {
              void window.browser.invoke('shortcuts:resetAll', undefined).then(load)
              setProblem('')
              setConflict('')
            }}
            className="shrink-0 cursor-default rounded-md border border-[var(--glass-edge)] px-2 py-1 text-[11px] transition hover:border-[var(--color-accent)]"
          >
            Reset all
          </button>
        )}
      </div>

      <div role="status" aria-live="polite">
        {problem !== '' && <p className="mb-2 text-[11px] text-[var(--color-warn)]">{problem}</p>}
        {conflict !== '' && <p className="mb-2 text-[11px] text-[var(--color-warn)]">{conflict}</p>}
      </div>

      <div className="max-h-[420px] overflow-y-auto pr-1">
        {Object.entries(grouped).map(([group, items]) => (
          <div key={group} className="mb-3">
            <p className="mb-1 text-[10px] tracking-wide text-[var(--color-text-muted)] uppercase">
              {group}
            </p>
            {items.map((row) => {
              const isRecording = recording === row.id
              const changed = row.accelerator !== row.defaultAccelerator
              return (
                <div
                  key={row.id}
                  className="flex items-center gap-2 border-b border-[var(--glass-edge)] py-1.5 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-xs">{row.label}</span>

                  {changed && !isRecording && (
                    <button
                      type="button"
                      title={`Back to ${row.defaultAccelerator}`}
                      onClick={() => apply(row.id, null)}
                      className="shrink-0 cursor-default text-[10px] text-[var(--color-text-muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent)]"
                    >
                      reset
                    </button>
                  )}

                  <button
                    type="button"
                    aria-label={
                      isRecording
                        ? `Recording a new shortcut for ${row.label}. Press the keys, or Escape to cancel.`
                        : `${row.label}: ${prettifyAccelerator(row.accelerator)}. Activate to change.`
                    }
                    aria-pressed={isRecording}
                    onClick={() => {
                      setProblem('')
                      setConflict('')
                      setRecording(isRecording ? null : row.id)
                    }}
                    className={`shrink-0 cursor-default rounded border px-2 py-0.5 font-mono text-[11px] transition ${
                      isRecording
                        ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                        : changed
                          ? 'border-[var(--color-accent)]/50 text-[var(--color-text-primary)]'
                          : 'border-[var(--glass-edge)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
                    }`}
                  >
                    {isRecording ? 'Press keys…' : prettifyAccelerator(row.accelerator)}
                  </button>
                </div>
              )
            })}
          </div>
        ))}
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        A combination needs Ctrl, Alt or Shift held, or to be a function key — a bare letter would
        fire while you were typing into a page. Escape cancels rather than binding, so it always
        means &ldquo;stop&rdquo;.
      </p>
    </div>
  )
}

