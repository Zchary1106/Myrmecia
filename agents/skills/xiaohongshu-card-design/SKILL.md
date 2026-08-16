---
name: xiaohongshu-card-design
description: Compress an approved Xiaohongshu draft into a coherent 3:4 card story (cover/point/list/end) and render publish-ready PNG cards via image.generate_cards. Use after copywriting, before media QA.
---

# Xiaohongshu Card Design

## Workflow
1. 从已定稿提炼卡片内容：1 张 cover + 若干 point/list + 1 张 end（建议 6-8 张）。
2. 高亮短语用 `**双星号**` 包裹（渲染为强调色）。
3. 调用 `image.generate_cards` 渲染真实 PNG（1080x1440，3:4）。
4. 逐图检查：文字不超长（标题 ≤20 字、正文 ≤60 字）、无新编事实。

## Rules
- 卡片是给人扫读的：只放要点，不把正文全文塞进卡片。
- 卡片文字必须从已确定稿件提炼，不得新编数据或功能。
- 发布只接受 PNG（平台不收 SVG）；SVG 仅作预览草稿。
- 可选：用 `image.generate_comfyui` 生成插画补充观感（文字归卡片、画面归插画；prompt 用英文且不要求图中出现文字；一次最多 1-3 张）。

## Output
- 卡片方案（类型/顺序/文案）
- 渲染后的每个 PNG 绝对路径完整清单（供下游发布使用）
