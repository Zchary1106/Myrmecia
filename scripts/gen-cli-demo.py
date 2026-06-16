#!/usr/bin/env python3
"""Generate a terminal mockup of the Myrmecia interactive CLI (SVG).

Shows the welcome screen — gradient ANSI-shadow wordmark, tagline, status —
then a natural-language prompt being routed to a specialist agent and streamed,
plus a /agents slash command. Mirrors what `myrmecia` prints in a real terminal.
"""

import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "docs", "diagrams", "cli-demo.svg")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

PANEL = "#0b0f14"; BAR = "#161b22"; WHITE = "#e6edf3"; GRAY = "#8b949e"
GREEN = "#3fb950"; YELLOW = "#d29922"; CYAN = "#58a6ff"; TEAL = "#39d2c0"; VIOLET = "#bc8cff"

# teal -> cyan -> violet, one stop per banner letter
GRAD = ["#39d2c0", "#42c5d2", "#4bb9e4", "#54acf6", "#66a2ff", "#839bff", "#9f93ff", "#bc8cff"]

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

CHAR_W = 8.5
LINE_H = 21
FS = 14
PAD_X = 24
BAR_H = 38
FONT = "'SF Mono','JetBrains Mono',Menlo,Consolas,'Liberation Mono',monospace"

y = BAR_H + 30
parts = []
max_chars = 0


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def text(x, ypos, s, fill, bold=False):
    w = ' font-weight="700"' if bold else ''
    return (f'<text x="{x:.1f}" y="{ypos:.1f}" font-family="{FONT}" font-size="{FS}" '
            f'fill="{fill}"{w} xml:space="preserve">{esc(s)}</text>')


# banner: 6 rows, each letter block in its gradient color
banner_w = sum(len(GLYPHS[ch][0]) + 1 for ch in WORD)
max_chars = banner_w
for r in range(6):
    x = PAD_X
    for i, ch in enumerate(WORD):
        g = GLYPHS[ch][r]
        parts.append(text(x, y, g, GRAD[i]))
        x += (len(g) + 1) * CHAR_W
    y += LINE_H
y += 8


def line(segs):
    global y, max_chars
    x = PAD_X
    total = 0
    for (t, col, b) in segs:
        parts.append(text(x, y, t, col, b))
        x += len(t) * CHAR_W
        total += len(t)
    max_chars = max(max_chars, total)
    y += LINE_H


line([("Autonomous Multi-Agent Orchestration", WHITE, True), ("   \u00b7   v0.1", GRAY, False)])
line([("Not one model \u2014 a ", GRAY, False), ("colony", CYAN, False),
      (". Tasks route to specialists, run in parallel, remembered.", GRAY, False)])
y += 6
line([("\u25cf ", GREEN, False), ("connected ", GRAY, False), ("http://localhost:3000", CYAN, False),
      ("   \u00b7   23 agents ready", GRAY, False)])
line([("Type a task, or ", GRAY, False), ("/help", CYAN, False), (" \u00b7 ", GRAY, False),
      ("/agents", CYAN, False), (" \u00b7 ", GRAY, False), ("/exit", CYAN, False)])
y += 10

line([("myrmecia \u276f ", CYAN, True), ("Add a dark-mode toggle to settings, with tests", WHITE, False)])
line([("\U0001f41c routed", CYAN, False), (" \u2192 ", GRAY, False), ("dev", WHITE, True),
      ("  \u00b7 pipeline \u00b7 medium \u00b7 via semantic", GRAY, False)])
line([("  done      ", GREEN, False), ("Spec", WHITE, False), ("  \u00b7 pm", GRAY, False)])
line([("  running   ", YELLOW, False), ("Code", WHITE, False), ("  \u00b7 dev", GRAY, False)])
line([("  \U0001f527 ", VIOLET, False), ("apply_patch  settings.tsx", GRAY, False)])
line([("  done      ", GREEN, False), ("Review", WHITE, False), ("  \u00b7 review", GRAY, False)])
line([("result ", WHITE, True), ("done", GREEN, False)])
y += 8

line([("myrmecia \u276f ", CYAN, True), ("/agents", WHITE, False)])
line([("  ", GRAY, False), ("pm", CYAN, False), ("    product-manager   ", GRAY, False), ("PM Agent", WHITE, False)])
line([("  ", GRAY, False), ("dev", CYAN, False), ("   developer        ", GRAY, False), ("Dev Agent", WHITE, False)])
line([("  ", GRAY, False), ("qa", CYAN, False), ("    tester            ", GRAY, False), ("QA Agent", WHITE, False)])
line([("  ", GRAY, False), ("\u2026", GRAY, False), ("  23 specialists in the colony", GRAY, False)])

H = int(y + 14)
W = int(PAD_X * 2 + max_chars * CHAR_W) + 8

chrome = []
chrome.append(f'<rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="12" fill="{PANEL}" stroke="#30363d"/>')
chrome.append(f'<path d="M12 0.5 H {W-12} A 11.5 11.5 0 0 1 {W-0.5} 12 V {BAR_H} H 0.5 V 12 A 11.5 11.5 0 0 1 12 0.5 Z" fill="{BAR}"/>')
for i, col in enumerate(("#ff5f56", "#ffbd2e", "#27c93f")):
    chrome.append(f'<circle cx="{22 + i*20}" cy="{BAR_H/2}" r="6" fill="{col}"/>')
chrome.append(f'<text x="{W/2}" y="{BAR_H/2+4}" text-anchor="middle" font-family="{FONT}" font-size="12.5" fill="{GRAY}">myrmecia \u2014 interactive</text>')

svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
       f'fill="none" role="img" aria-label="Myrmecia interactive CLI">\n'
       + "\n".join("  " + p for p in chrome + parts) + "\n</svg>\n")

with open(OUT, "w") as f:
    f.write(svg)
print("wrote", OUT, f"({W}x{H})")
