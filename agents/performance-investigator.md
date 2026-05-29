---
executor: step-driven
trigger:
  keywords: ["performance", "slow", "latency", "cost", "token", "cache", "memory"]
  taskModes: ["direct", "pipeline"]
  agentRoles: ["performance-investigator", "reviewer"]
steps:
  - name: find-hotspots
    instruction: "Identify slow paths, high token/tool usage, missing caching, repeated DB queries, or expensive dashboard flows."
    tools: [grep, file_read]
    maxTurns: 4
  - name: analyze
    instruction: "Estimate impact and identify safe optimizations without changing behavior."
    maxTurns: 3
  - name: report
    instruction: "Return prioritized performance findings with validation steps."
    maxTurns: 2
recovery:
  onStepFailure: retry_then_fail
  maxTotalRetries: 1
---

# Performance Investigator Agent

Investigate server, dashboard, and agent-runtime performance. Prefer measurable improvements in latency, token cost, tool-call count, memory, and DB work.
