import { describe, expect, it } from 'vitest'
import { shouldPromptForUpdate } from './launchPrompt'
import type { UpdateState } from '@shared/types/updates'

const ask = (state: UpdateState, promptedThisLaunch = false): boolean =>
  shouldPromptForUpdate({ state, promptedThisLaunch })

describe('when there is something to install', () => {
  it('asks as soon as one is found', () => {
    expect(ask('update-available')).toBe(true)
  })

  it('asks while it is still downloading', () => {
    // Auto-download is on by default, so the first status main sees can
    // already be 'downloading'. Waiting for 'ready' would put the dialog
    // minutes later, on top of whatever the user had started doing.
    expect(ask('downloading')).toBe(true)
  })

  it('asks when the package is downloaded and verified', () => {
    expect(ask('ready')).toBe(true)
  })
})

describe('when there is nothing to ask about', () => {
  it('stays silent on every other state', () => {
    const quiet: UpdateState[] = ['no-channel', 'idle', 'checking', 'up-to-date', 'error']
    for (const state of quiet) expect(ask(state)).toBe(false)
  })

  it('does not turn a failed check into a dialog', () => {
    // A feed that is down must not produce a modal on every launch.
    expect(ask('error')).toBe(false)
  })
})

describe('cancel lasts until the browser is reopened', () => {
  it('does not ask twice in one launch', () => {
    expect(ask('update-available', true)).toBe(false)
    expect(ask('ready', true)).toBe(false)
  })

  it('asks again on the next launch, because the flag starts false', () => {
    // The six-hourly re-check must not reopen it, but a fresh launch must.
    // Modelled the way the caller does it: a new run, a new flag.
    let promptedThisLaunch = false
    expect(shouldPromptForUpdate({ state: 'update-available', promptedThisLaunch })).toBe(true)
    promptedThisLaunch = true
    expect(shouldPromptForUpdate({ state: 'update-available', promptedThisLaunch })).toBe(false)

    const nextLaunch = false
    expect(shouldPromptForUpdate({ state: 'update-available', promptedThisLaunch: nextLaunch })).toBe(
      true
    )
  })
})
