# T4 兼容与回滚方案

> 来源：`docs/architecture/agent-skill-domain-team-refactor.md`（T4、§5.4、§10）
> 状态：基线版本 2026-08-15

## 1. 原则

- 历史执行记录、历史 Pipeline、旧 Agent ID 永远可读。
- 新 Contract 带版本号，不静默改变旧数据含义。
- 先加兼容层，后隐藏，再经过观测期删除。
- 一切迁移默认 dry-run，输出影响报告。

## 2. Legacy Agent Alias 生命周期

| 阶段 | 行为 | 触发条件 |
|---|---|---|
| 1. add | 注册 `legacy-agent-aliases.yaml`，旧 ID 与新角色 + Skills 并存 | PR-B 落地 |
| 2. deprecate | API 返回 `deprecated: true` + `replacement`，前端提示迁移 | 新运行全部走 Resolver 后 |
| 3. hidden | Agent Directory 默认隐藏，保留在 “Legacy aliases” 折叠区 | 观测期无回归 |
| 4. delete | 删除旧配置与 alias | 至少保留两个小版本后，且无活跃运行 |

Alias 结构：

```yaml
legacyAgentAliases:
  xiaohongshu-writer:
    agentId: content-creator
    skills: [xiaohongshu-copywriting, hashtag-planning]
```

要求：

- 旧 Pipeline 与历史执行展示原始 Agent 名称。
- 新运行将旧 ID 解析为新角色 + Skill 快照。
- API 返回 `deprecated` 与 `replacement`。
- 至少保留两个小版本，不立即删除旧配置。

## 3. 数据迁移规则

| 数据 | 规则 |
|---|---|
| `executions` / `execution_ledger` | 保留原始 `agent_id`，不动历史行；新字段 `replacement` 仅在展示层补充 |
| `pipelines`（历史模板实例） | 读取时通过 alias 映射展示，不重写存储 |
| `team`（DB 自定义团队） | 读旧 `members`，写新 `roles`；两者并存，`members` 标记 deprecated |
| Skill 绑定 | `assignSkillVersionToAgent` 保留；新增 Team role slot 绑定为独立关系 |

## 4. 回滚条件与步骤

回滚触发条件（任一）：

- 构建 / 单测 / Dashboard 测试回归且无法 1 小时内修复。
- 新运行使用旧 ID 时解析失败（Resolver 抛错而非降级）。
- Preflight 误阻止正常任务（假阳性率异常）。
- 数据迁移 dry-run 报告非预期改动。

回滚步骤：

1. `git revert` 对应 PR，或切回 Feature Flag 关闭分支。
2. 关闭 `MYRMECIA_REFACTOR_V2=off` 后，API 回到 v1 路径，alias 层不再参与解析。
3. 校验历史执行、模板、团队列表与 Dashboard 首页正常。
4. 观察 24h 无回归后恢复发布。

## 5. Feature Flags

| Flag | 默认 | 作用 |
|---|---|---|
| `MYRMECIA_REFACTOR_V2` | off（分阶段开） | 开启 v2 Team/Pipeline 解析链 |
| `MYRMECIA_LEGACY_ALIAS` | on | 开启旧 ID alias 解析与 deprecation 标注 |
| `MYRMECIA_HIDE_LEGACY_AGENTS` | off | Agent Directory 隐藏 legacy Agent |
| `MYRMECIA_PREFLIGHT_ENFORCE` | off（先 warn） | Preflight 从报告升级为阻断启动 |

## 6. 偏差记录

- 本文档是方案 §5.4 / §10 的可执行落地版；若实现与方案冲突，以“不破坏历史数据与现有工作流”为优先，并在对应 PR 中记录偏差。
