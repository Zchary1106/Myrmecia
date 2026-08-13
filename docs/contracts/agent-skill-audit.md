# Agent / Skill 第一阶段盘点

盘点日期：2026-08-13

当前注册表包含 34 个 Agent。第一阶段先建立契约和职责边界，不立即删除或合并 Agent，
避免影响现有 Team 和 Workflow。

## 建议保留为稳定责任角色

| 类型 | Agent |
|---|---|
| 编排 | `master` |
| 产品与设计 | `pm`、`ui` |
| 工程执行 | `dev`、`ops` |
| 独立质量 | `qa`、`review`、`security-reviewer` |
| 内容上游 | `trend-scout`、`content-strategist` |
| 社媒质量与交付 | `social-review-coordinator`、`media-qa`、`social-preflight`、`social-publisher`、`social-ops`、`social-analytics` |

这些角色拥有独立责任、独立放行权或高风险工具权限，不应仅作为 Prompt 片段存在。

## 后续更适合作为 Skill / Domain Pack

| 当前 Agent | 建议归属 |
|---|---|
| `api-design` | `dev` / `architecture-planner` + API Design Skill |
| `db-migration` | `dev` + DB Migration Skill |
| `i18n` | `dev` / `qa` + i18n Skill |
| `doc-writer` | `dev` / `release-notes-writer` + Documentation Skill |
| `accessibility-tester` | `qa` + Accessibility Skill |
| `react-dashboard-auditor` | `review` + React Dashboard Skill |
| `performance-investigator` | `review` / `dev` + Performance Skill |
| `release-notes-writer` | `ops` / `review` + Release Notes Skill |

后续迁移时保留兼容 Agent ID，内部转发到“核心 Agent + Skill”，避免破坏已有模板。

## 内容生产线建议

`wechat-writer`、`xiaohongshu-writer`、`xiaohongshu-visual-designer` 和
`douyin-writer` 当前可以继续作为独立 Workflow 节点，因为三条生产线的产物和质量标准不同。

第四阶段再评估是否统一为：

```text
Content Writer Agent
+ Xiaohongshu Writing Skill
+ Douyin Video Skill
+ WeChat Long-form Skill
```

即使底层 Agent 合并，Workflow 中仍保留三个独立生产节点，避免重新捆绑三种平台内容。

## 当前迁移状态

- 显式 Contract：`master`、`pm`、`dev`、`qa`、`review`、`social-publisher`。
- 其余 Agent：由兼容层生成 Contract。
- 下一轮：为高风险与独立 QA Agent 补齐显式 Contract。

