"""Nativski app icons: an amber "N" on black (run: python3 scripts/web/make-icons.py)."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[2] / "web" / "public" / "icons"
S = 1024

# Amber gradient (top-left #ffb020 → bottom-right #ff7a3d), masked by the N shape.
grad = Image.new("RGB", (S, S))
gp = grad.load()
a, b = (255, 176, 32), (255, 122, 61)
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * (S - 1))
        gp[x, y] = tuple(round(p + (q - p) * t) for p, q in zip(a, b))

mask = Image.new("L", (S, S), 0)
m = ImageDraw.Draw(mask)
L, R, T, B, w = 262, 762, 250, 774, 132        # N: two uprights and a diagonal
m.rounded_rectangle([L, T, L + w, B], radius=28, fill=255)
m.rounded_rectangle([R - w, T, R, B], radius=28, fill=255)
m.polygon([(L, T), (L + w + 36, T), (R, B), (R - w - 36, B)], fill=255)

img = Image.new("RGB", (S, S), (0, 0, 0))
img.paste(grad, (0, 0), mask)
for name, size in [("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)]:
    img.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
print("icons written to", OUT)
