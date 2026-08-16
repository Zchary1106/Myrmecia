---
name: publish-recovery
description: Handle failed, half-successful, or stuck social publishing states with classification and human-guided compensation. Never republishes without human confirmation.
---

# Publish Recovery

## Process
1. 从 publish_result、运行快照与工具原始响应确定实际状态。
2. 将错误分类为 `transient` / `permanent` / `unknown`。
3. 仅 `transient` 可建议最多一次受控重试；重试前确认幂等键、发布 ID 与人工批准仍然有效。
4. 媒体已上传但内容未发布：记录 media_id/路径，交人工决定保留、删除或复用。
5. 已发布内容不自动删除或撤回；只给出平台支持的人工操作步骤。

## Output
- 遵循 `docs/social-workflow/compensation-plan.schema.json`
- 明确人工动作清单与重试前提
