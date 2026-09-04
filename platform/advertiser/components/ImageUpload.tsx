'use client'

import { useCallback, useRef, useState } from 'react'

/**
 * Drag-and-drop creative upload, with the preview shown immediately.
 *
 * The preview is a local object URL, so it appears the instant a file is
 * chosen rather than after a round trip. What is being previewed is the exact
 * file that will be uploaded — not a re-encoded approximation — because an
 * advertiser about to spend money should see what readers will see.
 *
 * Both limits are enforced here *and* on the bucket. The client check exists to
 * explain the problem; the bucket check exists because a client check is a
 * suggestion.
 */

export const MAX_BYTES = 512 * 1024
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp']

export interface Chosen {
  file: File
  previewUrl: string
}

export function ImageUpload({
  value,
  onChange
}: {
  value: Chosen | null
  onChange: (chosen: Chosen | null) => void
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [problem, setProblem] = useState('')

  const accept = useCallback(
    (file: File | undefined) => {
      if (!file) return
      if (!ACCEPTED.includes(file.type)) {
        setProblem('That file type is not supported. Use a PNG, JPEG or WebP.')
        return
      }
      if (file.size > MAX_BYTES) {
        setProblem(
          `That image is ${Math.round(file.size / 1024)} KB. The limit is 512 KB — every ` +
            'live creative is delivered inside the batch each reader downloads, so size is ' +
            "everyone's problem, not just yours."
        )
        return
      }
      setProblem('')
      onChange({ file, previewUrl: URL.createObjectURL(file) })
    },
    [onChange]
  )

  return (
    <div>
      <label htmlFor="creative">Creative image</label>

      <div
        className={`dropzone${over ? ' over' : ''}${value ? ' filled' : ''}`}
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setOver(false)
          accept(event.dataTransfer.files[0])
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') input.current?.click()
        }}
      >
        {value ? (
          <div className="preview">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value.previewUrl} alt="" />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14 }}>{value.file.name}</div>
              <div className="note">{Math.round(value.file.size / 1024)} KB</div>
            </div>
            <button
              type="button"
              className="secondary"
              style={{ marginLeft: 'auto' }}
              onClick={(event) => {
                event.stopPropagation()
                URL.revokeObjectURL(value.previewUrl)
                onChange(null)
                setProblem('')
                if (input.current) input.current.value = ''
              }}
            >
              Remove
            </button>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 14, color: 'var(--text)' }}>
              Drop an image here, or click to choose one
            </div>
            <div className="note" style={{ marginTop: 4 }}>
              PNG, JPEG or WebP · up to 512 KB · square works best
            </div>
          </>
        )}
      </div>

      <input
        ref={input}
        id="creative"
        type="file"
        accept={ACCEPTED.join(',')}
        style={{ display: 'none' }}
        onChange={(event) => accept(event.target.files?.[0])}
      />

      {problem !== '' && <p className="error">{problem}</p>}
      <p className="note">
        Your image is delivered <em>with</em> the advert to each reader&rsquo;s machine, so showing
        it never calls your server — and never tells anyone who saw it. That is also why it has to
        be uploaded rather than linked.
      </p>
    </div>
  )
}
