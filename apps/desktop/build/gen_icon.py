"""Generate Mcode app icons (PNG / ICO / ICNS) with a bold 'M'.

Design:
  - Rounded-square tile (modern IDE icon shape, works in Win/macOS taskbars).
  - Dark gradient background (deep indigo -> near-black) for a "developer tool" feel.
  - A thick white 'M' in Impact, slightly offset to leave room for a code chevron
    accent in the lower-right, echoing the "Code" in Mcode.

Run from the repo root:
    python apps/desktop/build/gen_icon.py
"""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

OUT_DIR = Path(__file__).resolve().parent
SIZE = 1024  # master size; everything else is derived


def _rounded_gradient(size: int, radius: float, top, bottom) -> Image.Image:
    """A size×size RGBA image with a vertical gradient clipped to a rounded rect.

    To get truly transparent corners (alpha exactly 0), we render at 4x scale
    with a hard rounded-rect mask, then downscale with LANCZOS. The
    supersampling makes the rounded-rect edge anti-aliased while keeping the
    corners fully transparent (rather than the 4x-mask's bleed-through of ~45).
    """
    ss = 4
    big = size * ss
    grad = Image.new("RGB", (big, big), 0)
    px = grad.load()
    for y in range(big):
        t = y / (big - 1)
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        for x in range(big):
            px[x, y] = (r, g, b)

    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=radius * ss, fill=255
    )
    big_rgba = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    big_rgba.paste(grad, (0, 0), mask)
    # Downscale: this is where the AA edge is produced, from clean 0/255 alphas.
    return big_rgba.resize((size, size), Image.LANCZOS)


def _font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(name, size)


def render_master() -> Image.Image:
    s = SIZE
    radius = s * 0.22  # macOS-style squircle-ish rounding

    # Background gradient: indigo #4F46E5 -> deep #0B1021.
    img = _rounded_gradient(
        s, radius, top=(79, 70, 229), bottom=(11, 16, 33)
    )

    # Soft inner glow / vignette to add depth. Only the ellipse should light up
    # the center; the corners must stay fully transparent. Build the glow as an
    # RGBA image whose alpha is the blurred ellipse, so empty (corner) areas
    # keep alpha 0 (not ~45 from a global brightness scale).
    glow = Image.new("L", (s, s), 0)
    ImageDraw.Draw(glow).ellipse(
        [int(s * 0.18), int(s * 0.10), int(s * 0.82), int(s * 0.72)],
        fill=255, outline=0,
    )
    glow = glow.filter(ImageFilter.GaussianBlur(s * 0.10))
    # Tint the glow bluish, then use the blurred ellipse as the alpha channel.
    glow_color = Image.new("RGB", (s, s), (120, 110, 255))
    glow_rgba = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    glow_rgba.paste(glow_color, (0, 0), glow)
    # Dim the glow's contribution to ~18% so it reads as a subtle sheen.
    r, g, b, a = glow_rgba.split()
    dimmed = Image.merge(
        "RGBA",
        (r.point(lambda v: int(v * 0.18)),
         g.point(lambda v: int(v * 0.18)),
         b.point(lambda v: int(v * 0.18)),
         a),
    )
    img.alpha_composite(dimmed)

    # The 'M'.
    font = _font(r"C:\Windows\Fonts\impact.ttf", int(s * 0.72))
    m_img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(m_img)
    # Measure the glyph to center it (biased slightly left/up).
    bbox = d.textbbox((0, 0), "M", font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    tx = (s - w) / 2 - bbox[0] - int(s * 0.02)
    ty = (s - h) / 2 - bbox[1] - int(s * 0.06)
    # Subtle drop shadow behind the M.
    shadow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).text((tx, ty), "M", font=font, fill=(0, 0, 0, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(s * 0.012))
    img.alpha_composite(shadow)
    # The M itself, pure white.
    d.text((tx, ty), "M", font=font, fill=(255, 255, 255, 255))
    img.alpha_composite(m_img)

    # Code-chevron accent in the lower-right: a small ">" bracket in accent cyan.
    acc = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ad = ImageDraw.Draw(acc)
    cx, cy = int(s * 0.70), int(s * 0.74)
    arm = int(s * 0.085)
    thick = max(8, int(s * 0.028))
    ad.line(
        [(cx - arm, cy - arm), (cx, cy), (cx - arm, cy + arm)],
        fill=(125, 211, 252, 255), width=thick, joint="curve",
    )
    img.alpha_composite(acc)

    return img


# ── PNG ──────────────────────────────────────────────────────────────────────
def write_png(img: Image.Image, path: Path, size: int) -> None:
    img.resize((size, size), Image.LANCZOS).save(path, "PNG", optimize=True)


# ── ICO (Windows, multi-size) ────────────────────────────────────────────────
# Encode the ICO container by hand: PIL's ICO writer occasionally collapses
# multi-size RGBA inputs to a single 16×16 entry. Writing the directory +
# PNG-encoded entries ourselves guarantees every size is present.
def _png_bytes(img: Image.Image) -> bytes:
    from io import BytesIO
    b = BytesIO()
    img.save(b, format="PNG", optimize=True)
    return b.getvalue()


def write_ico(img: Image.Image, path: Path) -> None:
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [img.resize((s, s), Image.LANCZOS) for s in sizes]
    blobs = [_png_bytes(f) for f in frames]

    n = len(sizes)
    # ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes each) + image data.
    header = struct.pack("<HHH", 0, 1, n)  # reserved, type=1 (icon), count
    offset = 6 + 16 * n
    entries = bytearray()
    for (s, blob) in zip(sizes, blobs):
        # entry: w(1) h(1) colors(1) reserved(1) planes(2) bpp(2) size(4) offset(4)
        w = 0 if s >= 256 else s
        entries += struct.pack(
            "<BBBBHHII", w, w, 0, 0, 1, 32, len(blob), offset
        )
        offset += len(blob)

    with open(path, "wb") as f:
        f.write(header)
        f.write(entries)
        for blob in blobs:
            f.write(blob)


# ── ICNS (macOS) ─────────────────────────────────────────────────────────────
# Minimal pack-as-ic09 (512x512@1x 1024) + ic08 (256x256@1x 512) + ic07 (128).
# PIL can write ICNS directly; we rely on that for correctness.
def write_icns(img: Image.Image, path: Path) -> None:
    # PIL's ICNS writer wants a square source and picks sizes itself.
    img.save(path, format="ICNS")


def main() -> None:
    master = render_master()
    write_png(master, OUT_DIR / "icon.png", 1024)
    write_ico(master, OUT_DIR / "icon.ico")
    write_icns(master, OUT_DIR / "icon.icns")
    # Favicon for the renderer window.
    write_png(master, OUT_DIR / "favicon.png", 64)
    print("generated: icon.png, icon.ico, icon.icns, favicon.png in", OUT_DIR)


if __name__ == "__main__":
    main()
