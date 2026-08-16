---
name: wechat-html-layout
description: Convert approved WeChat article Markdown into editor-paste-ready HTML blocks with mobile-friendly typography, section dividers, and safe inline styling. Use with wechat-longform-writing before draft sync.
---

# WeChat HTML Layout

## Layout rules
- 段落用 `<p>`，小标题用 `<h3>`（公众号编辑器常用样式可接受内联 style）。
- 关键句用 `<strong>` 高亮；emoji 只作视觉引导，不堆砌。
- 每 300 字左右插入分割线或小标题，避免长文本墙。
- 引用与来源用列表/引用块呈现，保持可追溯。
- 不嵌入外部脚本、跟踪像素或站外资源。

## Output
- 可直接粘贴进公众号编辑器的 HTML 块
- 对应 Markdown 正文（保持同源，便于校对）
- 若使用 `content.wechat_layout` 工具，校验输出后再交付

> 排版块只用于草稿同步，不承担发布动作。
