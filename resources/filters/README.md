# Bundled filter lists

Shipped with Slash via `extraResources`, so they land beside `app.asar` rather than inside it —
the compiler reads them with plain `fs`, and a native file open cannot see through the archive.
Same reasoning as `resources/models`.

They are **data, not code**. Slash deliberately does not bundle uBlock Origin's scriptlet library:
those are executable GPLv3 files, and shipping them inside this application carries obligations that
filter lists distributed with attribution do not. The one scriptlet Slash needs — the `window.open`
defuser — is written locally in `src/main/shield/inject/popupDefuserScript.ts`.

| File | Source | Licence |
|---|---|---|
| `easylist.txt` | [EasyList](https://easylist.to/) | CC BY-SA 3.0 |
| `easyprivacy.txt` | [EasyPrivacy](https://easylist.to/) | CC BY-SA 3.0 |
| `ublock-filters.txt` | [uBlock Origin filters](https://github.com/uBlockOrigin/uAssets) | GPL-3.0 |
| `ublock-privacy.txt` | [uBlock Origin privacy](https://github.com/uBlockOrigin/uAssets) | GPL-3.0 |
| `ublock-badware.txt` | [uBlock Origin badware](https://github.com/uBlockOrigin/uAssets) | GPL-3.0 |

The matching engine is [`@ghostery/adblocker`](https://github.com/ghostery/adblocker) (MPL-2.0),
chosen partly because it is pure TypeScript: this project's path contains spaces, and node-gyp
refuses to build any module whose path does, so a native filter engine could not be built here at
all.

## Updating

These are a snapshot, not a live feed. Fetching newer lists is an outbound request, so it follows
the same rule as everything else in Slash — off until the user asks for it. Replacing a file here
changes the fingerprint (`name:bytesize` per list, plus a format version), which invalidates the
compiled cache in `userData` and triggers one recompile on the next launch.

Refresh them with:

```bash
curl -sSL -o resources/filters/easylist.txt https://easylist.to/easylist/easylist.txt
```

…and the equivalent for the others, from the source URLs above.
