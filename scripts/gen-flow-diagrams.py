#!/usr/bin/env python3
"""Generate *animated* data-flow SVGs for the Myrmecia README.

These are pure declarative SVG (SMIL + CSS) so they animate when embedded as
an <img> on GitHub, yet degrade to a clean static picture everywhere else.

Outputs:
  docs/diagrams/agent-pool.svg
  docs/diagrams/dynamic-workflow-lifecycle.svg
"""

import os
import math

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "docs", "diagrams")
os.makedirs(OUT, exist_ok=True)

BG = "#0d1117"
PANEL = "#0f1420"
CARD = "#161c26"
BORDER = "#30363d"
WHITE = "#e6edf3"
GRAY = "#8b949e"
BLUE = "#58a6ff"
GREEN = "#3fb950"
PURPLE = "#bc8cff"
ORANGE = "#f0883e"
CYAN = "#39d2c0"
YELLOW = "#e3b341"
PINK = "#f778ba"
RED = "#f85149"


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def ray_rect_exit(px, py, x0, y0, x1, y1):
    rcx, rcy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    dx, dy = px - rcx, py - rcy
    if dx == 0 and dy == 0:
        return (rcx, rcy)
    hx, hy = (x1 - x0) / 2.0, (y1 - y0) / 2.0
    tx = hx / abs(dx) if dx != 0 else 1e9
    ty = hy / abs(dy) if dy != 0 else 1e9
    t = min(tx, ty)
    return (rcx + dx * t, rcy + dy * t)


def defs():
    return f'''<defs>
  <filter id="glow" x="-120%" y="-120%" width="340%" height="340%">
    <feGaussianBlur stdDeviation="3.2" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="softglow" x="-160%" y="-160%" width="420%" height="420%">
    <feGaussianBlur stdDeviation="9" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <radialGradient id="vign" cx="50%" cy="42%" r="75%">
    <stop offset="0%" stop-color="#121a26"/>
    <stop offset="100%" stop-color="{BG}"/>
  </radialGradient>
</defs>'''


def flow_path(pid, p0, p1):
    """An invisible path used as the motion track for particles."""
    return f'<path id="{pid}" d="M {p0[0]:.1f} {p0[1]:.1f} L {p1[0]:.1f} {p1[1]:.1f}" fill="none" stroke="none"/>'


def flow_polyline(pid, pts):
    d = "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in pts)
    return f'<path id="{pid}" d="{d}" fill="none" stroke="none"/>'


def dashed_line(p0, p1, color, dur=1.1, opacity=0.30, off=-44):
    return (f'<line x1="{p0[0]:.1f}" y1="{p0[1]:.1f}" x2="{p1[0]:.1f}" y2="{p1[1]:.1f}" '
            f'stroke="{color}" stroke-width="2" stroke-opacity="{opacity}" '
            f'stroke-dasharray="2 9" stroke-linecap="round">'
            f'<animate attributeName="stroke-dashoffset" from="0" to="{off}" dur="{dur}s" '
            f'repeatCount="indefinite"/></line>')


def dashed_poly(pts, color, dur=1.3, opacity=0.30, off=-44):
    d = "M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in pts)
    return (f'<path d="{d}" fill="none" stroke="{color}" stroke-width="2" stroke-opacity="{opacity}" '
            f'stroke-dasharray="2 9" stroke-linecap="round">'
            f'<animate attributeName="stroke-dashoffset" from="0" to="{off}" dur="{dur}s" '
            f'repeatCount="indefinite"/></path>')


def particles(path_id, color, n=3, dur=2.6, r=3.6, begin0=0.0, glow="url(#glow)"):
    s = ""
    for k in range(n):
        b = begin0 + k * dur / n
        s += (f'<circle r="{r}" fill="{color}" filter="{glow}" opacity="0">'
              f'<animateMotion dur="{dur}s" begin="{b:.2f}s" repeatCount="indefinite" '
              f'rotate="auto"><mpath xlink:href="#{path_id}"/></animateMotion>'
              f'<animate attributeName="opacity" dur="{dur}s" begin="{b:.2f}s" '
              f'repeatCount="indefinite" values="0;1;1;0" keyTimes="0;0.12;0.82;1"/>'
              f'</circle>')
    return s


def text(x, y, s, color, size, weight="700", anchor="middle", spacing=None):
    ls = f' letter-spacing="{spacing}"' if spacing else ""
    return (f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}" '
            f'font-family="Inter,Segoe UI,Helvetica,Arial,sans-serif" font-size="{size}" '
            f'font-weight="{weight}" fill="{color}"{ls}>{esc(s)}</text>')


def card(x0, y0, x1, y1, color, title, lines, delay=0.0, title_size=21, rx=16):
    cx = (x0 + x1) / 2
    parts = [
        f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{x1-x0:.1f}" height="{y1-y0:.1f}" rx="{rx}" '
        f'fill="{CARD}" stroke="{color}" stroke-width="2">'
        f'<animate attributeName="stroke-opacity" values="0.55;1;0.55" dur="3.2s" '
        f'begin="{delay:.2f}s" repeatCount="indefinite"/></rect>',
        text(cx, y0 + 30, title, color, title_size),
    ]
    if lines:
        parts.append(f'<line x1="{cx-30:.1f}" y1="{y0+45:.1f}" x2="{cx+30:.1f}" y2="{y0+45:.1f}" '
                     f'stroke="{color}" stroke-width="2" stroke-opacity="0.8"/>')
        for i, ln in enumerate(lines):
            parts.append(text(cx, y0 + 66 + i * 18, ln, GRAY, 14, weight="400"))
    return "".join(parts)


def node_card(x0, y0, x1, y1, color, title, delay=0.0):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return (
        f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{x1-x0:.1f}" height="{y1-y0:.1f}" rx="14" '
        f'fill="{CARD}" stroke="{color}" stroke-width="2">'
        f'<animate attributeName="stroke-opacity" values="0.55;1;0.55" dur="3s" '
        f'begin="{delay:.2f}s" repeatCount="indefinite"/></rect>'
        + text(cx, cy + 7, title, color, 21))


def stage_card(x0, y0, x1, y1, color, title, subtitle="", delay=0.0, title_size=23, rx=16, fill=CARD):
    """A vertically-centered card with an optional subtitle (for flow rows)."""
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    parts = [
        f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{x1-x0:.1f}" height="{y1-y0:.1f}" rx="{rx}" '
        f'fill="{fill}" stroke="{color}" stroke-width="2">'
        f'<animate attributeName="stroke-opacity" values="0.55;1;0.55" dur="3.2s" '
        f'begin="{delay:.2f}s" repeatCount="indefinite"/></rect>',
    ]
    if subtitle:
        parts.append(text(cx, cy - 4, title, color, title_size))
        parts.append(text(cx, cy + 20, subtitle, GRAY, 15, weight="400"))
    else:
        parts.append(text(cx, cy + 7, title, color, title_size))
    return "".join(parts)


def band(x0, y0, x1, y1, title, color):
    """A labeled container panel."""
    return (f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{x1-x0:.1f}" height="{y1-y0:.1f}" rx="26" '
            f'fill="{PANEL}" stroke="{color}" stroke-width="2" stroke-opacity="0.85"/>'
            + text((x0 + x1) / 2, y0 + 34, title, color, 26))


def chip(x0, y0, x1, y1, label, color):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return (f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{x1-x0:.1f}" height="{y1-y0:.1f}" rx="14" '
            f'fill="#0f1722" stroke="{color}" stroke-width="2"/>'
            + text(cx, cy + 6, label, color, 18))


# ============================================================
# Agent Pool — animated hub-and-spoke data flow
# ============================================================
def gen_agent_pool():
    W, H = 1240, 720
    cx, cy = 620, 384
    R_hub, R_orbit = 62, 236
    cw, ch = 186, 112

    nodes = [
        ("PM Agent", ["Requirements", "Task breakdown", "Prioritization"], BLUE, 120),
        ("UI Agent", ["Design systems", "Prototypes", "Components"], PURPLE, 60),
        ("Dev Agent", ["Implementation", "Refactoring", "Debugging"], GREEN, 0),
        ("QA Agent", ["Test suites", "Bug hunting", "Validation"], ORANGE, 300),
        ("Ops Agent", ["Deployment", "CI / CD", "Monitoring"], CYAN, 240),
        ("Review", ["Code review", "Best practices", "Security"], YELLOW, 180),
    ]

    placed = []
    for i, (name, desc, color, ang) in enumerate(nodes):
        th = math.radians(ang)
        ax, ay = cx + R_orbit * math.cos(th), cy - R_orbit * math.sin(th)
        rect = (ax - cw / 2, ay - ch / 2, ax + cw / 2, ay + ch / 2)
        he = (cx + R_hub * math.cos(th), cy - R_hub * math.sin(th))
        ce = ray_rect_exit(cx, cy, *rect)
        placed.append((i, name, desc, color, rect, he, ce))

    s = []
    s.append(f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
             f'viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="Inter,Segoe UI,Arial,sans-serif">')
    s.append(defs())
    s.append(f'<rect width="{W}" height="{H}" rx="16" fill="url(#vign)"/>')

    # motion tracks (out = hub->card, back = card->hub)
    tracks = []
    for i, name, desc, color, rect, he, ce in placed:
        tracks.append(flow_path(f"out{i}", he, ce))
        tracks.append(flow_path(f"back{i}", ce, he))
    s.append('<g>' + "".join(tracks) + '</g>')

    # crawling dashed flow lines under everything
    for i, name, desc, color, rect, he, ce in placed:
        s.append(dashed_line(he, ce, color, dur=1.1, opacity=0.32))

    # title
    s.append(text(W / 2, 56, "Agent Pool — Specialized Roles", WHITE, 32))
    s.append(text(W / 2, 90, "One orchestrator routes each task to the right specialist — live", GRAY, 17, weight="400"))

    # particles: bright task going out, faint result coming back
    for i, name, desc, color, rect, he, ce in placed:
        s.append(particles(f"out{i}", color, n=3, dur=2.6, r=3.8, begin0=i * 0.18))
        s.append(particles(f"back{i}", WHITE, n=1, dur=2.9, r=2.4, begin0=1.3 + i * 0.18, glow="url(#glow)"))

    # hub
    s.append(f'<circle cx="{cx}" cy="{cy}" r="{R_hub}" fill="none" stroke="{GREEN}" stroke-width="2" opacity="0.5">'
             f'<animate attributeName="r" values="{R_hub};{R_hub+18};{R_hub}" dur="3s" repeatCount="indefinite"/>'
             f'<animate attributeName="opacity" values="0.5;0;0.5" dur="3s" repeatCount="indefinite"/></circle>')
    s.append(f'<circle cx="{cx}" cy="{cy}" r="{R_hub}" fill="#10231a" stroke="{GREEN}" stroke-width="2.5" filter="url(#softglow)"/>')
    s.append(f'<circle cx="{cx}" cy="{cy}" r="{R_hub-11}" fill="none" stroke="{GREEN}" stroke-width="1.5" '
             f'stroke-opacity="0.45" stroke-dasharray="4 9">'
             f'<animateTransform attributeName="transform" type="rotate" from="0 {cx} {cy}" to="360 {cx} {cy}" '
             f'dur="16s" repeatCount="indefinite"/></circle>')
    s.append(text(cx, cy - 4, "Orchestrator", GREEN, 18))
    s.append(text(cx, cy + 18, "routes · gates", GRAY, 12, weight="400"))

    # cards
    for i, name, desc, color, rect, he, ce in placed:
        s.append(card(*rect, color, name, desc, delay=i * 0.3))
        # connector endpoint dot on the card
        s.append(f'<circle cx="{ce[0]:.1f}" cy="{ce[1]:.1f}" r="3" fill="{color}"/>')

    s.append(text(W - 16, H - 22, "Myrmecia © 2026", GRAY, 13, weight="400", anchor="end"))
    s.append('</svg>')
    open(os.path.join(OUT, "agent-pool.svg"), "w").write("\n".join(s))
    print("agent-pool.svg")


# ============================================================
# Dynamic Workflow Lifecycle — animated pipeline + DAG
# ============================================================
def gen_workflow():
    W, H = 1600, 920
    s = []
    s.append(f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
             f'viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="Inter,Segoe UI,Arial,sans-serif">')
    s.append(defs())
    s.append(f'<rect width="{W}" height="{H}" rx="18" fill="url(#vign)"/>')

    s.append(text(W / 2, 64, "Dynamic Workflow Lifecycle", WHITE, 44))
    s.append(text(W / 2, 106, "From one goal to a controlled multi-agent DAG — data in motion", GRAY, 19, weight="400"))

    # ---- top pipeline ----
    flow = [
        ("Intent", "user goal", BLUE),
        ("Plan", "preview + edit", PURPLE),
        ("Persist", "workflow run", GREEN),
        ("Fan-out", "agent tasks", ORANGE),
        ("Control", "rerun / skip", PINK),
    ]
    cw, ty0, ty1 = 232, 170, 288
    centers = [175, 482, 789, 1096, 1403]
    rects = [(c - cw / 2, ty0, c + cw / 2, ty1) for c in centers]
    ymid = (ty0 + ty1) / 2

    tracks, anim = [], []
    for i in range(len(flow) - 1):
        p0 = (rects[i][2], ymid)
        p1 = (rects[i + 1][0], ymid)
        tracks.append(flow_path(f"pf{i}", p0, p1))
        anim.append(dashed_line(p0, p1, flow[i][2], dur=0.9, opacity=0.4))
        anim.append(arrowhead(p1, (1, 0), flow[i][2]))

    agg = (605, 372, 995, 500)
    # Persist -> Aggregate (state)
    ps0, ps1 = (789, ty1), (789, agg[1])
    tracks.append(flow_path("state", ps0, ps1))
    anim.append(dashed_line(ps0, ps1, GREEN, dur=1.0, opacity=0.4))
    anim.append(arrowhead(ps1, (0, 1), GREEN))
    # Control -> Aggregate (events, elbow)
    ev = [(1403, ty1), (1403, 436), (agg[2], 436)]
    tracks.append(flow_polyline("events", ev))
    anim.append(dashed_poly(ev, PINK, dur=1.2, opacity=0.4))
    anim.append(arrowhead((agg[2], 436), (-1, 0), PINK))

    s.append('<g>' + "".join(tracks) + '</g>')
    s.extend(anim)

    # particles on pipeline
    for i in range(len(flow) - 1):
        s.append(particles(f"pf{i}", flow[i][2], n=2, dur=1.6, r=4.0, begin0=i * 0.3))
    s.append(particles("state", GREEN, n=2, dur=1.7, r=3.6, begin0=0.2))
    s.append(particles("events", PINK, n=2, dur=2.0, r=3.6, begin0=0.5))

    # labels + cards
    s.append(text(843, 330, "state", GREEN, 15, weight="400"))
    s.append(text(1455, 416, "events", PINK, 15, weight="400"))
    for (title, sub, color), rect in zip(flow, rects):
        s.append(card(rect[0], rect[1], rect[2], rect[3], color, title, [], title_size=25, rx=18))
        s.append(text((rect[0] + rect[2]) / 2, rect[1] + 78, sub, GRAY, 16, weight="400"))
    s.append(card(agg[0], agg[1], agg[2], agg[3], CYAN, "Aggregate", [], title_size=25, rx=18))
    s.append(text((agg[0] + agg[2]) / 2, agg[1] + 84, "validate + summarize", GRAY, 16, weight="400"))

    # ---- bottom Example DAG ----
    panel = (90, 575, 1510, 868)
    s.append(f'<rect x="{panel[0]}" y="{panel[1]}" width="{panel[2]-panel[0]}" height="{panel[3]-panel[1]}" '
             f'rx="28" fill="{PANEL}" stroke="{PURPLE}" stroke-width="2.5"/>')
    s.append(text((panel[0] + panel[2]) / 2, panel[1] + 44, "Example DAG", PURPLE, 30))

    nodes = {
        "Spec": ((150, 688, 320, 758), BLUE),
        "Design": ((430, 660, 600, 724), PURPLE),
        "API": ((430, 760, 600, 824), GREEN),
        "Build": ((730, 690, 910, 758), ORANGE),
        "QA": ((1030, 660, 1200, 724), YELLOW),
        "Security": ((1030, 760, 1200, 824), PINK),
        "Done": ((1320, 690, 1490, 758), CYAN),
    }
    edges = [
        ("Spec", "Design"), ("Spec", "API"), ("Design", "Build"), ("API", "Build"),
        ("Build", "QA"), ("Build", "Security"), ("QA", "Done"), ("Security", "Done"),
    ]
    etracks, eanim, eparts = [], [], []
    for j, (a, b) in enumerate(edges):
        ra, ca = nodes[a]
        rb, cb = nodes[b]
        ac = ((ra[0] + ra[2]) / 2, (ra[1] + ra[3]) / 2)
        bc = ((rb[0] + rb[2]) / 2, (rb[1] + rb[3]) / 2)
        p0 = ray_rect_exit(*bc, *ra)
        p1 = ray_rect_exit(*ac, *rb)
        etracks.append(flow_path(f"e{j}", p0, p1))
        eanim.append(dashed_line(p0, p1, ca, dur=1.0, opacity=0.4))
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        n = math.hypot(dx, dy) or 1
        eanim.append(arrowhead(p1, (dx / n, dy / n), ca))
        eparts.append(particles(f"e{j}", ca, n=2, dur=1.5, r=3.6, begin0=j * 0.16))

    s.append('<g>' + "".join(etracks) + '</g>')
    s.extend(eanim)
    s.extend(eparts)
    for name, (rect, color) in nodes.items():
        s.append(node_card(rect[0], rect[1], rect[2], rect[3], color, name))

    s.append('</svg>')
    open(os.path.join(OUT, "dynamic-workflow-lifecycle.svg"), "w").write("\n".join(s))
    print("dynamic-workflow-lifecycle.svg")


def arrowhead(tip, direction, color, size=11):
    dx, dy = direction
    ang = math.atan2(dy, dx)
    a1, a2 = ang + math.pi * 0.82, ang - math.pi * 0.82
    p1 = (tip[0] + size * math.cos(a1), tip[1] + size * math.sin(a1))
    p2 = (tip[0] + size * math.cos(a2), tip[1] + size * math.sin(a2))
    return (f'<polygon points="{tip[0]:.1f},{tip[1]:.1f} {p1[0]:.1f},{p1[1]:.1f} {p2[0]:.1f},{p2[1]:.1f}" '
            f'fill="{color}"/>')


def hflow(s, rects, colors, ymid, prefix, dur=0.95, pdur=1.7):
    """Animate a left-to-right flow of `rects`: dashed lines + particles + arrowheads."""
    tracks, anim, parts = [], [], []
    for i in range(len(rects) - 1):
        p0 = (rects[i][2], ymid)
        p1 = (rects[i + 1][0], ymid)
        pid = f"{prefix}{i}"
        tracks.append(flow_path(pid, p0, p1))
        anim.append(dashed_line(p0, p1, colors[i], dur=dur, opacity=0.42))
        anim.append(arrowhead(p1, (1, 0), colors[i]))
        parts.append(particles(pid, colors[i], n=2, dur=pdur, r=3.8, begin0=i * 0.28))
    s.append('<g>' + "".join(tracks) + '</g>')
    s.extend(anim)
    s.extend(parts)


def vconnect(s, p0, p1, color, pid, label=None, label_dx=70, dur=1.0, pdur=1.7):
    """A vertical (or near-vertical) connector with particles + arrowhead."""
    s.append('<g>' + flow_path(pid, p0, p1) + '</g>')
    s.append(dashed_line(p0, p1, color, dur=dur, opacity=0.42))
    s.append(arrowhead(p1, (p1[0] - p0[0] or 0.0001, p1[1] - p0[1]), color))
    s.append(particles(pid, color, n=2, dur=pdur, r=3.8, begin0=0.2))
    if label:
        s.append(text((p0[0] + p1[0]) / 2 + label_dx, (p0[1] + p1[1]) / 2 + 5, label, color, 15, weight="400"))


def svg_open(W, H):
    return [f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="Inter,Segoe UI,Arial,sans-serif">',
            defs(), f'<rect width="{W}" height="{H}" rx="18" fill="url(#vign)"/>']


# ============================================================
# Schema — end-to-end harness data flow
# ============================================================
def gen_schema():
    W, H = 1600, 900
    s = svg_open(W, H)
    s.append(text(W / 2, 56, "Myrmecia — Multi-Agent Orchestration Harness", WHITE, 38))
    s.append(text(W / 2, 96, "One request — routed, orchestrated, executed by a governed agent harness, shipped", GRAY, 18, weight="400"))

    flow = [
        ("Request", "one-line goal", BLUE),
        ("Supervisor", "intent + routing", CYAN),
        ("Orchestrator", "pipeline · DAG · master", PURPLE),
        ("Agent Harness", "tool-loop + context", GREEN),
        ("Governed Tools", "built-in + MCP", PINK),
        ("Output", "code · review · deploy", ORANGE),
    ]
    cw, y0, y1 = 224, 188, 312
    xs = [70, 322, 574, 826, 1078, 1330]
    rects = [(x, y0, x + cw, y1) for x in xs]
    ymid = (y0 + y1) / 2
    hflow(s, rects, [f[2] for f in flow], ymid, "sf")
    for (title, sub, color), r in zip(flow, rects):
        s.append(stage_card(*r, color, title, sub, title_size=22))

    # Band 1: harness internals
    b1 = (70, 430, 1530, 620)
    inner1 = [
        ((118, 506, 448, 596), GREEN, "Tool-Calling Loop", "multi-turn fn-calls"),
        ((478, 506, 778, 596), CYAN, "Context Manager", "compress + recall"),
        ((808, 506, 1098, 596), PURPLE, "Unified Memory", "4-layer + graph"),
        ((1128, 506, 1500, 596), YELLOW, "Model Gateway", "providers + streaming"),
    ]
    vconnect(s, (rects[3][0] + cw / 2, y1), (rects[3][0] + cw / 2, b1[1]), GREEN, "toharness", "runs", 56)
    s.append(band(*b1, "Agent Harness Internals", GREEN))
    for r, color, t, sub in inner1:
        s.append(stage_card(*r, color, t, sub, title_size=20))

    # Band 2: cross-cutting platform
    b2 = (70, 690, 1530, 840)
    inner2 = [
        ((118, 760, 568, 826), PINK, "Governance", "policy / sandbox / DLP"),
        ((588, 760, 1018, 826), BLUE, "Observability", "OTel traces + metrics"),
        ((1038, 760, 1500, 826), GRAY, "Persistence", "SQLite/PG · Redis/BullMQ"),
    ]
    vconnect(s, (800, b1[3]), (800, b2[1]), GRAY, "tobase", "secured + traced", 110)
    s.append(band(*b2, "Governance  ·  Observability  ·  Persistence", GRAY))
    for r, color, t, sub in inner2:
        s.append(stage_card(*r, color, t, sub, title_size=20))

    s.append('</svg>')
    open(os.path.join(OUT, "schema.svg"), "w").write("\n".join(s))
    print("schema.svg")


# ============================================================
# Runtime Governance — every tool call passes the chain
# ============================================================
def gen_runtime_governance():
    W, H = 1600, 880
    s = svg_open(W, H)
    s.append(text(W / 2, 58, "Runtime Governance", WHITE, 42))
    s.append(text(W / 2, 100, "Every tool call passes policy, sandbox, DLP, and audit", GRAY, 19, weight="400"))

    chain = [
        ("Runtime", "request", GREEN),
        ("Registry", "known tools", BLUE),
        ("Policy", "allow / approve", PURPLE),
        ("Sandbox", "confine", ORANGE),
        ("DLP", "redact / block", PINK),
    ]
    cw, y0, y1 = 224, 190, 314
    xs = [72, 364, 656, 948, 1240]
    rects = [(x, y0, x + cw, y1) for x in xs]
    ymid = (y0 + y1) / 2
    hflow(s, rects, [c[2] for c in chain], ymid, "gf")
    for (title, sub, color), r in zip(chain, rects):
        s.append(stage_card(*r, color, title, sub, title_size=23))

    # Audit report fed by Runtime (metadata) and DLP (findings)
    audit = (610, 452, 990, 580)
    a_in = ray_rect_exit((rects[0][0] + cw / 2), ymid, *audit)
    vconnect(s, (rects[0][0] + cw / 2, y1), a_in, GREEN, "gmeta", "metadata", -70, dur=1.1)
    a_in2 = ray_rect_exit((rects[4][0] + cw / 2), ymid, *audit)
    vconnect(s, (rects[4][0] + cw / 2, y1), a_in2, PINK, "gfind", "findings", 70, dur=1.1)
    s.append(stage_card(*audit, CYAN, "Audit Report", "why it ran or stopped", title_size=24))

    # Outcomes band
    bb = (120, 690, 1480, 824)
    s.append(band(*bb, "Possible Outcomes", GRAY))
    outs = [
        ((176, 760, 432, 812), "Allowed", GREEN),
        ((496, 760, 752, 812), "Needs Approval", YELLOW),
        ((816, 760, 1072, 812), "Blocked", RED),
        ((1136, 760, 1392, 812), "Redacted", PINK),
    ]
    for r, label, color in outs:
        s.append(chip(*r, label, color))

    s.append('</svg>')
    open(os.path.join(OUT, "runtime-governance.svg"), "w").write("\n".join(s))
    print("runtime-governance.svg")


# ============================================================
# Architecture — layered top-to-bottom data flow
# ============================================================
def gen_architecture():
    W, H = 1600, 1050
    s = svg_open(W, H)
    s.append(text(W / 2, 58, "Myrmecia Architecture", WHITE, 44))
    s.append(text(W / 2, 100, "Dashboard → Orchestrator API → Agent Runtime → Governed Tools + Models", GRAY, 19, weight="400"))

    # Layer 1: dashboard
    l1 = (110, 150, 1490, 262)
    s.append(band(*l1, "Web Dashboard", BLUE))
    s.append(text((l1[0] + l1[2]) / 2, l1[1] + 78, "Console · Work Queue · Board · Audit", WHITE, 18, weight="400"))

    # Layer 2: API
    l2 = (110, 340, 1490, 524)
    s.append(band(*l2, "Express Orchestrator API", GREEN))
    api = [
        ((150, 418, 360, 500), GREEN, "Auth", "tenant + scope"),
        ((392, 418, 602, 500), BLUE, "Supervisor", "intent + plans"),
        ((634, 418, 844, 500), ORANGE, "Queue", "tasks + deps"),
        ((876, 418, 1086, 500), CYAN, "Pipelines", "fixed flows"),
        ((1118, 418, 1328, 500), PINK, "Events", "WS + audit"),
    ]
    for r, color, t, sub in api:
        s.append(stage_card(*r, color, t, sub, title_size=21))

    # Layer 3: runtime
    l3 = (110, 602, 1490, 786)
    s.append(band(*l3, "Planning + Agent Execution", PURPLE))
    rt = [
        ((150, 680, 412, 762), PURPLE, "Dynamic Workflow", "DAG fan-out"),
        ((444, 680, 706, 762), GREEN, "Agent Runtime", "TS loop / Python"),
        ((738, 680, 1000, 762), CYAN, "Model Router", "cost + risk"),
        ((1032, 680, 1294, 762), PINK, "Tool Governance", "policy + DLP"),
    ]
    for r, color, t, sub in rt:
        s.append(stage_card(*r, color, t, sub, title_size=20))

    # Layer 4: infra
    l4 = (110, 864, 1490, 986)
    s.append(band(*l4, "Persistence + Runtime Infrastructure", GRAY))
    s.append(text((l4[0] + l4[2]) / 2, l4[1] + 80, "SQLite/Postgres · Redis/BullMQ · Workspaces · Model Endpoint · Audit Store", WHITE, 17, weight="400"))

    # vertical data flow down the layers
    cx = 800
    vconnect(s, (cx, l1[3]), (cx, l2[1]), BLUE, "a1", "API / WS", 80)
    vconnect(s, (cx, l2[3]), (cx, l3[1]), GREEN, "a2", "dispatch", 80)
    vconnect(s, (cx, l3[3]), (cx, l4[1]), PURPLE, "a3", "persist", 78)

    s.append('</svg>')
    open(os.path.join(OUT, "architecture-overview.svg"), "w").write("\n".join(s))
    print("architecture-overview.svg")


if __name__ == "__main__":
    gen_agent_pool()
    gen_workflow()
    gen_schema()
    gen_runtime_governance()
    gen_architecture()
    print("\nAnimated flow diagrams generated!")
