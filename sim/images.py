"""Synthetic inspection images with labelled defects.

Four views: a flat pericardium patch, a single cut leaflet, the assembled valve seen
from the outflow side, and a backlit transillumination scan of the leaflet. The scan
returns many small detections instead of one defect; the app draws the numbered boxes
over the image, the way the vision system does on the light table.
Deterministic for a given rng, so re-running the simulator reproduces images.
"""

import math
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 320
TISSUE = (226, 211, 176)
FABRIC = (236, 236, 232)
BG = (36, 44, 52)
LIGHTBOX = (26, 38, 168)     # blue backlight of the transillumination table
LEAFLET_LIT = (150, 190, 255)


def _texture(rng: random.Random, base, amp=14):
    seed = rng.randrange(2**31)
    noise = np.random.default_rng(seed).normal(0, amp, (SIZE // 4, SIZE // 4, 1))
    noise = np.kron(noise, np.ones((4, 4, 1)))
    arr = np.clip(np.array(base, dtype=float) + noise, 0, 255).astype("uint8")
    return Image.fromarray(np.broadcast_to(arr, (SIZE, SIZE, 3)).copy()).filter(ImageFilter.GaussianBlur(1.6))


def _mask(draw_fn):
    m = Image.new("L", (SIZE, SIZE), 0)
    draw_fn(ImageDraw.Draw(m))
    return m


def _patch(rng, img):
    pts = []
    for k in range(14):
        a = 2 * math.pi * k / 14
        r = rng.uniform(110, 140)
        pts.append((SIZE / 2 + r * math.cos(a), SIZE / 2 + r * math.sin(a)))
    img.paste(_texture(rng, TISSUE), (0, 0), _mask(lambda d: d.polygon(pts, fill=255)))
    return (SIZE / 2, SIZE / 2, 95)  # region where defects may land


def _leaflet(rng, img):
    cx, cy = SIZE / 2, SIZE / 2 + 20
    pts = [(cx - 120, cy - 70), (cx + 120, cy - 70)]
    for k in range(21):
        a = math.pi * k / 20
        pts.append((cx + 120 * math.cos(a), cy - 70 + 150 * math.sin(a) ** 1.2))
    img.paste(_texture(rng, TISSUE), (0, 0), _mask(lambda d: d.polygon(pts, fill=255)))
    return (cx, cy, 70)


def _valve(rng, img, misalign=False, gap=False):
    c = SIZE / 2
    d = ImageDraw.Draw(img)
    # sewing ring
    img.paste(_texture(rng, FABRIC, 8), (0, 0), _mask(lambda m: m.ellipse((12, 12, SIZE - 12, SIZE - 12), fill=255)))
    img.paste(_texture(rng, TISSUE), (0, 0), _mask(lambda m: m.ellipse((52, 52, SIZE - 52, SIZE - 52), fill=255)))
    # coaptation lines (Y); misalignment shifts the centre and bends one arm
    off = (rng.uniform(14, 22) * rng.choice([-1, 1]), rng.uniform(10, 18)) if misalign else (0, 0)
    centre = (c + off[0], c + off[1])
    for k in range(3):
        a = -math.pi / 2 + 2 * math.pi * k / 3 + (0.18 if misalign and k == 1 else 0)
        end = (c + 106 * math.cos(a), c + 106 * math.sin(a))
        d.line([centre, end], fill=(150, 132, 100), width=3)
    # stitches around the ring
    gap_start = rng.randrange(0, 48) if gap else -99
    for k in range(48):
        if gap and gap_start <= k < gap_start + 5:
            continue
        a = 2 * math.pi * k / 48
        r1, r2 = 118, 132
        d.line([(c + r1 * math.cos(a), c + r1 * math.sin(a)), (c + r2 * math.cos(a), c + r2 * math.sin(a))], fill=(40, 70, 140), width=2)
    bbox = None
    if gap:
        a = 2 * math.pi * (gap_start + 2.5) / 48
        bx, by = c + 125 * math.cos(a), c + 125 * math.sin(a)
        bbox = (bx - 30, by - 30, 60, 60)
    if misalign:
        bbox = (centre[0] - 40, centre[1] - 40, 80, 80)
    return (c, c, 70), bbox


def transillumination(rng: random.Random, dets: list, path: str):
    """Backlit leaflet: bright translucent belly, dark rim, one speck per detection.

    `dets` are the vision system's hits (normalised boxes); the app overlays the
    numbered rectangles, so the image itself stays the raw camera view.
    """
    img = Image.new("RGB", (SIZE, SIZE), (14, 18, 64))
    d = ImageDraw.Draw(img)
    for k in range(60):                                   # light table falls off at the edges
        v = k / 60
        d.ellipse((SIZE * 0.5 * v - 10, SIZE * 0.5 * v - 10, SIZE * (1 - 0.5 * v) + 10, SIZE * (1 - 0.5 * v) + 10),
                  fill=tuple(int(a + (b - a) * v) for a, b in zip((14, 18, 64), LIGHTBOX)))

    cx, cy = SIZE / 2, SIZE / 2 + 26
    cusp = [(cx - 104, cy - 96), (cx + 104, cy - 96)]     # inverted cone, like the photo
    for k in range(25):
        a = math.pi * k / 24
        cusp.append((cx + 104 * math.cos(a), cy - 96 + 138 * math.sin(a) ** 1.35))
    # the valve body tents up behind the leaflet, dark against the backlight
    d.polygon([(cx, cy - 210), (cx + 112, cy - 84), (cx - 112, cy - 84)], fill=(10, 14, 52))
    d.line([(cx, cy - 210), (cx + 30, cy - 120), (cx + 112, cy - 84)], fill=(70, 96, 170), width=2)
    lit = _texture(rng, LEAFLET_LIT, 10)
    img.paste(lit, (0, 0), _mask(lambda m: m.polygon(cusp, fill=232)))
    # dark folded edges either side, and the seam running up the middle
    d.line(cusp[2:], fill=(8, 10, 40), width=7)
    d.line([(cx, cy - 92), (cx, cy - 20)], fill=(120, 160, 230), width=2)
    for k in range(3):
        y = cy - 84 + k * 7
        d.arc((cx - 96, y - 40, cx + 96, y + 60), 200, 340, fill=(180, 210, 255), width=1)

    for det in dets:
        x, y = det["bbox_x"] * SIZE + det["bbox_w"] * SIZE / 2, det["bbox_y"] * SIZE + det["bbox_h"] * SIZE / 2
        s = max(1.2, det["size_mm"] * 9)
        if det["cls"] == "FIBER":
            a = rng.uniform(0, math.pi)
            d.line([(x - s * math.cos(a), y - s * math.sin(a)), (x + s * math.cos(a), y + s * math.sin(a))],
                   fill=(20, 24, 60), width=1)
        elif det["cls"] == "THIN_SPOT":                   # thin tissue passes more light
            d.ellipse((x - s, y - s * 0.8, x + s, y + s * 0.8), fill=(220, 240, 255))
        else:
            d.ellipse((x - s, y - s, x + s, y + s), fill=(16, 20, 54))
    img.filter(ImageFilter.GaussianBlur(0.6)).save(path, optimize=True)


def render(step_id: int, defect: str | None, rng: random.Random, path: str):
    """Draw the image for a visual step and return the defect bbox (normalised) or None."""
    img = Image.new("RGB", (SIZE, SIZE), BG)
    bbox = None
    if step_id == 1:
        region = _patch(rng, img)
    elif step_id == 10:
        region = _leaflet(rng, img)
    else:
        region, bbox = _valve(rng, img, misalign=defect == "LEAFLET_MISALIGN", gap=defect == "SUTURE_GAP")

    d = ImageDraw.Draw(img)
    cx, cy, rr = region
    a, r = rng.uniform(0, 2 * math.pi), rng.uniform(0, rr)
    x, y = cx + r * math.cos(a), cy + r * math.sin(a)
    if defect == "TISSUE_TEAR":
        pts, ang = [(x, y)], rng.uniform(0, math.pi)
        for _ in range(7):
            ang += rng.uniform(-0.6, 0.6)
            px, py = pts[-1]
            pts.append((px + 7 * math.cos(ang), py + 7 * math.sin(ang)))
        d.line(pts, fill=(70, 40, 35), width=3)
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        bbox = (min(xs) - 8, min(ys) - 8, max(xs) - min(xs) + 16, max(ys) - min(ys) + 16)
    elif defect == "CALCIFIC_SPOT":
        for _ in range(rng.randint(3, 6)):
            dx, dy, s = rng.uniform(-12, 12), rng.uniform(-12, 12), rng.uniform(3, 7)
            d.ellipse((x + dx - s, y + dy - s, x + dx + s, y + dy + s), fill=(250, 250, 240))
        bbox = (x - 22, y - 22, 44, 44)
    elif defect == "FIBER_PARTICLE":
        ang = rng.uniform(0, math.pi)
        x2, y2 = x + 26 * math.cos(ang), y + 26 * math.sin(ang)
        d.line([(x, y), ((x + x2) / 2 + rng.uniform(-5, 5), (y + y2) / 2 + rng.uniform(-5, 5)), (x2, y2)], fill=(30, 30, 30), width=1)
        bbox = (min(x, x2) - 8, min(y, y2) - 8, abs(x2 - x) + 16, abs(y2 - y) + 16)

    img = img.filter(ImageFilter.GaussianBlur(0.5))
    img.save(path, optimize=True)
    if bbox is None:
        return None
    bx, by, bw, bh = bbox
    return (max(bx, 0) / SIZE, max(by, 0) / SIZE, bw / SIZE, bh / SIZE)
