import { useRef, useState } from 'react'
import { CREATIVE_TYPES, MAX_CREATIVE_BYTES } from '@shared/types/advertising'
import { Icon } from '../../components/Icon'

/**
 * Choosing the picture that goes in the advert.
 *
 * This was a bare `<input type="file">`, which is a control that tells you
 * nothing: not whether the file was accepted, not what it looks like, and not
 * why 512 KB is the limit. The limit is the interesting part — every live
 * creative is inlined into the batch each reader downloads, so an advert's
 * file size is a cost paid by every person who sees it, not storage we happen
 * to be renting. That is worth saying next to the box rather than in a policy.
 *
 * Everything here is local. The bytes go to main only when the campaign is
 * submitted, and the preview is a `blob:` URL from the file already on this
 * machine — nothing is uploaded while somebody is still deciding.
 */
export function CreativePicker({
  imageType,
  onPick,
  onClear,
  problem
}: {
  imageType: string
  /** base64 without the data: prefix, and the MIME type the bucket will see. */
  onPick: (base64: string, type: string, name: string, size: number) => void
  onClear: () => void
  problem?: string
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState('')
  const [name, setName] = useState('')
  const [size, setSize] = useState(0)
  const [dimensions, setDimensions] = useState('')
  const [over, setOver] = useState(false)
  const [rejected, setRejected] = useState('')

  const take = (file: File | undefined): void => {
    if (!file) return
    setRejected('')

    if (!CREATIVE_TYPES.includes(file.type as (typeof CREATIVE_TYPES)[number])) {
      setRejected('That has to be a PNG, JPEG or WebP.')
      return
    }
    if (file.size > MAX_CREATIVE_BYTES) {
      setRejected(
        `That is ${Math.round(file.size / 1024)} KB. The limit is ${Math.round(
          MAX_CREATIVE_BYTES / 1024
        )} KB — every live advert is downloaded by every reader, so its size is their cost too.`
      )
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const base64 = result.slice(result.indexOf(',') + 1)
      setPreview(result)
      setName(file.name)
      setSize(file.size)
      onPick(base64, file.type, file.name, file.size)

      // Read the real pixels rather than asking for them: the answer is in the
      // file, and an advert at the wrong ratio is the most common way one
      // comes back from review.
      const image = new Image()
      image.onload = () => setDimensions(`${image.naturalWidth} × ${image.naturalHeight}`)
      image.src = result
    }
    reader.readAsDataURL(file)
  }

  const clear = (): void => {
    setPreview('')
    setName('')
    setSize(0)
    setDimensions('')
    setRejected('')
    if (input.current) input.current.value = ''
    onClear()
  }

  return (
    <div className="mt-3">
      <label className="mb-1.5 block text-[11.5px] text-[var(--color-text-muted)]">
        The picture in the advert
      </label>

      {preview === '' ? (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault()
            setOver(false)
            take(event.dataTransfer.files?.[0])
          }}
          className={`flex w-full cursor-default flex-col items-center gap-2 rounded-xl border border-dashed px-5 py-8 text-center transition ${
            over
              ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/8'
              : 'border-[var(--glass-edge)] hover:border-[var(--color-accent)]/60'
          }`}
        >
          <Icon name="download" size={18} className="text-[var(--color-text-muted)]" />
          <span className="text-[13px]">Drop an image here, or click to choose one</span>
          <span className="text-[11.5px] text-[var(--color-text-muted)]">
            PNG, JPEG or WebP · up to {Math.round(MAX_CREATIVE_BYTES / 1024)} KB · landscape reads
            best, around 1200 × 630
          </span>
        </button>
      ) : (
        <div className="flex items-center gap-4 rounded-xl border border-[var(--glass-edge)] bg-white/[0.03] p-3">
          {/* The file on this machine, not an upload. Nothing has left yet. */}
          <img
            src={preview}
            alt=""
            className="size-20 shrink-0 rounded-lg bg-black/30 object-cover"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px]">{name}</p>
            <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
              {Math.round(size / 1024)} KB
              {dimensions !== '' ? ` · ${dimensions}` : ''}
              {imageType !== '' ? ` · ${imageType.replace('image/', '').toUpperCase()}` : ''}
            </p>
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              Uploaded when you submit, not before.
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-1.5">
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="cursor-default rounded-lg border border-[var(--glass-edge)] px-3 py-1.5 text-[11.5px] transition hover:border-[var(--color-accent)]"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={clear}
              className="cursor-default rounded-lg border border-[var(--glass-edge)] px-3 py-1.5 text-[11.5px] text-[var(--color-text-muted)] transition hover:border-[var(--color-bad)] hover:text-[var(--color-bad)]"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      <input
        ref={input}
        type="file"
        accept={CREATIVE_TYPES.join(',')}
        onChange={(event) => take(event.target.files?.[0])}
        className="hidden"
      />

      {(rejected !== '' || problem) && (
        <p className="mt-1.5 text-[11.5px] text-[var(--color-bad)]">{rejected || problem}</p>
      )}
      {rejected === '' && !problem && preview === '' && (
        <p className="mt-1.5 text-[11.5px] text-[var(--color-text-muted)]">
          Optional — a campaign can run as text alone, and some placements are text only.
        </p>
      )}
    </div>
  )
}
