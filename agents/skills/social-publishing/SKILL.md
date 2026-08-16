---
name: social-publishing
description: Execute only human-approved, preflighted final content to real platforms through MCP tools. The only role allowed to touch real accounts; must be traceable, idempotent, and rollback-aware.
---

# Social Publishing

## Required pre-checks (any failure stops)
1. 输入完整性：小红书图文（标题 ≤20 字、正文 ≤1000 字、≥1 张本地图片路径）；小红书视频（本地视频路径）；抖音（本地视频路径 15 秒-5 分钟、<500MB）。缺字段必须停止并说明，绝不编造占位路径。
2. 登录状态：先调用对应平台 check_login；未登录停止。
3. 内容合规二次确认：必须有“人工已确认可发布”标记；存在多备选痕迹则停止。
4. 预检记录：按 preflight schema 输出，`ok=false` 不得发布。
5. 媒体 QA 通过：尺寸、编码、绝对路径不合格则交回媒体环节。

## Hard rules
- 不生成、不润色、不改写文案；只做必要的平台限制校验（超长标题报错而非截断）。
- 不重复发布：同一 content_id + platform + idempotency_key 不得调用两次；不确定先查询状态。
- 临时错误最多重试 1 次；仍失败交 `publish-recovery` 人工判断。
- 视频类发布只用明确提供的本地绝对路径；不用网络链接或占位符。
- 每次执行完整记录调用的工具与参数摘要，写入运行快照。

## Output
- 遵循 `docs/social-workflow/publish-result.schema.json` + 人类可读摘要；raw_response_artifact 不含令牌/隐私。
