# Team Composer Contracts

第一阶段通过三个契约把“Agent 直接聊天”改造成“Agent 通过结构化产物协作”。

## 1. Agent Contract

定义一个 Agent **负责什么、不负责什么、接收什么、产出什么以及如何判断完成**。

核心字段：

- `responsibility.owns`：Agent 的责任边界。
- `responsibility.doesNotOwn`：必须拒绝或升级的工作。
- `inputs` / `outputs`：结构化 Artifact 声明。
- `skills` / `tools`：能力与执行权限分离。
- `quality.definitionOfDone`：进入下一节点前必须满足的条件。

旧 Agent 不需要立即迁移。运行时会从 `role`、`capabilities`、`skill` 和
`allowed_tools` 生成兼容契约；显式契约始终优先。

## 2. Artifact Contract

Artifact 是 Agent 间的主要数据交换单位。它包含：

- 类型、Schema 和 MIME 信息；
- URI 或内联内容；
- 生产 Agent、Workflow、Node 和 Run；
- 上游 Artifact lineage；
- SHA-256 完整性信息。

Artifact 不等同于聊天消息。聊天用于协商，Artifact 用于驱动下一阶段执行和验收。

## 3. Workflow Contract

Workflow 使用 DAG 表达：

- `nodes`：Agent、Gate、人工审批或 Publisher。
- `edges`：数据、控制、审批或重试关系。
- `artifactMappings`：明确上游哪个输出连接到下游哪个输入。

保存与运行前必须拒绝：

- 重复节点或边 ID；
- 指向不存在节点的边；
- 自环或 DAG 循环；
- 引用了未声明输入/输出的 Artifact mapping。

## 验证

```bash
pnpm validate:contracts
```

验证内容包括：

1. `agents/registry.yaml` 中的所有 Agent Contract；
2. Agent ID、role 与显式 Contract 是否一致；
3. `templates/*.yaml` 的依赖索引与循环；
4. Workflow 中声明的输入输出 Artifact。

## 兼容策略

- 不修改现有数据库表结构。
- Agent Contract 暂存于现有 `AgentConfig.contract`。
- 旧 Pipeline Template 可以继续运行。
- 新增 `inputs`、`outputs`、`required_skills` 字段只提供结构化元数据，不改变第一阶段执行语义。

## 第二阶段 Runtime

节点状态机、Artifact 数据流、Schema Gate、重试、人工接管和 Team Template
版本管理参见 [runtime-orchestration.md](runtime-orchestration.md)。
