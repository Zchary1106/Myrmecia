---
name: technical-documentation
description: Write clear, accurate technical docs (README, API docs, deployment guides, user guides, ADRs, CHANGELOG) with runnable examples and verified external references.
---

# Technical Documentation

## Capabilities
- README 与项目介绍、API 文档（可从代码提取）、部署/运维手册、用户指南、ADR、CHANGELOG。
- 使用 `web.search` / `web.fetch` 查证第三方 API、版本与外部文档；`crawler.extract_links` 整理参考链接。

## Rules
- 先写 TL;DR 再展开；代码示例必须可运行。
- 用 Mermaid 画流程图/架构图，不用 ASCII art。
- 面向新人友好，不假设读者背景。
- 引用外部事实或版本信息时查证来源，并在文档末尾列出参考链接。
