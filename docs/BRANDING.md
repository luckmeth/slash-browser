# Changing the logo

There is one command.

```bash
npm run logo -- path/to/your-logo.png
```

Or drop the file at `build/logo-source.png` and run `npm run logo` with no argument.

That regenerates:

| File | What it becomes |
|---|---|
| `build/icon.png` (1024×1024) | The icon embedded in `Slash.exe` — taskbar, Alt+Tab, window, desktop shortcut |
| `build/icon.ico` (16–256px) | The installer and uninstaller icon, and the Add/Remove Programs entry |

Then `npm run package` to see it on a real build.

## What the source file should be

- **Square.** Non-square input is padded, and you get a warning. An app icon wants the *mark* on its
  own — a wordmark at 16px is a smudge.
- **At least 512×512**, ideally 1024. Anything smaller is upscaled and looks soft on a desktop icon.
- **PNG with transparency.** The icon sits on the taskbar, on the desktop, and on whatever wallpaper
  the user has. A baked-in background shows as a rectangle.

## The one thing the command does not change

`src/renderer/components/BrandMark.tsx` — the mark drawn inside the application: onboarding, the
start page, empty states.

It is inline SVG on purpose. It recolours with the surrounding text, stays crisp at every size, and
needs no CSP allowance for an image asset. A PNG cannot do the first of those, which matters because
the mark appears on both light and dark surfaces.

So a logo change is two steps: run the command, then bring `BrandMark.tsx` in line with the new
shape by hand. If the new logo genuinely cannot be expressed as a single-colour SVG path, that is
worth knowing before it becomes the application's mark — it means the logo will not work in a
monochrome context, and browsers land in several.

## Where else the mark appears

- `platform/advertiser/components/BrandMark.tsx` — the advertiser portal, a separate copy in a
  separate codebase. Update it in the same change or the portal drifts.
- The marketing site at `D:\Slash-Browser-marketing`.

None of these share a file, deliberately: they are three deployable products and a shared asset
pipeline between them would couple releases that have no reason to be coupled. The cost is that a
logo change is three edits, which is why they are listed here.
