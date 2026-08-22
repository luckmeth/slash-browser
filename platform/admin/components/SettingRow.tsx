'use client'

import { useActionState } from 'react'
import { savePlatformSetting, saveBrowserSetting, type SaveResult } from '@/app/settings/actions'

interface Props {
  settingKey: string
  value: unknown
  hint: string
  target: 'platform' | 'browser'
}

export function SettingRow({ settingKey, value, hint, target }: Props): React.JSX.Element {
  const [state, action, saving] = useActionState<SaveResult, FormData>(
    target === 'platform' ? savePlatformSetting : saveBrowserSetting,
    undefined
  )

  return (
    <form className="card" action={action}>
      <input type="hidden" name="key" value={settingKey} />
      <label htmlFor={`v-${settingKey}`}>
        <code>{settingKey}</code>
      </label>
      <p className="note" style={{ marginTop: 0 }}>
        {hint}
      </p>
      <textarea
        id={`v-${settingKey}`}
        name="value"
        defaultValue={JSON.stringify(value, null, 2)}
        rows={JSON.stringify(value, null, 2).split('\n').length + 1}
        spellCheck={false}
        style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
      />
      {state && 'error' in state && <p className="error">{state.error}</p>}
      {state && 'ok' in state && (
        <p className="note" style={{ color: 'var(--good)' }}>
          {state.ok}
        </p>
      )}
      <button type="submit" disabled={saving} style={{ marginTop: 10 }}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </form>
  )
}
