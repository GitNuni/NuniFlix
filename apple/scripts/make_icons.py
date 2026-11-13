#!/usr/bin/env python3
"""Generates the app icons for both Apple targets from the NuniFlix logo
(the same red gradient + white N as server/app/web/icon.svg).

    python3 apple/scripts/make_icons.py      # needs Pillow: pip3 install pillow

Writes:
  apple/Resources/iOS/Assets.xcassets   AppIcon (1024x1024, Xcode makes the other sizes)
  apple/Resources/TV/Assets.xcassets    "App Icon & Top Shelf Image": layered icons
                                         (front: the N, back: the gradient) + Top Shelf images
"""
import json
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

APPLE = Path(__file__).resolve().parent.parent
TOP = (0xFF, 0x2A, 0x36)
BOTTOM = (0x8A, 0x0B, 0x12)
# The N from icon.svg, in its 512x512 coordinate space (the letter spans x 150..362, y 132..380).
N_POINTS = [(150, 380), (150, 132), (202, 132), (310, 292), (310, 132),
            (362, 132), (362, 380), (312, 380), (202, 220), (202, 380)]
SS = 4  # supersampling for smooth edges
INFO = {"author": "xcode", "version": 1}


def gradient(w, h):
    """Diagonal top-left -> bottom-right gradient, opaque RGB."""
    small = Image.new("RGB", (256, 256))
    px = small.load()
    for y in range(256):
        for x in range(256):
            t = (x + y) / 510
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
    return small.resize((w, h), Image.BICUBIC)


def draw_n(img, cx, cy, height):
    """Draws the white N centred on (cx, cy), `height` pixels tall, onto an RGBA/RGB image."""
    w, h = img.size
    layer = Image.new("L", (w * SS, h * SS), 0)
    scale = height / 248 * SS
    ox, oy = cx * SS - 256 * scale, cy * SS - 256 * scale
    pts = [(ox + x * scale, oy + y * scale) for x, y in N_POINTS]
    ImageDraw.Draw(layer).polygon(pts, fill=255)
    mask = layer.resize((w, h), Image.LANCZOS)
    img.paste((255, 255, 255), (0, 0), mask)


def font(size):
    for path, index in [("/System/Library/Fonts/HelveticaNeue.ttc", 1), ("/System/Library/Fonts/Helvetica.ttc", 1)]:
        try:
            return ImageFont.truetype(path, size, index=index)
        except OSError:
            continue
    return ImageFont.load_default()


def write_json(path, data):
    path.mkdir(parents=True, exist_ok=True)
    (path / "Contents.json").write_text(json.dumps(data, indent=2) + "\n")


# ---------- iOS ----------

def ios():
    root = APPLE / "Resources/iOS/Assets.xcassets"
    shutil.rmtree(root, ignore_errors=True)
    write_json(root, {"info": INFO})
    icon_dir = root / "AppIcon.appiconset"
    img = gradient(1024, 1024)  # full bleed, no rounded corners, no alpha: iOS applies the mask
    draw_n(img, 512, 512, 248 * 2)
    write_json(icon_dir, {"images": [{"filename": "icon-1024.png", "idiom": "universal",
                                      "platform": "ios", "size": "1024x1024"}], "info": INFO})
    img.save(icon_dir / "icon-1024.png")


# ---------- tvOS ----------

def tv_stack(brand, name, size, scales):
    """A layered tvOS icon: Front (the N, transparent) over Back (the gradient)."""
    stack = brand / f"{name}.imagestack"
    write_json(stack, {"info": INFO, "layers": [{"filename": "Front.imagestacklayer"},
                                                {"filename": "Back.imagestacklayer"}]})
    w, h = size
    for layer in ("Front", "Back"):
        layer_dir = stack / f"{layer}.imagestacklayer"
        write_json(layer_dir, {"info": INFO})
        imageset = layer_dir / "Content.imageset"
        images = []
        for s in scales:
            fname = f"{layer.lower()}@{s}x.png"
            if layer == "Back":
                img = gradient(w * s, h * s)
            else:
                img = Image.new("RGBA", (w * s, h * s), (0, 0, 0, 0))
                draw_n(img, w * s / 2, h * s / 2, h * s * 0.5)
            imageset.mkdir(parents=True, exist_ok=True)
            img.save(imageset / fname)
            images.append({"filename": fname, "idiom": "tv", "scale": f"{s}x"})
        write_json(imageset, {"images": images, "info": INFO})


def tv_top_shelf(brand, name, size):
    """Top Shelf banner: gradient, the N and the NuniFlix wordmark."""
    imageset = brand / f"{name}.imageset"
    w, h = size
    images = []
    for s in (1, 2):
        W, H = w * s, h * s
        img = gradient(W, H)
        n_h = H * 0.36
        text = "NuniFlix"
        f = font(int(H * 0.30))
        d = ImageDraw.Draw(img)
        tw = d.textlength(text, font=f)
        gap = H * 0.08
        n_w = n_h * 212 / 248
        x0 = (W - (n_w + gap + tw)) / 2
        draw_n(img, x0 + n_w / 2, H / 2, n_h)
        d.text((x0 + n_w + gap, H / 2), text, font=f, fill="white", anchor="lm")
        fname = f"top-shelf@{s}x.png"
        imageset.mkdir(parents=True, exist_ok=True)
        img.save(imageset / fname)
        images.append({"filename": fname, "idiom": "tv", "scale": f"{s}x"})
    write_json(imageset, {"images": images, "info": INFO})


def tv():
    root = APPLE / "Resources/TV/Assets.xcassets"
    shutil.rmtree(root, ignore_errors=True)
    write_json(root, {"info": INFO})
    brand = root / "App Icon & Top Shelf Image.brandassets"
    write_json(brand, {"assets": [
        {"filename": "App Icon - App Store.imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "1280x768"},
        {"filename": "App Icon.imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "400x240"},
        {"filename": "Top Shelf Image Wide.imageset", "idiom": "tv", "role": "top-shelf-image-wide", "size": "2320x720"},
        {"filename": "Top Shelf Image.imageset", "idiom": "tv", "role": "top-shelf-image", "size": "1920x720"},
    ], "info": INFO})
    tv_stack(brand, "App Icon", (400, 240), (1, 2))
    tv_stack(brand, "App Icon - App Store", (1280, 768), (1,))
    tv_top_shelf(brand, "Top Shelf Image", (1920, 720))
    tv_top_shelf(brand, "Top Shelf Image Wide", (2320, 720))


if __name__ == "__main__":
    ios()
    tv()
    print("Icons written to", APPLE / "Resources")
