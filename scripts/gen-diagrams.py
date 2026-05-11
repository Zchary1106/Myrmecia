#!/usr/bin/env python3
"""Generate colorful architecture diagrams for Agent Factory README."""

from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.expanduser("~/.openclaw/workspace/agent-factory/docs/diagrams")
os.makedirs(OUT, exist_ok=True)

# Try to get a decent font
def get_font(size):
    for p in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def get_font_regular(size):
    for p in [
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

# ============================================================
# Diagram 1: System Architecture Overview
# ============================================================
def gen_architecture():
    W, H = 1200, 800
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # Title
    text_center(d, (W//2, 35), "🏭 Agent Factory — System Architecture", font_title, WHITE)

    # Layer 1: Dashboard
    rounded_rect(d, (100, 80, 1100, 160), 12, "#1c2333", ACCENT_BLUE, 2)
    text_center(d, (600, 105), "🖥️  Web Dashboard", font_header, ACCENT_BLUE)
    text_center(d, (600, 135), "React 19  ·  Tailwind CSS  ·  shadcn/ui  ·  WebSocket", font_small, GRAY)

    # Arrow
    draw_arrow(d, (600, 160), (600, 200), ACCENT_BLUE)
    text_center(d, (660, 178), "WebSocket", font_label, GRAY)

    # Layer 2: Orchestrator API
    rounded_rect(d, (100, 200, 1100, 310), 12, "#1c2333", ACCENT_GREEN, 2)
    text_center(d, (600, 225), "⚙️  Orchestrator API", font_header, ACCENT_GREEN)

    # Sub-boxes in orchestrator
    boxes = [
        (140, 255, 310, 295, "Queue (BullMQ)", ACCENT_ORANGE),
        (330, 255, 500, 295, "Agent Pool", ACCENT_PURPLE),
        (520, 255, 690, 295, "Pipeline Engine", ACCENT_CYAN),
        (710, 255, 880, 295, "Event Bus", ACCENT_YELLOW),
        (900, 255, 1060, 295, "Tool Runtime", ACCENT_PINK),
    ]
    for x0, y0, x1, y1, label, color in boxes:
        rounded_rect(d, (x0, y0, x1, y1), 8, BG, color, 2)
        text_center(d, ((x0+x1)//2, (y0+y1)//2), label, font_small, color)

    # Arrow to modes
    draw_arrow(d, (300, 310), (250, 370), ACCENT_GREEN)
    draw_arrow(d, (600, 310), (600, 370), ACCENT_GREEN)
    draw_arrow(d, (900, 310), (950, 370), ACCENT_GREEN)

    # Layer 3: Operation Modes
    modes = [
        (100, 370, 420, 460, "Mode A: Master Dispatch", "🎯", ACCENT_ORANGE),
        (440, 370, 760, 460, "Mode B: Direct Assign", "📌", ACCENT_CYAN),
        (780, 370, 1100, 460, "Mode C: Pipeline Flow", "🔗", ACCENT_PURPLE),
    ]
    for x0, y0, x1, y1, label, emoji, color in modes:
        rounded_rect(d, (x0, y0, x1, y1), 12, "#1c2333", color, 2)
        text_center(d, ((x0+x1)//2, (y0+y1)//2 - 10), f"{emoji}  {label}", font_body, color)
        desc = {
            "Mode A": "AI breaks down & delegates",
            "Mode B": "Manual agent assignment",
            "Mode C": "Stage-by-stage pipeline",
        }
        key = label.split(":")[0]
        text_center(d, ((x0+x1)//2, (y0+y1)//2 + 15), desc.get(key, ""), font_label, GRAY)

    # Arrows to agents
    draw_arrow(d, (250, 460), (250, 510), ACCENT_ORANGE)
    draw_arrow(d, (600, 460), (600, 510), ACCENT_CYAN)
    draw_arrow(d, (950, 460), (950, 510), ACCENT_PURPLE)

    # Layer 4: Agent Pool
    rounded_rect(d, (100, 510, 1100, 610), 12, "#1c2333", ACCENT_PINK, 2)
    text_center(d, (600, 530), "🤖  Agent Pool", font_header, ACCENT_PINK)

    agents = [
        ("👔 PM", ACCENT_BLUE),
        ("🎨 UI", ACCENT_PURPLE),
        ("💻 Dev", ACCENT_GREEN),
        ("🧪 QA", ACCENT_ORANGE),
        ("🚀 Ops", ACCENT_CYAN),
        ("📝 Review", ACCENT_YELLOW),
    ]
    start_x = 150
    for i, (name, color) in enumerate(agents):
        x = start_x + i * 160
        rounded_rect(d, (x, 555, x+130, 595), 8, BG, color, 2)
        text_center(d, (x+65, 575), name, font_body, color)

    # Arrow to infra
    draw_arrow(d, (600, 610), (600, 650), ACCENT_PINK)

    # Layer 5: Infrastructure
    rounded_rect(d, (100, 650, 1100, 750), 12, "#1c2333", GRAY, 2)
    text_center(d, (600, 670), "🔧  Infrastructure", font_header, GRAY)

    infra = [
        (150, 695, 320, 735, "SQLite DB", ACCENT_BLUE),
        (340, 695, 510, 735, "Redis Queue", ACCENT_RED),
        (530, 695, 700, 735, "Claude CLI", ACCENT_GREEN),
        (720, 695, 890, 735, "Model Registry", ACCENT_PURPLE),
        (910, 695, 1060, 735, "Skill Store", ACCENT_ORANGE),
    ]
    for x0, y0, x1, y1, label, color in infra:
        rounded_rect(d, (x0, y0, x1, y1), 8, BG, color, 2)
        text_center(d, ((x0+x1)//2, (y0+y1)//2), label, font_small, color)

    # Watermark
    d.text((W - 200, H - 20), "Agent Factory © 2025", font=font_label, fill=GRAY)

    img.save(os.path.join(OUT, "architecture-overview.png"), quality=95)
    print("✅ architecture-overview.png")

# ============================================================
# Diagram 2: Pipeline Flow
# ============================================================
def gen_pipeline():
    W, H = 1200, 500
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    text_center(d, (W//2, 35), "🔗 Pipeline Flow — Full Product Lifecycle", font_title, WHITE)

    stages = [
        ("📋", "PM", "Spec &\nPlanning", ACCENT_BLUE),
        ("🎨", "UI", "Design &\nPrototype", ACCENT_PURPLE),
        ("💻", "Dev", "Code &\nBuild", ACCENT_GREEN),
        ("🧪", "QA", "Test &\nValidate", ACCENT_ORANGE),
        ("📝", "Review", "Code\nReview", ACCENT_YELLOW),
        ("🚀", "Ops", "Deploy &\nMonitor", ACCENT_CYAN),
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
    text_center(d, (W//2, y_center + box_h//2 + 50), "Each stage output → next stage input  ·  Auto/Manual gates  ·  Retry on failure", font_small, GRAY)

    # Progress bar
    bar_y = y_center + box_h//2 + 80
    rounded_rect(d, (start_x, bar_y, start_x + total_w, bar_y + 12), 6, BORDER)
    progress = int(total_w * 0.65)
    rounded_rect(d, (start_x, bar_y, start_x + progress, bar_y + 12), 6, ACCENT_GREEN)
    text_center(d, (start_x + progress + 30, bar_y + 6), "65%", font_label, ACCENT_GREEN)

    d.text((W - 200, H - 20), "Agent Factory © 2025", font=font_label, fill=GRAY)
    img.save(os.path.join(OUT, "pipeline-flow.png"), quality=95)
    print("✅ pipeline-flow.png")

# ============================================================
# Diagram 3: Agent Pool & Roles
# ============================================================
def gen_agent_pool():
    W, H = 1200, 650
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    text_center(d, (W//2, 35), "🤖 Agent Pool — Specialized Roles", font_title, WHITE)

    # Center hub
    cx, cy = W//2, 330
    d.ellipse((cx-60, cy-60, cx+60, cy+60), fill="#1c2333", outline=ACCENT_GREEN, width=3)
    text_center(d, (cx, cy-12), "⚙️", font_title, WHITE)
    text_center(d, (cx, cy+18), "Orchestrator", font_small, ACCENT_GREEN)

    agents = [
        ("👔", "PM Agent", "Requirements\nTask breakdown\nPrioritization", ACCENT_BLUE, -1, -1),
        ("🎨", "UI Agent", "Design systems\nPrototypes\nComponents", ACCENT_PURPLE, 1, -1),
        ("💻", "Dev Agent", "Implementation\nRefactoring\nDebugging", ACCENT_GREEN, 1.3, 0.3),
        ("🧪", "QA Agent", "Test suites\nBug hunting\nValidation", ACCENT_ORANGE, 0.7, 1.2),
        ("🚀", "Ops Agent", "Deployment\nCI/CD\nMonitoring", ACCENT_CYAN, -0.7, 1.2),
        ("📝", "Review", "Code review\nBest practices\nSecurity", ACCENT_YELLOW, -1.3, 0.3),
    ]

    import math
    radius = 200
    for i, (emoji, name, desc, color, dx, dy) in enumerate(agents):
        ax = cx + int(dx * radius)
        ay = cy + int(dy * radius)

        # Line to center
        d.line([(cx, cy), (ax, ay)], fill=color, width=2)

        # Agent card
        card_w, card_h = 150, 120
        x0 = ax - card_w // 2
        y0 = ay - card_h // 2
        rounded_rect(d, (x0, y0, x0+card_w, y0+card_h), 12, "#1c2333", color, 2)

        text_center(d, (ax, y0 + 22), emoji, font_header, WHITE)
        text_center(d, (ax, y0 + 48), name, font_body, color)

        lines = desc.split("\n")
        for j, line in enumerate(lines):
            text_center(d, (ax, y0 + 70 + j * 16), line, font_label, GRAY)

    d.text((W - 200, H - 20), "Agent Factory © 2025", font=font_label, fill=GRAY)
    img.save(os.path.join(OUT, "agent-pool.png"), quality=95)
    print("✅ agent-pool.png")

# ============================================================
# Diagram 4: Tech Stack
# ============================================================
def gen_tech_stack():
    W, H = 1200, 550
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    text_center(d, (W//2, 35), "🧰 Tech Stack", font_title, WHITE)

    layers = [
        ("Frontend", [("React 19", ACCENT_BLUE), ("TypeScript", ACCENT_CYAN), ("Tailwind", ACCENT_PURPLE), ("shadcn/ui", ACCENT_PINK), ("WebSocket", ACCENT_GREEN)], ACCENT_BLUE),
        ("Backend", [("Express", ACCENT_GREEN), ("TypeScript", ACCENT_CYAN), ("BullMQ", ACCENT_ORANGE), ("REST API", ACCENT_YELLOW), ("WS Server", ACCENT_PURPLE)], ACCENT_GREEN),
        ("Runtime", [("Claude CLI", ACCENT_PURPLE), ("Model Registry", ACCENT_BLUE), ("Skill Store", ACCENT_ORANGE), ("Tool Runtime", ACCENT_PINK), ("CrewAI", ACCENT_CYAN)], ACCENT_PURPLE),
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

    d.text((W - 200, H - 20), "Agent Factory © 2025", font=font_label, fill=GRAY)
    img.save(os.path.join(OUT, "tech-stack.png"), quality=95)
    print("✅ tech-stack.png")

# Generate all
gen_architecture()
gen_pipeline()
gen_agent_pool()
gen_tech_stack()
print("\n🎉 All diagrams generated!")
