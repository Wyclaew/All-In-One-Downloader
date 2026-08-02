"""App icon for All in One Downloader.

The mark has to say two things and survive 16 pixels: many sources, one file,
coming down. Three narrowing bars read as a list of things funnelling in; a bold
arrow beneath them reads as the download. Nothing else — detail disappears at tab
size, and a tile that stays legible small is worth more than one that looks
clever large.

Run: python3 build/make-icon.py
"""

import os
import subprocess
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__))
S = 2048          # render at 2x the master, then downscale for clean edges
MASTER = 1024

# macOS icon geometry: art inset inside the canvas, squircle-ish corner.
MARGIN = int(S * 0.086)
RADIUS = int(S * 0.185)

INK_TOP = (0x22, 0x2C, 0x38)
INK_BOTTOM = (0x11, 0x18, 0x20)
EDGE = (0x36, 0x43, 0x52)
PAPER = (0xF2, 0xEE, 0xE8)
VERMILION = (0xE0, 0x50, 0x24)
VERMILION_DEEP = (0xB8, 0x37, 0x14)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_bar(draw, cx, y, width, height, colour):
    half = width / 2
    draw.rounded_rectangle(
        [cx - half, y, cx + half, y + height], radius=height * 0.34, fill=colour + (255,)
    )


def main():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # ---- tile: deep ink with a soft vertical gradient ----------------------
    inner = S - 2 * MARGIN
    grad = Image.new("RGB", (1, inner))
    for y in range(inner):
        grad.putpixel((0, y), lerp(INK_TOP, INK_BOTTOM, y / (inner - 1)))
    grad = grad.resize((inner, inner))

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [MARGIN, MARGIN, S - MARGIN, S - MARGIN], radius=RADIUS, fill=255
    )
    img.paste(grad, (MARGIN, MARGIN), mask.crop((MARGIN, MARGIN, S - MARGIN, S - MARGIN)))

    edge = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        [MARGIN, MARGIN, S - MARGIN, S - MARGIN],
        radius=RADIUS,
        outline=EDGE + (255,),
        width=max(2, S // 330),
    )
    img.alpha_composite(edge)

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    cx = S / 2

    # ---- the sources: three bars, narrowing as they funnel in --------------
    bar_h = S * 0.052
    gap = S * 0.034
    y = S * 0.198
    for width in (S * 0.42, S * 0.315, S * 0.21):
        rounded_bar(draw, cx, y, width, bar_h, PAPER)
        y += bar_h + gap

    # ---- the download: one bold arrow -------------------------------------
    # The shaft needs real length or the head swallows it and the mark reads as
    # a triangle rather than an arrow.
    shaft_w = S * 0.108
    shaft_top = y + S * 0.004
    shaft_bottom = S * 0.638
    draw.rounded_rectangle(
        [cx - shaft_w / 2, shaft_top, cx + shaft_w / 2, shaft_bottom],
        radius=shaft_w * 0.2,
        fill=VERMILION + (255,),
    )

    head_w = S * 0.30
    head_top = shaft_bottom - S * 0.004
    head_bottom = S * 0.80
    draw.polygon(
        [(cx - head_w / 2, head_top), (cx + head_w / 2, head_top), (cx, head_bottom)],
        fill=VERMILION_DEEP + (255,),
    )

    img.alpha_composite(layer)

    master = img.resize((MASTER, MASTER), Image.LANCZOS)
    master.save(os.path.join(OUT, "icon.png"))

    # ---- .icns via iconutil -----------------------------------------------
    iconset = os.path.join(OUT, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    for size, name in [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]:
        master.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, name))

    subprocess.run(
        ["iconutil", "-c", "icns", iconset, "-o", os.path.join(OUT, "icon.icns")], check=True
    )
    subprocess.run(["rm", "-rf", iconset], check=True)

    master.resize((256, 256), Image.LANCZOS).save(
        os.path.join(OUT, "icon.ico"),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    print("yazıldı:", sorted(f for f in os.listdir(OUT) if f.startswith("icon.")))


if __name__ == "__main__":
    main()
