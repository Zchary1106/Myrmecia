#!/usr/bin/env python3
"""Generate the Myrmecia logo lockup (fancy mark + wordmark) and a square mark."""

import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "packages", "dashboard", "public")
os.makedirs(OUT, exist_ok=True)

# ---- palette (matches dashboard accents) ----
TEAL = (57, 210, 192)      # #39d2c0
CYAN = (88, 166, 255)      # #58a6ff
VIOLET = (188, 140, 255)   # #bc8cff
WHITE = (230, 237, 243)
INK = (13, 17, 23)

def load_font(size, index=0):
    for p, idx in [("/System/Library/Fonts/Supplemental/Futura.ttc", index),
                   ("/System/Library/Fonts/Avenir Next.ttc", 0),
                   ("/Library/Fonts/Arial Bold.ttf", 0),
                   ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0)]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size, index=idx)
            except Exception:
                try:
                    return ImageFont.truetype(p, size)
                except Exception:
                    continue
    return ImageFont.load_default()

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def vgrad(w, h, top, bottom):
    g = Image.new("RGB", (w, h))
    px = g.load()
    for y in range(h):
        c = lerp(top, bottom, y / max(1, h - 1))
        for x in range(w):
            px[x, y] = c
    return g

def hgrad(w, h, stops):
    """stops: list of (pos0..1, color)."""
    g = Image.new("RGB", (w, h))
    px = g.load()
    for x in range(w):
        t = x / max(1, w - 1)
        # find segment
        for i in range(len(stops) - 1):
            p0, c0 = stops[i]
            p1, c1 = stops[i + 1]
            if p0 <= t <= p1:
                c = lerp(c0, c1, (t - p0) / max(1e-6, p1 - p0))
                break
        else:
            c = stops[-1][1]
        for y in range(h):
            px[x, y] = c
    return g

def hexagon(cx, cy, r, rot=0):
    import math
    pts = []
    for k in range(6):
        ang = math.radians(60 * k - 90 + rot)
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return pts

def draw_mark(size=420, scale=3):
    """A rounded hexagon badge with a glowing node-ant inside."""
    S = size * scale
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    cx = cy = S // 2
    r = int(S * 0.40)

    # --- glow behind the badge ---
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.polygon(hexagon(cx, cy, r + 10), fill=(57, 210, 192, 150))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.05))
    img = Image.alpha_composite(img, glow)

    # --- hexagon body with gradient (violet top -> teal bottom) ---
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).polygon(hexagon(cx, cy, r), fill=255)
    grad = vgrad(S, S, VIOLET, TEAL).convert("RGBA")
    badge = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    badge.paste(grad, (0, 0), mask)
    img = Image.alpha_composite(img, badge)

    # inner darken for depth + crisp edge
    d = ImageDraw.Draw(img)
    d.polygon(hexagon(cx, cy, r), outline=(255, 255, 255, 60), width=scale * 2)
    d.polygon(hexagon(cx, cy, int(r * 0.995)), outline=(13, 17, 23, 90), width=scale)

    # --- node-ant: 3 body nodes + legs + antennae, drawn in white ---
    ant = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    a = ImageDraw.Draw(ant)
    # body nodes along a vertical axis (head top -> abdomen bottom)
    bx = cx
    head = (bx, int(cy - r * 0.42), int(S * 0.045))
    thorax = (bx, int(cy - r * 0.02), int(S * 0.058))
    abdomen = (bx, int(cy + r * 0.42), int(S * 0.075))
    line_w = max(2, int(S * 0.012))
    # spine
    a.line([head[:2], thorax[:2], abdomen[:2]], fill=(255, 255, 255, 235), width=line_w, joint="curve")
    # legs (3 pairs from thorax)
    leg_w = max(2, int(S * 0.009))
    for i, ly in enumerate((-0.10, 0.02, 0.14)):
        y0 = int(thorax[1] + r * ly)
        span = int(r * (0.34 + 0.04 * i))
        drop = int(r * 0.12)
        a.line([(bx, y0), (bx - span, y0 + drop)], fill=(255, 255, 255, 220), width=leg_w)
        a.line([(bx, y0), (bx + span, y0 + drop)], fill=(255, 255, 255, 220), width=leg_w)
    # antennae
    a.line([head[:2], (bx - int(r * 0.22), int(head[1] - r * 0.26))], fill=(255, 255, 255, 220), width=leg_w)
    a.line([head[:2], (bx + int(r * 0.22), int(head[1] - r * 0.26))], fill=(255, 255, 255, 220), width=leg_w)
    # nodes (circles)
    for (nx, ny, nr) in (head, thorax, abdomen):
        a.ellipse([nx - nr, ny - nr, nx + nr, ny + nr], fill=(255, 255, 255, 255))
    # antenna + leg tip dots
    for (tx, ty) in [(bx - int(r * 0.22), int(head[1] - r * 0.26)), (bx + int(r * 0.22), int(head[1] - r * 0.26))]:
        tr = int(S * 0.018)
        a.ellipse([tx - tr, ty - tr, tx + tr, ty + tr], fill=(255, 255, 255, 255))
    # soft glow on the ant
    antglow = ant.filter(ImageFilter.GaussianBlur(S * 0.012))
    img = Image.alpha_composite(img, antglow)
    img = Image.alpha_composite(img, ant)

    return img.resize((size, size), Image.LANCZOS)

def gradient_text(text, font, stops, glow_color):
    bbox = font.getbbox(text)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pad = int(th * 0.6)
    W, H = tw + 2 * pad, th + 2 * pad
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).text((pad - bbox[0], pad - bbox[1]), text, font=font, fill=255)
    grad = hgrad(W, H, stops).convert("RGBA")
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).text((pad - bbox[0], pad - bbox[1]), text, font=font, fill=glow_color)
    glow = glow.filter(ImageFilter.GaussianBlur(H * 0.04))
    final = Image.alpha_composite(glow, out)
    bb = final.getbbox()
    return final.crop(bb) if bb else final

def build_lockup():
    scale = 3
    H = 340
    markpx = 270
    mark = draw_mark(markpx, scale)

    word = gradient_text("Myrmecia", load_font(140, index=4),
                         [(0.0, TEAL), (0.45, CYAN), (1.0, WHITE)], (57, 210, 192, 200))
    tg = gradient_text("MULTI-AGENT ORCHESTRATION", load_font(33, 0),
                       [(0.0, (146, 156, 167)), (1.0, (146, 156, 167))], (0, 0, 0, 0))
    ww, wh = word.size
    tw, th = tg.size

    margin = 54
    gap = 26
    tx = margin + markpx + gap
    W = tx + max(ww, tw) + margin

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))

    # dark rounded panel + halo
    panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(panel).rounded_rectangle([0, 0, W - 1, H - 1], radius=44,
                                            fill=(13, 17, 23, 255), outline=(57, 210, 192, 70), width=3)
    halo = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(halo).ellipse([margin - 30, H // 2 - 150, margin + markpx + 30, H // 2 + 150],
                                 fill=(57, 210, 192, 45))
    halo = halo.filter(ImageFilter.GaussianBlur(40))
    img = Image.alpha_composite(img, Image.alpha_composite(panel, halo))

    # mark centered vertically
    img.alpha_composite(mark, (margin, (H - markpx) // 2))

    # word + tagline as a centered group, left-aligned at tx
    text_gap = 16
    block_h = wh + text_gap + th
    top = (H - block_h) // 2
    img.alpha_composite(word, (tx, top))
    img.alpha_composite(tg, (tx + 4, top + wh + text_gap))

    img.save(os.path.join(OUT, "myrmecia-logo.png"))
    print("wrote", os.path.join(OUT, "myrmecia-logo.png"), img.size)

    mark.save(os.path.join(OUT, "myrmecia-mark.png"))
    print("wrote", os.path.join(OUT, "myrmecia-mark.png"), mark.size)

build_lockup()
print("done")
