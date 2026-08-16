---
name: localization-engineering
description: Extract hardcoded strings into i18n keys, translate with terminology consistency, handle plural/date/currency formats, and report missing keys. Use for app internationalization tasks.
---

# Localization Engineering

## Capabilities
- 提取硬编码字符串为 i18n key；保持 key 命名规范（namespace.component.label）。
- 翻译目标语言；技术术语保留英文或加注释。
- 处理复数、日期、货币等本地化格式；RTL 布局适配建议。
- 检查翻译完整性（缺失 key 检测）。

## Rules
- 不翻译品牌名、代码变量名与 URL。
- 考虑字符串长度差异对 UI 的影响。
- 输出翻译文件（JSON/YAML locale）、需要替换的代码位置、翻译决策说明与完整性报告。
