#!/usr/bin/env python3
"""Generate colorful architecture diagrams for the Myrmecia README."""

from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "docs", "diagrams")
os.makedirs(OUT, exist_ok=True)

# Try to get a decent font
def get_font(size):
    for p in [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def get_font_regular(size):
    for p in [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

font_title = get_font(28)
font_header = get_font(22)
font_body = get_font(18)
font_small = get_font_regular(15)
font_label = get_font_regular(13)
font_big_title = get_font(42)
font_section = get_font(28)
font_card = get_font(20)
font_card_small = get_font_regular(16)
font_tiny = get_font_regular(14)
font_hero = get_font(48)
font_large = get_font(32)
font_mid = get_font(26)
font_readable = get_font_regular(22)
font_caption = get_font_regular(18)

# Color palette
BG = "#0d1117"
CARD_BG = "#161b22"
BORDER = "#30363d"
ACCENT_BLUE = "#58a6ff"
ACCENT_GREEN = "#3fb950"
ACCENT_PURPLE = "#bc8cff"
ACCENT_ORANGE = "#f0883e"
ACCENT_RED = "#f85149"
ACCENT_CYAN = "#39d2c0"
ACCENT_YELLOW = "#e3b341"
ACCENT_PINK = "#f778ba"
WHITE = "#e6edf3"
GRAY = "#8b949e"

def rounded_rect(draw, xy, radius, fill, outline=None, width=1):
    x0, y0, x1, y1 = xy
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)

def draw_arrow(draw, start, end, color, width=2):
    draw.line([start, end], fill=color, width=width)
    # arrowhead
    import math
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    angle = math.atan2(dy, dx)
    arrow_len = 10
    a1 = angle + math.pi * 0.8
    a2 = angle - math.pi * 0.8
    p1 = (end[0] + arrow_len * math.cos(a1), end[1] + arrow_len * math.sin(a1))
    p2 = (end[0] + arrow_len * math.cos(a2), end[1] + arrow_len * math.sin(a2))
    draw.polygon([end, p1, p2], fill=color)

def text_center(draw, xy, text, font, fill):
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = xy[0] - tw // 2
    y = xy[1] - th // 2
    draw.text((x, y), text, font=font, fill=fill)

def text_left(draw, xy, text, font, fill):
    draw.text(xy, text, font=font, fill=fill)

def wrap_text(text, max_chars):
    words = text.split()
    lines = []
    current = ""
    for word in words:
        if len(current) + len(word) + (1 if current else 0) > max_chars:
            if current:
                lines.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        lines.append(current)
    return lines

def text_block(draw, x, y, lines, font, fill, line_gap=6, max_lines=None):
    visible = lines[:max_lines] if max_lines else lines
    for i, line in enumerate(visible):
        draw.text((x, y + i * (font.size + line_gap)), line, font=font, fill=fill)

def diagram_card(draw, xy, title, subtitle, color, bullets=None, fill="#111827", wrap_chars=34):
    x0, y0, x1, y1 = xy
    rounded_rect(draw, xy, 18, fill, color, 3)
    draw.text((x0 + 24, y0 + 22), title, font=font_card, fill=color)
    cursor_y = y0 + 62
    if subtitle:
        subtitle_lines = wrap_text(subtitle, wrap_chars)
        text_block(draw, x0 + 24, cursor_y, subtitle_lines, font_card_small, GRAY, line_gap=6, max_lines=3)
        cursor_y += min(len(subtitle_lines), 3) * (font_card_small.size + 6) + 12
    if bullets:
        line_h = font_tiny.size + 8
        for bullet in bullets:
            bullet_lines = wrap_text(bullet, max(18, wrap_chars - 4))
            for i, line in enumerate(bullet_lines[:2]):
                if cursor_y + line_h > y1 - 16:
                    return
                prefix = "- " if i == 0 else "  "
                draw.text((x0 + 26, cursor_y), f"{prefix}{line}", font=font_tiny, fill=WHITE)
                cursor_y += line_h
            cursor_y += 2

def labeled_arrow(draw, start, end, color, label=None, label_offset=(0, 0), width=3):
    draw_arrow(draw, start, end, color, width=width)
    if label:
        mid = ((start[0] + end[0]) // 2 + label_offset[0], (start[1] + end[1]) // 2 + label_offset[1])
        text_center(draw, mid, label, font_tiny, color)

def simple_card(draw, xy, title, subtitle, color, fill="#111827"):
    x0, y0, x1, y1 = xy
    height = y1 - y0
    rounded_rect(draw, xy, 22, fill, color, 4)
    if subtitle:
        text_center(draw, ((x0 + x1) // 2, y0 + int(height * 0.36)), title, font_mid, color)
        for i, line in enumerate(wrap_text(subtitle, 26)[:2]):
            text_center(draw, ((x0 + x1) // 2, y0 + int(height * 0.68) + i * 24), line, font_caption, GRAY)
    else:
        text_center(draw, ((x0 + x1) // 2, (y0 + y1) // 2), title, font_mid, color)

def band_title(draw, xy, title, color):
    x0, y0, x1, _ = xy
    text_center(draw, ((x0 + x1) // 2, y0 + 36), title, font_large, color)

# ---- helpers for the high-fidelity (supersampled) diagrams ----
def _hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def ray_rect_exit(px, py, x0, y0, x1, y1):
    """Point on rect border along the ray from the rect center toward (px, py)."""
    rcx, rcy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    dx, dy = px - rcx, py - rcy
    if dx == 0 and dy == 0:
        return (rcx, rcy)
    hx, hy = (x1 - x0) / 2.0, (y1 - y0) / 2.0
    tx = hx / abs(dx) if dx != 0 else float("inf")
    ty = hy / abs(dy) if dy != 0 else float("inf")
    t = min(tx, ty)
    return (rcx + dx * t, rcy + dy * t)

def _arrowhead(d, start, end, color, size):
    import math
    ang = math.atan2(end[1] - start[1], end[0] - start[0])
    a1, a2 = ang + math.pi * 0.82, ang - math.pi * 0.82
    p1 = (end[0] + size * math.cos(a1), end[1] + size * math.sin(a1))
    p2 = (end[0] + size * math.cos(a2), end[1] + size * math.sin(a2))
    d.polygon([end, p1, p2], fill=color)

# ============================================================
# Diagram 1: System Architecture Overview
# ============================================================
def gen_architecture():
    W, H = 1600, 1050
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    text_center(d, (W // 2, 58), "Myrmecia Architecture", font_hero, WHITE)
    text_center(d, (W // 2, 104), "Dashboard -> Orchestrator -> Agent Runtime -> Governed Tools + Models", font_readable, GRAY)

    dashboard = (110, 150, 1490, 260)
    rounded_rect(d, dashboard, 28, "#111827", ACCENT_BLUE, 5)
    text_center(d, (800, 195), "Web Dashboard", font_large, ACCENT_BLUE)
    text_center(d, (800, 232), "Console · Work Queue · Board · Audit", font_readable, WHITE)

    api = (110, 335, 1490, 520)
    rounded_rect(d, api, 28, "#111827", ACCENT_GREEN, 5)
    band_title(d, api, "Express Orchestrator API", ACCENT_GREEN)
    for xy, title, subtitle, color in [
        ((150, 415, 360, 495), "Auth", "tenant + scope", ACCENT_GREEN),
        ((390, 415, 600, 495), "Supervisor", "intent + plans", ACCENT_BLUE),
        ((630, 415, 840, 495), "Queue", "tasks + deps", ACCENT_ORANGE),
        ((870, 415, 1080, 495), "Pipelines", "fixed flows", ACCENT_CYAN),
        ((1110, 415, 1320, 495), "Events", "WS + audit", ACCENT_PINK),
    ]:
        simple_card(d, xy, title, subtitle, color)

    runtime = (110, 600, 1490, 785)
    rounded_rect(d, runtime, 28, "#111827", ACCENT_PURPLE, 5)
    band_title(d, runtime, "Planning + Agent Execution", ACCENT_PURPLE)
    for xy, title, subtitle, color in [
        ((150, 680, 405, 760), "Dynamic Workflow", "DAG fan-out", ACCENT_PURPLE),
        ((435, 680, 690, 760), "Agent Runtime", "TS loop / Python", ACCENT_GREEN),
        ((720, 680, 975, 760), "Model Router", "cost + risk", ACCENT_CYAN),
        ((1005, 680, 1260, 760), "Tool Governance", "policy + DLP", ACCENT_PINK),
    ]:
        simple_card(d, xy, title, subtitle, color)

    infra = (110, 865, 1490, 985)
    rounded_rect(d, infra, 28, "#111827", GRAY, 5)
    text_center(d, (800, 900), "Persistence + Runtime Infrastructure", font_large, GRAY)
    text_center(d, (800, 945), "SQLite/Postgres · Redis/BullMQ · Workspaces · Model Endpoint · Audit Store", font_readable, WHITE)

    labeled_arrow(d, (800, 260), (800, 335), ACCENT_BLUE, "API / WS", (90, 0), width=5)
    labeled_arrow(d, (800, 520), (800, 600), ACCENT_GREEN, "dispatch", (90, 0), width=5)
    labeled_arrow(d, (800, 785), (800, 865), ACCENT_PURPLE, "persist", (85, 0), width=5)

    rounded_rect(d, (1250, 45, 1490, 95), 18, "#0f172a", ACCENT_YELLOW, 3)
    text_center(d, (1370, 70), "Safety by default", font_caption, ACCENT_YELLOW)

    img.save(os.path.join(OUT, "architecture-overview.png"), quality=95)
    print("architecture-overview.png")

# ============================================================
# Diagram 2: Dynamic Workflow Lifecycle
# ============================================================
def gen_dynamic_workflow_lifecycle():
    import math
    W, H = 1600, 920
    SS = 2
    img = Image.new("RGB", (W * SS, H * SS), BG)

    def sf(size, bold=True):
        return get_font(int(size * SS)) if bold else get_font_regular(int(size * SS))
    F_hero, F_readable = sf(46), sf(20, False)
    F_card, F_sub = sf(25), sf(16, False)
    F_node, F_lbl = sf(22), sf(15, False)
    F_panel = sf(30)

    def S(v):
        return int(round(v * SS))

    def tc(d, xy, text, font, fill):
        b = d.textbbox((0, 0), text, font=font)
        d.text((S(xy[0]) - (b[2] - b[0]) // 2, S(xy[1]) - (b[3] - b[1]) // 2), text, font=font, fill=fill)

    def card(d, rect, title, subtitle, color):
        x0, y0, x1, y1 = rect
        d.rounded_rectangle((S(x0), S(y0), S(x1), S(y1)), radius=S(18), fill="#161c26", outline=color, width=S(3))
        if subtitle:
            tc(d, ((x0 + x1) / 2, y0 + (y1 - y0) * 0.36), title, F_card, color)
            tc(d, ((x0 + x1) / 2, y0 + (y1 - y0) * 0.70), subtitle, F_sub, GRAY)
        else:
            tc(d, ((x0 + x1) / 2, (y0 + y1) / 2), title, F_node, color)

    glow = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    connectors = []  # (start, end, color, headsize)

    def connect(p0, p1, color, head=11, glow_w=8):
        gd.line([(S(p0[0]), S(p0[1])), (S(p1[0]), S(p1[1]))], fill=_hex_rgb(color) + (95,), width=S(glow_w))
        connectors.append((p0, p1, color, head))

    def connect_path(pts, color, glow_w=8):
        sp = [(S(p[0]), S(p[1])) for p in pts]
        gd.line(sp, fill=_hex_rgb(color) + (95,), width=S(glow_w))
        connectors.append(("path", pts, color, 11))

    # ---- top flow row ----
    flow = [
        ("Intent", "user goal", ACCENT_BLUE),
        ("Plan", "preview + edit", ACCENT_PURPLE),
        ("Persist", "workflow run", ACCENT_GREEN),
        ("Fan-out", "agent tasks", ACCENT_ORANGE),
        ("Control", "rerun / skip", ACCENT_PINK),
    ]
    cw, ch, ty0, ty1 = 232, 118, 170, 288
    centers = [175, 482, 789, 1096, 1403]
    rects = [(c - cw / 2, ty0, c + cw / 2, ty1) for c in centers]
    for i in range(len(flow) - 1):
        connect((rects[i][2], 229), (rects[i + 1][0], 229), flow[i][2])

    # Persist -> Aggregate (state) and Control -> Aggregate (events)
    agg = (605, 372, 995, 500)
    connect((789, ty1), (789, agg[1]), ACCENT_GREEN)                       # state, straight down
    connect_path([(1403, ty1), (1403, 436), (agg[2], 436)], ACCENT_PINK)   # events, elbow into right edge

    # ---- bottom DAG panel ----
    panel = (90, 575, 1510, 868)
    nodes = {
        "Spec": ((150, 688, 320, 758), ACCENT_BLUE),
        "Design": ((430, 660, 600, 724), ACCENT_PURPLE),
        "API": ((430, 760, 600, 824), ACCENT_GREEN),
        "Build": ((730, 690, 910, 758), ACCENT_ORANGE),
        "QA": ((1030, 660, 1200, 724), ACCENT_YELLOW),
        "Security": ((1030, 760, 1200, 824), ACCENT_PINK),
        "Done": ((1320, 690, 1490, 758), ACCENT_CYAN),
    }
    edges = [
        ("Spec", "Design"), ("Spec", "API"), ("Design", "Build"), ("API", "Build"),
        ("Build", "QA"), ("Build", "Security"), ("QA", "Done"), ("Security", "Done"),
    ]
    for a, b in edges:
        ra, ca = nodes[a]
        rb, cb = nodes[b]
        ac = ((ra[0] + ra[2]) / 2, (ra[1] + ra[3]) / 2)
        bc = ((rb[0] + rb[2]) / 2, (rb[1] + rb[3]) / 2)
        connect(ray_rect_exit(*bc, *ra), ray_rect_exit(*ac, *rb), ca, head=10)

    glow = glow.filter(ImageFilter.GaussianBlur(S(4)))
    # paint the DAG panel background BEFORE compositing glow/cores so the
    # in-panel connectors are not covered by it.
    ImageDraw.Draw(img).rounded_rectangle(
        (S(panel[0]), S(panel[1]), S(panel[2]), S(panel[3])), radius=S(28), fill="#0f1420")
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    d = ImageDraw.Draw(img)

    # crisp connector cores + arrowheads
    for item in connectors:
        if item[0] == "path":
            _, pts, color, head = item
            sp = [(S(p[0]), S(p[1])) for p in pts]
            d.line(sp, fill=color, width=S(3), joint="curve")
            _arrowhead(d, sp[-2], sp[-1], color, S(head))
        else:
            p0, p1, color, head = item
            d.line([(S(p0[0]), S(p0[1])), (S(p1[0]), S(p1[1]))], fill=color, width=S(3))
            _arrowhead(d, (S(p0[0]), S(p0[1])), (S(p1[0]), S(p1[1])), color, S(head))

    # titles
    tc(d, (W // 2, 60), "Dynamic Workflow Lifecycle", F_hero, WHITE)
    tc(d, (W // 2, 108), "From one goal to a controlled multi-agent DAG", F_readable, GRAY)

    # connector labels
    tc(d, (843, 326), "state", F_lbl, ACCENT_GREEN)
    tc(d, (1455, 412), "events", F_lbl, ACCENT_PINK)

    # top flow cards
    for (title, sub, color), rect in zip(flow, rects):
        card(d, rect, title, sub, color)
    card(d, agg, "Aggregate", "validate + summarize", ACCENT_CYAN)

    # bottom panel border (background already painted) + nodes
    d.rounded_rectangle((S(panel[0]), S(panel[1]), S(panel[2]), S(panel[3])), radius=S(28), outline=ACCENT_PURPLE, width=S(3))
    tc(d, ((panel[0] + panel[2]) / 2, panel[1] + 36), "Example DAG", F_panel, ACCENT_PURPLE)
    for name, (rect, color) in nodes.items():
        card(d, rect, name, "", color)

    img = img.resize((W, H), Image.LANCZOS)
    img.save(os.path.join(OUT, "dynamic-workflow-lifecycle.png"), quality=95)
    print("dynamic-workflow-lifecycle.png")

# ============================================================
# Diagram 3: Runtime Governance Chain
# ============================================================
def gen_runtime_governance():
    W, H = 1600, 900
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    text_center(d, (W // 2, 58), "Runtime Governance", font_hero, WHITE)
    text_center(d, (W // 2, 104), "Every tool call passes policy, sandbox, DLP, and audit", font_readable, GRAY)

    chain = [
        ((80, 185, 300, 305), "Runtime", "request", ACCENT_GREEN),
        ((370, 185, 590, 305), "Registry", "known tools", ACCENT_BLUE),
        ((660, 185, 880, 305), "Policy", "allow / approve", ACCENT_PURPLE),
        ((950, 185, 1170, 305), "Sandbox", "confine", ACCENT_ORANGE),
        ((1240, 185, 1460, 305), "DLP", "redact / block", ACCENT_PINK),
    ]
    for i, (xy, title, subtitle, color) in enumerate(chain):
        simple_card(d, xy, title, subtitle, color)
        if i < len(chain) - 1:
            draw_arrow(d, (xy[2] + 20, 245), (chain[i + 1][0][0] - 20, 245), color, width=5)

    simple_card(d, (600, 440, 1000, 570), "Audit Report", "why it ran or stopped", ACCENT_CYAN)
    labeled_arrow(d, (190, 305), (600, 440), ACCENT_GREEN, "metadata", (10, -20), width=5)
    labeled_arrow(d, (1350, 305), (1000, 440), ACCENT_PINK, "findings", (20, -20), width=5)

    rounded_rect(d, (120, 690, 1480, 820), 26, "#111827", GRAY, 5)
    text_center(d, (800, 728), "Possible Outcomes", font_large, GRAY)
    for xy, label, color in [
        ((180, 755, 430, 800), "Allowed", ACCENT_GREEN),
        ((500, 755, 750, 800), "Needs Approval", ACCENT_YELLOW),
        ((820, 755, 1070, 800), "Blocked", ACCENT_RED),
        ((1140, 755, 1390, 800), "Redacted", ACCENT_PINK),
    ]:
        rounded_rect(d, xy, 16, "#0f172a", color, 3)
        text_center(d, ((xy[0] + xy[2]) // 2, (xy[1] + xy[3]) // 2), label, font_readable, color)

    img.save(os.path.join(OUT, "runtime-governance.png"), quality=95)
    print("runtime-governance.png")

# ============================================================
# Diagram 4: Pipeline Flow
# ============================================================
def gen_pipeline():
    W, H = 1200, 500
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    text_center(d, (W//2, 35), "Pipeline Flow — Full Product Lifecycle", font_title, WHITE)

    stages = [
        ("", "PM", "Spec &\nPlanning", ACCENT_BLUE),
        ("", "UI", "Design &\nPrototype", ACCENT_PURPLE),
        ("", "Dev", "Code &\nBuild", ACCENT_GREEN),
        ("", "QA", "Test &\nValidate", ACCENT_ORANGE),
        ("", "Review", "Code\nReview", ACCENT_YELLOW),
        ("", "Ops", "Deploy &\nMonitor", ACCENT_CYAN),
    ]

    y_center = 250
    box_w, box_h = 140, 160
    gap = 40
    total_w = len(stages) * box_w + (len(stages) - 1) * gap
    start_x = (W - total_w) // 2

    for i, (emoji, role, desc, color) in enumerate(stages):
        x = start_x + i * (box_w + gap)

        # Stage number circle
        cx = x + box_w // 2
        cy = y_center - box_h // 2 - 30
        d.ellipse((cx-16, cy-16, cx+16, cy+16), fill=color)
        text_center(d, (cx, cy), str(i+1), font_body, BG)

        # Connecting line from circle to box
        d.line([(cx, cy+16), (cx, y_center - box_h//2)], fill=color, width=2)

        # Box
        rounded_rect(d, (x, y_center - box_h//2, x+box_w, y_center + box_h//2), 12, "#1c2333", color, 2)

        # Emoji
        text_center(d, (x + box_w//2, y_center - 40), emoji, font_title, WHITE)
        # Role
        text_center(d, (x + box_w//2, y_center - 5), role, font_header, color)
        # Desc
        lines = desc.split("\n")
        for j, line in enumerate(lines):
            text_center(d, (x + box_w//2, y_center + 25 + j*18), line, font_small, GRAY)

        # Arrow to next
        if i < len(stages) - 1:
            ax = x + box_w + 5
            draw_arrow(d, (ax, y_center), (ax + gap - 10, y_center), color)

    # Bottom: data flow labels
    text_center(d, (W//2, y_center + box_h//2 + 50), "Each stage output next stage input  ·  Auto/Manual gates  ·  Retry on failure", font_small, GRAY)

    # Progress bar
    bar_y = y_center + box_h//2 + 80
    rounded_rect(d, (start_x, bar_y, start_x + total_w, bar_y + 12), 6, BORDER)
    progress = int(total_w * 0.65)
    rounded_rect(d, (start_x, bar_y, start_x + progress, bar_y + 12), 6, ACCENT_GREEN)
    text_center(d, (start_x + progress + 30, bar_y + 6), "65%", font_label, ACCENT_GREEN)

    d.text((W - 200, H - 20), "Myrmecia © 2026", font=font_label, fill=GRAY)
    img.save(os.path.join(OUT, "pipeline-flow.png"), quality=95)
    print("pipeline-flow.png")

# ============================================================
# Diagram 5: Agent Pool & Roles
# ============================================================
def gen_agent_pool():
    import math
    W, H = 1240, 720
    SS = 2
    img = Image.new("RGB", (W * SS, H * SS), BG)

    def sf(size, bold=True):
        return get_font(int(size * SS)) if bold else get_font_regular(int(size * SS))
    F_title, F_sub = sf(34), sf(18, False)
    F_card, F_desc = sf(21), sf(14, False)
    F_hub, F_hubsub = sf(18), sf(12, False)
    F_foot = sf(13, False)

    def S(v):
        return int(round(v * SS))

    def tc(d, xy, text, font, fill):
        b = d.textbbox((0, 0), text, font=font)
        d.text((S(xy[0]) - (b[2] - b[0]) // 2, S(xy[1]) - (b[3] - b[1]) // 2), text, font=font, fill=fill)

    cx, cy = 620, 384
    R_hub, R_orbit = 62, 236
    card_w, card_h = 186, 112

    nodes = [
        ("PM Agent", ["Requirements", "Task breakdown", "Prioritization"], ACCENT_BLUE, 120),
        ("UI Agent", ["Design systems", "Prototypes", "Components"], ACCENT_PURPLE, 60),
        ("Dev Agent", ["Implementation", "Refactoring", "Debugging"], ACCENT_GREEN, 0),
        ("QA Agent", ["Test suites", "Bug hunting", "Validation"], ACCENT_ORANGE, 300),
        ("Ops Agent", ["Deployment", "CI / CD", "Monitoring"], ACCENT_CYAN, 240),
        ("Review", ["Code review", "Best practices", "Security"], ACCENT_YELLOW, 180),
    ]

    placed = []
    for name, desc, color, ang in nodes:
        th = math.radians(ang)
        ax, ay = cx + R_orbit * math.cos(th), cy - R_orbit * math.sin(th)
        rect = (ax - card_w / 2, ay - card_h / 2, ax + card_w / 2, ay + card_h / 2)
        hub_edge = (cx + R_hub * math.cos(th), cy - R_hub * math.sin(th))
        card_edge = ray_rect_exit(cx, cy, *rect)
        placed.append((name, desc, color, rect, hub_edge, card_edge))

    # soft glow under the spokes
    glow = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for _, _, color, _, he, ce in placed:
        gd.line([(S(he[0]), S(he[1])), (S(ce[0]), S(ce[1]))], fill=_hex_rgb(color) + (110,), width=S(9))
    glow = glow.filter(ImageFilter.GaussianBlur(S(5)))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    d = ImageDraw.Draw(img)

    # crisp spoke cores + endpoint dots
    for _, _, color, _, he, ce in placed:
        d.line([(S(he[0]), S(he[1])), (S(ce[0]), S(ce[1]))], fill=color, width=S(2))
        for pt in (he, ce):
            d.ellipse((S(pt[0] - 3), S(pt[1] - 3), S(pt[0] + 3), S(pt[1] + 3)), fill=color)

    tc(d, (W // 2, 50), "Agent Pool — Specialized Roles", F_title, WHITE)
    tc(d, (W // 2, 90), "One orchestrator routes each task to the right specialist", F_sub, GRAY)

    # hub
    d.ellipse((S(cx - R_hub), S(cy - R_hub), S(cx + R_hub), S(cy + R_hub)), fill="#10231a", outline=ACCENT_GREEN, width=S(3))
    d.ellipse((S(cx - R_hub + 9), S(cy - R_hub + 9), S(cx + R_hub - 9), S(cy + R_hub - 9)), outline="#1f7a45", width=S(1))
    tc(d, (cx, cy - 9), "Orchestrator", F_hub, ACCENT_GREEN)
    tc(d, (cx, cy + 15), "routes · gates", F_hubsub, GRAY)

    # cards
    for name, desc, color, rect, _, _ in placed:
        x0, y0, x1, y1 = rect
        d.rounded_rectangle((S(x0), S(y0), S(x1), S(y1)), radius=S(16), fill="#161c26", outline=color, width=S(2))
        tc(d, ((x0 + x1) / 2, y0 + 28), name, F_card, color)
        uw = 30
        d.line([(S((x0 + x1) / 2 - uw), S(y0 + 47)), (S((x0 + x1) / 2 + uw), S(y0 + 47))], fill=color, width=S(2))
        for i, line in enumerate(desc):
            tc(d, ((x0 + x1) / 2, y0 + 66 + i * 18), line, F_desc, GRAY)

    b = d.textbbox((0, 0), "Myrmecia © 2026", font=F_foot)
    d.text((S(W - 20) - (b[2] - b[0]), S(H - 34)), "Myrmecia © 2026", font=F_foot, fill=GRAY)

    img = img.resize((W, H), Image.LANCZOS)
    img.save(os.path.join(OUT, "agent-pool.png"), quality=95)
    print("agent-pool.png")

# ============================================================
# Diagram 6: Tech Stack
# ============================================================
def gen_tech_stack():
    W, H = 1200, 550
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    text_center(d, (W//2, 35), "Tech Stack", font_title, WHITE)

    layers = [
        ("Frontend", [("React 19", ACCENT_BLUE), ("TypeScript", ACCENT_CYAN), ("Tailwind", ACCENT_PURPLE), ("shadcn/ui", ACCENT_PINK), ("WebSocket", ACCENT_GREEN)], ACCENT_BLUE),
        ("Backend", [("Express", ACCENT_GREEN), ("TypeScript", ACCENT_CYAN), ("BullMQ", ACCENT_ORANGE), ("REST API", ACCENT_YELLOW), ("WS Server", ACCENT_PURPLE)], ACCENT_GREEN),
        ("Runtime", [("TS Agent Loop", ACCENT_PURPLE), ("Model Registry", ACCENT_BLUE), ("Skill Store", ACCENT_ORANGE), ("Tool Runtime", ACCENT_PINK), ("Python Runtime", ACCENT_CYAN)], ACCENT_PURPLE),
        ("Data", [("SQLite", ACCENT_BLUE), ("Redis", ACCENT_RED), ("BullMQ Queue", ACCENT_ORANGE), ("Event Store", ACCENT_YELLOW), ("Audit Log", ACCENT_GRAY if False else GRAY)], ACCENT_ORANGE),
    ]

    y = 80
    for layer_name, items, color in layers:
        # Layer label
        rounded_rect(d, (50, y, 180, y+90), 10, "#1c2333", color, 2)
        text_center(d, (115, y+45), layer_name, font_header, color)

        # Items
        ix = 220
        for item_name, item_color in items:
            rounded_rect(d, (ix, y+10, ix+170, y+80), 10, "#1c2333", item_color, 2)
            text_center(d, (ix+85, y+45), item_name, font_body, item_color)
            ix += 190

        # Connection line
        if y < 80 + 3 * 110:
            d.line([(115, y+90), (115, y+110)], fill=GRAY, width=2)

        y += 110

    d.text((W - 200, H - 20), "Myrmecia © 2026", font=font_label, fill=GRAY)
    img.save(os.path.join(OUT, "tech-stack.png"), quality=95)
    print("tech-stack.png")

# ============================================================
# Diagram 0: Header schema (left-to-right harness flow)
# ============================================================
def gen_schema():
    W, H = 1600, 900
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    text_center(d, (W // 2, 52), "Myrmecia — Multi-Agent Orchestration Harness", font_hero, WHITE)
    text_center(d, (W // 2, 100), "One request -> routed -> orchestrated -> executed by a governed agent harness -> shipped", font_readable, GRAY)

    # Row 1: the end-to-end flow
    flow = [
        (80, "Request", "one-line goal", ACCENT_BLUE),
        (330, "Supervisor", "intent + routing", ACCENT_CYAN),
        (580, "Orchestrator", "pipeline / DAG / master", ACCENT_PURPLE),
        (830, "Agent Harness", "tool-loop + context", ACCENT_GREEN),
        (1080, "Governed Tools", "built-in + MCP", ACCENT_PINK),
        (1330, "Output", "code / review / deploy", ACCENT_ORANGE),
    ]
    cw = 220
    for x, title, subtitle, color in flow:
        simple_card(d, (x, 200, x + cw, 360), title, subtitle, color)
    for i in range(len(flow) - 1):
        x_end = flow[i][0] + cw
        x_next = flow[i + 1][0]
        labeled_arrow(d, (x_end, 280), (x_next, 280), GRAY, width=4)

    # Row 2: harness internals band (under the Agent Harness column)
    band = (80, 440, 1550, 630)
    rounded_rect(d, band, 26, "#111827", ACCENT_GREEN, 4)
    band_title(d, band, "Agent Harness Internals", ACCENT_GREEN)
    for xy, title, subtitle, color in [
        ((120, 515, 440, 605), "Tool-Calling Loop", "multi-turn fn-calls", ACCENT_GREEN),
        ((470, 515, 770, 605), "Context Manager", "compress + recall", ACCENT_CYAN),
        ((800, 515, 1090, 605), "Unified Memory", "4-layer + graph", ACCENT_PURPLE),
        ((1120, 515, 1510, 605), "Model Gateway", "providers + streaming", ACCENT_YELLOW),
    ]:
        simple_card(d, xy, title, subtitle, color)
    labeled_arrow(d, (940, 360), (940, 440), ACCENT_GREEN, "runs", (60, 0), width=5)

    # Row 3: cross-cutting platform band
    base = (80, 690, 1550, 840)
    rounded_rect(d, base, 26, "#111827", GRAY, 4)
    band_title(d, base, "Governance  ·  Observability  ·  Persistence", GRAY)
    for xy, title, subtitle, color in [
        ((120, 762, 560, 828), "Governance", "policy / sandbox / DLP", ACCENT_PINK),
        ((590, 762, 1030, 828), "Observability", "OTel traces + metrics", ACCENT_BLUE),
        ((1060, 762, 1510, 828), "Persistence", "SQLite/PG · Redis/BullMQ", GRAY),
    ]:
        simple_card(d, xy, title, subtitle, color)
    labeled_arrow(d, (815, 630), (815, 690), GRAY, "secured + traced", (110, 0), width=5)

    img.save(os.path.join(OUT, "schema.png"), quality=95)
    print("schema.png")

# Generate all
gen_schema()
gen_architecture()
gen_dynamic_workflow_lifecycle()
gen_runtime_governance()
gen_pipeline()
gen_agent_pool()
gen_tech_stack()
print("\nAll diagrams generated!")
