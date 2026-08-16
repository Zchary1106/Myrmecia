# T2 引用扫描：Agent / Skill / Team / Pipeline / 前端硬编码盘点

> 来源：`docs/architecture/agent-skill-domain-team-refactor.md`（T2）
> 扫描日期：2026-08-15
> 扫描方式：对当前 checkout 执行 `rg` / `grep` / `awk` 静态扫描，未修改任何配置。

## 1. 扫描结论

- `agents/registry.yaml` 预置 **34 个 Agent**，其中 18 个属于"任务型/平台型"旧模型 Agent（目标转为 Skill + 稳定角色），7 个专业角色第一阶段保留，9 个为核心稳定角色。
- `agents/teams.yaml` 预置 **8 个 Team**，全部以 `members: [agentId...]` 表达，没有 `roles` / `skills` / `tools` / `domain` / `policy` 结构（v1）。
- `templates/*.yaml` 共 **15 个 Pipeline 模板**，stage 通过 `role:` 引用旧 Agent ID（如 `xiaohongshu-writer`、`social-publisher`）。
- Skill 来源有两处：`agents/*.md`（33 个，作为每个 Agent 的 `skillPath` 导入）和 `skills/<name>/SKILL.md`（6 个）。
- 前端硬编码集中在 `packages/dashboard/src/components/agents/ContentStudio.tsx`（按 `selectedAgentId` 分支 + 内置 stage `agentRole` 表）、`AgentWorkspace.tsx`、`Models.tsx`、`Pipelines.tsx`。
- Server 侧 Team 数据模型仍为 v1（`routes/teams.ts` 的 `teamSchema` 只有 `members`），没有 v2 字段。

## 2. Agent 清单（agents/registry.yaml，34 个）

### 2.1 核心稳定角色（9）— 目标模型中保留为 Agent

| id | 角色 | 说明 |
|---|---|---|
| master | orchestrator | 任务分解与调度 |
| pm | product-manager | 需求分析、PRD |
| ui | designer | UI/UX 设计 |
| dev | developer | 全栈开发 |
| qa | tester | 测试 |
| ops | devops | 运维 |
| review | reviewer | 审查 |
| issue-refiner | issue-refiner | Issue 精炼 |
| react-dashboard-auditor | react-dashboard-auditor | Dashboard 审计 |

### 2.2 专业角色（7）— 第一阶段暂不强制迁移（见方案 §4.3）

security-reviewer、architecture-planner、qa-automation、gitops-reviewer、release-compliance、accessibility-tester、performance-investigator。

### 2.3 任务型 / 平台型旧模型 Agent（18）— 目标转为 Skill + 稳定角色

| id | 目标归属 | 对应 Skill（计划） |
|---|---|---|
| wechat-writer | content-creator | wechat-longform-writing、wechat-html-layout |
| xiaohongshu-writer | content-creator | xiaohongshu-copywriting、hashtag-planning |
| xiaohongshu-visual-designer | ui | xiaohongshu-card-design、social-image-generation |
| douyin-writer | content-creator | douyin-hook-script、shot-list-design |
| trend-scout | researcher | social-trend-evidence、competitive-research |
| content-strategist | pm / content-creator | content-core-planning、cross-platform-adaptation |
| i18n | dev / review | localization-engineering |
| db-migration | dev / review | database-migration |
| api-design | architecture-planner / dev | api-contract-design |
| doc-writer | content-creator / review | technical-documentation |
| release-notes-writer | content-creator / ops | release-notes |
| social-compliance-reviewer | review | social-compliance |
| social-review-coordinator | Pipeline Gate | review-package-preparation |
| media-qa | qa | media-quality-check |
| social-preflight | ops / Gate | social-publish-preflight |
| social-publisher | ops + Tool | social-publishing |
| social-ops | ops | publish-recovery |
| social-analytics | researcher / pm | social-performance-analysis |

## 3. Team 清单（agents/teams.yaml，8 个，全部 v1）

| id | name | lead | members | template |
|---|---|---|---|---|
| feature | Feature Team | master | product-manager, designer, developer, tester, devops | Full Product |
| bugfix | Bugfix Team | master | issue-refiner, developer, tester, reviewer, gitops | Bugfix |
| quality | Quality Team | master | accessibility-tester, react-dashboard-auditor, performance-investigator, release-notes | Product Quality |
| release | Release & Security Team | master | issue-refiner, qa-automation, security-reviewer, gitops, release-compliance | Release Compliance |
| content | WeChat Content Team | master | product-manager, wechat-writer, reviewer | WeChat Article |
| xiaohongshu | Xiaohongshu Team | master | trend-scout, xiaohongshu-writer, social-compliance-reviewer, social-review-coordinator, xiaohongshu-visual-designer, media-qa, social-preflight, social-publisher | Xiaohongshu Publish |
| douyin | Douyin Video Team | master | trend-scout, douyin-writer, social-compliance-reviewer, social-review-coordinator, media-qa, social-preflight, social-publisher, social-ops, social-analytics | Douyin Video Publish |
| social-three-lanes | Social Three-Lane Team | master | trend-scout, content-strategist, douyin-writer, xiaohongshu-writer, wechat-writer, social-compliance-reviewer, social-review-coordinator, media-qa, social-preflight, social-publisher, social-ops, social-analytics | Social Content Three Lanes |

## 4. Pipeline 模板清单（templates/*.yaml，15 个）

bugfix、douyin-video-publish、feature-with-qa-loop、feature、full-product、gallery、parallel-feature、product-quality、qa-validation、release-compliance、social-content-three-lanes、structured-autonomy、wechat-article、xiaohongshu-douyin-crosspost、xiaohongshu-note、xiaohongshu-publish。

### 4.1 stage `role:` 引用频率（旧 Agent ID 依赖面）

| role | 出现次数 | 涉及模板 |
|---|---|---|
| xiaohongshu-writer | 6 | xiaohongshu-*、social-content-three-lanes |
| wechat-writer | 5 | wechat-article、social-content-three-lanes |
| social-publisher | 5 | 各社媒模板 |
| trend-scout | 4 | 各社媒模板 |
| qa / pm / dev / qa-automation | 4 次左右 | 工程模板 |
| social-review-coordinator / social-preflight / social-compliance-reviewer / media-qa | 3 次左右 | 社媒模板 |
| douyin-writer / xiaohongshu-visual-designer / social-ops / social-analytics | 2 次左右 | 社媒模板 |
| content-strategist | 1 | social-content-three-lanes |

> 结论：社媒链路 stage 强依赖旧 Agent ID；直接删除旧 Agent 会破坏 5 个模板。必须先实现 alias 兼容层。

## 5. Skill 来源盘点

### 5.1 `agents/*.md`（33 个，随 Agent 导入为 Skill，sourcePath=`agents/<id>.md`）

与 registry 中 34 个 Agent 一一对应（`release-notes` 与 `release-notes-writer` 名称差异需核对），由 `packages/server/src/skills/skill-registry.ts::syncBuiltinSkills` 导入数据库并 `assignSkillVersionToAgent`。

### 5.2 `skills/<name>/SKILL.md`（6 个，独立 Skill 目录）

- cross-platform-content-core
- douyin-hot-video-writer
- social-trend-evidence
- wechat-depth-writer
- xiaohongshu-save-first-writer
- xiaohongshu-visual-creator

## 6. 前端硬编码引用（T18 的改造目标）

| 文件 | 位置 | 硬编码内容 |
|---|---|---|
| packages/dashboard/src/components/agents/ContentStudio.tsx | L14–L59 | 内置 workflow 定义中的 `agentRole`（trend-scout、xiaohongshu-writer、social-publisher 等） |
| 同上 | L63、L72、L81、L262–L264 | `selectedAgentId === 'wechat-writer' / 'xiaohongshu-writer' / 'douyin-writer'` 分支切换 UI |
| 同上 | L120–L136 | `roles.includes('xiaohongshu-writer')` 等组合判断 |
| 同上 | L349、L358、L366 | `agentRole === 'social-publisher'` 发布判断 |
| packages/dashboard/src/components/agents/AgentWorkspace.tsx | L8–L9 | `contentAgentIds` / `contentStudioAgentIds` Set |
| packages/dashboard/src/pages/Models.tsx | L25–L27 | `role:wechat-writer` 等模型路由标签 |
| packages/dashboard/src/pages/Pipelines.tsx | L15、L40 | `agentRole === 'social-publisher'` 发布确认逻辑 |

## 7. Server 侧引用

| 文件 | 说明 |
|---|---|
| packages/server/src/routes/teams.ts | `teamSchema` 仅支持 `members`（v1），无 v2 字段 |
| packages/server/src/agents/team-registry.ts | `Team.members: string[]`，`resolveTeamAgents` 按角色解析 |
| packages/server/src/contracts/team-composer-contracts.ts | 仅有 `schemaVersion: '1.0'` 的 Agent/Artifact/Workflow 验证器 |
| packages/server/src/routes/agents.ts | `GET /api/agents` 直接返回 DB 中全部 Agent，无 legacy/deprecation 标记 |
| packages/server/src/db/models/skill.ts | Skill 与 Agent 绑定为 `assignSkillVersionToAgent`，无 Team role slot 绑定 |

## 8. 建议

1. 从 T3（Contract v2）与 T5（Legacy Alias）开始，不动 Registry 内容。
2. `agents/legacy-agent-aliases.yaml` 覆盖 §2.3 全部 18 个旧 ID。
3. Content Studio 的固定分支（§6）在 T18 前不要单独修改，避免与 v2 Contract 双写。
4. 模板 stage `role:` 在 alias 层先做映射，保留原文件不动。
