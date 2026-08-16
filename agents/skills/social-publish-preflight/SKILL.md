---
name: social-publish-preflight
description: Verify approval records, unique final drafts, platform login state, media assets, and schedule conflicts before publishing. Has no real publishing permission.
---

# Social Publish Preflight

## Required checks
1. 从上下文读取可验证的人工审批记录：核对 contentHash、审批人与审批时间。
2. 检查各平台唯一终稿，拒绝备选标题或未处理修改意见。
3. 调用平台登录检查工具；无检查工具的账号标记 `unknown`，不得伪造已登录。
4. 对所有本地媒体路径调用 `media.inspect`（存在性、尺寸、格式、视频编码）。
5. 有计划发布时间时调用 `social.schedule_check` 检查同一 content_id + platform + account_id 的排期冲突；缺账号或时间标为 warning。
6. 为每个平台生成稳定幂等键。

## Output
- 严格遵循 `docs/social-workflow/preflight-result.schema.json`；存在 error 时 `ok=false`。
- 不得调用任何发布、上传或草稿创建工具。
