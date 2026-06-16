#!/usr/bin/env python3
"""Generate a terminal-style mockup of the Myrmecia CLI (SVG).

Renders a realistic CLI session — health, an agent run with streamed output,
and a pipeline streaming its stages — as a macOS-style terminal window, with
the CLI's ANSI colors mapped to on-brand SVG text colors.
"""

import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "docs", "diagrams", "cli-demo.svg")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

# palette
INK = "#0d1117"
PANEL = "#0b0f14"
BAR = "#161b22"
WHITE = "#e6edf3"
GRAY = "#8b949e"
GREEN = "#3fb950"
YELLOW = "#d29922"
CYAN = "#58a6ff"
TEAL = "#39d2c0"
VIOLET = "#bc8cff"
RED = "#ff7b72"

# A session: list of lines; each line is a list of (text, color) segments.
P = (TEAL, "bold")  # prompt marker style sentinel (handled below)

def seg(t, color=WHITE, bold=False):
    return (t, color, bold)

def prompt(cmd):
    return [seg("$ ", TEAL, True), seg(cmd, WHITE, True)]

LINES = [
    prompt("pnpm cli health"),
    [seg("Myrmecia", WHITE, True), seg(" @ ", GRAY), seg("http://localhost:3000", CYAN)],
    [seg("  status   ", GRAY), seg("ok", GREEN), seg("   uptime 72878s", GRAY)],
    [seg("  agents   ", GRAY), seg("23 total · 22 idle · 1 active", WHITE)],
    [seg("  tasks    ", GRAY), seg("0 running · 1 queued", WHITE)],
    [],
    prompt('myrmecia run pm "Write a spec for a dark-mode toggle"'),
    [seg("\u25b6 ", GREEN), seg("pm", WHITE, True), seg(" task ", WHITE), seg("task_94a2f742", CYAN)],
    [seg("## Dark Mode Toggle \u2014 Spec", WHITE)],
    [seg("1. Problem: users want to switch the dashboard theme\u2026", WHITE)],
    [seg("2. Acceptance: choice persists across reloads\u2026", WHITE)],
    [],
    [seg("result ", WHITE, True), seg("done", GREEN)],
    [],
    prompt('myrmecia pipeline Feature "Add CSV export to reports"'),
    [seg("\u25b6 ", GREEN), seg("pipeline ", WHITE), seg("pipe_7f3a2c", CYAN), seg("  (Feature, auto)", GRAY)],
    [seg("  done      ", GREEN), seg("Spec", WHITE), seg(" · pm", GRAY)],
    [seg("  running   ", YELLOW), seg("Code", WHITE), seg(" · dev", GRAY)],
    [seg("  done      ", GREEN), seg("Code", WHITE), seg(" · dev", GRAY)],
    [seg("  done      ", GREEN), seg("Test", WHITE), seg(" · qa", GRAY)],
    [seg("  done      ", GREEN), seg("Review", WHITE), seg(" · review", GRAY)],
    [],
    [seg("pipeline ", WHITE, True), seg("completed", GREEN)],
]

CHAR_W = 8.6
LINE_H = 22
FS = 14
PAD_X = 22
BAR_H = 38
TOP = BAR_H + 18

max_len = max((sum(len(s[0]) for s in ln) for ln in LINES if ln), default=40)
W = int(PAD_X * 2 + max_len * CHAR_W) + 10
H = int(TOP + len(LINES) * LINE_H + 18)

FONT = "'SF Mono','JetBrains Mono',Menlo,Consolas,'Liberation Mono',monospace"


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


parts = []
# window
parts.append(f'<rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="12" fill="{PANEL}" stroke="#30363d"/>')
parts.append(f'<path d="M12 0.5 H {W-12} A 11.5 11.5 0 0 1 {W-0.5} 12 V {BAR_H} H 0.5 V 12 A 11.5 11.5 0 0 1 12 0.5 Z" fill="{BAR}"/>')
for i, col in enumerate(("#ff5f56", "#ffbd2e", "#27c93f")):
    parts.append(f'<circle cx="{22 + i*20}" cy="{BAR_H/2}" r="6" fill="{col}"/>')
parts.append(f'<text x="{W/2}" y="{BAR_H/2+4}" text-anchor="middle" font-family="{FONT}" font-size="12.5" fill="{GRAY}">myrmecia \u2014 CLI</text>')

# body lines
y = TOP
for ln in LINES:
    x = PAD_X
    for (t, color, bold) in ln:
        weight = ' font-weight="700"' if bold else ''
        parts.append(f'<text x="{x:.1f}" y="{y:.1f}" font-family="{FONT}" font-size="{FS}" fill="{color}"{weight} xml:space="preserve">{esc(t)}</text>')
        x += len(t) * CHAR_W
    y += LINE_H

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" fill="none" role="img" aria-label="Myrmecia CLI demo">
  {chr(10).join("  " + p for p in parts)}
</svg>
'''
with open(OUT, "w") as f:
    f.write(svg)
print("wrote", OUT, f"({W}x{H})")
