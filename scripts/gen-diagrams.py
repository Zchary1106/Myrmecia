#!/usr/bin/env python3
"""Generate colorful architecture diagrams for Agent Factory README."""

from PIL import Image, ImageDraw, ImageFont
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

# ============================================================
# Diagram 1: System Architecture Overview
# ============================================================
def gen_architecture():
    W, H = 2400, 1800
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # Header
    text_center(d, (W // 2, 58), "Agent Factory — Detailed System Architecture", font_big_title, WHITE)
    text_center(d, (W // 2, 108), "Dynamic workflows · task-aware model routing · tool governance · auditability", font_card_small, GRAY)

    # Dashboard layer
    rounded_rect(d, (90, 150, 2310, 320), 26, "#111827", ACCENT_BLUE, 4)
    text_center(d, (1200, 198), "Web Dashboard", font_section, ACCENT_BLUE)
    text_center(d, (1200, 246), "Interaction Console · Work Queue · Orchestration Board · Pipelines · Skills · Models · Audit · Cost Dashboard", font_card_small, WHITE)
    text_center(d, (1200, 286), "React 19 · Zustand · Vite · Tailwind · REST client · WebSocket subscriptions", font_tiny, GRAY)

    labeled_arrow(d, (1200, 320), (1200, 390), ACCENT_BLUE, "HTTP API + WebSocket", (170, -2), width=4)

    # API layer
    rounded_rect(d, (90, 390, 2310, 770), 26, "#111827", ACCENT_GREEN, 4)
    text_center(d, (1200, 438), "Express Orchestrator API", font_section, ACCENT_GREEN)
    api_cards = [
        ((145, 500, 535, 720), "Auth + Tenant", "Token auth, API key scopes, workspace isolation.", ACCENT_GREEN,
         ["workspace filters", "tenant-aware routes", "scoped audit access"]),
        ((575, 500, 965, 720), "Supervisor", "Classifies operator intent and owns dynamic workflow APIs.", ACCENT_BLUE,
         ["dispatch + plan preview", "workflow cancel", "step controls"]),
        ((1005, 500, 1395, 720), "Task Queue", "Queues work through BullMQ or the local in-memory fallback.", ACCENT_ORANGE,
         ["priority + dependencies", "retry / cancel", "worker handoff"]),
        ((1435, 500, 1825, 720), "Pipeline Engine", "Runs YAML templates, stage dependencies, and artifacts.", ACCENT_CYAN,
         ["dependsOn DAG", "manual gates", "rollback support"]),
        ((1865, 500, 2255, 720), "Realtime + Audit", "Publishes events and records execution policy snapshots.", ACCENT_PINK,
         ["WebSocket channels", "trace spans", "audit reports"]),
    ]
    for xy, title, subtitle, color, bullets in api_cards:
        diagram_card(d, xy, title, subtitle, color, bullets, wrap_chars=34)

    # Planning / execution layer
    labeled_arrow(d, (730, 770), (520, 890), ACCENT_ORANGE, "enqueue")
    labeled_arrow(d, (1200, 770), (1200, 890), ACCENT_GREEN, "plan / route")
    labeled_arrow(d, (1670, 770), (1880, 890), ACCENT_PINK, "events")

    rounded_rect(d, (90, 890, 2310, 1285), 26, "#111827", ACCENT_PURPLE, 4)
    text_center(d, (1200, 938), "Planning + Agent Execution", font_section, ACCENT_PURPLE)
    exec_cards = [
        ((135, 985, 545, 1235), "Dynamic Workflow Runtime", "Builds executable plans, fans out many agent tasks, and aggregates validation.", ACCENT_PURPLE,
         ["plan preview / JSON edit", "DAG dependencies", "rerun / skip / unblock"]),
        ((590, 985, 960, 1235), "Agent Manager", "Selects available agent templates by role, skill, and capacity.", ACCENT_BLUE,
         ["23 agent templates", "skill assignment", "concurrency limits"]),
        ((1005, 985, 1375, 1235), "Agent Runtime", "Builds prompts, records traces, executes work, and streams progress.", ACCENT_GREEN,
         ["TS Agent Loop", "Python Runtime", "progress events"]),
        ((1420, 985, 1790, 1235), "Model Router", "Chooses a model by task risk, prompt size, retry count, and agent policy.", ACCENT_CYAN,
         ["cheap/simple", "codex/code", "gpt-5.5/risk", "gpt-5.4/long context"]),
        ((1835, 985, 2265, 1235), "Tool Governance", "Every tool call passes policy, sandbox, DLP, and guardian checks.", ACCENT_PINK,
         ["allowlists + approval gates", "secret redaction", "dangerous command block"]),
    ]
    for xy, title, subtitle, color, bullets in exec_cards:
        diagram_card(d, xy, title, subtitle, color, bullets, wrap_chars=36)

    # Data / infrastructure layer
    labeled_arrow(d, (1200, 1285), (1200, 1380), ACCENT_PURPLE, "persist + observe", (160, -2), width=4)
    rounded_rect(d, (90, 1380, 2310, 1665), 26, "#111827", GRAY, 4)
    text_center(d, (1200, 1428), "Persistence + Runtime Infrastructure", font_section, GRAY)
    data_cards = [
        ((125, 1480, 475, 1630), "SQLite / Postgres", "Canonical state for tasks, workflows, agents, tools.", ACCENT_BLUE,
         ["tasks", "executions", "dynamic_workflows"]),
        ((505, 1480, 855, 1630), "Redis / BullMQ", "Optional distributed queue and worker execution.", ACCENT_RED,
         ["agent-factory-tasks", "priority jobs"]),
        ((885, 1480, 1235, 1630), "Workspaces", "Isolated task and pipeline files plus stage artifacts.", ACCENT_ORANGE,
         [".agent-factory/workspaces", "test-report.json"]),
        ((1265, 1480, 1615, 1630), "Skill + Model Stores", "Versioned prompts and model route registry.", ACCENT_PURPLE,
         ["skill_versions", "model_routes", "usage stats"]),
        ((1645, 1480, 1995, 1630), "Audit + Events", "Operator actions, policy snapshots, platform events.", ACCENT_PINK,
         ["execution_audit", "operator_actions"]),
        ((2025, 1480, 2275, 1630), "Model Endpoint", "OpenAI-compatible API for selected models.", ACCENT_CYAN,
         ["gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.5"]),
    ]
    for xy, title, subtitle, color, bullets in data_cards:
        diagram_card(d, xy, title, subtitle, color, bullets, wrap_chars=31)

    # Cross-cutting rail
    rounded_rect(d, (90, 1700, 2310, 1758), 16, "#0f172a", ACCENT_YELLOW, 3)
    text_center(
        d,
        (1200, 1729),
        "Cross-cutting controls: auth scopes · tenant isolation · runtime budgets · DLP · sandbox · approval inbox · cost tracking",
        font_card_small,
        ACCENT_YELLOW,
    )

    d.text((W - 270, H - 34), "Agent Factory © 2026", font=font_tiny, fill=GRAY)

    img.save(os.path.join(OUT, "architecture-overview.png"), quality=95)
    print("✅ architecture-overview.png")

# ============================================================
# Diagram 2: Dynamic Workflow Lifecycle
# ============================================================
def gen_dynamic_workflow_lifecycle():
    W, H = 2200, 1300
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    text_center(d, (W // 2, 58), "Dynamic Workflow Lifecycle", font_big_title, WHITE)
    text_center(d, (W // 2, 108), "Operator intent -> executable DAG -> parallel agent tasks -> validation summary", font_card_small, GRAY)

    steps = [
        ((95, 180, 415, 410), "1. Intent", "The operator asks for a complex task in the Interaction Console or API.", ACCENT_BLUE,
         ["goal + constraints", "workspace context", "priority"]),
        ((465, 180, 785, 410), "2. Plan Preview", "Supervisor builds a deterministic executable plan before dispatch.", ACCENT_PURPLE,
         ["editable JSON", "agent roles", "dependency graph"]),
        ((835, 180, 1155, 410), "3. Persist Workflow", "The run is stored in dynamic_workflows with plan, status, and taskIds.", ACCENT_GREEN,
         ["plan snapshot", "status history", "validation fields"]),
        ((1205, 180, 1525, 410), "4. Fan-out Tasks", "Each ready step becomes a normal task with mapped dependencies.", ACCENT_ORANGE,
         ["TaskQueue", "dependsOn", "agent assignment"]),
        ((1575, 180, 1895, 410), "5. Observe + Control", "Operators inspect DAG progress, messages, audit, and artifacts.", ACCENT_PINK,
         ["rerun / skip", "replace agent", "force unblock"]),
    ]

    for i, (xy, title, subtitle, color, bullets) in enumerate(steps):
        diagram_card(d, xy, title, subtitle, color, bullets, wrap_chars=30)
        if i < len(steps) - 1:
            x1 = xy[2]
            next_x0 = steps[i + 1][0][0]
            draw_arrow(d, (x1 + 12, 295), (next_x0 - 12, 295), color, width=4)

    diagram_card(
        d,
        (720, 500, 1480, 725),
        "6. Completion Aggregator",
        "The workflow runtime listens for task terminal events, combines step outputs, and writes a validation summary.",
        ACCENT_CYAN,
        ["all steps terminal", "failed/skipped counts", "result + evidence links"],
        wrap_chars=64,
    )

    labeled_arrow(d, (1735, 410), (1480, 500), ACCENT_PINK, "events", (20, -18), width=4)
    labeled_arrow(d, (1100, 410), (1100, 500), ACCENT_GREEN, "persist", (90, -4), width=4)

    # DAG detail row
    rounded_rect(d, (95, 805, 2105, 1215), 26, "#111827", ACCENT_PURPLE, 4)
    text_center(d, (1100, 855), "Executable DAG Detail", font_section, ACCENT_PURPLE)

    dag_nodes = [
        ((190, 940, 430, 1075), "Spec", "PM / planner", ACCENT_BLUE),
        ((570, 900, 810, 1035), "Design", "UI / architecture", ACCENT_PURPLE),
        ((570, 1060, 810, 1195), "Data/API", "backend developer", ACCENT_GREEN),
        ((950, 980, 1190, 1115), "Implementation", "developer", ACCENT_ORANGE),
        ((1330, 900, 1570, 1035), "QA", "test automation", ACCENT_YELLOW),
        ((1330, 1060, 1570, 1195), "Security", "security reviewer", ACCENT_PINK),
        ((1710, 980, 1950, 1115), "Validation", "aggregate result", ACCENT_CYAN),
    ]
    for xy, title, subtitle, color in dag_nodes:
        diagram_card(d, xy, title, subtitle, color, [], wrap_chars=22)

    edges = [
        ((430, 1008), (570, 967), ACCENT_BLUE),
        ((430, 1008), (570, 1127), ACCENT_BLUE),
        ((810, 967), (950, 1048), ACCENT_PURPLE),
        ((810, 1127), (950, 1048), ACCENT_GREEN),
        ((1190, 1048), (1330, 967), ACCENT_ORANGE),
        ((1190, 1048), (1330, 1127), ACCENT_ORANGE),
        ((1570, 967), (1710, 1048), ACCENT_YELLOW),
        ((1570, 1127), (1710, 1048), ACCENT_PINK),
    ]
    for start, end, color in edges:
        draw_arrow(d, start, end, color, width=4)

    rounded_rect(d, (95, 1230, 2105, 1280), 16, "#0f172a", ACCENT_YELLOW, 3)
    text_center(d, (1100, 1255), "Step controls are persisted as operator actions and reflected back through WebSocket workflow events.", font_card_small, ACCENT_YELLOW)

    d.text((W - 270, H - 18), "Agent Factory © 2026", font=font_tiny, fill=GRAY)
    img.save(os.path.join(OUT, "dynamic-workflow-lifecycle.png"), quality=95)
    print("✅ dynamic-workflow-lifecycle.png")

# ============================================================
# Diagram 3: Runtime Governance Chain
# ============================================================
def gen_runtime_governance():
    W, H = 2200, 1250
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    text_center(d, (W // 2, 58), "Runtime Governance and Tool Safety", font_big_title, WHITE)
    text_center(d, (W // 2, 108), "Every model output and tool call is constrained, scanned, budgeted, and auditable", font_card_small, GRAY)

    chain = [
        ((95, 200, 405, 430), "Agent Runtime", "Build prompt, select model, create execution, and stream events.", ACCENT_GREEN,
         ["policy snapshot", "runtime budgets", "trace spans"]),
        ((465, 200, 775, 430), "Tool Registry", "Resolves known tools and risk metadata before execution.", ACCENT_BLUE,
         ["readOnly / network", "writesWorkspace", "approvalRequired"]),
        ((835, 200, 1145, 430), "Tool Policy", "Enforces agent allowlists, domain rules, and approval gates.", ACCENT_PURPLE,
         ["allowed tools", "blocked metadata", "operator approval"]),
        ((1205, 200, 1515, 430), "Sandbox", "Confines filesystem, shell, and network operations.", ACCENT_ORANGE,
         ["workspace paths", "command guard", "timeout budgets"]),
        ((1575, 200, 1885, 430), "DLP + Guardian", "Scans inputs, outputs, logs, and artifacts for unsafe data.", ACCENT_PINK,
         ["PII redaction", "secret blocking", "prompt injection"]),
    ]

    for i, (xy, title, subtitle, color, bullets) in enumerate(chain):
        diagram_card(d, xy, title, subtitle, color, bullets, wrap_chars=30)
        if i < len(chain) - 1:
            draw_arrow(d, (xy[2] + 14, 315), (chain[i + 1][0][0] - 14, 315), color, width=4)

    diagram_card(
        d,
        (720, 535, 1480, 780),
        "Audit Report",
        "Allowed calls, blocked calls, DLP findings, model route, token/cost usage, and runtime limits are persisted for explainability.",
        ACCENT_CYAN,
        ["execution_audit_reports", "operator_actions", "task / execution events"],
        wrap_chars=64,
    )
    labeled_arrow(d, (1730, 430), (1480, 535), ACCENT_PINK, "sanitized events", (70, -28), width=4)
    labeled_arrow(d, (250, 430), (720, 535), ACCENT_GREEN, "execution metadata", (40, -20), width=4)

    # Decision outcomes
    rounded_rect(d, (95, 875, 2105, 1135), 26, "#111827", GRAY, 4)
    text_center(d, (1100, 925), "Execution Outcomes", font_section, GRAY)
    outcomes = [
        ((155, 985, 555, 1095), "Allowed", "Tool executes and sanitized result returns to the model.", ACCENT_GREEN),
        ((640, 985, 1040, 1095), "Requires Approval", "Execution pauses and creates an approval card / inbox item.", ACCENT_YELLOW),
        ((1125, 985, 1525, 1095), "Blocked", "Dangerous command, forbidden path, domain, or policy violation.", ACCENT_RED),
        ((1610, 985, 2010, 1095), "Redacted", "Sensitive output is masked before storage or display.", ACCENT_PINK),
    ]
    for xy, title, subtitle, color in outcomes:
        diagram_card(d, xy, title, subtitle, color, [], wrap_chars=34)

    rounded_rect(d, (95, 1165, 2105, 1218), 16, "#0f172a", ACCENT_YELLOW, 3)
    text_center(d, (1100, 1191), "Guardrails apply to TS Agent Loop, Python Runtime output, cached artifacts, task outputs, and dashboard-visible logs.", font_card_small, ACCENT_YELLOW)

    d.text((W - 270, H - 18), "Agent Factory © 2026", font=font_tiny, fill=GRAY)
    img.save(os.path.join(OUT, "runtime-governance.png"), quality=95)
    print("✅ runtime-governance.png")

# ============================================================
# Diagram 4: Pipeline Flow
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
# Diagram 5: Agent Pool & Roles
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
# Diagram 6: Tech Stack
# ============================================================
def gen_tech_stack():
    W, H = 1200, 550
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    text_center(d, (W//2, 35), "🧰 Tech Stack", font_title, WHITE)

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

    d.text((W - 200, H - 20), "Agent Factory © 2025", font=font_label, fill=GRAY)
    img.save(os.path.join(OUT, "tech-stack.png"), quality=95)
    print("✅ tech-stack.png")

# Generate all
gen_architecture()
gen_dynamic_workflow_lifecycle()
gen_runtime_governance()
gen_pipeline()
gen_agent_pool()
gen_tech_stack()
print("\n🎉 All diagrams generated!")
