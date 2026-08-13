# Team Composer Runtime

第二阶段把第一阶段的静态 Contract 接入可恢复的 DAG Runtime。

## 节点状态机

```text
pending
  -> ready
  -> running
  -> done

running
  -> retrying -> running
  -> waiting_approval
  -> failed

waiting_approval
  -> done
  -> retrying
  -> failed
```

所有状态变更必须经过 `transitionWorkflowNode`。非法回退会被拒绝。

## Artifact 数据流

每个完成节点将输出转换为 `ArtifactContract`：

- 自动生成 SHA-256 和 lineage；
- 写入当前 `runState.artifacts`；
- 节点只记录 `artifactIds`；
- 下游只接收边上声明的 `artifactMappings`；
- 没有声明输出的旧 Workflow 自动生成 `result` Artifact。

这避免了把所有上游聊天记录直接拼接给下游 Agent。

## Quality Gate

### Agent Gate

`kind: gate` 且配置 `agentRole`：

- 启动独立 QA Agent；
- 只向 QA 提供声明的 Artifact；
- Prompt 明确禁止依赖隐藏对话和上游结论。

### Automatic Gate

`kind: gate` 且没有 `agentId` / `agentRole`：

- 不启动模型；
- 使用 `qualityGate.outputSchema` 验证上游 Artifact；
- 成功后自动继续，失败进入重试或人工接管。

## 重试与人工接管

```yaml
retryPolicy:
  maxAttempts: 2
  backoffMs: 1000
  onExhausted: human
```

达到最大次数后，`onExhausted: human` 会把节点置为
`waiting_approval`，Workflow 置为 `waiting`。

控制 API：

```text
POST /api/v1/graph-workflows/:id/nodes/:nodeId/retry
POST /api/v1/graph-workflows/:id/nodes/:nodeId/approve
POST /api/v1/graph-workflows/:id/nodes/:nodeId/reject
GET  /api/v1/graph-workflows/:id/artifacts
```

## Team Template Version

Team 的 Workflow Graph 以不可变版本保存：

```text
draft -> published -> archived
```

同一个 Team 和 Workspace 同时只能有一个 published 版本。修改已发布
Workflow 时必须创建新版本。

```text
GET  /api/v1/teams/:id/versions
POST /api/v1/teams/:id/versions
POST /api/v1/teams/:id/versions/:versionId/publish
POST /api/v1/teams/:id/versions/:versionId/archive
POST /api/v1/teams/:id/instantiate
```
