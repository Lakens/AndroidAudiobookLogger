"""Generate app icon PNGs — open book with a yellow highlight stripe."""
import os
import math
from PIL import Image, ImageDraw

RES_DIR = os.path.join(os.path.dirname(__file__), "android", "app", "src", "main", "res")

SIZES = {
    "mipmap-mdpi":    48,
    "mipmap-hdpi":    72,
    "mipmap-xhdpi":   96,
    "mipmap-xxhdpi":  144,
    "mipmap-xxxhdpi": 192,
}

BG       = (26,  26,  46)   # #1a1a2e
ACCENT   = (160, 196, 255)  # #a0c4ff
PAGE     = (240, 240, 230)  # off-white pages
SPINE    = (100, 140, 210)  # slightly darker blue for spine
HIGHLIGHT= (255, 230, 80, 180)  # yellow, semi-transparent


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d   = ImageDraw.Draw(img, "RGBA")

    p = size / 48  # scale factor (base 48 px)

    # Background circle
    d.ellipse([0, 0, size - 1, size - 1], fill=BG)

    cx = size / 2
    cy = size / 2

    # Book geometry (open book lying flat, viewed slightly from above)
    # Spine is a thin vertical strip in the centre
    spine_w = max(2, round(2 * p))
    book_h  = round(22 * p)
    page_w  = round(13 * p)
    top_y   = cy - book_h / 2
    bot_y   = cy + book_h / 2

    # Left page (trapezoid — outer edge slightly lower)
    lx0 = cx - spine_w / 2 - page_w
    d.polygon(
        [
            (cx - spine_w / 2, top_y),
            (lx0,              top_y + round(2 * p)),
            (lx0,              bot_y - round(2 * p)),
            (cx - spine_w / 2, bot_y),
        ],
        fill=PAGE,
    )

    # Right page (mirror)
    rx1 = cx + spine_w / 2 + page_w
    d.polygon(
        [
            (cx + spine_w / 2, top_y),
            (rx1,              top_y + round(2 * p)),
            (rx1,              bot_y - round(2 * p)),
            (cx + spine_w / 2, bot_y),
        ],
        fill=PAGE,
    )

    # Spine strip
    d.rectangle(
        [cx - spine_w / 2, top_y, cx + spine_w / 2, bot_y],
        fill=SPINE,
    )

    # Highlight stripe across both pages (semi-transparent yellow)
    hy = cy - round(2 * p)
    hh = round(4 * p)
    # Left page highlight
    d.polygon(
        [
            (cx - spine_w / 2, hy),
            (lx0 + round(1 * p), hy + round(0.3 * p)),
            (lx0 + round(1 * p), hy + hh + round(0.3 * p)),
            (cx - spine_w / 2, hy + hh),
        ],
        fill=HIGHLIGHT,
    )
    # Right page highlight
    d.polygon(
        [
            (cx + spine_w / 2, hy),
            (rx1 - round(1 * p), hy + round(0.3 * p)),
            (rx1 - round(1 * p), hy + hh + round(0.3 * p)),
            (cx + spine_w / 2, hy + hh),
        ],
        fill=HIGHLIGHT,
    )

    # Thin horizontal lines on pages (text simulation)
    line_color = (180, 175, 160, 120)
    for offset in (-8, -4, 4, 8):
        ly = cy + round(offset * p)
        if ly < top_y + round(3 * p) or ly > bot_y - round(3 * p):
            continue
        # left
        d.line([(lx0 + round(2 * p), ly), (cx - spine_w / 2 - round(1 * p), ly)], fill=line_color, width=max(1, round(0.8 * p)))
        # right
        d.line([(cx + spine_w / 2 + round(1 * p), ly), (rx1 - round(2 * p), ly)], fill=line_color, width=max(1, round(0.8 * p)))

    return img


def main():
    for folder, size in SIZES.items():
        icon = draw_icon(size)
        for name in ("ic_launcher.png", "ic_launcher_round.png"):
            out = os.path.join(RES_DIR, folder, name)
            icon.save(out, "PNG")
            print(f"  wrote {out}  ({size}x{size})")
    print("Done.")


if __name__ == "__main__":
    main()
