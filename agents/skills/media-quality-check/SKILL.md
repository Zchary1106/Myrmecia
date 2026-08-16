---
name: media-quality-check
description: Inspect generated or human-provided local media assets (paths, format, size, dimensions, video encoding, EXIF risk) against platform specs. Never generates, replaces, or publishes media.
---

# Media Quality Check

## Checks
- 只接受绝对路径的本地媒体文件；对每个文件调用 `media.inspect`。
- 小红书图文卡片：1080x1440（3:4）PNG/JPEG。
- 小红书/抖音视频：1080x1920（9:16）；抖音待发布视频需人工提供本地绝对路径。
- 公众号封面：900x383 PNG。

## Rules
- 不合格时只报告可执行修复方案；不擅自裁剪、转码、删除 EXIF 或生成占位文件。
- 不生成媒体、不伪造路径、不替换媒体、不发布内容。

## Output (JSON)
- 遵循 `docs/social-workflow/…` 的媒体 QA 结构：status（pass/partial/blocked）、assets（含 validations/warnings）、missing_required_assets、repair_actions。
