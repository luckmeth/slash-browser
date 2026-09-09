#!/usr/bin/env python3
"""Build `build/icon.icns` from `build/icon.png`.

Why this exists rather than letting electron-builder convert the PNG: it does
not. The macOS job's first run failed with

    cannot find specified resource "build/icon.icns"

on a repository whose `mac.icon` pointed at a perfectly good 1024x1024 PNG.
electron-builder resolves a macOS icon to an `.icns` and, when the configured
source is not one, looks for a sibling with that extension rather than
generating it. So the file has to exist.

The obvious objection — that a committed `.icns` is a second copy of the icon to
forget to update — is real, and this script is the answer to it: the `.icns` is
derived from `icon.png` by a command anyone can re-run, and the PNG stays the
single source image. Run it after changing the icon:

    python scripts/make-icns.py

ICNS is a flat container: an `icns` magic, the total length, then chunks of
`<4-byte type><4-byte length including this header><payload>`. The modern type
codes take a PNG payload directly, which is why no Apple tooling is needed and
this runs anywhere.
"""

from __future__ import annotations

import struct
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "build" / "icon.png"
TARGET = ROOT / "build" / "icon.icns"

# Type code -> pixel size. These are the PNG-carrying entries; the older
# `is32`/`il32` types hold raw RLE bitmaps and are not worth writing for an
# application that has never supported a pre-Lion macOS.
ENTRIES = [
    ("icp4", 16),
    ("icp5", 32),
    ("ic11", 32),   # 16pt @2x
    ("ic12", 64),   # 32pt @2x
    ("ic07", 128),
    ("ic08", 256),
    ("ic13", 256),  # 128pt @2x
    ("ic09", 512),
    ("ic14", 512),  # 256pt @2x
    ("ic10", 1024), # 512pt @2x
]


def main() -> int:
    if not SOURCE.exists():
        print(f"no source icon at {SOURCE}", file=sys.stderr)
        return 1

    source = Image.open(SOURCE).convert("RGBA")
    if source.width != source.height:
        print(f"icon.png must be square, got {source.width}x{source.height}", file=sys.stderr)
        return 1
    if source.width < 1024:
        # Upscaling would ship a blurry icon at the size macOS actually shows in
        # the Dock. Better to fail and say so.
        print(f"icon.png must be at least 1024x1024, got {source.width}px", file=sys.stderr)
        return 1

    chunks = bytearray()
    for code, size in ENTRIES:
        resized = source.resize((size, size), Image.LANCZOS)
        buffer = BytesIO()
        resized.save(buffer, format="PNG", optimize=True)
        payload = buffer.getvalue()
        chunks += code.encode("ascii")
        chunks += struct.pack(">I", len(payload) + 8)
        chunks += payload

    total = len(chunks) + 8
    TARGET.write_bytes(b"icns" + struct.pack(">I", total) + bytes(chunks))
    print(f"wrote {TARGET.relative_to(ROOT)} — {len(ENTRIES)} sizes, {total:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
