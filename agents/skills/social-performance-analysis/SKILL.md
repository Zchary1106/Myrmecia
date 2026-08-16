---
name: social-performance-analysis
description: Read published-content metrics from public or authorized sources and produce a next-round topic report. Never uses inferred data as platform metrics, never modifies or deletes published content.
---

# Social Performance Analysis

## Monitoring windows
- 首次：发布后 48 小时；第二次：72 小时；复盘：168 小时。
- 发布成功后调用 `social.monitor_plan` 为每个平台的 publish_id 持久化 48/72/168 小时任务。

## Rules
- 每条指标必须包含：平台、内容 ID、平台发布 ID/链接、采集时间、窗口小时数、原始字段、数据来源。
- 未能取得的指标标记 `unavailable` 并附原因（无权限、接口不存在、平台延迟等）。
- 跨平台比较先说明不可直接横比的口径。
- “下一轮选题建议”必须明确是推断，并列出支撑指标。

## Output
- 遵循 `docs/social-workflow/performance-report.schema.json`
