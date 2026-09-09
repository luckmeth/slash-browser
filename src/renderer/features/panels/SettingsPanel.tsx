import { createContext, useContext, useEffect, useState } from 'react'
import type { InvokeResponse } from '@shared/ipc/contracts'
import type { Settings } from '@shared/types/settings'
import { SEARCH_ENGINES } from '@shared/constants'
import { SEMANTIC_MODEL_MB } from '@shared/types/semantic'
import { useBrowserStore } from '../../stores/browserStore'
import { useSemanticStatus } from '../memory/useSemanticStatus'
import { ImportSection } from './ImportSection'
import { SearchEnginesSection } from './SearchEnginesSection'
import { splitHint } from './settingsText'
import { HintText, Toggle } from './SettingsControls'
import { Icon, type IconName } from '../../components/Icon'
import { SiteZoomSection } from './SiteZoomSection'
import { ToolbarSection } from './ToolbarSection'
import { PasswordsSection } from './PasswordsSection'
import { NewTabSection } from './NewTabSection'
import { SponsorSection } from './SponsorSection'
import { ShieldVerificationNotice } from './ShieldVerificationNotice'
import { RewardsSection } from './RewardsSection'
import { ShortcutEditor } from './ShortcutEditor'
import { AddressSection } from './AddressSection'
import { ProfileSection } from './ProfileSection'
import { PublisherSection } from './PublisherSection'
import { SyncSection } from './SyncSection'
import { ExtensionsSection } from './ExtensionsSection'
import { DiagnosticsSection } from './DiagnosticsSection'
import { UpdateSection } from './UpdateSection'

/**
 * An icon for each category.
 *
 * Not decoration: the rail is seventeen words of similar length in the same
 * colour, and an icon is what lets somebody find "Downloads" again by shape
 * rather than by reading the list top to bottom every time. Drawn from the
 * existing set, so nothing new ships for this.
 */
const CATEGORY_ICONS: Record<string, IconName> = {
  Appearance: 'sparkle',
  Search: 'search',
  'Privacy & security': 'shield',
  Browsing: 'globe',
  Extensions: 'folder',
  Earning: 'star',
  'About Slash': 'activity'
}

export function SettingsPanel(): React.JSX.Element {
  const settings = useBrowserStore((s) => s.settings)
  const { status: semantic, setEnabled: setSemanticEnabled } = useSemanticStatus()
  const [filter, setFilter] = useState('')
  const [category, setCategory] = useState<Category>('Appearance')

  if (!settings) return <p className="p-4 text-sm text-[var(--color-text-muted)]">Loading…</p>

  const update = (patch: Partial<Settings>): void => {
    void window.browser.invoke('settings:update', patch)
  }

  return (
    <SettingsFilter.Provider value={filter}>
     <SettingsCategory.Provider value={category}>
      <div className="mx-auto flex h-full w-full max-w-5xl gap-6 p-6">
        {/*
          A category rail, as Chrome and Brave have. Seventeen groups in one
          scroll is a list rather than a settings screen, and it was the least
          usable part of the browser because of it.
        */}
        <nav className="w-48 shrink-0" aria-label="Settings categories">
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <ul className="mt-3 flex flex-col gap-0.5">
            {CATEGORIES.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  aria-current={filter.trim() === '' && category === name ? 'page' : undefined}
                  onClick={() => {
                    // Choosing a category clears the search, or the rail would
                    // appear not to respond while results from elsewhere showed.
                    setFilter('')
                    setCategory(name)
                  }}
                  className={`flex w-full cursor-default items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition ${
                    filter.trim() === '' && category === name
                      ? 'bg-[var(--color-accent)]/15 font-medium text-[var(--color-accent)]'
                      : 'text-[var(--color-text-muted)] hover:bg-white/[0.06]'
                  }`}
                >
                  <Icon name={CATEGORY_ICONS[name] ?? 'settings'} size={15} />
                  {name}
                </button>
              </li>
            ))}
          </ul>
          {filter.trim() !== '' && (
            <p className="mt-3 px-1 text-[11px] leading-snug text-[var(--color-text-muted)]">
              Showing matches from every category.
            </p>
          )}
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto pb-8">
          {/*
            Says where you are. Without it the right-hand column started
            mid-thought, and with the search box in the rail there was nothing
            on screen naming the section being shown.
          */}
          <h2 className="mb-4 text-xl font-semibold text-[var(--color-text-primary)]">
            {filter.trim() === '' ? category : `Results for “${filter.trim()}”`}
          </h2>
          <div className="space-y-6">
      <Group title="Appearance">
        <Field label="Accent colour">
          {/* Swatches rather than a dropdown: the thing being chosen is a
              colour, so showing the colours is the whole point. */}
          <div className="flex flex-wrap gap-1.5">
            {ACCENT_SWATCHES.map(([id, hex]) => (
              <button
                key={id}
                type="button"
                title={id}
                aria-label={id}
                aria-pressed={settings.accentColor === id}
                onClick={() => update({ accentColor: id as Settings['accentColor'] })}
                style={{ background: hex }}
                className={`size-6 cursor-default rounded-full transition ${
                  settings.accentColor === id
                    ? 'ring-2 ring-[var(--color-text-primary)] ring-offset-2 ring-offset-[var(--color-surface)]'
                    : 'hover:scale-110'
                }`}
              />
            ))}
          </div>
          <Note>
            A workspace with its own colour overrides this while you are in it.
          </Note>
        </Field>

        <Field label="Density">
          <select
            value={settings.uiDensity}
            onChange={(event) =>
              update({ uiDensity: event.target.value as Settings['uiDensity'] })
            }
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact — more on screen</option>
          </select>
        </Field>

        <Field label="Tab strip">
          <select
            value={settings.tabStripPosition}
            onChange={(event) =>
              update({
                tabStripPosition: event.target.value as Settings['tabStripPosition']
              })
            }
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          >
            <option value="top">Across the top</option>
            <option value="left">Down the left side</option>
          </select>
          <Note>
            Vertical keeps titles readable past a dozen tabs, at the cost of some window width.
          </Note>
        </Field>

        <Field label={`Glass ${settings.glassOpacity}%`}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={settings.glassOpacity}
            onChange={(event) => update({ glassOpacity: Number(event.target.value) })}
            className="w-full accent-[var(--color-accent)]"
          />
          {/* Said outright because it is a performance setting as much as a
              taste one, and that is not obvious from a slider. */}
          <Note>
            Lower is more transparent. At 100% the blur is switched off entirely, which is the
            faster setting on an older machine and on Windows 10, where the effect is ignored
            anyway.
          </Note>
        </Field>
      </Group>

      {/*
        Near the top on purpose. This is the first thing someone needs on a new
        install and the least useful thing on their five-hundredth launch, so it
        belongs where a new user will actually see it.
      */}
      <Group title="Import from another browser">
        <ImportSection />
      </Group>

      <Group title="Search">
        <Field label="Search engine">
          <select
            value={settings.searchEngineId}
            onChange={(event) =>
              update({ searchEngineId: event.target.value })
            }
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          >
            {Object.entries(SEARCH_ENGINES).map(([id, engine]) => (
              <option key={id} value={id}>
                {engine.name}
              </option>
            ))}
            {/* The user's own engines can be the default too. That is what makes
                a search partnership possible: the deal pays against a URL
                carrying your code, and it only earns if searches actually go
                there rather than needing a keyword typed first. */}
            {settings.customSearchEngines.length > 0 && (
              <optgroup label="Your engines">
                {settings.customSearchEngines.map((engine) => (
                  <option key={engine.id} value={engine.id}>
                    {engine.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>

        <Field label="Your own engines">
          <SearchEnginesSection />
        </Field>
      </Group>

      <Group title="Zoom">
        <SiteZoomSection />
      </Group>

      <Group title="Start page">
        <NewTabSection />
      </Group>

      <Group title="Slash Coin">
        <RewardsSection />
      </Group>

      <Group title="Sponsored placements">
        <SponsorSection />
      </Group>

      <Group title="Extensions">
        <ExtensionsSection />
      </Group>

      <Group title="Toolbar">
        <ToolbarSection />
      </Group>

      <Group title="Saved sign-ins">
        <PasswordsSection />
      </Group>

      <Group title="Content blocking">
        <Toggle
          label="Block ads and trackers"
          hint="Requests are cancelled before they leave your machine, so they cost no bandwidth or time."
          checked={settings.blockAds}
          onChange={(blockAds) => update({ blockAds })}
        />
        <Toggle
          label="Refuse known-malicious sites"
          hint="Checks the address against a list of known-bad domains."
          checked={settings.blockMaliciousSites}
          onChange={(blockMaliciousSites) => update({ blockMaliciousSites })}
        />
        {/*
          Given its own switch rather than being implied by the shield settings,
          because it is the one capability that reaches inside a page.
        */}
        <Toggle
          label="Let Slash run scripts inside pages"
          hint="Needed to remove YouTube's ad breaks, and to stop a blocked popup from breaking the link you clicked. Turning this off also frees the debugger connection Slash keeps on each tab."
          checked={settings.allowPageScripts}
          onChange={(allowPageScripts) => update({ allowPageScripts })}
        />
        {/*
          On by default and, until now, with no way to turn it off. Worth its own
          switch rather than being folded into "block ads": it is the only rule
          that edits a page's own data rather than cancelling a request, and
          somebody who wants to leave YouTube alone should be able to.
        */}
        <Toggle
          label="Try to remove YouTube's ad breaks"
          hint="Deletes the fields YouTube lists its ad breaks in, before the player reads them, and hides its ad panels. Needs the switch above. It does not touch sponsor segments a creator reads out. Be aware this does not always work: YouTube also inserts adverts on its servers, stitched into the same stream as the video, and an advert delivered that way cannot be removed from the video it is inside. Expect some adverts to get through."
          checked={settings.blockYouTubeVideoAds}
          disabled={!settings.allowPageScripts || !settings.blockAds}
          onChange={(blockYouTubeVideoAds) => update({ blockYouTubeVideoAds })}
        />
        {/*
          The switch above states an intention. This states an observation, and
          they came apart badly once: the strip stopped running entirely while
          every signal — the protocol reply, the log, this screen — said it was
          on. It stays silent until there is something to report.
        */}
        <ShieldVerificationNotice />
        {/*
          Said plainly, because a shield icon invites the assumption that this is
          antivirus. It is not, and a browser cannot be.
        */}
        <Note>
          This is not a virus scanner. A browser cannot inspect a file for malware — keep Windows
          Security on for that. The malicious-site list is also small and bundled; real coverage
          needs a continuously updated feed, which this build does not have.
        </Note>
      </Group>

      <Group title="Browsing memory">
        <Toggle
          label="Make visited pages searchable"
          hint="Records the address and title of pages you visit."
          checked={settings.indexHistory}
          onChange={(indexHistory) => update({ indexHistory })}
        />
        <Toggle
          label="Also index page text"
          hint="Lets you find a page by words that were on it, not just its title. Stored only on this device."
          checked={settings.indexPageContent}
          disabled={!settings.indexHistory}
          onChange={(indexPageContent) => update({ indexPageContent })}
        />
        <Toggle
          label="Keep private windows out of memory"
          checked={settings.excludePrivateFromMemory}
          onChange={(excludePrivateFromMemory) => update({ excludePrivateFromMemory })}
        />

        {/*
          `memoryRetentionDays` is enforced by `MemoryIndexer` on every prune and
          could only be changed by editing the settings row. A retention period
          nobody can see is not a promise anybody can rely on.
        */}
        <Field label={`Forget pages after — ${settings.memoryRetentionDays} days`}>
          <input
            type="range"
            min={7}
            max={365}
            step={7}
            value={settings.memoryRetentionDays}
            onChange={(event) =>
              update({ memoryRetentionDays: Number(event.currentTarget.value) })
            }
            className="w-full"
          />
        </Field>
        {/*
          Driven through its own channel rather than `settings:update`, because
          enabling it starts a download and the panel has to be able to show the
          progress and the failure. The handler writes the same setting, so the
          two routes cannot disagree.
        */}
        <Toggle
          label="Search by meaning as well as by words"
          hint={
            semantic?.state === 'unsupported'
              ? semantic.detail
              : semantic?.state === 'off' || !semantic
                ? `Runs a ${SEMANTIC_MODEL_MB} MB model that ships with Slash — offline, nothing sent anywhere. Works on titles alone, but far better with page text indexing on.`
                : semantic.detail
          }
          checked={
            semantic !== null && semantic.state !== 'off' && semantic.state !== 'unsupported'
          }
          disabled={semantic === null || semantic.state === 'unsupported'}
          onChange={setSemanticEnabled}
        />
      </Group>

      <Group title="Publisher configuration">
        <PublisherSection />
      </Group>

      <Group title="Profiles">
        <ProfileSection />
      </Group>

      <Group title="Saved addresses">
        <AddressSection />
      </Group>

      <Group title="Sync">
        <SyncSection />
      </Group>

      <Group title="Keyboard shortcuts">
        <ShortcutEditor />
      </Group>

      <Group title="Media keys">
        <Toggle
          label="Let the media keys control Slash"
          hint="Play/pause, next and previous act on whichever tab is making sound — or the last one that did."
          checked={settings.mediaKeysEnabled}
          onChange={(mediaKeysEnabled) => update({ mediaKeysEnabled })}
        />
        <Toggle
          label="Even when Slash is in the background"
          hint="Off by default. These keys are taken from the whole system, so with this on, pressing pause while listening to something else pauses a Slash tab instead — and nothing on screen explains why."
          checked={settings.mediaKeysAlwaysOn}
          onChange={(mediaKeysAlwaysOn) => update({ mediaKeysAlwaysOn })}
        />
      </Group>

      <Group title="Assistant">
        <Field label="Docked beside the page">
          <select
            value={settings.assistantId}
            onChange={(event) =>
              update({ assistantId: event.target.value as Settings['assistantId'] })
            }
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          >
            <option value="claude">Claude</option>
            <option value="chatgpt">ChatGPT</option>
            <option value="gemini">Gemini</option>
            <option value="perplexity">Perplexity</option>
            <option value="mistral">Le Chat</option>
            <option value="custom">Another address…</option>
          </select>
        </Field>

        {settings.assistantId === 'custom' && (
          <Field label="Address">
            <input
              type="url"
              value={settings.assistantCustomUrl}
              placeholder="https://"
              onChange={(event) => update({ assistantCustomUrl: event.target.value })}
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </Field>
        )}

        {/* The claim that matters, stated where somebody might otherwise assume
            the opposite. This is a website in a pane, not an integration: no key
            to enter, and the page you are reading is not sent anywhere. */}
        <Note>
          Ctrl+Shift+L opens this beside the page you are reading. It is the real site, signed in
          the way you normally sign in — so a subscription you already pay for works, and there is
          no API key to enter. Slash does not read the page or send anything to it; what reaches
          the assistant is what you type. Sending page content to an AI provider is a separate
          feature with its own switch.
        </Note>
      </Group>

      <Group title="Default browser">
        <DefaultBrowserField />
      </Group>

      <Group title="Restore points">
        <Toggle
          label="Reopen tabs from the last session"
          checked={settings.restoreTabsOnStartup}
          onChange={(restoreTabsOnStartup) => update({ restoreTabsOnStartup })}
        />
        <Toggle
          label="Also restore what you typed into forms"
          hint="Off by default: this writes form contents — including a half-typed password — into the local database."
          checked={settings.restoreFormState}
          onChange={(restoreFormState) => update({ restoreFormState })}
        />
      </Group>

      <Group title="Privacy">
        <Toggle
          label="Record browsing history"
          hint="When off, nothing is written to the history list at all."
          checked={settings.recordHistory}
          onChange={(recordHistory) => update({ recordHistory })}
        />
        <Toggle
          label="Warn before opening executable downloads"
          hint="Based on the file extension alone. It cannot tell whether a particular file is harmful."
          checked={settings.warnOnExecutableDownload}
          onChange={(warnOnExecutableDownload) => update({ warnOnExecutableDownload })}
        />
        {/*
          Not a setting — a signpost. Private browsing lives entirely in the
          application menu, which is hidden behind Alt on Windows, so the feature
          was effectively undiscoverable from the one screen people open when
          they go looking for privacy controls.
        */}
        <Note>
          <span className="text-[var(--color-text-primary)]">Private window</span> — Ctrl+Shift+N, or
          File → New Private Window. It records no history, no browsing memory and no reopenable
          tabs, and is left out of session restore. It does not hide you from the sites you visit or
          from your network.
        </Note>
      </Group>

      {/*
        The switch that decides whether the text of pages you are reading may be
        sent to an AI provider. It has always been enforced — in `AiEngine` and
        again in `TranslationService` — and until now there was nowhere to change
        it, so the stricter of the two AI privacy gates could only be moved by
        editing the settings row by hand. Principle 2 is that nothing leaves the
        machine unless the user turned it on; a switch nobody can reach does not
        satisfy that.
      */}
      <Group title="AI and your page content">
        <Toggle
          label="Let AI features read the text of pages"
          hint="Off by default. When off, the assistant sees only page titles and addresses, and Translate refuses rather than sending an article anywhere."
          checked={settings.aiMayReadPageContent}
          onChange={(aiMayReadPageContent) => update({ aiMayReadPageContent })}
        />
        <Note>
          This applies wherever page text would reach a provider, including Translate — one switch
          rather than several, so there is no second one to miss. It does not switch AI on: nothing
          contacts a provider until you connect one, and every action is still previewed and
          approved before it runs.
        </Note>
      </Group>

      <Group title="Downloads">
        <Toggle
          label="Ask where to save each file"
          checked={settings.askWhereToSaveDownloads}
          onChange={(askWhereToSaveDownloads) => update({ askWhereToSaveDownloads })}
        />

        <Toggle
          label="Offer to download links you copy"
          hint="When a Slash window comes into focus, checks whether the clipboard holds a link to a file and offers to fetch it. Slash only ever looks while it is the focused window — never in the background, and never while you are working in another application."
          checked={settings.watchClipboardForDownloads}
          onChange={(watchClipboardForDownloads) => update({ watchClipboardForDownloads })}
        />
        {settings.watchClipboardForDownloads && (
          <Note>
            Reading a clipboard means reading everything you copy, so this stays off unless you ask
            for it. Text that is not a single link to a file is discarded before anything else in
            the browser sees it.
          </Note>
        )}

        {/*
          `downloadDirectory` has always been honoured by `DownloadManager`; the
          only way to change it was to edit the settings row by hand. The path
          never comes from here — `downloadEngine:chooseFolder` opens a native
          chooser in main and returns what the OS gave it.
        */}
        <Field label="Save files to">
          <div className="flex items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-muted)]"
              title={settings.downloadDirectory || undefined}
            >
              {settings.downloadDirectory === ''
                ? 'Your system Downloads folder'
                : settings.downloadDirectory}
            </span>
            <button
              type="button"
              onClick={() => {
                void window.browser
                  .invoke('downloadEngine:chooseFolder', undefined)
                  .then((result) => {
                    // A cancelled dialog is an ordinary outcome; keep what was set.
                    if (result.ok && result.value.directory !== null) {
                      update({ downloadDirectory: result.value.directory })
                    }
                  })
              }}
              className="shrink-0 cursor-default rounded border border-[var(--color-border-subtle)] px-2 py-1 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              Change
            </button>
            {settings.downloadDirectory !== '' && (
              <button
                type="button"
                onClick={() => update({ downloadDirectory: '' })}
                className="shrink-0 cursor-default rounded border border-[var(--color-border-subtle)] px-2 py-1 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                Reset
              </button>
            )}
          </div>
        </Field>
      </Group>

      <Group title="Reading">
        <Toggle
          label="Hide the toolbar until the pointer reaches the top"
          hint="Gives the page the whole window while you read. The bars come back when you move the pointer to the top edge, and Ctrl+L still reaches the address bar from anywhere."
          checked={settings.autoHideChrome}
          onChange={(autoHideChrome) => update({ autoHideChrome })}
        />
      </Group>

      <Group title="Right-click menu">
        <Toggle
          label="Restore the menu on sites that block it"
          hint="Some sites cancel the right-click event to stop you copying a link or saving an image. Every browser respects that, including Chrome — this makes Slash ignore it. The cost: a site with a genuinely useful menu of its own loses it, YouTube's player menu included."
          checked={settings.restoreContextMenu}
          onChange={(restoreContextMenu) => update({ restoreContextMenu })}
        />
      </Group>

      <Group title="Download acceleration">
        <Toggle
          label="Download large files with several connections"
          hint="Slash takes downloads over 4 MB from Chromium and fetches them in parallel. Smaller ones are left alone: splitting saves less than the extra request costs, and a small download is often a form result that cannot be asked for twice."
          checked={settings.accelerateDownloads}
          onChange={(accelerateDownloads) => update({ accelerateDownloads })}
        />

        <Field label={`Connections per file — ${settings.downloadConnections}`}>
          <input
            type="range"
            min={1}
            max={16}
            step={1}
            value={settings.downloadConnections}
            onChange={(event) => update({ downloadConnections: Number(event.target.value) })}
            className="w-full accent-[var(--color-accent)]"
          />
          {/* Said plainly, because more is not always better and servers
              disagree about it. */}
          <Note>
            More connections help on a fast link and a server that allows them. Some servers refuse
            or throttle several at once, and a few count them against a per-user limit — if
            downloads from a particular site get slower, lower this.
          </Note>
        </Field>

        <Toggle
          label="Sort downloads into folders by kind"
          hint="Video, Music, Images, Documents, Archives and Programs, inside your downloads folder. Anything Slash cannot classify stays at the top level rather than going into an Other folder nobody looks in."
          checked={settings.sortDownloadsByCategory}
          onChange={(sortDownloadsByCategory) => update({ sortDownloadsByCategory })}
        />

        <Field label="When everything has finished">
          <select
            value={settings.downloadCompletionAction}
            onChange={(event) =>
              update({
                downloadCompletionAction: event.target
                  .value as typeof settings.downloadCompletionAction
              })
            }
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          >
            <option value="nothing">Do nothing</option>
            <option value="notify">Show a notification</option>
            <option value="quit">Close Slash</option>
            <option value="sleep">Sleep this computer</option>
            <option value="shutdown">Shut down this computer</option>
          </select>
          <Note>
            Anything that ends the session waits 30 seconds first and can be called off. It only
            runs when the queue is genuinely finished — a paused or failed download stops it,
            because those are transfers you meant to come back to.
          </Note>
        </Field>

        <Toggle
          label="Use yt-dlp for sites Slash cannot download"
          hint="Some sites — YouTube among them — serve video in a form no browser can turn into a file on its own. Reaching those means defeating the site's access controls, which Slash does not do. Those pages are handed to yt-dlp, a separate public-domain program, and every download it makes is labelled so it never looks like one Slash made itself."
          checked={settings.useExternalDownloader}
          onChange={(useExternalDownloader) => update({ useExternalDownloader })}
        />

        <Toggle
          label="Fetch yt-dlp automatically on first run"
          hint="Slash downloads it once, from the official yt-dlp repository, and checks the bytes against the published SHA-512 before installing. It goes beside your profile, not into Program Files, so updating never needs administrator rights and uninstalling Slash takes it with it. This is the only thing a fresh install fetches on its own — turn it off and the button below does the same job when you ask."
          checked={settings.ytDlpInstallOnFirstRun}
          onChange={(ytDlpInstallOnFirstRun) => update({ ytDlpInstallOnFirstRun })}
        />

        <Toggle
          label="Keep yt-dlp up to date"
          hint="Checks for a newer release every couple of weeks and replaces it the same way, checksum and all. This matters more than it sounds: yt-dlp ships extractor fixes every few weeks, and a stale copy does not fail loudly — it just stops being able to download particular sites. Only ever replaces the copy Slash installed beside your profile; a yt-dlp you installed yourself is left alone."
          checked={settings.ytDlpAutoUpdate}
          onChange={(ytDlpAutoUpdate) => update({ ytDlpAutoUpdate })}
        />

        {settings.useExternalDownloader && <ExternalDownloaderRow />}

        {settings.useExternalDownloader && (
          <Field label="Path to yt-dlp">
            <input
              value={settings.externalDownloaderPath}
              onChange={(event) => update({ externalDownloaderPath: event.target.value })}
              placeholder="Leave empty to find it on your PATH"
              className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <Note>
              Only needed if yt-dlp is not on your PATH.
            </Note>
          </Field>
        )}

        <Toggle
          label="Notify when a download finishes"
          hint="Names the file, and clicking the notification shows it in your file manager. Separate from the queue action above, which is about what happens when everything finishes."
          checked={settings.notifyOnDownloadComplete}
          onChange={(notifyOnDownloadComplete) => update({ notifyOnDownloadComplete })}
        />

        <Field label="Speed limit">
          <select
            value={String(settings.downloadBandwidthLimit)}
            onChange={(event) =>
              update({ downloadBandwidthLimit: Number(event.target.value) })
            }
            className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          >
            <option value="0">No limit</option>
            <option value="262144">256 KB/s</option>
            <option value="524288">512 KB/s</option>
            <option value="1048576">1 MB/s</option>
            <option value="2097152">2 MB/s</option>
            <option value="5242880">5 MB/s</option>
            <option value="10485760">10 MB/s</option>
          </select>
          <Note>
            Across all downloads at once. Useful when a large file is making a call or a game
            unusable.
          </Note>
        </Field>
      </Group>

      <Group title="Video downloads">
        <Toggle
          label="Find downloadable video and audio on pages"
          hint="Watches what a page fetches, so a video can be saved even when the page offers no link. This is the one feature that costs something on every page — switching it off removes the check entirely, not just its result."
          checked={settings.detectPageMedia}
          onChange={(detectPageMedia) => update({ detectPageMedia })}
        />
        <Toggle
          label="Show a download button over the video"
          hint="A small panel in the corner of the page while something downloadable is playing. Off leaves the toolbar button and the Downloads panel, which find the same files."
          checked={settings.mediaOverlayButton}
          disabled={!settings.detectPageMedia}
          onChange={(mediaOverlayButton) => update({ mediaOverlayButton })}
        />
        {/* The limit, stated where somebody would otherwise conclude the
            feature is broken on the site they tried it on. */}
        <Note>
          Complete files only. Video delivered as an adaptive stream — thousands of short segments —
          is not reassembled, and video protected by DRM cannot be downloaded at all. Slash says
          which of those it found rather than offering a file that will not play.
        </Note>
      </Group>

      {/*
        Capabilities that genuinely are not built are listed as such rather than
        shown as controls, so nothing on this screen implies something the build
        cannot do.

        The reverse matters just as much: this group claimed private browsing did
        not exist for as long as private browsing existed, so the one place a
        user goes to check told them the feature was missing. A stale "not built"
        is as much a lie as an overstated capability.
      */}
      <Group title="Updates">
        <UpdateSection autoCheck={settings.updateAutoCheck}
              autoDownload={settings.updateAutoDownload}
              feedUrl={settings.updateFeedUrl} onFeedChange={update} />
      </Group>

      <Group title="Crash reports">
        <DiagnosticsSection />
      </Group>

      <Group title="Not built yet">
        <Note>
          <span className="text-[var(--color-text-primary)]">Automatic updates.</span> This build
          cannot update itself, and it is not code-signed. Chromium ships security fixes roughly
          monthly, so check for a newer version yourself rather than assuming this one is current.
          Both need a signing certificate before they can exist — an unsigned update channel would be
          an unauthenticated way onto your machine, which is worse than none.
        </Note>
      </Group>

        {/* Nothing matched: say so, rather than leaving an empty panel that
            looks like the settings failed to load. */}
        {filter.trim() !== '' && !Object.keys(GROUP_META).some((t) => groupMatches(t, filter)) && (
          <Note>
            Nothing matches &ldquo;{filter.trim()}&rdquo;.
          </Note>
        )}
          </div>
        </div>
      </div>
     </SettingsCategory.Provider>
    </SettingsFilter.Provider>
  )
}

/** Kept in step with useAppearance's ACCENTS table. */
const ACCENT_SWATCHES: readonly [string, string][] = [
  ['default', '#6ea8fe'],
  ['blue', '#5b9dff'],
  ['green', '#4ade80'],
  ['purple', '#a78bfa'],
  ['amber', '#fbbf24'],
  ['rose', '#fb7185'],
  ['teal', '#2dd4bf']
]

/**
 * The current filter text, read by every Group.
 *
 * A context rather than a prop threaded through eleven call sites: the filter is
 * ambient to the whole panel, and passing it by hand would mean a new group
 * silently opting out of search by forgetting an argument.
 */
const SettingsFilter = createContext('')

/**
 * The category currently selected in the rail.
 *
 * A context for the same reason the filter is one: it is ambient to the whole
 * screen, and threading it through seventeen call sites would mean a new group
 * silently escaping the navigation by forgetting an argument.
 */
const SettingsCategory = createContext<Category>('Appearance')

/**
 * Extra words each group matches on, beyond its heading.
 *
 * Matching only headings would mean searching "zoom" or "cookies" found
 * nothing, because those words live in the controls rather than the titles.
 * Listed here rather than scraped from rendered children, which would depend on
 * how deeply a control happens to be nested — and kept in one table so the
 * groups and the "nothing matched" message can never disagree about what
 * matches.
 */
/**
 * Which category each group belongs to, and what it matches on in search.
 *
 * One table rather than two, so a group cannot end up in the navigation without
 * being findable, or findable without a home. The categories exist because
 * seventeen groups in a 380px scroll is not a settings screen, it is a list —
 * which is what made this the least usable part of the browser.
 */
const CATEGORIES = [
  'Appearance',
  'Search',
  'Privacy & security',
  'Browsing',
  'Extensions',
  'Earning',
  'About Slash'
] as const

type Category = (typeof CATEGORIES)[number]

const GROUP_META: Record<string, { category: Category; keywords: string }> = {
  Appearance: {
    category: 'Appearance',
    keywords: 'theme accent colour color density glass tabs vertical strip dark light'
  },
  'Start page': {
    category: 'Appearance',
    keywords: 'new tab home background image wallpaper gradient start page appearance'
  },
  Toolbar: {
    category: 'Appearance',
    keywords: 'toolbar buttons icons hide show customise customize clutter'
  },
  Search: {
    category: 'Search',
    keywords: 'engine google duckduckgo bing startpage keyword shortcut custom default'
  },
  Zoom: { category: 'Search', keywords: 'zoom per-site text size magnify scale percent' },
  'Content blocking': {
    category: 'Privacy & security',
    keywords: 'ads trackers shield popups youtube malicious scripts'
  },
  Privacy: {
    category: 'Privacy & security',
    keywords: 'cookies clear data private excluded origins'
  },
  Reading: {
    category: 'Browsing',
    keywords: 'auto hide chrome toolbar focus distraction free reading fullscreen immersive'
  },
  'AI and your page content': {
    category: 'Privacy & security',
    keywords: 'ai page content read translate assistant provider privacy egress send text llm'
  },
  'Saved sign-ins': {
    category: 'Privacy & security',
    keywords: 'password passwords login logins credentials autofill fill vault account'
  },
  Profiles: {
    category: 'Privacy & security',
    keywords: 'people accounts separate user switch multiple person work personal'
  },
  'Saved addresses': {
    category: 'Privacy & security',
    keywords: 'autofill address delivery shipping billing postcode form checkout card payment'
  },
  Sync: {
    category: 'Privacy & security',
    keywords: 'devices bookmarks reading list encrypted passphrase account cross-device backup'
  },
  'Media keys': {
    category: 'Browsing',
    keywords: 'play pause next previous track hardware headphones music video global'
  },
  'Keyboard shortcuts': {
    category: 'Browsing',
    keywords: 'keys keybinding hotkey accelerator remap rebind ctrl alt shift shortcut customise'
  },
  'Restore points': { category: 'Browsing', keywords: 'session snapshot restore tabs startup' },
  'Right-click menu': {
    category: 'Browsing',
    keywords: 'right click context menu blocked copy link save image restore'
  },
  'Download acceleration': {
    category: 'Browsing',
    keywords: 'download accelerate connections speed limit bandwidth parallel segments idm manager fast'
  },
  'Video downloads': {
    category: 'Browsing',
    keywords: 'video download media detect stream mp4 save youtube idm audio'
  },
  Assistant: {
    category: 'Browsing',
    keywords: 'ai assistant claude chatgpt gemini perplexity chat sidebar split pane subscription'
  },
  'Default browser': {
    category: 'Browsing',
    keywords: 'default browser links open http https windows settings associations'
  },
  'Browsing memory': {
    category: 'Browsing',
    keywords: 'index semantic embedding history pages search'
  },
  Downloads: { category: 'Browsing', keywords: 'folder location ask save' },
  Extensions: {
    category: 'Extensions',
    keywords: 'extension extensions addon add-on plugin unpacked crx chrome web store'
  },
  'Slash Coin': {
    category: 'Earning',
    keywords:
      'slash coin coins rewards reward earn earning balance points crypto currency sign in login google collect'
  },
  'Sponsored placements': {
    category: 'Earning',
    keywords: 'sponsored ads advertising sponsor revenue tile support funding'
  },
  'Import from another browser': {
    category: 'About Slash',
    keywords: 'chrome edge bookmarks history migrate transfer'
  },
  Updates: { category: 'About Slash', keywords: 'version upgrade release' },
  'Publisher configuration': {
    category: 'About Slash',
    keywords: 'remote config operator managed enterprise notice flags rollout endpoint'
  },
  'Crash reports': { category: 'About Slash', keywords: 'diagnostics minidump' },
  'Not built yet': { category: 'About Slash', keywords: 'roadmap missing planned' }
}

function groupMatches(title: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return `${title} ${GROUP_META[title]?.keywords ?? ''}`.toLowerCase().includes(q)
}

/**
 * Whether Slash is the default browser, and the one route to changing it.
 *
 * Deliberately not a switch. Windows has not let an application set itself as
 * the default since Windows 8 — the association is signed against the user and
 * the ProgId, and anything written from code is reverted without an error. A
 * toggle here would appear to work and then quietly not have.
 */
function DefaultBrowserField(): React.JSX.Element {
  const [status, setStatus] = useState<{ isDefault: boolean; supported: boolean } | null>(null)

  const refresh = (): void => {
    void window.browser.invoke('system:defaultBrowser', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }
  useEffect(refresh, [])

  if (status?.supported === false) {
    return (
      <Note>
        Setting the default browser is not available on this platform.
      </Note>
    )
  }

  return (
    <div className="space-y-2">
      <Note>
        {status === null
          ? 'Checking…'
          : status.isDefault
            ? 'Slash is your default browser. Links from other applications open here.'
            : 'Slash is not your default browser.'}
      </Note>

      {status !== null && !status.isDefault && (
        <>
          <button
            type="button"
            onClick={() => {
              void window.browser
                .invoke('system:openDefaultBrowserSettings', undefined)
                // Re-read from the registry rather than assumed: the user may
                // not have gone through with it, and a screen claiming
                // otherwise is worse than one that does not know.
                .then(() =>
                  setTimeout(() => {
                    void window.browser
                      .invoke('system:refreshDefaultBrowser', undefined)
                      .then((result) => {
                        if (result.ok) setStatus(result.value)
                      })
                  }, 4000)
                )
            }}
            className="cursor-pointer rounded-lg border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Open Windows settings
          </button>
          <Note>
            Windows does not let an application make itself the default. This opens the Default apps
            screen, where Slash can be chosen for http and https.
          </Note>
        </>
      )}
    </div>
  )
}

function Group({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element | null {
  const query = useContext(SettingsFilter)
  const category = useContext(SettingsCategory)

  // Searching looks across every category — someone typing "cookies" should not
  // have to already know which section it lives in. Only with an empty box does
  // the rail decide what is shown.
  if (query.trim() === '' && GROUP_META[title]?.category !== category) return null
  if (!groupMatches(title, query)) return null

  return (
    <section>
      {/*
        A group whose name is the category's is not telling anybody anything —
        the page heading directly above already says "Appearance", and repeating
        it read as a rendering fault rather than as structure.
      */}
      {title !== category && (
        <h3 className="mb-2.5 px-1 text-[13px] font-semibold text-[var(--color-text-primary)]">
          {title}
        </h3>
      )}
      {/*
        One surface per group, with a hairline between rows — the shape every
        other browser's settings screen uses, and the reason theirs can be
        skimmed. Seventeen groups of free-floating paragraphs had no edges at
        all, so nothing told the eye where one setting ended and the next began.
      */}
      {/*
        `Field` and `Toggle` both render a <label> and carry their own padding,
        so the dividers can run the full width of the card. Anything else a
        group contains — a grid of presets, a list, a stray paragraph — has
        none, and went edge to edge against the border. The variant pads those
        without touching the rows.
      */}
      <div className="divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.035] shadow-sm [&>*:not(label):not(.settings-row)]:px-3.5 [&>*:not(label):not(.settings-row)]:py-3">
        {children}
      </div>
    </section>
  )
}

/**
 * A labelled control.
 *
 * Stacked rather than side-by-side, unlike `Toggle`: the controls here are
 * sliders, text fields and selects that need room, and squeezing them into a
 * right-hand column makes a path field four characters wide. The label carries
 * the weight instead, and the row's padding does the separating.
 */
/**
 * An explanation under a control.
 *
 * Wraps `HintText` so every one of these gets the same treatment: a first
 * sentence, and the rest behind More. They were plain paragraphs of three or
 * four lines, twenty of them down one screen, and the effect was a wall — the
 * settings were hard to use *because* they were thorough.
 *
 * Only splits when the child is a single string. Several of these carry markup
 * or an interpolated value, and those render whole rather than being cut at a
 * full stop that might be inside them.
 */
function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  if (typeof children === 'string') {
    const { lead, rest } = splitHint(children)
    return <HintText lead={lead} rest={rest} />
  }
  return (
    <span className="mt-1.5 block text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
      {children}
    </span>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  const { lead, rest } = splitHint(hint)
  return (
    // A <div>, not a <label>. The control here is arbitrary — a select, a
    // slider, a text field — so it cannot be named by id from out here, and an
    // implicit association would be claimed by the "More" disclosure below
    // rather than by the control, for the same reason it was in `Toggle`.
    // Each control inside carries its own accessible name.
    <div className="settings-row block px-3.5 py-3">
      <span className="mb-1.5 block text-[13px] font-medium text-[var(--color-text-primary)]">
        {label}
      </span>
      {lead !== '' && <HintText lead={lead} rest={rest} />}
      {children}
    </div>
  )
}

/**
 * Install, update and remove the copy of yt-dlp that Slash manages.
 *
 * Not bundled with the installer on purpose, and the copy says so: yt-dlp ships
 * extractor fixes every few weeks because the sites keep moving, Slash has no
 * auto-update of its own, and a version frozen into the installer would break
 * within a month with no way to repair it short of reinstalling.
 */
function ExternalDownloaderRow(): React.JSX.Element {
  const [status, setStatus] = useState<InvokeResponse<'external:status'> | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refresh = (): void => {
    void window.browser.invoke('external:status', undefined).then((result) => {
      if (result.ok) setStatus(result.value)
    })
  }

  useEffect(refresh, [])

  const install = (): void => {
    setBusy(true)
    setNote('Fetching the current release…')
    void window.browser.invoke('external:install', undefined).then((result) => {
      setBusy(false)
      setNote(result.ok ? result.value.note : 'That did not work.')
      refresh()
    })
  }

  const remove = (): void => {
    setBusy(true)
    void window.browser.invoke('external:uninstall', undefined).then((result) => {
      setBusy(false)
      setNote(result.ok ? result.value.note : 'Nothing to remove.')
      refresh()
    })
  }

  return (
    <Field label="yt-dlp">
      <Note>
        {status === null
          ? 'Checking…'
          : status.installed
            ? `Found ${status.version ?? 'an unknown version'}${status.managed ? ', installed by Slash' : ' on your PATH'}.`
            : 'Not installed. Slash can fetch it from the project’s official releases and check it against the published checksum.'}
      </Note>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={install}
          className="cursor-pointer rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] transition hover:border-[var(--color-accent)] disabled:opacity-40"
        >
          {busy ? 'Working…' : status?.managed ? 'Update' : 'Install yt-dlp'}
        </button>
        {status?.managed === true && (
          <button
            type="button"
            disabled={busy}
            onClick={remove}
            className="cursor-pointer rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] transition hover:border-[var(--color-danger)] disabled:opacity-40"
          >
            Remove
          </button>
        )}
      </div>

      {note !== null && (
        <p className="mt-2 text-[11px] text-[var(--color-text-muted)]" role="status">
          {note}
        </p>
      )}

      <Note>
        Kept out of the Slash installer deliberately. yt-dlp is updated every few weeks as sites
        change, and a copy frozen into the installer would stop working with no way to fix it.
        Installing here keeps it current and updatable.
      </Note>
    </Field>
  )
}
