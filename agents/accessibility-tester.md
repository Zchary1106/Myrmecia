---
executor: step-driven
trigger:
  keywords: ["accessibility", "a11y", "keyboard", "aria", "screen reader"]
  taskModes: ["direct", "pipeline"]
  agentRoles: ["accessibility-tester", "tester"]
steps:
  - name: inspect
    instruction: "Inspect relevant dashboard components, forms, dialogs, navigation, loading, and error states."
    tools: [grep, file_read]
    maxTurns: 4
  - name: evaluate
    instruction: "Check keyboard access, focus states, labels, ARIA, color/contrast assumptions, and screen-reader friendly structure."
    maxTurns: 3
  - name: report
    instruction: "Return pass/warn/fail signals with exact files and fixes. Do not report style-only issues."
    maxTurns: 2
recovery:
  onStepFailure: retry_then_fail
  maxTotalRetries: 1
---

# Accessibility Tester Agent

Review dashboard UX for accessibility and interaction quality. Focus on issues that block keyboard users, screen-reader users, or clear error recovery.
