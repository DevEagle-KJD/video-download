"""Generates the app icons in app/icons (run: python3 scripts/make-icons.py)."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "app" / "icons"
OUT.mkdir(parents=True, exist_ok=True)
S = 1024  # draw large, then downscale for smooth edges

img = Image.new("RGB", (S, S))
px = img.load()
top, bottom = (255, 94, 58), (255, 42, 104)  # warm coral → pink gradient
for y in range(S):
    t = y / (S - 1)
    row = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    for x in range(S):
        px[x, y] = row

d = ImageDraw.Draw(img)
white = (255, 255, 255)
cx = S // 2
w = 64
# Arrow shaft + head
d.rounded_rectangle([cx - w // 2, 230, cx + w // 2, 640], radius=w // 2, fill=white)
d.line([(cx - 190, 470), (cx, 660)], fill=white, width=w)
d.line([(cx + 190, 470), (cx, 660)], fill=white, width=w)
for p in [(cx - 190, 470), (cx + 190, 470), (cx, 660)]:
    d.ellipse([p[0] - w // 2, p[1] - w // 2, p[0] + w // 2, p[1] + w // 2], fill=white)
# Tray
d.rounded_rectangle([cx - 260, 770, cx + 260, 770 + w], radius=w // 2, fill=white)

for name, size in [("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)]:
    img.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
print("icons written to", OUT)
