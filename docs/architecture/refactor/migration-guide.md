# Myrmecia Agent / Skill / Domain / Team 重构 — 用户升级指南

> 适用版本：重构 Phase 0–4（T1～T18）合入后的 `main`。
> 对应方案：`docs/architecture/agent-skill-domain-team-refactor.md`。

## 1. 这次改了什么

- **Agent 是稳定执行角色**：`researcher`（研究）、`content-creator`（内容创作）等通用角色替代任务型 Agent；业务能力由 `agents/skills/<skill-id>/SKILL.md` 提供。
- **Team Contract v2**：Team 现在可以声明 `roles`（槽位：slot / agentId / skills / tools / domainIds）、`policy.requireHumanApprovalBefore` 和 `domainIds`。四个内容 Team（content / xiaohongshu / douyin / social-three-lanes）已升级。
- **Domain Pack 产品化**：支持 `version` / `versionNote` 版本锁定、复制（`/domains/:id/copy`）、检索预览（`/domains/:id/test`）和安全删除（被 Team/任务引用时返回 409）。
- **Content Studio 由 Team 驱动**：新增平台只需在 `packages/dashboard/src/components/agents/contentStudioProfiles.ts` 增加一条配置 + Team 的 Skills。
- **Execution Plan Snapshot**：每次 v2 运行会把不可变的能力/配置快照写入 Execution Ledger（`type = plan.snapshot`），供审计与重放。

## 2. 兼容性

- **旧 Agent ID 仍然可运行**：`agents/legacy-agent-aliases.yaml`（18 条）把旧 ID 映射到“稳定角色 + Skills + Tools”，API 返回 `legacy: { deprecated, replacement }`。
- **旧 Team（仅 members）仍然可用**：Team v2 校验允许 `members` 或 `roles` 至少其一；未指定 `lead` 时默认取首个 role slot。
- **旧 Pipeline / 历史执行记录不会被修改**：迁移只做 alias 解析和快照记录，不改写历史数据。
- **默认不隐藏 legacy Agent**：`MYRMECIA_HIDE_LEGACY_AGENTS=true` 开启后 `/api/agents` 默认过滤 legacy，前端 Agent 页面仍通过 “Legacy aliases” 折叠区展示。

## 3. 升级步骤

1. 备份数据库（SQLite 单文件，直接复制即可）。
2. 启动服务，自动应用迁移：
   - `202608160001_domain_pack_versioning`（domain_packs 增加 `version` / `version_note`）
   - `202608160002_team_definitions_v2`（team_definitions 增加 `roles` / `policy` / `domain_ids` / `contract_version`）
3. 运行迁移影响评估（只读，不写库）：

   ```bash
   node packages/server/scripts/refactor-migration-dry-run.mjs --out /tmp/impact.json
   # 或指定数据库
   DB_PATH=/path/to/agent-factory.db node packages/server/scripts/refactor-migration-dry-run.mjs
   ```

   报告包含：legacy Agent 在 tasks / pipelines 中的引用、Team v1 待迁移清单、built-in Team v2 覆盖、Domain 版本化状态、Execution Ledger 快照数量。

4. 按报告决定是否需要把 v1 Team 升级为 v2（Dashboard Teams → 编辑 → 添加 role slots，或直接改 `agents/teams.yaml`）。
5. 无回归后再开启隐藏：设置 `MYRMECIA_HIDE_LEGACY_AGENTS=true`。

## 4. 回滚

- 代码回滚到上一个发布版本即可；两个 DB 迁移是**增量加列**，回滚代码不要求删除列。
- 旧代码不会读取新列，`roles` / `policy` / `domain_ids` 为空时行为等同 v1。
- 已生成的 `plan.snapshot` 记录保留在 Execution Ledger（append-only），不影响旧执行路径。

## 5. 常用 Feature Flag

| Flag | 作用 | 默认 |
|---|---|---|
| `MYRMECIA_HIDE_LEGACY_AGENTS` | `/api/agents` 默认隐藏 legacy Agent | 关（false） |
| `MYRMECIA_PREFLIGHT_ENFORCE` | 启动时对所有 v2 Team 执行 Preflight，发现 error 即拒绝启动 | 关（false） |
| `MCP_SERVERS` | 接入平台 MCP 服务器（xiaohongshu / douyin-upload / douyin-search 等） | 空 |

## 6. 已验证

- Server 单测：83 文件 / 549 用例。
- Dashboard 单测：6 文件 / 73 用例；e2e 覆盖 Team v2 Preflight、Legacy aliases、Content Studio Team 切换。
- CI：`lint-and-build` / `test-server` / `test-dashboard` / `e2e` / `desktop-stage`。
