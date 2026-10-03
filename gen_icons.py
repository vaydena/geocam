#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GeoCam Icon-Generator -> icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png
Eigenes Logo: quadratische icon-source.png daneben legen. Sonst wird der Glyph
(Standort-Pin mit Kameralinse) gezeichnet.  Aufruf: python gen_icons.py   (pip install pillow)"""
import os
from PIL import Image, ImageDraw

BG        = (11, 18, 32)        # #0b1220
ACCENT    = (20, 184, 166)      # #14b8a6
WHITE     = (255, 255, 255)
OUT_DIR   = os.path.dirname(os.path.abspath(__file__))
SOURCE    = os.path.join(OUT_DIR, "icon-source.png")
SS        = 4
MASK_SAFE = 0.80


def draw_glyph(size, with_bg=True):
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if with_bg:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * 0.22), fill=BG)
    cx, cy, r = big * 0.5, big * 0.42, big * 0.25
    # Pin: Kreis + Spitze
    d.polygon([(cx - r * 0.86, cy + r * 0.52), (cx + r * 0.86, cy + r * 0.52), (cx, big * 0.86)], fill=ACCENT)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT)
    # Kameralinse
    r1, r2, r3 = r * 0.62, r * 0.42, r * 0.14
    d.ellipse([cx - r1, cy - r1, cx + r1, cy + r1], fill=WHITE)
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=BG)
    d.ellipse([cx - r2 * 0.55 - r3, cy - r2 * 0.55 - r3, cx - r2 * 0.55 + r3, cy - r2 * 0.55 + r3], fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


def base_any(size):
    if os.path.exists(SOURCE):
        return Image.open(SOURCE).convert("RGBA").resize((size, size), Image.LANCZOS)
    return draw_glyph(size, with_bg=True)


def make_maskable(size=512):
    bg = Image.new("RGBA", (size, size), BG + (255,))
    inner = int(size * MASK_SAFE)
    off = (size - inner) // 2
    if os.path.exists(SOURCE):
        content = Image.open(SOURCE).convert("RGBA").resize((inner, inner), Image.LANCZOS)
    else:
        content = draw_glyph(inner, with_bg=False)
    bg.paste(content, (off, off), content)
    return bg


def make_apple(size=180):
    icon = base_any(size)
    flat = Image.new("RGB", (size, size), BG)
    flat.paste(icon, (0, 0), icon)
    return flat


def save(img, name):
    img.save(os.path.join(OUT_DIR, name), "PNG")
    print("  geschrieben:", name, img.size)


if __name__ == "__main__":
    save(base_any(192), "icon-192.png")
    save(base_any(512), "icon-512.png")
    save(make_maskable(512), "icon-maskable-512.png")
    save(make_apple(180), "apple-touch-icon.png")
