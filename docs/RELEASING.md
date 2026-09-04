# Releasing Slash

Cutting a release is three commands. What follows explains what happens, and
the one decision you have to make once: **where the update feed lives.**

```bash
# 1. bump the version — the workflow refuses a tag that disagrees with it
npm version 0.2.0 --no-git-tag-version
git commit -am "release: 0.2.0"

# 2. tag and push
git tag v0.2.0
git push && git push --tags
```

`.github/workflows/release.yml` then runs on a Windows runner: install,
typecheck, lint, test, fetch ffmpeg, package, measure, publish. It takes about
ten minutes, most of it packaging.

## What it produces

| Asset | What it is |
|---|---|
| `Slash-0.2.0-x64.exe` | The NSIS installer |
| `latest.json` | The update feed, in the exact shape the browser parses |

The release notes carry the SHA-512 and the byte size, and so does the job
summary. Nobody types a checksum by hand — transcribing 128 characters is the
one mistake that makes every update fail verification, and the failure looks
like a broken updater rather than a typo.

## The decision: where the feed lives

The browser reads **one URL** (`updateFeedUrl` in Settings) to learn whether a
newer version exists. It will fetch the installer itself only from Slash's own
Supabase host or from a GitHub release asset — a feed that could name any host
could make every copy of Slash download an executable from anywhere.

There are two ways to serve that feed, and they differ in one thing: whether
publishing is automatic.

### A. Supabase feed — the default, and what ships today

`updateFeedUrl` defaults to the `releases` table read through PostgREST.
Published rows carry a public read policy, so no deployment and no key is
needed.

Publishing is a manual step: **Slash Operations → Releases**, paste the
installer URL from the GitHub release, press Publish. Operations downloads the
file, computes the checksum itself, and writes the row.

- **Cost:** one paste per release. Forget it and nobody gets the update.
- **Benefit:** pulling a bad release is instant and needs nobody's cooperation —
  unpublish the row and the previous release starts being served again on the
  next check. Channels (`stable`, `beta`) work.

### B. GitHub feed — fully automatic, needs a public repository

Point `updateFeedUrl` at:

```
https://github.com/<owner>/<repo>/releases/latest/download/latest.json
```

That URL always resolves to the newest release's asset, so tagging is the whole
of publishing. No database, no secret, nothing to remember.

**It only works while the repository is public.** A private repository's
release assets are not publicly downloadable and the updater carries no
credentials — every client would silently fail to check. If the code should stay
private, make a second, public repository that holds nothing but releases and
publish the assets there.

To pull a bad release, delete it or mark it a pre-release; `latest` then points
at the one before.

### C. Both, if you want automation *and* a kill switch

Nothing stops you publishing to Supabase as well. There is an optional job in
the workflow, off behind `vars.PUBLISH_TO_FEED`, that writes the row from CI —
but it needs `SUPABASE_SERVICE_ROLE_KEY` as a repository secret, and **that key
bypasses every row-level security policy in the database**. Anyone who can push
a workflow change can then read or write everything. Publishing from Operations
costs one paste and keeps that key on your own machine.

## What the browser does with it

1. Checks on launch (45 seconds in, so it never competes with the first paint)
   and every six hours. Nothing is contacted if `updateFeedUrl` is empty.
2. Downloads the package when one is newer, hashing it **as it arrives**.
3. Deletes it and refuses if the hash does not match what the feed published.
4. Shows a chip in the browser chrome. Clicking it runs the installer.

Windows will warn about an unknown publisher: the build is unsigned, and the
checksum proves the file is the one that was published, not who published it.
Code signing is the thing that fixes that, and the signed install path is
already written for the day there is a certificate.

## Testing it once, properly

Before relying on any of this, do the round trip:

1. Publish 0.2.0 by whichever route you chose.
2. Install **0.1.0** (an older installer) on a machine.
3. Open it. Within a minute the chip should appear, download, and verify.

The download-and-verify path is unit-tested; it has never run against a real
release. One manual round trip is worth more than the tests here, because it is
the only thing that exercises the feed, the host rule and the installer
together.

## If something goes wrong

| Symptom | Cause |
|---|---|
| Workflow fails at "Check the tag matches package.json" | You tagged without bumping. Bump, commit, delete the tag, re-tag. |
| Workflow fails at "Fetch ffmpeg" | The upstream download or its checksum changed. See `scripts/fetch-ffmpeg.mjs`. |
| Browsers never see the release | The feed was not published (route A), or the repository is private (route B). |
| "The package did not match its published checksum" | The asset was replaced after publishing. Re-publish with the new checksum. |
