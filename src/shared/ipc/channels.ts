/**
 * Channel names, with zero dependencies.
 *
 * Kept separate from `contracts.ts` because the preload needs the name lists at
 * runtime but must not drag zod and every schema into its bundle — a preload is
 * evaluated before each privileged view's first paint, so its size is startup
 * latency. Importing the contracts here instead cost ~137 KB.
 *
 * Drift is prevented at compile time rather than by discipline: `contracts.ts`
 * declares `satisfies Record<InvokeChannel, ChannelContract>`, which fails the
 * build both when a channel listed here has no contract and when a contract
 * exists for a channel not listed here.
 */

export const INVOKE_CHANNELS = [
  // --- app / diagnostics ---
  'app:info',
  'diagnostics:dbStatus',

  // --- settings ---
  'settings:getAll',
  'settings:update',

  // --- overlay / layout ---
  'overlay:setState',
  'layout:setRightPanelWidth',

  // --- tabs ---
  'tabs:list',
  'tabs:create',
  'tabs:close',
  'tabs:activate',
  'tabs:reorder',
  'tabs:setPinned',
  'tabs:setMuted',
  'tabs:duplicate',
  'tabs:reopenClosed',
  'tabs:findByUrl',
  'tabs:moveToWorkspace',

  // --- workspaces ---
  'workspaces:list',
  'workspaces:create',
  'workspaces:update',
  'workspaces:delete',
  'workspaces:activate',
  'workspaces:duplicate',

  // --- navigation ---
  'nav:navigate',
  'nav:goBack',
  'nav:goForward',
  'nav:reload',
  'nav:stop',

  // --- performance ---
  'performance:snapshot',
  'performance:setMode',
  'performance:setProtected',
  'performance:hibernate',
  'performance:freeze',
  'performance:restore',
  'performance:applyRecommendation',

  // --- history ---
  'history:search',
  'history:delete',
  'history:clear',

  // --- bookmarks ---
  'bookmarks:list',
  'bookmarks:create',
  'bookmarks:update',
  'bookmarks:delete',
  'bookmarks:findByUrl',

  // --- downloads ---
  'downloads:list',
  'downloads:pause',
  'downloads:resume',
  'downloads:cancel',
  'downloads:openFile',
  'downloads:showInFolder',
  'downloads:remove',
  'downloads:clearCompleted'
] as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]

export const EVENT_CHANNELS = [
  'settings:changed',
  'overlay:stateChanged',
  'tabs:snapshot',
  'downloads:changed',
  'history:changed',
  'bookmarks:changed',
  'workspaces:snapshot',
  'performance:changed',
  /** Menu accelerators that must be handled by the UI, not the main process. */
  'ui:command'
] as const

export type EventChannel = (typeof EVENT_CHANNELS)[number]

export function isInvokeChannel(value: string): value is InvokeChannel {
  return (INVOKE_CHANNELS as readonly string[]).includes(value)
}

export function isEventChannel(value: string): value is EventChannel {
  return (EVENT_CHANNELS as readonly string[]).includes(value)
}
