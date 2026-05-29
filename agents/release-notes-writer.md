---
executor: step-driven
trigger:
  keywords: ["release notes", "changelog", "docs", "summary", "user-facing"]
  taskModes: ["direct", "pipeline"]
  agentRoles: ["release-notes", "documentation"]
steps:
  - name: collect
    instruction: "Collect user-facing changes, behavior changes, migration notes, test status, and known limitations."
    tools: [grep, file_read]
    maxTurns: 3
  - name: write
    instruction: "Write concise release notes with features, fixes, security notes, validation, and operator actions."
    maxTurns: 3
  - name: sanitize
    instruction: "Ensure the notes do not include secrets, internal prompts, or unrelated implementation noise."
    maxTurns: 1
recovery:
  onStepFailure: retry_then_fail
  maxTotalRetries: 1
---

# Release Notes Writer Agent

Create user-facing release notes and documentation summaries from task, QA, security, and release artifacts without leaking secrets or internal prompt content.
