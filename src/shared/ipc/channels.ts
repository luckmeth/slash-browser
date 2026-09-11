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

  // --- omnibox suggestions ---
  'omnibox:suggest',
  'omnibox:setState',
  'omnibox:getState',
  'omnibox:accept',
  'omnibox:dismiss',

  // --- overlay / layout ---
  'overlay:setState',
  'overlay:getState',
  'ui:run',
  'notice:current',
  'sponsor:currentNotice',
  'print:preview',
  'print:run',
  'print:savePdf',
  'shortcuts:list',
  'shortcuts:set',
  'shortcuts:resetAll',
  'menu:showAppMenu',
  'layout:setRightPanelWidth',
  'layout:setChromeHeight',
  'layout:setChromeHidden',

  // --- tabs ---
  'tabs:list',
  'tabs:listAll',
  'tabs:create',
  'tabs:close',
  'tabs:setSplit',
  'tabs:toggleSplit',
  'tabs:setSplitFraction',
  'tabs:setSplitOrientation',
  'tabs:swapSplit',
  'tabs:createGroup',
  'tabs:updateGroup',
  'tabs:deleteGroup',
  'tabs:closeGroup',
  'tabs:setTabGroup',
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

  // --- native browser behaviours ---
  'menu:showTabContextMenu',
  'view:setZoomLevel',
  'view:find',
  'view:stopFind',
  'view:print',
  'window:toggleFullScreen',
  'shell:openTabExternally',

  // --- performance ---
  'performance:snapshot',
  'performance:setMode',
  'performance:setProtected',
  'performance:hibernate',
  'performance:freeze',
  'performance:restore',
  'performance:applyRecommendation',

  // --- permissions ---
  'permissions:respond',
  'permissions:getPending',
  'permissions:list',
  'permissions:revoke',
  'permissions:events',
  'permissions:clearEvents',

  // --- time machine ---
  'snapshots:list',
  'snapshots:detail',
  'snapshots:create',
  'snapshots:restore',
  'snapshots:restoreTab',
  'snapshots:delete',

  // --- web memory ---
  'memory:search',
  'memory:stats',
  'memory:forget',
  'memory:clear',
  'memory:semanticStatus',
  'memory:setSemanticEnabled',

  // --- ai action engine ---
  'ai:status',
  'ai:setApiKey',
  'ai:egressPreview',
  'ai:propose',
  'ai:approve',
  'ai:cancel',
  'ai:undo',
  'ai:activity',

  // --- content blocking ---
  'blocking:status',
  'blocking:setSiteAllowed',
  'blocking:sessionTotals',
  'shield:releasePopup',
  'shield:allowPopupsHere',
  'shield:setSiteLock',
  'shield:setMode',
  'shield:clearActivity',
  'shield:verification',
  'shield:reportLeak',
  'shield:verification',

  // --- reading list ---
  'reading:list',
  'reading:add',
  'reading:remove',
  'reading:setRead',
  'reading:clearRead',

  // --- saved sign-ins ---
  'vault:status',
  'vault:save',
  'vault:remove',
  'vault:clearAll',
  'vault:formForTab',
  'vault:fill',

  // --- sponsored tiles ---
  'sponsor:status',
  'sponsor:impression',
  'sponsor:click',
  'sponsor:refresh',
  'sponsor:clear',

  // --- start page ---
  'newtab:pickBackground',
  'newtab:backgroundImage',

  // --- unpacked extensions ---
  'extensions:status',
  'extensions:add',
  'extensions:remove',

  // --- reader mode ---
  'reader:open',
  'reader:get',
  'reader:translate',
  'reader:translateAvailable',

  // --- import from another browser ---
  'import:sources',
  'import:run',

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
  'downloads:clearCompleted',

  // --- advanced download engine ---
  'downloadEngine:list',
  'downloadEngine:enqueue',
  'downloadEngine:pause',
  'downloadEngine:resume',
  'downloadEngine:cancel',
  'downloadEngine:remove',
  'downloadEngine:setPriority',
  'downloadEngine:clearFinished',
  'downloadEngine:openFile',
  'downloadEngine:showInFolder',
  'downloadEngine:destination',
  'downloadEngine:chooseFolder',
  'downloadEngine:startNow',
  'downloadEngine:enqueueBatch',
  'downloadEngine:previewBatch',
  'downloadEngine:setQueue',
  'downloadEngine:refreshUrl',
  'downloadEngine:cancelCompletionAction',

  // --- mission mode ---
  'mission:status',
  'mission:start',
  'mission:complete',
  'mission:discard',
  'mission:setNotes',
  'mission:saveForLater',
  'mission:removeItem',

  // --- page watching ---
  'watch:status',
  'watch:toggle',
  'watch:remove',
  'watch:markSeen',

  // --- updates ---
  'system:hardware',
  'updates:status',
  'updates:check',
  'config:remote',
  'profiles:list',
  'profiles:create',
  'profiles:rename',
  'profiles:delete',
  'profiles:switch',
  'addresses:list',
  'addresses:save',
  'addresses:delete',
  'addresses:fieldsHere',
  'addresses:fill',
  'sync:status',
  'sync:unlock',
  'sync:lock',
  'sync:now',
  'sync:reset',
  'rewards:status',
  'rewards:signIn',
  'rewards:completeSignIn',
  'rewards:signOut',
  'rewards:refresh',
  'advertiser:state',
  'advertiser:saveCompany',
  'advertiser:submitCampaign',
  'advertiser:cancelCampaign',
  'rewards:profile',
  'rewards:saveProfile',
  'rewards:requestPayout',
  'rewards:walletChallenge',
  'rewards:submitWalletSignature',
  'updates:install',
  'updates:download',

  // --- diagnostics / crash reporting ---
  'crashes:report',
  'crashes:clear',
  'crashes:openFolder',

  // --- ai hub ---
  'aiHub:status',
  'aiHub:connect',
  'aiHub:disconnect',
  'aiHub:setDefault',
  'aiHub:comparePreview',
  'aiHub:compare',

  // --- redirect x-ray ---
  'redirects:chains',
  'redirects:clear',
  'redirects:blockDomain',

  // --- page insight ---
  'insight:analyse',

  // --- cleanup mode ---
  'cleanup:apply',
  'cleanup:restore',
  'cleanup:status',
  'cleanup:setDisabledForHost',

  // --- tab brain ---
  'tabBrain:analyse',
  'tabBrain:closeTabs',
  'tabBrain:groupIntoWorkspace',

  // --- download guardian / media detection ---
  'guardian:scanDownloads',
  'guardian:scanMedia',
  'guardian:grabSite',
  /** How many downloadable files the active tab has been seen fetching. */
  'media:detected',
  /** What the floating chip over the page should say. */
  'media:offer',
  /** Puts the chip away for this page. */
  'media:dismissOffer',
  /** Opens the picker: everything this page can be downloaded as. */
  'media:openPicker',
  /** What the picker shows — asked by the picker itself once it is up. */
  'media:options',
  /** Downloads one of the options the picker listed. */
  'media:qualities',
  'media:requestQuality',
  'external:status',
  'external:install',
  'external:uninstall',
  'media:externalFormats',
  'media:downloadExternal',
  'media:downloadChoice',

  /** Docks the chosen AI assistant beside the page, or puts it away. */
  'assistant:toggle',

  // --- default browser ---
  'system:defaultBrowser',
  'system:openDefaultBrowserSettings',
  /** Re-reads the registry after the user has been to the Windows screen. */
  'system:refreshDefaultBrowser',
  'system:dismissDefaultBrowser'
] as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]

export const EVENT_CHANNELS = [
  'settings:changed',
  'overlay:stateChanged',
  'tabs:snapshot',
  'downloads:changed',
  'history:changed',
  'sponsor:changed',
  'bookmarks:changed',
  'sync:changed',
  'rewards:changed',
  'updates:changed',
  'config:changed',
  'workspaces:snapshot',
  'performance:changed',
  /** Chrome → overlay, so the dropdown can render outside the chrome document. */
  'omnibox:state',
  'permissions:prompt',
  'permissions:changed',
  /**
   * Model download and backfill progress.
   *
   * Pushed rather than polled: preparing the model involves a download that can
   * take minutes, and a progress bar the renderer has to ask about repeatedly is
   * both jerkier and more expensive than one it is told about.
   */
  'memory:semanticChanged',
  /** Engine download progress. Pushed, because it changes several times a second. */
  'downloadEngine:changed',
  /** A redirect chain finished and is worth the user's attention. */
  'redirects:chain',
  /** A watched page changed since the last visit. */
  'watch:changed',
  /** A page looks off-mission; the chrome offers to save it for later. */
  'mission:suggestion',
  /** Menu accelerators that must be handled by the UI, not the main process. */
  'ui:command',
  /** Slash Shield held a popup; the chrome view offers it to the user. */
  'shield:popupBlocked',
  /** A top-level navigation was refused, or flagged and allowed. */
  'shield:navigationBlocked',
  'shield:navigationWarned',
  /**
   * Whether the page-world ad strip was observed actually running.
   *
   * Pushed rather than polled because the check happens once, seconds after
   * a YouTube page settles — long after the settings screen was opened.
   */
  'shield:verificationChanged',
  /**
   * Whether the page-world ad strip was observed actually running.
   *
   * Pushed rather than polled because the check happens once, seconds after
   * a YouTube page settles — long after the settings screen was opened.
   */
  'shield:verificationChanged',
  /**
   * The active tab started playing something downloadable.
   *
   * Pushed rather than polled: a video usually starts seconds after the page
   * settles, so asking once per navigation would miss it, and asking on every
   * snapshot would put an IPC round-trip on the browsing path.
   */
  'media:found'
] as const

export type EventChannel = (typeof EVENT_CHANNELS)[number]

export function isInvokeChannel(value: string): value is InvokeChannel {
  return (INVOKE_CHANNELS as readonly string[]).includes(value)
}

export function isEventChannel(value: string): value is EventChannel {
  return (EVENT_CHANNELS as readonly string[]).includes(value)
}
