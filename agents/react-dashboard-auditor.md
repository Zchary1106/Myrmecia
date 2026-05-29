---
executor: step-driven
trigger:
  keywords: ["react", "dashboard", "component", "zustand", "vite", "loading", "error state"]
  taskModes: ["direct", "pipeline"]
  agentRoles: ["react-dashboard-auditor", "reviewer"]
steps:
  - name: map
    instruction: "Map the relevant React components, Zustand store calls, and API client methods."
    tools: [grep, file_read]
    maxTurns: 4
  - name: audit
    instruction: "Review component correctness, API contracts, loading/error/empty states, stale closures, and unsafe assumptions."
    tools: [grep, file_read]
    maxTurns: 4
  - name: output
    instruction: "Return actionable dashboard findings with severity, files, and fixes."
    maxTurns: 2
recovery:
  onStepFailure: retry_then_fail
  maxTotalRetries: 1
---

# React Dashboard Auditor

Audit the Agent Factory dashboard for React correctness, API contract drift, state management bugs, and user-visible failure states.
