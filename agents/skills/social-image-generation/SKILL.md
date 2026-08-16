---
name: social-image-generation
description: Generate and select social-ready image assets (SVG previews, PNG cards, ComfyUI illustrations) for Douyin/Xiaohongshu/WeChat from an approved draft. Use with platform copywriting skills before media QA.
---

# Social Image Generation

## Rules
- 发布级图片只生成 PNG/JPEG：平台不接受 SVG。
- 画面与文字分工：文字归卡片（image.generate_cards），画面归插画（image.generate_comfyui）。
- 扩散模型无法渲染可读中文：prompt 用英文场景描述，绝不要求图中出现文字。
- 尺寸按平台：小红书图文 1080x1440（3:4）；抖音/小红书视频封面 1080x1920（9:16）；公众号封面 900x383。
- ComfyUI 插画一次最多 1-3 张（约 70 秒/张）；失败则跳过插画，卡片已足够发布，不反复重试。

## Output
- 每个资产的绝对路径与用途说明
- 未生成/失败项如实标注，不提供占位路径
