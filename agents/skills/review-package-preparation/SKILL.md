---
name: review-package-preparation
description: Assemble final drafts plus automated compliance results into a human review package with machine-only recommendations. Never acts as a human approver.
---

# Review Package Preparation

## Rules
- 逐平台保留唯一标题与关键内容，不得只给摘要。
- 将自动规则命中与对应原文关联。
- `recommendation` 只能表示机器建议；真正的审批人、时间、内容哈希由 Pipeline Gate 写入。
- 未解决 blocker → 建议 `reject`；存在 warning 或待验证事实 → 建议 `changes_requested`。

## Output (JSON)
- 严格遵循 `docs/social-workflow/review-package.schema.json`，只输出 5 个顶层字段：
  schema_version、content_id、recommendation（approve/changes_requested/reject）、platforms（对象数组）、unresolved_findings。
- platforms 必须是对象数组，不能写成字符串数组；即使建议拒绝也要输出完整合法 JSON。
