"""App icon: a graphite instrument tile with a descending stack of amber
segments — the download direction and the level meter in one mark."""

import os
import subprocess
from PIL import Image, ImageDraw

OUT = "/Users/erne/Desktop/everything downloader/build"
S = 2048            # render at 2x the master, then downscale for clean edges
MASTER = 1024

# macOS icon geometry: art inset inside the 1024 canvas, squircle-ish radius.
MARGIN = int(S * 0.088)
RADIUS = int(S * 0.185)

TOP = (0x22, 0x2B, 0x35)
BOTTOM = (0x0D, 0x11, 0x16)
EDGE = (0x33, 0x3F, 0x4C)
AMBER_TOP = (0xF7, 0xB8, 0x60)
AMBER_BOTTOM = (0xC0, 0x72, 0x1A)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def main():
    os.makedirs(OUT, exist_ok=True)

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # --- tile: vertical graphite gradient clipped to a rounded square --------
    grad = Image.new("RGB", (1, S - 2 * MARGIN))
    for y in range(grad.height):
        grad.putpixel((0, y), lerp(TOP, BOTTOM, y / (grad.height - 1)))
    grad = grad.resize((S - 2 * MARGIN, S - 2 * MARGIN))

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [MARGIN, MARGIN, S - MARGIN, S - MARGIN], radius=RADIUS, fill=255
    )
    img.paste(grad, (MARGIN, MARGIN), mask.crop((MARGIN, MARGIN, S - MARGIN, S - MARGIN)))

    # a hairline panel edge, the same device the UI uses everywhere
    edge = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        [MARGIN, MARGIN, S - MARGIN, S - MARGIN],
        radius=RADIUS,
        outline=EDGE + (255,),
        width=max(2, S // 340),
    )
    img.alpha_composite(edge)

    # --- mark: four bars narrowing downwards --------------------------------
    bars = 4
    widths = [0.52, 0.40, 0.28, 0.16]
    bar_h = int(S * 0.088)
    gap = int(S * 0.046)
    block = bars * bar_h + (bars - 1) * gap
    y = (S - block) // 2
    cx = S // 2
    # Barely-rounded ends, matching the 3px radius the interface uses.
    r = max(2, int(bar_h * 0.17))

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for i, w in enumerate(widths):
        half = int(S * w / 2)
        colour = lerp(AMBER_TOP, AMBER_BOTTOM, i / (bars - 1))
        draw.rounded_rectangle(
            [cx - half, y, cx + half, y + bar_h], radius=r, fill=colour + (255,)
        )
        y += bar_h + gap
    img.alpha_composite(layer)

    master = img.resize((MASTER, MASTER), Image.LANCZOS)
    master.save(os.path.join(OUT, "icon.png"))

    # --- .icns via iconutil -------------------------------------------------
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
        ["iconutil", "-c", "icns", iconset, "-o", os.path.join(OUT, "icon.icns")],
        check=True,
    )
    subprocess.run(["rm", "-rf", iconset], check=True)

    # A 256px ico keeps electron-builder from having to guess on Windows.
    master.resize((256, 256), Image.LANCZOS).save(
        os.path.join(OUT, "icon.ico"), sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    )

    print("yazıldı:", sorted(os.listdir(OUT)))


if __name__ == "__main__":
    main()
