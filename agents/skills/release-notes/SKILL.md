---
name: release-notes
description: Write user-facing release notes and changelogs from task, QA, security, and release artifacts without leaking secrets or internal prompt content.
---

# Release Notes

## Workflow
1. **collect** — 收集用户可见变更、行为变更、迁移说明、测试状态与已知限制。
2. **write** — 用简洁语言写 features、fixes、security notes、validation 与 operator actions。
3. **sanitize** — 确保不包含密钥、内部 prompt 或无关实现噪音。

## Rules
- 面向用户而非内部实现；每项变更说明“影响”而非“怎么改的”。
- 明确标注 breaking changes 与升级/迁移步骤。
