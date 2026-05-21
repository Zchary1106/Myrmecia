# Batch B: Runtime Improvements — Design Spec

## Overview

Two independent modules enhancing the Agent Factory runtime:

1. **Skill Hot-Reload** — File watching + API updates for skill markdown files, with automatic version creation and agent assignment updates. Running tasks are unaffected; agents pick up new skills on their next task.
2. **Cost Tracking Dashboard** — Backend aggregation API + React dashboard page with charts showing token/cost trends by agent, task, and model.

```
fs.watch → SkillWatcher → skill:updated → DB sync + Notification
API PUT  → SkillRegistry → skill:updated → writeback to .md + Notification

GET /api/v1/cost-dashboard/* → aggregate model_usage_stats
Dashboard CostDashboard page → Recharts visualizations
```

---

## 1. Skill Hot-Reload

### 1.1 File Watcher

New class `SkillWatcher` in `packages/server/src/skills/skill-watcher.ts`.

**Behavior:**
- Uses `fs.watch` on the `agents/` directory for `.md` file changes
- 500ms debounce per file to avoid multiple triggers during editor saves
- On change detected:
  1. Read file content, compute checksum via existing `checksumSkillContent()`
  2. Compare with DB — if checksum differs, create new `SkillVersion` with status `published`
  3. Update all agent assignments using this skill to point to the new version
  4. Emit `skill:updated` event via EventBus
  5. Create Notification: "Skill X updated to version N"

**Lifecycle:**
- `start()` — begin watching, called during server startup
- `stop()` — stop watching, called during graceful shutdown

**Running tasks:** Not affected. Agents resolve their skill content at task start time. An agent currently executing a task continues with the old skill. Next task picks up the new version automatically.

### 1.2 API Update Endpoint

Extend existing skill routes in `packages/server/src/routes/skills.ts`:

```
PUT /api/v1/skills/:id/content
Body: { content: string }
```

**Behavior:**
1. Validate skill exists
2. Compute checksum, skip if unchanged
3. Create new `SkillVersion` (published)
4. Update agent assignments
5. If skill has a `sourcePath`, write content back to the `.md` file on disk (keeps file and DB in sync)
6. Emit `skill:updated` event + Notification

**File writeback:** The watcher must ignore changes triggered by API writeback to avoid infinite loops. Use a short-lived "ignore set" of file paths currently being written.

### 1.3 Data Model

No new tables needed. Uses existing:
- `skills` table (via `upsertSkill`)
- `skill_versions` table (via `createSkillVersion`)
- `skill_assignments` table (via `assignSkillVersionToAgent`)

### 1.4 Implementation Files

| File | Action |
|------|--------|
| `packages/server/src/skills/skill-watcher.ts` | Create — SkillWatcher class |
| `packages/server/src/routes/skills.ts` | Modify — add PUT content endpoint |
| `packages/server/src/index.ts` | Modify — instantiate and start SkillWatcher, stop on shutdown |

---

## 2. Cost Tracking Dashboard

### 2.1 Backend API

New route module `packages/server/src/routes/cost-dashboard.ts` mounted at `/api/v1/cost-dashboard`.

**Data source:** Existing `model_usage_stats` table. No new tables.

#### Endpoints

**GET /summary**
- Query params: `period` (day|week|month), `since`, `until`
- Returns: total input tokens, output tokens, cost USD, request count

```json
{
  "period": "day",
  "totalInputTokens": 150000,
  "totalOutputTokens": 60000,
  "totalCostUSD": 4.25,
  "requestCount": 87
}
```

**GET /by-agent**
- Query params: `period` (day|week|month), `since`, `until`
- Returns: per-agent time series

```json
{
  "agents": [
    {
      "agentId": "dev",
      "agentName": "Developer",
      "dataPoints": [
        { "date": "2026-05-20", "inputTokens": 12000, "outputTokens": 5000, "costUSD": 0.34 }
      ],
      "totalCostUSD": 0.56
    }
  ]
}
```

**GET /by-task**
- Query params: `limit` (default 50)
- Returns: most recent tasks with their token/cost

```json
{
  "tasks": [
    {
      "taskId": "task_abc",
      "title": "Build login page",
      "agentId": "dev",
      "inputTokens": 8000,
      "outputTokens": 3000,
      "costUSD": 0.22,
      "completedAt": "2026-05-21T10:30:00Z"
    }
  ]
}
```

**GET /by-model**
- Query params: `period` (day|week|month), `since`, `until`
- Returns: per-model distribution with time series

```json
{
  "models": [
    {
      "modelId": "claude-sonnet-4-20250514",
      "dataPoints": [
        { "date": "2026-05-20", "inputTokens": 50000, "outputTokens": 20000, "costUSD": 1.40 }
      ],
      "totalCostUSD": 2.80,
      "percentOfTotal": 65.8
    }
  ]
}
```

### 2.2 Frontend Dashboard

New page `CostDashboard` in the React dashboard app.

**Component structure:**

```
CostDashboard.tsx              — page container, time range state, data fetching
├── CostSummaryCards.tsx        — 3 summary cards (Total Tokens, Requests, Cost USD)
├── AgentCostChart.tsx          — multi-line chart showing agent cost trends
├── ModelDistChart.tsx          — pie chart showing model distribution
└── TaskCostTable.tsx           — table of recent tasks ranked by cost
```

**Layout:**
- Top bar: time range selector (Today / 7d / 30d / Custom date picker)
- Row 1: 3 summary cards
- Row 2: Agent cost trend line chart (full width)
- Row 3 left: Model distribution pie chart
- Row 3 right: Task cost ranking table (top 20)

**Tech:**
- Charts: `recharts` library (LineChart, PieChart, ResponsiveContainer)
- Data fetching: existing fetch/axios pattern used by other Dashboard pages
- Auto-refresh: 60-second polling interval

**Routing:** Add `/cost` route to Dashboard router, add nav menu item "Cost Dashboard".

### 2.3 Implementation Files

| File | Action |
|------|--------|
| `packages/server/src/routes/cost-dashboard.ts` | Create — aggregation API endpoints |
| `packages/server/src/index.ts` | Modify — mount cost-dashboard routes |
| `packages/dashboard/src/pages/CostDashboard.tsx` | Create — page container |
| `packages/dashboard/src/components/CostSummaryCards.tsx` | Create — summary cards |
| `packages/dashboard/src/components/AgentCostChart.tsx` | Create — agent trend chart |
| `packages/dashboard/src/components/ModelDistChart.tsx` | Create — model pie chart |
| `packages/dashboard/src/components/TaskCostTable.tsx` | Create — task cost table |
| `packages/dashboard/src/App.tsx` (or router file) | Modify — add /cost route + nav item |

---

## File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `packages/server/src/skills/skill-watcher.ts` | File watcher for skill hot-reload |
| `packages/server/src/routes/cost-dashboard.ts` | Cost dashboard API endpoints |
| `packages/dashboard/src/pages/CostDashboard.tsx` | Dashboard page container |
| `packages/dashboard/src/components/CostSummaryCards.tsx` | Summary cards component |
| `packages/dashboard/src/components/AgentCostChart.tsx` | Agent cost trend chart |
| `packages/dashboard/src/components/ModelDistChart.tsx` | Model distribution pie chart |
| `packages/dashboard/src/components/TaskCostTable.tsx` | Task cost ranking table |

### Modified Files

| File | Changes |
|------|---------|
| `packages/server/src/routes/skills.ts` | Add PUT /:id/content endpoint |
| `packages/server/src/index.ts` | Start SkillWatcher, mount cost-dashboard routes, stop watcher on shutdown |
| `packages/dashboard/src/App.tsx` | Add /cost route and nav menu item |
