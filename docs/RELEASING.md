# Releasing Slash

Cutting a release is three commands:

```bash
npm version 0.2.0 --no-git-tag-version    # the workflow refuses a tag that disagrees with this
git commit -am "release: 0.2.0"
git tag v0.2.0 && git push && git push --tags
```

CI then builds on a Windows runner — install, typecheck, lint, test, fetch
ffmpeg, package, measure — and publishes the installer to the **public releases
repository**. About ten minutes, most of it packaging. Nothing else is needed:
browsers find it on their next check and offer it.

## Why two repositories

The code repository is private. **A private repository's release assets are not
publicly downloadable**, and the browser carries no credentials — so an
installer published here would fail to download on every machine, silently, on
every check. That is the worst way for an update system to be broken, because
nothing reports it.

So installers go somewhere public that holds nothing else:

| Repository | Visibility | Holds |
|---|---|---|
| `luckmeth/slash-browser` | private | the source, this workflow |
| `luckmeth/slash-releases` | **public** | installers, checksums, `latest.json` |

## One-time setup

**1. Create the releases repository, public, with a README.**

```bash
gh repo create luckmeth/slash-releases --public --add-readme \
  --description "Installers for Slash. The source lives elsewhere."
```

The README matters: `gh release create` makes the tag against that
repository's default branch, and a repository with no commits has no branch to
tag.

**2. Make a fine-grained personal access token** at
<https://github.com/settings/personal-access-tokens>:

- Repository access: **only** `luckmeth/slash-releases`
- Permissions: **Contents → Read and write**, nothing else
- Expiry: whatever you will actually remember to renew

That scope is the point. The token can publish releases to that one public
repository and cannot read a line of the private one. `GITHUB_TOKEN` cannot be
used here at all — it is scoped to the repository the workflow runs in.

**3. Add them to `luckmeth/slash-browser`:**

| Where | Name | Value |
|---|---|---|
| Settings → Secrets and variables → Actions → **Secrets** | `RELEASES_TOKEN` | the token from step 2 |
| Settings → Secrets and variables → Actions → **Variables** | `RELEASES_REPO` | `luckmeth/slash-releases` |

Both are checked before the build starts, so a missing one costs thirty seconds
rather than ten minutes.

## What a release contains

| Asset | What it is |
|---|---|
| `Slash-0.2.0-x64.exe` | The NSIS installer |
| `latest.json` | The update feed, in the exact shape the browser parses |

The SHA-512 and the byte size are computed in CI and appear in the release
notes and the job summary. Nobody types a checksum: transcribing 128 characters
is the one mistake that makes every update fail verification, and the failure
looks like a broken updater rather than a typo.

## How a browser finds it

`updateFeedUrl` defaults to:

```
https://github.com/luckmeth/slash-releases/releases/latest/download/latest.json
```

GitHub resolves `releases/latest/download/<asset>` to the newest release, so
tagging *is* publishing. The request carries no key and no identifier and the
answer is the same for everybody, so a check cannot count installations.
Emptying that field in Settings stops it entirely.

Then, in the browser:

1. Checks 45 seconds after launch — late enough never to compete with the first
   paint — and every six hours.
2. Downloads the package when one is newer, hashing it **as it arrives**.
3. Deletes it and refuses if the hash does not match what the feed published.
4. Shows a chip in the toolbar: *Restart to update*. Clicking it runs the
   installer.

Windows warns about an unknown publisher, because the build is unsigned. The
checksum proves the file is the one that was published — not who published it.
Code signing is what fixes that, and the signed install path is already written
for the day there is a certificate.

## The first update is different

Every copy of Slash checks whatever feed was compiled into it. The builds
installed before this change point at the **Supabase** feed, so the 0.1.0 → 0.2.0
hop has to go through that once:

1. Tag and let CI publish 0.2.0 to the releases repository as usual.
2. Open **Slash Operations → Releases**, paste the installer URL from that
   release, and publish. Operations downloads the file and computes the
   checksum itself.

From 0.2.0 onwards every client is on the GitHub feed and no manual step
remains.

## Pulling a bad release

Delete the release, or mark it a pre-release, in `slash-releases`. `latest` then
resolves to the one before it and browsers move back on their next check.

If a client already downloaded the bad one, it verified against a checksum that
was correct at the time — a pulled release does not un-download it. Cut a new
version rather than relying on the pull.

## Testing it once, properly

Before relying on any of this, do the round trip:

1. Publish 0.2.0.
2. Install **0.1.0** on a machine.
3. Open it and wait a minute. The chip should appear, download and verify.

The download-and-verify path is unit-tested and has never run against a real
release. That one manual round trip is worth more than the tests, because it is
the only thing that exercises the feed, the host rule and the installer
together.

## If something goes wrong

| Symptom | Cause |
|---|---|
| Fails at "Check the tag matches package.json" | Tagged without bumping. Bump, commit, delete the tag, re-tag. |
| Fails at "Check the release destination" | `RELEASES_REPO` or `RELEASES_TOKEN` is missing. See the setup above. |
| Fails at "Fetch ffmpeg" | The upstream download or its checksum changed. See `scripts/fetch-ffmpeg.mjs`. |
| `gh release create` returns 404 | The token cannot see the releases repository, or the repository has no commits. |
| Browsers never notice | The releases repository is not public, or `updateFeedUrl` was cleared. |
| "The package did not match its published checksum" | The asset was replaced after publishing. Cut a new version. |
