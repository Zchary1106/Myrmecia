#!/usr/bin/env python3
"""Generate the full-width animated Myrmecia hero banner (SVG).

SMIL animations render on GitHub when the SVG is referenced as an <img>,
so this produces an eye-catching, landscape banner that fills the README
width: a living "colony" mesh of nodes/edges, a glowing hexagon node-ant
mark, and a shimmering wordmark.
"""

import math
import os
import random

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "packages", "dashboard", "public", "myrmecia-banner.svg")

# ---- palette (matches dashboard accents / gen-logo.py) ----
TEAL = "#39d2c0"
CYAN = "#58a6ff"
VIOLET = "#bc8cff"
WHITE = "#e6edf3"
INK = "#0d1117"
INK2 = "#11161f"

W, H = 1280, 360
random.seed(7)


def hexagon(cx, cy, r):
    pts = []
    for k in range(6):
        ang = math.radians(60 * k - 90)
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return pts


def poly(pts):
    return " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)


# ---------------------------------------------------------------- node-ant
def node_ant(cx, cy, r):
    """Vector node-ant (3 body nodes + spine + legs + antennae), white."""
    head = (cx, cy - r * 0.42)
    thorax = (cx, cy - r * 0.02)
    abdomen = (cx, cy + r * 0.42)
    head_r, thorax_r, abdomen_r = 0.1125 * r, 0.145 * r, 0.1875 * r
    spine_w = max(2.5, 0.030 * r)
    leg_w = max(2.0, 0.022 * r)
    s = []
    # spine
    s.append(
        f'<polyline points="{head[0]:.1f},{head[1]:.1f} {thorax[0]:.1f},{thorax[1]:.1f} '
        f'{abdomen[0]:.1f},{abdomen[1]:.1f}" fill="none" stroke="#fff" '
        f'stroke-width="{spine_w:.1f}" stroke-linecap="round" stroke-linejoin="round"/>'
    )
    # legs (3 pairs from thorax region)
    for i, ly in enumerate((-0.10, 0.02, 0.14)):
        y0 = thorax[1] + r * ly
        span = r * (0.34 + 0.04 * i)
        drop = r * 0.12
        s.append(
            f'<line x1="{cx:.1f}" y1="{y0:.1f}" x2="{cx-span:.1f}" y2="{y0+drop:.1f}" '
            f'stroke="#fff" stroke-width="{leg_w:.1f}" stroke-linecap="round"/>'
        )
        s.append(
            f'<line x1="{cx:.1f}" y1="{y0:.1f}" x2="{cx+span:.1f}" y2="{y0+drop:.1f}" '
            f'stroke="#fff" stroke-width="{leg_w:.1f}" stroke-linecap="round"/>'
        )
    # antennae + tip dots
    tips = [(cx - r * 0.22, head[1] - r * 0.26), (cx + r * 0.22, head[1] - r * 0.26)]
    for tx, ty in tips:
        s.append(
            f'<line x1="{head[0]:.1f}" y1="{head[1]:.1f}" x2="{tx:.1f}" y2="{ty:.1f}" '
            f'stroke="#fff" stroke-width="{leg_w:.1f}" stroke-linecap="round"/>'
        )
        s.append(f'<circle cx="{tx:.1f}" cy="{ty:.1f}" r="{0.045*r:.1f}" fill="#fff"/>')
    # body nodes
    for nx, ny, nr in (
        (*head, head_r),
        (*thorax, thorax_r),
        (*abdomen, abdomen_r),
    ):
        s.append(f'<circle cx="{nx:.1f}" cy="{ny:.1f}" r="{nr:.1f}" fill="#fff"/>')
    return "\n      ".join(s)


# ---------------------------------------------------------------- mesh
def build_mesh():
    """Seeded constellation of nodes + nearest-neighbour edges across the canvas."""
    nodes = []
    attempts = 0
    while len(nodes) < 26 and attempts < 4000:
        attempts += 1
        x = random.uniform(40, W - 40)
        y = random.uniform(34, H - 34)
        # keep the mesh slightly sparser directly under the wordmark for legibility
        if 360 < x < 1120 and 120 < y < 250 and random.random() < 0.6:
            continue
        if all((x - nx) ** 2 + (y - ny) ** 2 > 92 ** 2 for nx, ny, _ in nodes):
            nodes.append((x, y, random.choice([TEAL, CYAN, VIOLET])))
    # edges: connect each node to up to 2 nearest neighbours
    edges = set()
    for i, (x, y, _) in enumerate(nodes):
        d = sorted(
            range(len(nodes)),
            key=lambda j: (x - nodes[j][0]) ** 2 + (y - nodes[j][1]) ** 2,
        )
        for j in d[1:3]:
            edges.add(tuple(sorted((i, j))))
    return nodes, list(edges)


def render():
    nodes, edges = build_mesh()
    cx, cy, r = 196, 180, 116
    hexpts = hexagon(cx, cy, r)
    hexpts_in = hexagon(cx, cy, r * 0.99)

    # --- background mesh edges ---
    edge_svg = []
    for k, (i, j) in enumerate(edges):
        x1, y1, _ = nodes[i]
        x2, y2, _ = nodes[j]
        dur = 5 + (k % 5)
        edge_svg.append(
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{CYAN}" stroke-width="1" opacity="0.10">'
            f'<animate attributeName="opacity" values="0.05;0.22;0.05" '
            f'dur="{dur}s" begin="{(k%7)*0.4:.1f}s" repeatCount="indefinite"/></line>'
        )

    # --- background mesh nodes ---
    node_svg = []
    for k, (x, y, c) in enumerate(nodes):
        rr = random.choice([1.8, 2.4, 3.0])
        dur = 3 + (k % 6) * 0.6
        node_svg.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{rr}" fill="{c}" opacity="0.5">'
            f'<animate attributeName="opacity" values="0.2;0.85;0.2" dur="{dur:.1f}s" '
            f'begin="{(k%5)*0.5:.1f}s" repeatCount="indefinite"/>'
            f'<animate attributeName="r" values="{rr};{rr*1.7:.1f};{rr}" dur="{dur:.1f}s" '
            f'begin="{(k%5)*0.5:.1f}s" repeatCount="indefinite"/></circle>'
        )

    # --- data pulses travelling along a few edges ---
    pulse_svg = []
    for k, (i, j) in enumerate(edges[:7]):
        x1, y1, _ = nodes[i]
        x2, y2, _ = nodes[j]
        dur = 2.8 + k * 0.5
        pulse_svg.append(
            f'<circle r="2.6" fill="{WHITE}" opacity="0.9">'
            f'<animateMotion dur="{dur:.1f}s" begin="{k*0.6:.1f}s" repeatCount="indefinite" '
            f'path="M {x1:.1f} {y1:.1f} L {x2:.1f} {y2:.1f}"/>'
            f'<animate attributeName="opacity" values="0;1;0" dur="{dur:.1f}s" '
            f'begin="{k*0.6:.1f}s" repeatCount="indefinite"/></circle>'
        )

    ant = node_ant(cx, cy, r)
    edge_block = "\n    ".join(edge_svg)
    node_block = "\n    ".join(node_svg)
    pulse_block = "\n    ".join(pulse_svg)

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" fill="none" role="img" aria-label="Myrmecia — Multi-Agent Orchestration">
  <defs>
    <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{INK2}"/>
      <stop offset="1" stop-color="{INK}"/>
    </linearGradient>
    <linearGradient id="hex" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{VIOLET}"/>
      <stop offset="1" stop-color="{TEAL}"/>
    </linearGradient>
    <linearGradient id="word" gradientUnits="userSpaceOnUse" x1="360" y1="0" x2="660" y2="0" spreadMethod="reflect">
      <stop offset="0" stop-color="{TEAL}"/>
      <stop offset="0.5" stop-color="{CYAN}"/>
      <stop offset="1" stop-color="{WHITE}"/>
      <animateTransform attributeName="gradientTransform" type="translate" from="-300 0" to="300 0" dur="4.5s" repeatCount="indefinite"/>
    </linearGradient>
    <radialGradient id="halo" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="{TEAL}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="{TEAL}" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="6"/>
    </filter>
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="10" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- panel -->
  <rect x="1" y="1" width="{W-2}" height="{H-2}" rx="28" fill="url(#panel)" stroke="{TEAL}" stroke-opacity="0.45" stroke-width="2">
    <animate attributeName="stroke-opacity" values="0.25;0.7;0.25" dur="5s" repeatCount="indefinite"/>
  </rect>

  <!-- living colony mesh -->
  <g>
    {edge_block}
  </g>
  <g>
    {node_block}
  </g>
  <g>
    {pulse_block}
  </g>

  <!-- mark halo (pulsing) -->
  <ellipse cx="{cx}" cy="{cy}" rx="170" ry="150" fill="url(#halo)">
    <animate attributeName="rx" values="150;185;150" dur="4s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="0.7;1;0.7" dur="4s" repeatCount="indefinite"/>
  </ellipse>

  <!-- hexagon mark + node-ant -->
  <g filter="url(#glow)">
    <polygon points="{poly(hexpts)}" fill="url(#hex)" stroke="#ffffff" stroke-opacity="0.35" stroke-width="3"/>
    <polygon points="{poly(hexpts_in)}" fill="none" stroke="{INK}" stroke-opacity="0.35" stroke-width="1.5"/>
    <g opacity="0.98">
      {ant}
    </g>
  </g>

  <!-- wordmark -->
  <text x="372" y="196" font-family="Futura, 'Trebuchet MS', 'Century Gothic', Avenir, 'Segoe UI', system-ui, sans-serif" font-size="138" font-weight="700" letter-spacing="1" fill="url(#word)" filter="url(#soft)" opacity="0.55">Myrmecia</text>
  <text x="372" y="196" font-family="Futura, 'Trebuchet MS', 'Century Gothic', Avenir, 'Segoe UI', system-ui, sans-serif" font-size="138" font-weight="700" letter-spacing="1" fill="url(#word)">Myrmecia</text>

  <!-- tagline -->
  <text x="376" y="248" font-family="Futura, 'Trebuchet MS', Avenir, 'Segoe UI', system-ui, sans-serif" font-size="25" font-weight="600" letter-spacing="7" fill="#9 aa6b3">MULTI-AGENT ORCHESTRATION</text>

  <!-- accent underline -->
  <line x1="378" y1="266" x2="378" y2="266" stroke="{TEAL}" stroke-width="3" stroke-linecap="round">
    <animate attributeName="x2" values="378;760;378" dur="6s" repeatCount="indefinite"/>
    <animate attributeName="stroke" values="{TEAL};{CYAN};{VIOLET};{TEAL}" dur="6s" repeatCount="indefinite"/>
  </line>
</svg>
'''
    # fix accidental space in tagline color
    svg = svg.replace('fill="#9 aa6b3"', 'fill="#9aa6b3"')
    with open(OUT, "w") as f:
        f.write(svg)
    print("wrote", OUT, f"({W}x{H}, {len(nodes)} nodes, {len(edges)} edges)")


if __name__ == "__main__":
    render()
