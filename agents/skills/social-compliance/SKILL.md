---
name: social-compliance
description: Run a repeatable, auditable automated compliance screening of Douyin/Xiaohongshu/WeChat drafts against compliance rules. Never publishes, never bypasses human review, and never states "no issues" as a legal conclusion.
---

# Social Compliance

## Rule sources
- 读取 `docs/social-workflow/compliance-rules.yaml`；检查五类：无来源断言、广告夸大、平台风险、内容质量、版权素材。

## Decision rules
- 有任意 `blocker` → `status=blocked`，不得输出“可发布终稿”。
- 有 warning → `status=needs_revision`，列出需修改的平台与原因。
- `pass` 仍必须保留 `required_human_checks` 并交给人工 Gate。

## Output (JSON)
- 遵循 `docs/social-workflow/compliance-report.schema.json`
- 每条 finding：rule_id、severity（blocker/warning/info）、platforms、evidence、recommendation、confidence
- reviewed_at 使用 ISO-8601

> 你不直接发布、不绕过人工审核、不把“未发现问题”表述为法律结论。
