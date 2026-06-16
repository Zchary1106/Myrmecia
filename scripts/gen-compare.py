#!/usr/bin/env python3
"""Generate the Myrmecia capability-comparison matrix (SVG).

A coverage matrix: rows = capability layers, columns = Myrmecia vs the main
categories of tools in the space. ● full · ◐ partial · ○ none. On-brand
(teal/cyan/violet on ink) to match the README banner and diagrams.
"""

import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "docs", "diagrams", "comparison.svg")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

TEAL = "#39d2c0"
CYAN = "#58a6ff"
VIOLET = "#bc8cff"
WHITE = "#e6edf3"
MUTE = "#9aa6b3"
INK = "#0d1117"
INK2 = "#11161f"
GRID = "#30363d"

COLS = ["Myrmecia", "LangGraph\nCrewAI", "Dify\nn8n", "Mem0\nZep", "Hosted\nAssistants"]

ROWS = [
    ("Agent engine (tool loop)",        [2, 2, 1, 0, 2]),
    ("Edit code & run shell (TDD)",     [2, 1, 1, 0, 2]),
    ("Context auto-compact",            [2, 1, 0, 1, 2]),
    ("Multi-agent DAG orchestration",   [2, 2, 1, 0, 1]),
    ("Visual editor",                   [2, 0, 2, 0, 1]),
    ("Unified memory subsystem",        [2, 1, 0, 2, 1]),
    ("Tool governance & permissions",   [2, 0, 1, 0, 1]),
    ("Observability & tracing",         [2, 1, 1, 0, 1]),
    ("Real-time dashboard",             [2, 0, 2, 0, 1]),
    ("Self-hosted (data stays)",        [2, 2, 2, 2, 0]),
    ("MCP + model gateway",             [2, 1, 0, 0, 1]),
]

W = 1180
LABEL_W = 320
PAD = 24
HEAD_TOP = 96
HEAD_H = 56
ROW_H = 44
GRID_TOP = HEAD_TOP + HEAD_H
N = len(COLS)
COL_W = (W - PAD - LABEL_W - PAD) / N
ROWS_BOTTOM = GRID_TOP + ROW_H * len(ROWS)
H = ROWS_BOTTOM + 92


def col_cx(i):
    return PAD + LABEL_W + COL_W * (i + 0.5)


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def dot(cx, cy, state):
    r = 11
    if state == 2:  # full
        return (f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r}" fill="{TEAL}" />'
                f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r}" fill="none" stroke="{TEAL}" stroke-opacity="0.35" stroke-width="5"/>')
    if state == 1:  # partial (right half filled)
        return (f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r}" fill="none" stroke="{VIOLET}" stroke-width="2.2"/>'
                f'<path d="M {cx:.1f} {cy-r} A {r} {r} 0 0 1 {cx:.1f} {cy+r} Z" fill="{VIOLET}"/>')
    return f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r}" fill="none" stroke="{GRID}" stroke-width="2.2"/>'


parts = []
# header column labels (multi-line)
for i, name in enumerate(COLS):
    cx = col_cx(i)
    lines = name.split("\n")
    accent = i == 0
    fill = TEAL if accent else MUTE
    weight = 700 if accent else 600
    y0 = HEAD_TOP + 24 - (len(lines) - 1) * 9
    for k, ln in enumerate(lines):
        parts.append(
            f'<text x="{cx:.1f}" y="{y0 + k*18:.1f}" text-anchor="middle" '
            f'font-family="Futura,\'Trebuchet MS\',Avenir,\'Segoe UI\',system-ui,sans-serif" '
            f'font-size="16" font-weight="{weight}" fill="{fill}">{esc(ln)}</text>'
        )

# Myrmecia column highlight band
mx = PAD + LABEL_W
parts.insert(0,
    f'<rect x="{mx:.1f}" y="{HEAD_TOP-8:.1f}" width="{COL_W:.1f}" height="{ROWS_BOTTOM-HEAD_TOP+16:.1f}" '
    f'rx="14" fill="{TEAL}" fill-opacity="0.06" stroke="{TEAL}" stroke-opacity="0.35" stroke-width="1.5"/>'
)

# rows
for r, (label, states) in enumerate(ROWS):
    cy = GRID_TOP + ROW_H * r + ROW_H / 2
    if r % 2 == 0:
        parts.append(f'<rect x="{PAD}" y="{GRID_TOP + ROW_H*r:.1f}" width="{W-2*PAD}" height="{ROW_H}" fill="#ffffff" fill-opacity="0.015"/>')
    parts.append(
        f'<text x="{PAD+12}" y="{cy+5:.1f}" font-family="Futura,\'Trebuchet MS\',Avenir,\'Segoe UI\',system-ui,sans-serif" '
        f'font-size="16" fill="{WHITE}">{esc(label)}</text>'
    )
    for i, st in enumerate(states):
        parts.append(dot(col_cx(i), cy, st))

# legend
cap_y = ROWS_BOTTOM + 32
ly = ROWS_BOTTOM + 58
lx = PAD + 12
legend = [(2, "Full"), (1, "Partial"), (0, "None")]
parts.append(
    f'<text x="{PAD+12}" y="{cap_y:.1f}" font-family="Futura,\'Trebuchet MS\',Avenir,sans-serif" '
    f'font-size="14" fill="{MUTE}">Coverage of the capability, not quality of any single feature.</text>'
)
cur = lx
for st, name in legend:
    parts.append(dot(cur + 11, ly, st))
    parts.append(
        f'<text x="{cur+30:.1f}" y="{ly+5:.1f}" font-family="Futura,\'Trebuchet MS\',Avenir,sans-serif" '
        f'font-size="14" fill="{MUTE}">{name}</text>'
    )
    cur += 30 + len(name) * 8 + 34

body = "\n  ".join(parts)
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" fill="none" role="img" aria-label="Myrmecia capability comparison">
  <rect x="0.5" y="0.5" width="{W-1}" height="{H-1}" rx="20" fill="{INK2}" stroke="{GRID}"/>
  <text x="{PAD+12}" y="46" font-family="Futura,'Trebuchet MS',Avenir,'Segoe UI',system-ui,sans-serif" font-size="26" font-weight="700" fill="{WHITE}">How Myrmecia compares</text>
  <text x="{PAD+12}" y="72" font-family="Futura,'Trebuchet MS',Avenir,sans-serif" font-size="15" fill="{MUTE}">Engine + platform in one self-hosted system — others cover a slice.</text>
  {body}
</svg>
'''
with open(OUT, "w") as f:
    f.write(svg)
print("wrote", OUT, f"({W}x{H})")
