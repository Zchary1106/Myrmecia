#!/usr/bin/env python3
"""Render an animated GIF of the Myrmecia Agent Teams shared board.

Pure-PIL (no recorder): a dashboard-style board where the lead splits a goal
into subtasks and teammates run **in parallel**, dependency-gated — queued →
running (multiple at once) → done — looping forever.
"""

import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "docs", "diagrams", "teams-board.gif")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

# dashboard palette
BG = (15, 17, 23)
BAR = (26, 27, 35)
SURFACE = (26, 27, 35)
BORDER = (42, 43, 54)
WHITE = (230, 237, 243)
GRAY = (139, 148, 158)
DIM = (98, 106, 115)
BLUE = (88, 166, 255)
EMER = (63, 185, 80)
CYAN = (57, 210, 192)
YELLOW = (227, 179, 65)
VIOLET = (188, 140, 255)
SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

SS = 2
PAD = 22 * SS
BAR_H = 34 * SS

MENLO = "/System/Library/Fonts/Menlo.ttc"
SANS = "/System/Library/Fonts/Helvetica.ttc"
def f_sans(px, bold=False):
    try: return ImageFont.truetype(SANS, int(px * SS), index=1 if bold else 0)
    except Exception: return ImageFont.truetype(MENLO, int(px * SS))
def f_mono(px):
    return ImageFont.truetype(MENLO, int(px * SS))

F_title = f_sans(15, True)
F_goal = f_sans(12.5)
F_status = f_mono(11)
F_role = f_mono(10.5)
F_card = f_sans(12)
F_dep = f_mono(9.5)
F_chip = f_mono(15)
F_foot = f_sans(11)
F_bar = f_sans(11)

# Feature team board — declaration order is the grid order (3 cols x 2 rows)
CARDS = [
    ("pm",  "Write PRD for the profile page", 0),
    ("ui",  "Design profile UI / avatar UX",  1),
    ("ops", "Provision avatar storage + CDN", 1),
    ("dev", "Implement backend profile API",  2),
    ("dev", "Implement frontend profile page", 2),
    ("qa",  "Write tests for avatar upload",  1),
]
# wave: which dependency tier each card is in (0 first, then 1, then 2)
ROLE_COLOR = {"pm": BLUE, "ui": VIOLET, "ops": CYAN, "dev": EMER, "qa": YELLOW}

W = int(PAD * 2 + 3 * 280 * SS / 2 + 2 * 16 * SS / 2) // 1
# compute layout cleanly
GRID_PAD = PAD
GAP = 16 * SS
COLS = 3
CARD_W = 248 * SS
CARD_H = 120 * SS
W = GRID_PAD * 2 + COLS * CARD_W + (COLS - 1) * GAP
HEAD_Y = BAR_H + 16 * SS
GRID_Y = HEAD_Y + 60 * SS
H = GRID_Y + 2 * CARD_H + GAP + 52 * SS


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rrect(d, xy, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(xy, radius=r, fill=fill, outline=outline, width=width)


def text(d, xy, s, font, fill, anchor="la"):
    d.text(xy, s, font=font, fill=fill, anchor=anchor)


def render(state):
    """state: {statuses: [..6 of queued/running/done], spin:int, splitting:bool}"""
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # window chrome
    rrect(d, (SS, SS, W - SS, H - SS), 12 * SS, fill=BG, outline=BORDER, width=SS)
    d.rectangle((SS, SS, W - SS, BAR_H), fill=BAR)
    for i, col in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
        cx = 20 * SS + i * 18 * SS
        d.ellipse((cx - 5 * SS, BAR_H / 2 - 5 * SS, cx + 5 * SS, BAR_H / 2 + 5 * SS), fill=col)
    text(d, (W / 2, BAR_H / 2), "Myrmecia — Agent Teams", F_bar, GRAY, anchor="mm")

    statuses = state["statuses"]
    running = sum(1 for s in statuses if s == "running")
    done = sum(1 for s in statuses if s == "done")

    # header
    d.ellipse((PAD, HEAD_Y + 2 * SS, PAD + 14 * SS, HEAD_Y + 16 * SS), fill=CYAN)
    text(d, (PAD + 24 * SS, HEAD_Y - 1 * SS), "Feature Team", F_title, WHITE, anchor="la")
    tw = d.textlength("Feature Team", font=F_title)
    text(d, (PAD + 24 * SS + tw + 12 * SS, HEAD_Y + 2 * SS), "lead master · 5 teammates", F_status, DIM, anchor="la")
    text(d, (PAD + 24 * SS, HEAD_Y + 22 * SS), "add a profile page with avatar upload", F_goal, GRAY, anchor="la")

    # live status pill (right)
    pill = f"{running} working · {done}/6 done"
    pw = d.textlength(pill, font=F_status) + 20 * SS
    px0 = W - PAD - pw
    rrect(d, (px0, HEAD_Y - 2 * SS, W - PAD, HEAD_Y + 20 * SS), 11 * SS, fill=(20, 24, 33), outline=BORDER, width=SS)
    dotc = BLUE if running else (EMER if done == 6 else GRAY)
    d.ellipse((px0 + 10 * SS, HEAD_Y + 5 * SS, px0 + 16 * SS, HEAD_Y + 11 * SS), fill=dotc)
    text(d, (px0 + 22 * SS, HEAD_Y + 8 * SS), pill, F_status, GRAY, anchor="lm")

    if state.get("splitting"):
        text(d, (W / 2, GRID_Y + CARD_H), "the lead is splitting the goal into parallel tasks…", F_goal, DIM, anchor="mm")
    else:
        for i, (role, title, wave) in enumerate(CARDS):
            col = i % COLS
            row = i // COLS
            x0 = GRID_PAD + col * (CARD_W + GAP)
            y0 = GRID_Y + row * (CARD_H + GAP)
            x1, y1 = x0 + CARD_W, y0 + CARD_H
            st = statuses[i]
            rc = ROLE_COLOR[role]

            if st == "done":
                border, tint = EMER, lerp(BG, EMER, 0.06)
            elif st == "running":
                border, tint = BLUE, lerp(BG, BLUE, 0.10)
            else:
                border, tint = (58, 62, 74), BG

            rrect(d, (x0, y0, x1, y1), 12 * SS, fill=tint, outline=border, width=2 * SS if st == "running" else SS)
            if st == "running":  # subtle outer ring
                rrect(d, (x0 - 2 * SS, y0 - 2 * SS, x1 + 2 * SS, y1 + 2 * SS), 14 * SS, outline=lerp(BG, BLUE, 0.5), width=SS)

            # status indicator (drawn, not a glyph) — top-left
            icx, icy, ir = x0 + 20 * SS, y0 + 22 * SS, 6 * SS
            if st == "done":
                d.line([(icx - ir, icy), (icx - ir / 3, icy + ir * 0.7), (icx + ir, icy - ir * 0.8)], fill=EMER, width=2 * SS, joint="curve")
            elif st == "running":
                start = (state["spin"] * 45) % 360
                d.arc((icx - ir, icy - ir, icx + ir, icy + ir), start, start + 270, fill=BLUE, width=2 * SS)
            else:
                d.ellipse((icx - ir, icy - ir, icx + ir, icy + ir), outline=DIM, width=SS)

            text(d, (x0 + 36 * SS, y0 + 17 * SS), role, F_role, rc, anchor="la")
            text(d, (x1 - 14 * SS, y0 + 17 * SS), st, F_dep, DIM, anchor="ra")

            # title (wrap to 2 lines)
            words = title.split()
            line1, line2, cur = "", "", ""
            maxw = CARD_W - 28 * SS
            for w in words:
                t = (cur + " " + w).strip()
                if d.textlength(t, font=F_card) <= maxw:
                    cur = t
                else:
                    if not line1:
                        line1, cur = cur, w
                    else:
                        line2 = cur
                        cur = w
            if not line1:
                line1 = cur
            elif not line2:
                line2 = cur
            tcol = WHITE if st != "queued" else GRAY
            text(d, (x0 + 14 * SS, y0 + 44 * SS), line1, F_card, tcol, anchor="la")
            if line2:
                text(d, (x0 + 14 * SS, y0 + 62 * SS), line2, F_card, tcol, anchor="la")

            # dependency hint (drawn corner mark + text)
            if st == "queued" and wave > 0:
                dx, dy = x0 + 14 * SS, y1 - 18 * SS
                d.line([(dx, dy - 5 * SS), (dx, dy + 3 * SS), (dx + 6 * SS, dy + 3 * SS)], fill=DIM, width=SS)
                text(d, (dx + 11 * SS, dy - 4 * SS), f"waits on {wave}", F_dep, DIM, anchor="la")

    # footer hint
    text(d, (PAD, H - 26 * SS), "teammates run in parallel on a shared board · message or redirect any of them",
         F_foot, DIM, anchor="la")

    return img.resize((W // SS, H // SS), Image.LANCZOS)


def build_frames():
    frames = []
    def add(statuses, dur, spin=0, splitting=False):
        frames.append((render({"statuses": statuses, "spin": spin, "splitting": splitting}), dur))

    Q, R, D = "queued", "running", "done"

    # Phase A: splitting
    for k in range(3):
        add([Q] * 6, 360, spin=k, splitting=True)

    # Phase B: pm running, rest queued (waves) — show a few spinner frames
    for k in range(7):
        add([R, Q, Q, Q, Q, Q], 200, spin=k)

    # Phase C: pm done → ui, ops, qa run in PARALLEL
    for k in range(9):
        add([D, R, R, Q, Q, R], 200, spin=k)

    # Phase D: that wave done → two dev tasks run in PARALLEL
    for k in range(9):
        add([D, D, D, R, R, D], 200, spin=k)

    # Phase E: all done — hold
    for k in range(7):
        add([D, D, D, D, D, D], 320, spin=k)

    return frames


def main():
    frames = build_frames()
    imgs = [f[0] for f in frames]
    durs = [f[1] for f in frames]
    pal = imgs[0].convert("P", palette=Image.ADAPTIVE, colors=128)
    q = [im.quantize(palette=pal, dither=Image.NONE) for im in imgs]
    q[0].save(OUT, save_all=True, append_images=q[1:], duration=durs, loop=0, optimize=True, disposal=2)
    print(f"wrote {OUT} ({q[0].width}x{q[0].height}, {len(q)} frames, {os.path.getsize(OUT)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
