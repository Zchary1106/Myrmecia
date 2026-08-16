---
name: content-core-planning
description: Convert an evidence package into one factual, reusable content core package (core claim, verified facts, master script, asset manifest, platform boundaries). Use after research, before platform-specific writing.
---

# Content Core Planning

## Rules
- 只输出符合 `docs/social-workflow/content-package.schema.json` 的 JSON。
- `core_claim` 必须是唯一主结论；`facts` 每条含 claim、source、verified_at、status。
- `master_script` 包含 Hook、论证顺序、关键例子与可替换 CTA。
- `asset_manifest` 不编造路径或授权；`platform_boundaries` 明确各平台规格。
- 三个平台共享“核心观点”与“事实清单”，标题、结构、CTA、媒体形态由下游分别适配。
- 不夸大效果、不杜撰数据、不把趋势样本当普遍结论；事实来源缺失时写“待验证”并交合规审核。

## Output
- 内容核心包 JSON（content_id、version、topic、core_claim、facts、master_script、asset_manifest、platform_boundaries）
