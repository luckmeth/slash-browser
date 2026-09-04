# Launch checklist

Two things stand between Slash and being something other people can use and that earns money.
**Neither is a coding task** — the code for both is written and waiting. They need a purchase and a
conversation.

---

## 1. Code-signing certificate — the hard blocker

Without a signature:

- Windows SmartScreen shows **"unknown publisher"** to every user who downloads the installer, and
  most of them will stop there.
- **Auto-update cannot be switched on.** `UpdateService` deliberately checks a feed and refuses to
  install, because an unsigned auto-installer is an unauthenticated code path onto the user's
  machine. That refusal is the correct behaviour, not a missing feature.
- Chromium ships security fixes roughly monthly, and a browser that cannot update itself is a
  knowingly vulnerable renderer with no route to a patch.

### What to buy

An **OV (Organisation Validation)** code-signing certificate is enough. EV costs more and its main
advantage is immediate SmartScreen reputation; OV builds reputation over a few hundred downloads.

Issuers: DigiCert, Sectigo, SSL.com, GlobalSign. Expect roughly **$200–500/year**, plus a few days
for them to verify the business exists (registration documents, a verifiable phone listing).

**Since June 2023 the private key must live on hardware** — a FIPS token or a cloud HSM. You cannot
be emailed a `.pfx` any more. Cloud HSM (e.g. SSL.com eSigner, DigiCert KeyLocker) is easier for
automated builds than a physical USB token, which needs to be plugged into whatever machine runs
`npm run package`.

### What changes in this repo

`electron-builder.yml` already sets `signAndEditExecutable` and update-signature verification. Once
you hold a certificate:

1. Provide it to electron-builder — `CSC_LINK` and `CSC_KEY_PASSWORD` for a file-based cert, or the
   issuer's signing tool for an HSM.
2. Add a `publish` block (GitHub Releases is free and works):
   ```yaml
   publish:
     provider: github
     owner: <your-github-user>
     repo: <repo>
   ```
3. Set the feed URL in Settings → Updates. It is empty by default, which is why a fresh install
   contacts nothing.
4. Only then turn on installing updates rather than only reporting them.

---

## 2. Search partnership — the actual revenue

This is how Firefox, Brave, Vivaldi and Opera are funded. It costs users nothing, fits the privacy
story, and pays far more per user than a sponsored tile ever will at small scale.

**The code side is done.** As of the custom-default-engine change, one of your own search engines
can be the default — which is the thing a partnership requires, because the deal pays against a URL
carrying your partner code and earns nothing if searches do not actually go there.

### Who to approach

Lower barriers than Google, and all a better fit for this browser's positioning:

| Partner | Why |
|---|---|
| **Ecosia** | Runs a partner programme; the environmental angle pairs well with a privacy pitch |
| **DuckDuckGo** | Established affiliate/partner arrangements |
| **Brave Search** | Independent index, actively courting distribution |
| **Startpage** | Privacy-first, Google results |

Search for their "partnerships" or "business development" contact. Expect to be asked for install
base, how you distribute, and which markets.

### Once you have a code

Settings → Search → *Your own engines*, then set it as the default:

```
Name:    Ecosia
Keyword: ec
URL:     https://www.ecosia.org/search?q=%s&tt=YOURCODE
```

Verify the code survives: type a search, and check the address bar of the results page contains your
parameter. `UrlResolver.test.ts` covers this path.

---

## 3. Order of operations

The sequence matters, because most of it does not work in a different order:

1. **Certificate** → sign the installer → SmartScreen stops warning.
2. **Publish a release feed** → turn on real auto-update.
3. **Grow an audience.** Nothing below this line earns anything without one.
4. **Search partnership.** Realistic once you have real install numbers to quote.
5. **Sponsored tiles.** Direct deals only — programmatic networks like AdSense do not permit serving
   into a desktop application surface, and attempting it risks account termination. Needs a business
   entity that can invoice. Revenue is approximately zero below tens of thousands of daily users.
6. **Slash Pro**, if wanted — sync, AI credits. The most controllable revenue and the one that does
   not depend on ad markets or audience scale.

Donations (GitHub Sponsors, Open Collective) are the only item here that can earn today, at any
size.
