#!/usr/bin/env python3
"""Render an animated GIF of the Myrmecia interactive CLI.

Pure-PIL (no external recorder): each frame is drawn from a small state machine
— welcome banner, the task being typed into the pinned input box, routing, then
stages streaming above the box, and the result — looping forever. The input box
stays pinned at the bottom the whole time (matching the real CLI).
"""

import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "docs", "diagrams", "cli-demo.gif")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

# ---- palette ----
PANEL = (11, 15, 20)
BAR = (22, 27, 34)
STROKE = (48, 54, 61)
WHITE = (230, 237, 243)
GRAY = (139, 148, 158)
DIM = (98, 106, 115)
GREEN = (63, 185, 80)
YELLOW = (210, 153, 34)
CYAN = (88, 166, 255)
TEAL = (57, 210, 192)
VIOLET = (188, 140, 255)
GRAD = [(57, 210, 192), (66, 197, 210), (75, 185, 228), (84, 172, 246),
        (102, 162, 255), (131, 155, 255), (159, 147, 255), (188, 140, 255)]

GLYPHS = {
    "M": ["███╗   ███╗", "████╗ ████║", "██╔████╔██║", "██║╚██╔╝██║", "██║ ╚═╝ ██║", "╚═╝     ╚═╝"],
    "Y": ["██╗   ██╗", "╚██╗ ██╔╝", " ╚████╔╝ ", "  ╚██╔╝  ", "   ██║   ", "   ╚═╝   "],
    "R": ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"],
    "E": ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
    "C": [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
    "I": ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
    "A": [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
}
WORD = "MYRMECIA"
SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

SS = 2                      # supersample
FS = 17 * SS               # body font px
BFS = 15 * SS              # banner font px (slightly smaller so it's compact)
PAD = 26 * SS
BAR_H = 36 * SS

MENLO = "/System/Library/Fonts/Menlo.ttc"
font = ImageFont.truetype(MENLO, FS, index=0)
font_b = ImageFont.truetype(MENLO, FS, index=1)
font_banner = ImageFont.truetype(MENLO, BFS, index=0)
font_title = ImageFont.truetype(MENLO, int(12.5 * SS), index=0)

# monospace cell metrics
CW = font.getlength("M")
LH = int(FS * 1.42)
BCW = font_banner.getlength("█")
BLH = int(BFS * 1.30)

TASK = "Add a dark-mode toggle to settings, with tests"

# transcript lines revealed during streaming (text segments: (s, color, bold))
def transcript(stage):
    """stage: how many transcript lines are visible (0..7)."""
    rows = [
        [("\u276f ", CYAN, True), (TASK, WHITE, False)],
        [("routed ", TEAL, True), ("\u2192 ", GRAY, False), ("dev", WHITE, True),
         ("  \u00b7 pipeline \u00b7 medium \u00b7 via semantic", GRAY, False)],
        [("  done     ", GREEN, False), ("Spec", WHITE, False), ("  \u00b7 pm", GRAY, False)],
        [("  running  ", YELLOW, False), ("Code", WHITE, False), ("  \u00b7 dev", GRAY, False)],
        [("  \u21b3 ", VIOLET, False), ("apply_patch", VIOLET, False), ("  settings.tsx", GRAY, False)],
        [("  done     ", GREEN, False), ("Review", WHITE, False), ("  \u00b7 review", GRAY, False)],
        [("result ", WHITE, True), ("done", GREEN, False)],
    ]
    return rows[:stage]


def draw_segs(d, x, y, segs, bold_default=False):
    for (s, col, b) in segs:
        f = font_b if (b or bold_default) else font
        d.text((x, y), s, font=f, fill=col)
        x += font.getlength(s)  # keep monospace alignment using regular metric
    return x


# layout: chrome, banner(6), welcome(4), blank, transcript(7 reserved), blank, box(5)
N_TRANSCRIPT = 7
banner_w = sum(len(GLYPHS[ch][0]) + 1 for ch in WORD)
CONTENT_W = max(int(banner_w * BCW), int(86 * CW)) + 2 * PAD
W = CONTENT_W
# vertical budget
y_banner = BAR_H + 22 * SS
y_welcome = y_banner + 6 * BLH + 18 * SS
y_transcript = y_welcome + 4 * LH + 16 * SS
y_box = y_transcript + N_TRANSCRIPT * LH + 14 * SS
H = y_box + 5 * LH + 20 * SS

BOXW_CH = int((W - 2 * PAD) / CW)        # box rule width in chars


def render(state):
    """state keys: typed(int chars), stage(int), cursor(bool), spin(int|None), busy(str|None)"""
    img = Image.new("RGB", (W, H), PANEL)
    d = ImageDraw.Draw(img)

    # window chrome
    d.rounded_rectangle((SS, SS, W - SS, H - SS), radius=12 * SS, fill=PANEL, outline=STROKE, width=SS)
    d.rectangle((SS, SS, W - SS, BAR_H), fill=BAR)
    for i, col in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
        cx = 22 * SS + i * 20 * SS
        d.ellipse((cx - 6 * SS, BAR_H / 2 - 6 * SS, cx + 6 * SS, BAR_H / 2 + 6 * SS), fill=col)
    tt = "myrmecia — interactive"
    d.text((W / 2 - font_title.getlength(tt) / 2, BAR_H / 2 - FS / 2), tt, font=font_title, fill=GRAY)

    # banner
    y = y_banner
    for r in range(6):
        x = PAD
        for i, ch in enumerate(WORD):
            g = GLYPHS[ch][r]
            d.text((x, y), g, font=font_banner, fill=GRAD[i])
            x += (len(g) + 1) * BCW
        y += BLH

    # welcome
    y = y_welcome
    draw_segs(d, PAD, y, [("Autonomous Multi-Agent Orchestration", WHITE, True), ("   \u00b7   v0.1", GRAY, False)]); y += LH
    draw_segs(d, PAD, y, [("Not one model \u2014 a ", GRAY, False), ("colony", CYAN, False), (". Tasks route to specialists, run in parallel.", GRAY, False)]); y += LH
    draw_segs(d, PAD, y, [("\u25cf ", GREEN, False), ("connected ", GRAY, False), ("http://localhost:3000", CYAN, False), ("   \u00b7   23 agents ready", GRAY, False)]); y += LH
    draw_segs(d, PAD, y, [("Type a task, or ", GRAY, False), ("/help", CYAN, False), (" \u00b7 ", GRAY, False), ("/agents", CYAN, False), (" \u00b7 ", GRAY, False), ("/exit", CYAN, False)]); y += LH

    # transcript
    y = y_transcript
    for segs in transcript(state["stage"]):
        draw_segs(d, PAD, y, segs)
        y += LH

    # pinned input box
    y = y_box
    rule = "\u2500" * (BOXW_CH - 2)
    # meta top
    left = [("  ", GRAY, False), ("\u25cf", GREEN, False), (" myrmecia", CYAN, True)]
    right = "localhost:3000  \u00b7  23 agents"
    draw_segs(d, PAD, y, left)
    d.text((W - PAD - font.getlength(right), y), right, font=font, fill=GRAY); y += LH
    d.text((PAD, y), "  " + rule, font=font, fill=DIM); y += LH
    # input / busy line
    if state.get("busy"):
        sp = SPIN[(state.get("spin") or 0) % len(SPIN)]
        d.text((PAD, y), "  ", font=font, fill=GRAY)
        x = PAD + 2 * CW
        d.text((x, y), sp, font=font, fill=TEAL); x += 2 * CW
        d.text((x, y), state["busy"] + "   \u00b7  esc to interrupt", font=font, fill=GRAY)
    else:
        d.text((PAD, y), "  \u203a ", font=font, fill=CYAN)
        x = PAD + 4 * CW
        typed = TASK[:state["typed"]]
        if state["typed"] == 0:
            d.text((x, y), "Describe a task, or /help", font=font, fill=DIM)
            caret_x = x
        else:
            d.text((x, y), typed, font=font_b, fill=WHITE)
            caret_x = x + font.getlength(typed)
        if state.get("cursor"):
            d.rectangle((caret_x, y + 2 * SS, caret_x + 2 * SS, y + LH - 4 * SS), fill=TEAL)
    y += LH
    d.text((PAD, y), "  " + rule, font=font, fill=DIM); y += LH
    # hints + model
    draw_segs(d, PAD, y, [("  ", GRAY, False), ("/help", CYAN, False), (" \u00b7 ", GRAY, False), ("/model", CYAN, False), (" \u00b7 ", GRAY, False), ("/agents", CYAN, False), (" \u00b7 ", GRAY, False), ("/exit", CYAN, False)])
    mr = "model claude-haiku-4.5"
    d.text((W - PAD - font.getlength(mr), y), "model ", font=font, fill=GRAY)
    d.text((W - PAD - font.getlength("claude-haiku-4.5"), y), "claude-haiku-4.5", font=font, fill=TEAL)

    return img.resize((W // SS, H // SS), Image.LANCZOS)


def build_frames():
    frames = []   # (image, duration_ms)
    base = dict(typed=0, stage=0, cursor=True, spin=None, busy=None)

    def add(state, dur, blink=False):
        frames.append((render(state), dur))

    # Phase A: welcome hold with blinking cursor
    for k in range(4):
        s = dict(base); s["cursor"] = (k % 2 == 0)
        add(s, 420)

    # Phase B: type the task
    i = 0
    step = 3
    while i < len(TASK):
        i = min(len(TASK), i + step)
        s = dict(base); s["typed"] = i; s["cursor"] = True
        add(s, 60)
    # small pause with blink after typed
    for k in range(3):
        s = dict(base); s["typed"] = len(TASK); s["cursor"] = (k % 2 == 0)
        add(s, 260)

    # Phase C: submit → routing spinner (task echoed into transcript)
    for k in range(6):
        s = dict(base); s["typed"] = 0; s["stage"] = 1; s["busy"] = "routing to a specialist"; s["spin"] = k
        add(s, 110)

    # Phase D: stages stream above, agent-working spinner in box
    # reveal routed(2) then each stage, holding spinner between
    spin = 0
    for stage in range(2, 8):
        for k in range(3):
            s = dict(base); s["typed"] = 0; s["stage"] = stage
            if stage < 7:
                s["busy"] = "agent working"; s["spin"] = spin; spin += 1
            add(s, 230)

    # Phase E: result hold, box back to placeholder
    for k in range(6):
        s = dict(base); s["typed"] = 0; s["stage"] = 7; s["cursor"] = (k % 2 == 0)
        add(s, 440)

    return frames


def main():
    frames = build_frames()
    imgs = [f[0] for f in frames]
    durs = [f[1] for f in frames]
    # quantize to a shared adaptive palette for small, crisp output
    pal = imgs[0].convert("P", palette=Image.ADAPTIVE, colors=128)
    qimgs = [im.quantize(palette=pal, dither=Image.NONE) for im in imgs]
    qimgs[0].save(OUT, save_all=True, append_images=qimgs[1:], duration=durs,
                  loop=0, optimize=True, disposal=2)
    size = os.path.getsize(OUT) / 1024
    print(f"wrote {OUT} ({qimgs[0].width}x{qimgs[0].height}, {len(qimgs)} frames, {size:.0f} KB)")


if __name__ == "__main__":
    main()
