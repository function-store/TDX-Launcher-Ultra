#!/usr/bin/env python3
"""Regenerate the macOS icon artifacts from the exported source art.

Dev-only tool; its outputs are committed, so a normal build never runs it.
Requires Pillow (`pip install pillow`) plus `iconutil` from the macOS tools.

    python3 scripts/build-macos-icons.py

Inputs (assets/):
  TDXLU.icon/                          the layered Icon Composer document
  macos Exports/…-Dark-1024…@1x.png    its dark rendering, flattened
  icon_default_mono.png                white-on-clear glyph for the menu bar

Outputs (src-tauri/icons/):
  icon.icns                macOS app icon, inset to the standard Dock geometry
  Assets.car               compiled catalog macOS 26 renders per appearance
  tray-mac-template.png    black-on-clear NSImage template for the menu bar
  toe-document.icns        the .toe file icon — the app tile, not a page
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
ICONS = ROOT / "src-tauri" / "icons"
LAYERED = ASSETS / "TDXLU.icon"
EXPORTS = ASSETS / "macos Exports"

# Apple's Dock grid leaves the artwork short of the canvas edge and puts the
# shadow in the gap; a full-bleed export dropped straight into an .icns reads
# a size too big next to every other app.
CANVAS = 1024
CONTENT = 824
SHADOW_BLUR = 12
SHADOW_OFFSET = 16
SHADOW_ALPHA = 90

def build_icns(src: Path, out: Path) -> None:
    art = Image.open(src).convert("RGBA").resize((CONTENT, CONTENT), Image.LANCZOS)
    origin = ((CANVAS - CONTENT) // 2, (CANVAS - CONTENT) // 2)

    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    stamp = Image.new("RGBA", (CONTENT, CONTENT), (0, 0, 0, SHADOW_ALPHA))
    stamp.putalpha(art.getchannel("A").point(lambda a: a * SHADOW_ALPHA // 255))
    shadow.paste(stamp, (origin[0], origin[1] + SHADOW_OFFSET))
    shadow = shadow.filter(ImageFilter.GaussianBlur(SHADOW_BLUR))

    canvas = Image.alpha_composite(shadow, _placed(art, origin))

    _write_icns(canvas, out)


def _write_icns(canvas: Image.Image, out: Path) -> None:
    iconset = out.with_suffix(".iconset")
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir(parents=True)
    for size in (16, 32, 128, 256, 512):
        canvas.resize((size, size), Image.LANCZOS).save(
            iconset / f"icon_{size}x{size}.png"
        )
        canvas.resize((size * 2, size * 2), Image.LANCZOS).save(
            iconset / f"icon_{size}x{size}@2x.png"
        )

    subprocess.run(
        ["iconutil", "--convert", "icns", "--output", str(out), str(iconset)],
        check=True,
    )
    shutil.rmtree(iconset)
    print(f"wrote {out.relative_to(ROOT)}")


def _placed(art: Image.Image, origin: tuple[int, int]) -> Image.Image:
    layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    layer.paste(art, origin)
    return layer


# tray-icon scales whatever we hand it to 18pt tall, so the canvas is 36px
# (exactly 2x on a Retina menu bar) and the glyph sits inside it with the
# breathing room native menu bar items have.
TRAY_CANVAS = 36
TRAY_GLYPH = 30


def build_tray_template(src: Path, out: Path) -> None:
    glyph = Image.open(src).convert("RGBA")
    alpha = glyph.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        sys.exit(f"{src} has no opaque pixels")
    alpha = alpha.crop(bbox)

    scale = TRAY_GLYPH / max(alpha.size)
    size = (max(1, round(alpha.width * scale)), max(1, round(alpha.height * scale)))
    alpha = alpha.resize(size, Image.LANCZOS)

    # A template image is drawn from its alpha channel alone -- macOS tints it
    # black or white to match the menu bar. Black RGB is the documented form.
    template = Image.new("RGBA", (TRAY_CANVAS, TRAY_CANVAS), (0, 0, 0, 0))
    stamp = Image.new("RGBA", size, (0, 0, 0, 255))
    stamp.putalpha(alpha)
    template.paste(
        stamp, ((TRAY_CANVAS - size[0]) // 2, (TRAY_CANVAS - size[1]) // 2), stamp
    )
    template.save(out)
    print(f"wrote {out.relative_to(ROOT)}")


# An .icns holds one image set and macOS uses it in every appearance, so the
# dark and tinted renderings can only come from a compiled asset catalog that
# the system composites at draw time, out of the layered Icon Composer
# document. Flattening an appearance to a PNG throws away what it needs.
def _assert_layered_complete() -> None:
    """Every image the document names has to be in its Assets folder."""
    manifest = LAYERED / "icon.json"
    if not manifest.is_file():
        sys.exit(f"{manifest} not found")
    text = manifest.read_text()
    named = set(re.findall(r'"([\w\-. ]+\.png)"', text))
    # A layer that names no image falls back to its own layer name.
    for group in json.loads(text).get("groups", []):
        for layer in group.get("layers", []):
            if layer.get("name") and not (
                layer.get("image-name") or layer.get("image-name-specializations")
            ):
                named.add(f"{layer['name']}.png")
    missing = sorted(n for n in named if not (LAYERED / "Assets" / n).is_file())
    if missing or not named:
        sys.exit(
            f"{LAYERED.name} is unbuildable -- Assets/ is missing "
            f"{', '.join(missing) or 'every layer image'}. Re-save it from "
            "Icon Composer, keeping the Assets folder alongside icon.json."
        )


def build_assets_car(out: Path) -> None:
    _assert_layered_complete()
    with tempfile.TemporaryDirectory() as tmp:
        # actool takes the catalog name from the filename, and CFBundleIconName
        # in Info.plist has to match, so the document is staged as AppIcon.icon.
        staged = Path(tmp) / "AppIcon.icon"
        shutil.copytree(LAYERED, staged)

        compiled = Path(tmp) / "compiled"
        compiled.mkdir()
        subprocess.run(
            [
                "xcrun", "actool", str(staged),
                "--compile", str(compiled),
                "--app-icon", "AppIcon",
                "--output-partial-info-plist", str(Path(tmp) / "partial.plist"),
                "--platform", "macosx",
                "--minimum-deployment-target", "26.0",
            ],
            check=True,
            capture_output=True,
        )
        shutil.copy(compiled / "Assets.car", out)
    print(f"wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    # The document's fill is the same neutral dark in both appearances now, so
    # the dark rendering is what the flattened, single-appearance .icns should
    # carry too — the Default export still on disk is the old blue artwork.
    build_icns(EXPORTS / "macos-iOS-Dark-1024x1024@1x.png", ICONS / "icon.icns")
    build_assets_car(ICONS / "Assets.car")
    # Finder would badge the app icon onto its page template for .toe files;
    # CFBundleTypeIconFile overrides that with whatever we ship, and what we
    # want shipped is the icon itself — no page, no fold, no extension label.
    # Built from the dark rendering on purpose, so the file icon holds still
    # even if the app icon's light appearance changes.
    build_icns(
        EXPORTS / "macos-iOS-Dark-1024x1024@1x.png", ICONS / "toe-document.icns"
    )
    build_tray_template(ASSETS / "icon_default_mono.png", ICONS / "tray-mac-template.png")
