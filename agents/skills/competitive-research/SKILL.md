---
name: competitive-research
description: Sample competitors and content gaps on Douyin, Xiaohongshu, and WeChat with auditable evidence, deduplication, and source labels. Use after topic framing, before content-core planning.
---

# Competitive Research

## Rules
- 每个平台至少 5 个去重样本；按标题、作者、链接去重；不足必须报告样本量。
- 每条证据输出：平台、标题、作者/账号、链接或来源、采集时间、互动字段原值、关键词、观察结论。
- 区分“原始数据”“推断”“未知/缺失”；禁止编造互动数字。
- 抖音用 `mcp__douyin-search__search_videos` / `get_homefeed`（≤8 次调用，不重复检索同一关键词）；小红书用 `web.search` 公开页面并说明非站内全量。
- 采样窗口默认近 30 天，可扩至 90 天并标注原因。
- 说明限流、登录、DLP 或公开信息缺失等限制。

## Output
- 竞品/同质化内容清单（含证据字段）
- 内容缺口与差异化机会
- 数据限制与可信度说明
