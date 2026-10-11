---
goal: "Myrmecia Agent Runtime V2：可组合 Loop、可重建上下文与安全持久执行"
version: "2.0"
date_created: "2026-10-07"
last_updated: "2026-10-07"
owner: "Myrmecia maintainers"
status: "Implemented and locally accepted; rollout remains opt-in"
tags: ["refactor", "agent-runtime", "context", "recovery", "verification"]
---

# Introduction

![Status: Locally accepted](https://img.shields.io/badge/status-Locally_accepted-green)

这份计划修复上一轮与 Pi / DeepSeek Harness 源码对照中识别的八类差距，并补齐任务级验收和预算边界。采用渐进重构：保留自研 Runtime、现有 Provider、MCP、Skill、Domain、Team 和 Workflow，不整套替换框架。

用户已于 2026-10-07 批准从阶段 0 开始完整实施。阶段 0–7 的本地实现与验收已完成；真实账户也通过两项只读模型 smoke。下表的 Yes 是对应本地能力已验证，不等于所有 Provider/MCP、SDK resume、部署和发布都已验收。V2 保持显式 opt-in。完整证据和残余边界见 `artifacts/agent-runtime-v2/verification.md`。

## Refactor Plan: Myrmecia Agent Runtime V2

### Current State

代码基线为 `/Users/yadongzhai/MyWork/agent-factory`，分支 `codex/release-readiness-e2e`，HEAD `ee30d76f4520035655d95e1ecdb516541622a74f`。2026-10-07 的工作区含已实现但未提交的 CrewAI 移除改动；实施时必须以当前工作区为基线，不能回退到 HEAD 覆盖这些改动。

现有能力与差距：

| 问题 | 已有能力 | 要修复的具体缺口 | 阶段 |
| --- | --- | --- | --- |
| Core 与业务耦合 | RuntimeAdapter、ExecutionMiddlewareChain、MCP 和插件 | `TsAgentLoop` 同时负责模型循环、数据库、领域知识、研究策略、工具和恢复；缺少薄的单轮扩展契约 | 1 |
| Provider 语义不统一 | OpenAI-compatible 与官方 Copilot SDK | Copilot 一次 `sendAndWait` 可含内部多轮；外层请求次数不能等同于模型轮次，能力和停止原因需显式表达 | 1、5 |
| 会话无法从单一历史精确重建 | SQLite 消息、ledger、工具记录、checkpoint | Loop 仍以可变 `messages[]` 为主；缺少规范事件源、纯投影和请求快照关联 | 3 |
| 压缩丢关键上下文 | `compactMessages`；独立 `buildContextBudgetPlan` | 分层预算只有测试调用，尚未进入真实 Loop；旧摘要按行截断，缺少稳定约束和证据保留 | 2 |
| 中途修改与下轮追问混用 | 持久化 `agent_messages`、主输入框 | `drain` 一次消费全部待处理消息，没有持久 claim/apply/ack 边界；SDK 内部边界不可假定 | 3 |
| 工具调度串行且无通用冲突模型 | allowed tools、middleware、MCP 策略、write journal | 缺少只读有界并发、写操作排他、资源锁和原子预算预留 | 4 |
| 恢复不是统一持久执行 | 同 fingerprint 的只读稳定 checkpoint，未知写入阻断 | 缺少统一 owner lease/fencing、真实 Provider 会话延续、持续任务切片；日预算仍有进程内计数 | 5 |
| 执行世界边界不明确 | 路径检查、shell 策略、guardian、sandbox profile | TS 工具仍在宿主执行；`EXECUTOR_MODE=docker` 不等于 TS 工具容器隔离 | 6 |

补充缺口：`validateAgentOutput` 不等于任务成功验证；普通 TS 执行片段目前最多 600,000 ms；默认 Harness runner 不调用真实模型。阶段 5、7 处理这些平台问题，不通过替换 Loop 宣称解决。

### Target State

三层职责明确：

1. **Agent Core**：单轮模型请求、规范化内容/事件、上下文转换、工具批次和停止判定；通过注入接口工作，不直接依赖数据库、路由或小红书业务。
2. **Runtime Harness**：提供会话事件、上下文、Provider、工具策略、预算、运行切片和恢复适配；声明不支持的能力。
3. **Control Plane / Workbench**：任务分配、Team/Workflow、owner/wakeup、产物、验证、人类验收和现有聊天界面。

先完成阶段 0–2，得到可验证的运行基础；阶段 3–5 补持久性和吞吐；阶段 6 是可选隔离后端，未具备平台支持时明确阻断；阶段 7 完成任务验收及真实集成证据。

## 1. Requirements & Constraints

- **REQ-001**: 薄 Core 支持 `prepareRequest`、`transformContext`、`beforeToolCall`、`afterToolCall`、`finishTurn`、`prepareNextTurn` 注入点。hook 顺序固定，错误和取消语义可测试；现有治理检查不能被 hook 跳过。
- **REQ-002**: Provider 契约独立于 OpenAI SDK 类型，区分 `host_loop` 与 `provider_loop`。分别记录外层 request count、可观测 model turn count、tool call count 和 usage；不可观测数值为 `null`，不是伪造的 1 或 0。
- **REQ-003**: 请求上下文保护系统约束、任务目标、用户补充、未解决问题和失败证据；工具输出通过受控摘要和 artifact 引用压缩，不提升为系统指令。input context window、累计执行 token 预算和 output reserve 分开计算。
- **REQ-004**: 新会话事件 append-only、workspace scoped；模型请求与 UI 分别从事件投影。可以无副作用重建历史，但不能把 replay 理解为重新执行工具。旧会话仍可读取，迁移不能捏造历史事件。
- **REQ-005**: Inbox 区分 `steer` 与 `follow_up`。状态为 `pending → claimed → applied → acknowledged`；终止或失效时为 `rejected` 并保留原因。只在 Provider 声明支持的边界应用消息，主输入框保持唯一。
- **REQ-006**: 工具默认保守串行。仅显式可信只读分类允许有界并发；未知、外部写、发布、删除和 shell 默认排他。调度、取消、预算和副作用结果必须一致。
- **REQ-007**: 运行 ownership、预算、inbox 和恢复指针持久化；过期 owner 的迟到结果不能修改新 owner 或已终止任务。未知外部副作用只做 reconciliation，不自动重放。
- **REQ-008**: Sandbox 明确报告文件系统、进程、网络、凭证边界分别是否 enforced。要求隔离但后端不可用时返回 `SANDBOX_UNAVAILABLE`；不能悄悄回落到宿主。
- **REQ-009**: 区分输出完整、模型结束、确定性任务验证通过、集成验证和用户验收；完成证据必须关联预定义 criterion 与 artifact/hash。测试数量不等于真实 Agent 成功率。
- **SEC-001**: 保留 allowed tools、审批、DLP、workspace 校验、读后写门禁、write-once journal 和终态 fencing；未知副作用不得因重构而变成可重试。
- **SEC-002**: 不记录 token/cookie/环境变量全文、原始凭证或隐藏推理；规范日志仅存 DLP 检查后的必要正文、安全元数据和 artifact 引用。不可安全重建的请求标记不可自动恢复。
- **CON-001**: 保留当前未提交改动、会话、任务、知识、别名和历史证据；新增迁移必须 additive、幂等并经过旧数据库副本测试。禁止 reset、破坏性 down-migration 和清空用户队列。
- **CON-002**: 不恢复 Python/CrewAI，不替换现有认证或 Provider，不安装新框架，不修改 WorkAgent 仓库；提交、推送、PR、合并、打包和真实发布不属于本计划实施授权。
- **CON-003**: 不自动修改或恢复既有 WorkAgent task `myrmecia-agent-control-plane-v1-20261007`。它的 12 项验收标准仍有效；其中 AC01 的 TS/Python 表述需单独批准后修订后续执行契约，不能静默重写历史。
- **GUD-001**: 每个阶段单独交付、验证、记录证据；依赖未满足则不启动后继任务。同一阶段无显式依赖的任务可独立实施，但本计划不要求多 Agent 执行。
- **PAT-001**: 使用现有 `ExecutionMiddlewareChain`、`transitionAgentRun`、`runWriteOnce`、artifact indexer 和 ledger 作为安全适配参考，不复制一套彼此竞争的状态机。

## 2. Implementation Steps

### Execution Plan

以下新增路径、函数和配置是明确的实施设计，不是对当前已实现能力的描述。`Completed = No` 表示尚未实施。每阶段包含验收门槛；失败时先修复当前阶段，不能用后续功能掩盖失败。

### Implementation Phase 0 — 回归基线与契约对齐

- **GOAL-001**: 固化当前 dirty-worktree 基线、影响图及控制平面复用边界，建立可重复的无真实副作用测试。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | 新建 `artifacts/agent-runtime-v2/baseline.md`：记录 HEAD、branch、dirty path 列表、脱敏 diff 指纹、各验证命令/cwd/exitCode；运行本计划最终验证命令中的非 E2E 项。此次重新验证 server 805 passed / 1 skipped，dashboard 157 passed，10 条命令 exit 0；保留 28 条 legacy-inferred 警告。恢复副本/指纹及命令日志见 baseline.json 和 baseline.md。 | Yes | 2026-10-07 |
| TASK-002 | 新建 scripted transports 与生产入口基线测试，覆盖聊天、host/SDK 工具、Skill、MCP timeout、取消/迟到、预算及截断；阶段 0 共 33 项定向回归通过。WorkAgent 交付被 Review 拒绝后由 Codex 本地回退实现，失败任务没有 Completion；最终阶段 1 全量回归亦通过。 | Yes | 2026-10-07 |
| TASK-003 | 已新增 `docs/AGENT-RUNTIME-V2.md`，区分现有/计划能力、能力边界及控制平面 AC01–AC12 的复用范围。旧 JSON 保留 12 项标准和原 TS/Python 历史表述。检查不存在竞争的 ownership/budget 服务；后续阶段继续复核。依赖 TASK-001。 | Yes | 2026-10-07 |

验收：当前源码回归无失败；新 fixtures 对两种 Provider 语义分别断言；基线报告注明 skipped、真实集成未验证和所有预存改动；代码影响图通过实施前复核。

### Implementation Phase 1 — 统一 Provider 契约与薄 Agent Core

- **GOAL-002**: 拆出可测试的循环内核，保留现有入口和业务治理。依赖 GOAL-001。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-004 | 统一 protocol/types 已实现并导出，schemaVersion=1，含身份/sequence、内容、能力和 nullable metrics；shared build 与 Provider/Core 契约测试通过。 | Yes | 2026-10-07 |
| TASK-005 | ProviderDriver 与 gateway capability API 已实现；真实 SDK 生产入口通过 scripted transport 验证。未知成本/usage/内部 turn 保持 null，拒绝未支持 media，diagnostic 不暴露异常正文。依赖 TASK-004；阶段 1 全量检查通过。 | Yes | 2026-10-07 |
| TASK-006 | 薄 Core/types/hooks 已实现，无 DB/业务/SDK import；标准 normalized loop 与增量 governed-turn adapter 共存，请求 preparation/transform 和取消门禁统一。6 项 Core 测试及全量回归通过。 | Yes | 2026-10-07 |
| TASK-007 | 普通/Skill 轮次边界接入 Core，普通/Skill/总结请求接入 requestModel 适配；领域、治理和工具业务保留 Harness-owned。V2 true/false parity、真实 TS→SDK 两次工具回调及 metrics 通过；V2 默认暂关闭。阶段 1 server 831 passed/1 skipped、dashboard 157 passed、10 项验证全部 exit 0；见 phase1 报告。 | Yes | 2026-10-07 |

验收：全部 baseline fixtures 输出与 stop reason 不变；治理拦截仍生效；Core 依赖扫描无 DB/业务 import；Copilot 未暴露的内部 model turn 为 unknown；不能对所有 provider 宣称图片、思考流或内部 steering 支持。

### Implementation Phase 2 — 接通真实分层上下文预算

- **GOAL-003**: 让现有分层预算进入每个实际模型请求路径，并保留可追溯证据。依赖 GOAL-002。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-008 | 已接入 buildRequestContext/buildContextBudgetPlan，分别计算模型窗口、累计余量、output reserve 和 schema；完整轮次动态缩减、protected facts 超限安全停止。内部注入 provenance 避免合并约束被重复识别为用户新指令。分层预算/50 轮生产 Loop 测试及阶段 2 全量检查通过。 | Yes | 2026-10-07 |
| TASK-009 | context-state 已实现目标/约束/失败证据恢复及版本化摘要、历史工具全量 artifact 引用；文件读写仅依据已完成工具执行，不把请求或失败写入视作已改文件。失败证据保留为低优先级历史数据，非系统/用户新指令。相关 unit/integration 和全量回归通过。 | Yes | 2026-10-07 |
| TASK-010 | 普通、Skill、Skill 总结三处预算与 Core transformContext 均已接通；V2 context window 与 task allowance 分离，legacy export/关闭开关保留。生产入口 spy、50 次模型/工具回合与追问压缩测试通过。阶段 2 server 842 passed/1 skipped、dashboard 157 passed，10 项验证 exit 0。 | Yes | 2026-10-07 |

验收：50-turn fixture 中目标/约束/未解问题/失败证据仍在请求上下文；无孤立 tool result；工具 schema 和回复 reserve 计入预算；同一输入 deterministic；超大不可压缩约束安全停止；普通、Skill、总结三条路径覆盖齐全。Provider 估算 token 与真实 usage 分开记录。

### Implementation Phase 3 — Canonical Session Log 与 Durable Inbox

- **GOAL-004**: 可从规范历史重建模型上下文和 UI，并让追问消费可恢复。依赖 GOAL-003。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-011 | 在 `db/schema.sql`、`db/database.ts` 增加 `agent_session_events`，字段含 schema_version、workspace_id、session_id、sequence、event_id、run_id、request_id、type、payload、created_at；唯一键 `(workspace_id,session_id,sequence)` 和 event_id。新建 `db/models/agent-session-event.ts` 的 `appendSessionEvent`、`listSessionEvents`，事务内分配 sequence 并去重。DLP/size guard 沿用 checkpoint 原则。 | Yes (local acceptance) | 2026-10-07 UTC |
| TASK-012 | 新建 `agents/session-projector.ts` 的纯函数 `deriveModelMessages`、`deriveConversationView`。记录上下文 summary/ref、工具 schema 指纹、请求配置指纹、usage/stop 与产物关联；摘要不是覆盖原始历史。历史会话采用 legacy read adapter，仅从切换时刻记录新事件，不伪造过去 tool/model events。新 session 的请求不再以独立可变数组为 authority。依赖 TASK-011。 | Yes (local acceptance) | 2026-10-07 UTC |
| TASK-013 | 扩展 `message-bus.ts` 和 additive inbox 表：新增 `claimInbox`、`applyInbox`、`ackInbox`、`rejectInbox`；消息有 idempotencyKey、mode、目标 session、claim lease、applied event/request ref。应用记录与 context event 同事务提交，恢复不会重复追加。已发生模型请求但结果未知时标明 delivery uncertain，不伪称模型已处理。依赖 TASK-011。 | Yes (local acceptance) | 2026-10-07 UTC |
| TASK-014 | 修改 `routes/executions.ts` 现有 follow-up handler、`dashboard/src/lib/api.ts`、`TaskSession.tsx`、conversation store 和 `execution-messages.ts`：主输入框选择“调整当前任务/完成后继续”，展示 pending/applied/rejected 与实际 Agent。SDK 不支持内部安全 steering 时显示“下个可用边界应用”；不要声称立即打断。刷新按 sequence 重放并去重，工具卡仍默认折叠。依赖 TASK-012、TASK-013。 | Yes (local acceptance) | 2026-10-07 UTC |

验收：同一日志重复投影结果一致；delta/重复事件不会重复消息；crash 在 claim/application/ack 各位置均不丢失指令或重复上下文追加；workspace 越权失败；历史聊天/附件/Markdown 保留；浏览器发送两种消息并刷新能看到真实状态，不用 mock 截图代替真实后端验收。

### Implementation Phase 4 — 安全有界工具调度

- **GOAL-005**: 增加只读吞吐，不放宽权限或副作用约束。依赖 GOAL-002、GOAL-004。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-015 | 新建 `agents/core/tool-scheduler.ts` 的 `classifyToolEffect`、`scheduleToolBatch`。分类 read/write/unknown；默认 concurrency=1，显式配置 `MYRMECIA_TOOL_READ_CONCURRENCY` 可设 1–4，推荐试运行 2。unknown/write 为 barrier；工具 input/metadata/schema 的分类依据记入日志。MCP 默认每 server 并发 1，只有可信配置显式允许才放开。 | Yes (local acceptance) | 2026-10-07 UTC |
| TASK-016 | 修改 `tool-registry.ts`、`tools/mcp-tools.ts`、`ExecutionMiddlewareChain.beforeToolCall` 适配器，提供资源键和可信 classification。调度后权限重新核对；分类升级为写/unknown 时冻结后继批次并排空活动只读；不得把任意 shell 命令自动视为只读。依赖 TASK-015。 | Yes (local acceptance) | 2026-10-07 UTC |
| TASK-017 | 修改 Core 工具 dispatch、`runWriteOnce` 调用适配与 `tool-execution.ts`：dispatch 前原子预留 call/time/token 配额，取消停止新 dispatch，保留已派发未知结果。模型上下文按原 tool-call 次序呈现，真实开始/完成按事件次序记录。Copilot 原生内部批次无法接管时 capability=false，host scheduler 不伪接入。依赖 TASK-016。 | Yes (local acceptance) | 2026-10-07 UTC |

验收：4 个各 100 ms 的假只读工具、并发 2 时 fake clock 执行 200 ms 而非 400 ms；活动数量不超过配置；write barrier、同资源冲突、动态升级、MCP 限制、取消和剩余 quota 都通过；未知写不可重放；默认串行与旧行为一致。

### Implementation Phase 5 — Durable Run、Provider Session 与持久预算

- **GOAL-006**: 补齐安全持续执行与持久治理，复用控制平面同一套 authority。依赖 GOAL-004、GOAL-005。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-018 | 新建或复用 `db/models/run-ownership.ts`、`agents/run-coordinator.ts`，实现 `claimRun`、`renewRunLease`、`commitRunEvent`、`reconcileInterruptedRun`。默认 lease=60 s、heartbeat=20 s；递增 fencing token，所有状态/事件/checkpoint 提交验证 owner/token。接入 `queue/task-queue.ts` 与 `agent-runtime.ts`，不另起与控制平面竞争的 worker。 | Yes (local acceptance) | 2026-10-07 UTC |
| TASK-019 | 扩展 `loop-checkpoint.ts` 记录 journal cursor、fingerprint、剩余预算、pending request/provider session ref；仅 stable read-only boundary 自动恢复。`CopilotProvider` 按锁定 SDK 的实际接口探测 resume 能力，支持时以 workspace/conversation/agent/provider/config fingerprint 为 session key 保存延续引用；不支持时明确 fresh execution。换模型/改权限/终态不得复用旧身份或 session。依赖 TASK-018。 | Yes (local acceptance) | 2026-10-07 UTC |
| TASK-020 | 新建或复用 `db/models/budget-policy.ts`、`budget-reservation.ts` 与 `agents/budget-service.ts` 的 `reserveBudget`、`settleUsage`，替换 `safety-guardrails.ts` 的 cost enforcement authority；沿用 ledger。workspace/agent/task scope、UTC 持久 period、reservation 和 request/event 去重；exact/estimated/subscription/unavailable 独立。未知 cost 不写 0，配置硬 USD cap 且无法可靠预留时返回 `BUDGET_UNCERTAIN` 阻断；订阅默认走 token/tool/time limits。 | Yes (local acceptance) | 2026-10-07 UTC |
| TASK-021 | 在 `runtime-limits.ts`、`run-coordinator.ts` 增加显式 bounded continuation：单片仍 ≤600,000 ms，任务累计上限默认沿用现配置；仅允许显式配置更长任务上限。切片结束持久 checkpoint/wakeup、重新检查 owner/预算/副作用，再调度下一片；不通过取消所有 deadline 实现长任务。重启后累计 elapsed/token/usage 不重置。依赖 TASK-019、TASK-020。 | Yes (local acceptance) | 2026-10-07 UTC |

验收：两个 worker 同时 claim 只有一个 dispatch；过期 lease 后旧 token 提交被拒；模型响应/工具写后的各 crash 点均有明确恢复/unknown outcome；预算重启不重置、累计 usage 不重复扣费；fake clock 多切片遵守累计 deadline；真实 Redis 测试只针对专门隔离实例，不能清空用户队列。

### Implementation Phase 6 — 显式执行世界与可选隔离后端

- **GOAL-007**: 把策略检查和真实隔离分开，新增后端无法 enforcement 时 fail closed。依赖 GOAL-005、GOAL-006。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-022 | 新建 `agents/execution-world.ts` 的 `ExecutionWorld`、`ExecutionWorldCapabilities`、`resolveExecutionWorld`，适配 `tool-sandbox.ts` 与 `sandbox-profile.ts`。模式 `host_policy` 保持兼容，但明确 fs/process/network/credentials isolation 不存在；不能把设置名当作 enforcement 证明。 | Yes (local acceptance) | 2026-10-07 UTC |
| TASK-023 | 新建 `agents/execution-world-worker.ts` 与 `docker-world.ts`，实现可选 `docker_isolated`。受控 workspace/scratch 挂载、read-only rootfs、non-root、drop capabilities、no-new-privileges、CPU/memory/PID 限额；默认 network none、无 Docker socket、无宿主 env/cookie 凭证继承。宿主 MCP/远端工具单独标记不受容器边界保护。无可用 Docker 后端则明确 unavailable，不安装/启动 Docker 或静默宿主执行。依赖 TASK-022。 | Yes (local acceptance) | 2026-10-07 UTC |
| TASK-024 | 扩展 `plugins/sandbox.ts`、`routes/executions.ts`、`TaskSession.tsx` 显示 capability/diagnostic；新增 execution-world 契约测试及隔离集成脚本。对无法限制的 Windows/macOS/第三方远端能力写明支持矩阵；只有 escape/network/credential denial 实测通过的组合才标记 enforced。依赖 TASK-023。 | Yes (local acceptance) | 2026-10-07 UTC |

验收：离线 fake backend 证明要求隔离但 unavailable 时阻断；可用真实容器中 workspace 外读取、symlink escape、网络和凭证继承拒绝；取消/超时回收子进程；host mode 的命名/说明真实。没有实际 Docker 测试时，本阶段只能报告契约测试通过，隔离能力不得标记已验收。

### Implementation Phase 7 — Criterion-linked Completion 与综合验收

- **GOAL-008**: 让“完成”关联可验证结果，提供离线、浏览器和真实集成分开的证据。依赖 GOAL-003–GOAL-006；沙箱验收仅对已通过 GOAL-007 的组合开放。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-025 | 扩展 `shared/src/agent-run.ts`、`server/src/agents/run-state.ts` 并新建 `agents/completion-gate.ts` 的 `verifyCompletionCriteria`。criteria 来源为提交时的任务契约，不由执行模型自定；每项有 verifier、scope、evidence ref/hash、passed/failed/unavailable。保留 `validateAgentOutput` 为 output integrity，不把它当 outcome verification。无 criteria 的普通聊天保留回答完成状态，同时显式 outcome verification=not_requested。 | Yes (local acceptance) | 2026-10-07 UTC |
| TASK-026 | 接入 `agent-runtime.ts`、`external-agent-runtime.ts`、`graph-workflow.ts` 与 `routes/executions.ts` acceptance handler：工具/模型结束后执行批准的有界 verifier；不满足 mandatory criteria 不进入“任务已验证”，用户 acceptance 仍独立且不能自动 accepted。超时/权限不足为 unavailable；partial output 仍展示但不伪称成功。依赖 TASK-025。 | Yes (local acceptance) | 2026-10-07 UTC |
| TASK-027 | 扩展 `testing/harness-eval.ts`，新增 `testing/runtime-benchmark.ts` 的 `runRuntimeBenchmark` 和版本化 fixture matrix：至少覆盖长上下文、多工具冲突、steering、follow-up、崩溃恢复、预算、unknown writes、MCP timeout、附件、跨 workspace、产物和验收拒绝。报告 runner mode、model/provider version、input fingerprint、stop、criterion results、nullable cost、token/time 和人工介入。live runner 只使用现有账户且显式启用，不发布社交内容。依赖 TASK-026。 | Yes (local acceptance) | 2026-10-07 UTC |
| TASK-028 | 更新 `TaskSession.tsx`、相关 store/消息投影、`README.md`、`docs/ARCHITECTURE.md` 和 `docs/AGENT-RUNTIME-V2.md`；新增 E2E 验收场景：同会话追问、Agent 身份、刷新恢复、Markdown/附件、折叠工具、等待原因、产物验证/接受/拒绝。运行最终验证命令，保存 `artifacts/agent-runtime-v2/verification.md` 与 criteria-linked report，列明缺失的真实集成。依赖 TASK-014、TASK-021、TASK-027。 | Yes (local acceptance) | 2026-10-07 UTC |

验收：离线 mandatory cases 全通过；模型声称“完成”但缺 artifact/criterion 的 fixture 必须被拒；原聊天不因缺 criteria 被错误阻断；真实 UI 操作和截图通过；真实模型/MCP/Provider resume/容器测试分别注明是否执行。没有 live evidence 不得写“真实 Agent 验收全部通过”。

### Rollback Plan

实施收尾记录：服务端 925 passed / 5 skipped，前端 158 passed，最终十项测试/构建/契约检查 exit 0；常规浏览器 66 passed / 5 skipped，独立真实后端浏览器 5 passed；专用 Redis 3 passed（含实际容器重启与切片 jobId），Docker 5 passed（含 2 项真实隔离/取消场景）；12 类 fixture matrix 全通过。Copilot / claude-haiku-4.5 的真实聊天与文件读取 2/2 通过，内层 model turns 与订阅美元成本仍为 unknown/null。MCP 真实读调用、真实 SDK resume 和其他平台隔离仍未验证。原控制平面任务契约与失败 WorkAgent 历史没有被改写。

1. 实施前为当前工作区建立不覆盖原改动的恢复点，记录用户预存 diff 指纹；不执行 `git reset --hard` 或 `git checkout --`。
2. 新 Core/投影切换前保留兼容入口；新增 `MYRMECIA_RUNTIME_V2=false` 默认关闭，仅在隔离 fixture/测试环境启用。业务入口转 Core 后完成 parity gate 才改变默认值。
3. 阶段 2 压缩失败时仅在旧路径仍满足预算和安全约束时回退；不可压缩 protected facts 超限必须停止，不能降级为静默丢约束。
4. 阶段 3 新 session 固定记录 projectionVersion；rollback 对新日志提供版本化 reader，不能重新拼接不一致的旧 messages。保留新事件表，回滚到最后一个具备 reader 的实现。
5. 阶段 4 出错将只读 concurrency 设回 1；未知写入保持 sealed，不能靠再次调用“修复”。
6. 阶段 5 出错暂停新 dispatch，保留 claim/reservation/journal，先 reconcile；已启用持久预算的 workspace 不能回落到进程计数。禁用自动恢复可用既有 `MYRMECIA_DURABLE_RESUME=false`。
7. 阶段 6 失败保留 `SANDBOX_UNAVAILABLE`；只有用户显式选择 host_policy 才可宿主执行，不能自动回落。
8. 数据库不做 destructive down-migration。生产迁移先在脱敏副本进行备份/恢复演练；本计划不授权操作真实部署数据库。

## 3. Alternatives

- **ALT-001**: 整套迁移到 Pi。暂不采用：现有业务治理和官方 Copilot SDK 能力需重新接通；Pi Core 本身不替代任务验收、外部副作用治理或 sandbox。
- **ALT-002**: 整套迁移到 DeepSeek Harness。暂不采用：插件/session 模型迁移范围过大；本阶段借鉴规范日志、Inbox 和 bounded scheduler，保持现有 API。
- **ALT-003**: 直接拆大文件加 `Promise.all`。不采用：文件拆分不能解决 Provider 边界、预算原子性、排他写和未知副作用。
- **ALT-004**: 无限放宽 runtime deadline。拒绝：持续任务需要持久切片、累计预算和安全恢复，不是永不停止的单进程。
- **ALT-005**: 新建第二套控制平面。拒绝：ownership、预算、common protocol、workbench 复用已有计划，Projects/Goals/Routines 留在原 epic，不重复实现。

## 4. Dependencies

- **DEP-001**: 阶段依赖为 0→1→2→3→4→5；6 依赖 4/5，7 的基础验收依赖 2–5。6 的真实隔离验证不阻塞基础聊天验收，但阻塞“sandbox enforced”交付声明。
- **DEP-002**: 保持现有 pnpm、TypeScript、Vitest、SQLite、OpenAI-compatible client 与 `@github/copilot-sdk` 1.0.9。SDK 的 session resume、内部轮次/stream/steering 必须在实施时检查锁定接口；不为满足计划擅自换 Provider 或升级依赖。
- **DEP-003**: 原控制平面 AC01/AC02/AC03 与阶段 1/5/7 共用 runtime contract；AC04/AC05 与阶段 5 共用 ownership/wakeup；AC06/AC07 与阶段 5 共用 budget ledger；AC08 与阶段 3/7 共用 workbench。AC09/AC10 的 Projects/Goals/Routines 不属于这份 Loop 计划。AC11/AC12 仍需原任务完整证据，不能由本计划代为宣称完成。
- **DEP-004**: 真实 Provider/MCP 验收依赖现有有效登录；真实 Redis 依赖专用隔离实例；真实容器验收依赖可用受控后端。缺失时报告 unavailable，不请求用户粘贴密钥、不启动真实发布任务。
- **DEP-005**: 此处实现服务的范围是 Myrmecia。WorkAgent 是独立开发执行器；后续委托必须用户确认且分阶段建契约，不静默重用失败大任务或改变其历史标准。

## 5. Files

### Context Map

### Affected Files / Files to Modify

| File | Change Type | Dependencies / Purpose |
| --- | --- | --- |
| `packages/shared/src/runtime-protocol.ts`、`index.ts`、`agent-run.ts` | create/modify | 版本化 Provider/event/capability 和 verification 契约；先于所有 consumer |
| `packages/server/src/agents/core/{types,hooks,loop,tool-scheduler}.ts` | create | 薄 Core；只依赖注入契约，不依赖数据库或领域业务 |
| `packages/server/src/models/{provider-driver,gateway,copilot-provider}.ts` | create/modify | Provider 能力、事件、计数、实际支持的 session continuity |
| `packages/server/src/agents/{ts-agent-loop,agent-runtime,runtime-adapter,external-agent-runtime}.ts` | modify | 保留外层 lifecycle、adapter 优先级和执行治理 |
| `packages/server/src/agents/{context-compactor,execution-context}.ts`、`context-state.ts` | modify/create | 主 loop/Skill/总结三条实际请求链的上下文预算和 artifact 引用 |
| `packages/server/src/agents/{message-bus,session-projector}.ts` | modify/create | durable inbox 与纯模型/UI 投影 |
| `packages/server/src/db/{database.ts,schema.sql}`、`db/models/{agent-session-event,run-ownership,budget-policy,budget-reservation}.ts` | modify/create | additive journal、claim/fencing 和持久预算；复用已有同职责服务 |
| `packages/server/src/agents/{loop-checkpoint,run-state,safety-guardrails,runtime-limits}.ts`、`run-coordinator.ts`、`budget-service.ts` | modify/create | 安全恢复、计数不重置、运行切片 |
| `packages/server/src/tools/{tool-registry,mcp-tools,tool-execution,write-once}.ts`、`agents/execution-middleware.ts` | modify | 工具 effect classification、权限复查、配额预留、写入安全 |
| `packages/server/src/agents/{execution-world,execution-world-worker,docker-world}.ts`、`sandbox-profile.ts`、`skills/tool-sandbox.ts`、`plugins/sandbox.ts` | create/modify | 宿主 policy 与可选隔离后端分离，明确能力边界 |
| `packages/server/src/agents/completion-gate.ts`、`graph-workflow.ts`、`queue/task-queue.ts`、`routes/executions.ts` | create/modify | 统一 claim、follow-up 和 criterion-linked 验证 |
| `packages/dashboard/src/components/session/TaskSession.tsx`、`lib/api.ts`、`lib/execution-messages.ts`、`stores/conversations.ts` | modify | 沿用主输入框、真实身份、状态、Markdown、产物和验收 |
| `packages/server/src/testing/{harness-eval,runtime-benchmark}.ts`、`packages/server/tests/`、`packages/dashboard/tests/`、`packages/dashboard/e2e/` | modify/create | 合约、回归、重启、隔离和浏览器验证 |
| `docs/AGENT-RUNTIME-V2.md`、`docs/ARCHITECTURE.md`、`README.md`、`artifacts/agent-runtime-v2/` | create/modify | 兼容矩阵、已实现行为、验证证据和限制 |

### Dependencies (may need updates)

| File | Relationship |
| --- | --- |
| `packages/server/src/agents/agent-prompt.ts`、`domain-context.ts`、`research-budget.ts`、`research-evidence.ts` | 当前由大 Loop 引用；移至 Harness 的注入层，业务规则不可丢失 |
| `packages/server/src/memory/runtime-knowledge-bridge.ts`、`artifacts/execution-artifact-indexer.ts` | 知识/附件与 artifact 进入请求投影，保持来源和 workspace |
| `packages/server/src/db/models/execution-ledger.ts`、`audit/execution-audit.ts` | 已有审计/账本保留；session log 只承担模型/UI 的规范历史，不取代财务审计 |
| `packages/server/src/agents/team-coordinator.ts`、`graph-workflow.ts`、`workers/external-agent-scheduler.ts` | 控制平面接入 common runtime/claims；不在这里扩建 Team 或 Routines 产品 |
| `packages/server/src/events/event-bus.ts`、`event-recorder.ts` | 只负责通知与既有记录，不能冒充 canonical model history；持久写成功后发通知 |
| `packages/shared/src/conversation-policy.ts`、`server/src/db/models/conversation.ts` | archive/delete/restore 保持权限与终态规则，不能因 session 新表绕过生命周期 |

### Test Files

| Test | Coverage |
| --- | --- |
| `packages/server/tests/runtime-adapter.test.ts`、`agent-runtime-contract.test.ts`、`runtime-boundaries.test.ts` | TS/扩展优先级、CrewAI 退役错误、Provider 差异 |
| `packages/server/tests/ts-agent-loop-completion.test.ts`、`agent-run-state.test.ts`、`execution-middleware.test.ts` | 停止/输出、终态 fence、治理拦截 |
| `packages/server/tests/context-compactor.test.ts`、`src/agents/context-compactor.budget.test.ts`、新增 context integration tests | clean turn 边界、protected facts、实际请求路径 |
| `packages/server/tests/message-bus.test.ts`、`conversations.test.ts`、新增 session/inbox tests | durable consume、纯投影、旧历史及权限 |
| `packages/server/tests/loop-checkpoint.test.ts`、`task-queue.test.ts`、新增 ownership/budget tests | fingerprint、unknown writes、双 worker、restart 不重置 |
| `packages/server/tests/copilot-budget.test.ts`、`research-budget.test.ts`、`mcp-timeout.test.ts`、`mcp-cancellation.test.ts` | 订阅/未知计费、MCP 与预算 deadline |
| `packages/server/tests/tool-runtime.test.ts`、`sandbox-profile.test.ts`、`plugin-sandbox.test.ts`、新增 scheduler/world tests | 工具合约、权限、排他/并行、隔离 |
| `packages/server/tests/execution-acceptance.test.ts`、`execution-artifacts.test.ts`、`harness-eval.test.ts` | criterion/evidence、产物与人工验收、fixture/live 区分 |
| `packages/dashboard/tests/session-history.test.tsx`、`session-markdown.test.tsx`、`execution-messages.test.ts` | replay、Markdown、事件卡去重和状态 |
| `packages/dashboard/e2e/session-composer.spec.ts`、`session-history.spec.ts`、`agent-run.spec.ts`、新增 runtime-v2 spec | 同会话操作、刷新、身份、等待和验收 |

### Reference Patterns

| File | Pattern |
| --- | --- |
| `packages/server/src/agents/execution-middleware.ts` | 保留读后写、loop detection、工具前后治理 |
| `packages/server/src/agents/loop-checkpoint.ts`、`tools/write-once.ts` | DLP/size guard、安全恢复、未知外部副作用阻断 |
| `packages/server/src/agents/context-compactor.ts` | 复用分层预算实现，不再建另一个同功能 helper |
| `packages/server/src/agents/run-state.ts`、`routes/executions.ts` | 终态单调性、用户 acceptance 独立 |
| `packages/server/src/db/models/conversation.ts` | scoped 生命周期、事务内校验和历史保留 |

### Risk Assessment

- 公共 API：保留现有字段，增加版本与能力；弃用只能在 parity 和消费者迁移后执行。
- 数据库：需要 additive migration、唯一键和版本化 reader；不删除历史。
- 配置：新增 concurrency、V2 switch 和 execution-world；旧默认不变，隔离请求不得自动降级。
- 副作用：所有自动回归使用 fake transports、临时数据库和独立端口；真实社交发布不在验证范围。

- **FILE-001**: 上述 Files to Modify 表为计划影响集合，不是当前 changed-files 清单；实施前以 `rg --files` 和 imports 再核对。
- **FILE-002**: 编制计划时仅新增本计划；实施变更以 `artifacts/agent-runtime-v2/` 中逐阶段报告为准。历史 task JSON 和用户预存改动保持独立，不混为本计划交付。

## 6. Testing

- **TEST-001**: Provider contract 与 hook parity：同一 scripted fixture 分别跑现有路径和新 Core，断言文本、stop、usage、权限和真实可观测轮次；不要求两种 Provider 的内部运行次数相同。
- **TEST-002**: 上下文：50-turn、超大 tool output、超大 protected facts、附件/summary refs、多模态 unsupported case；assert 三条 live request preparation 路径调用预算，不只测 helper。
- **TEST-003**: canonical history/inbox：duplicate、乱序网络投递、分页/刷新、旧会话、跨 workspace、claim/apply/ack crash 和 SDK 不支持的 boundary。
- **TEST-004**: 调度：读并发、排他写、资源冲突、MCP 单 server、权限重新检查、classification 升级、取消和原子 quota；使用 fake clock，不用抖动的 wall-clock 性能断言。
- **TEST-005**: durability/budget：两 worker、多进程重启、过期 owner fence、fingerprint 变化、迟到结果、unknown writes、重复/cumulative usage、UTC period 跨日、持续切片和累计预算。
- **TEST-006**: execution world：fake backend 契约与真实隔离测试分开，覆盖不可用、path/symlink escape、网络/凭证、资源限制和取消清理。
- **TEST-007**: completion：missing/hash-mismatch artifact、模型虚假完成、mandatory verifier failed/unavailable、普通聊天无 criteria、用户重复 acceptance 幂等性。
- **TEST-008**: 浏览器：隔离后端启动后的真实操作、页面刷新、Markdown/附件、steer/follow-up 状态、Agent 标识、工具折叠、产物和验收；保存截图/事件关联。mock E2E 只证明渲染契约，不能替代真实服务链路。
- **TEST-009**: live benchmark 为显式 opt-in；每个结果带输入/模型配置和 evidence refs，fixture/live 不混算成功率。未执行真实调用就报告未验证。

### Final validation command

每条命令分别捕获退出码并遇错停止；不得用忽略前一命令失败的拼接提交。以下命令在仓库根目录执行，不能使用用户 runtime 数据库做 tests。

```sh
pnpm --filter @myrmecia/shared build
pnpm --filter @myrmecia/server test
pnpm --filter @myrmecia/dashboard test
pnpm --filter @myrmecia/server build
pnpm --filter @myrmecia/dashboard build
pnpm --filter @myrmecia/desktop exec tsc --noEmit
pnpm validate:contracts
pnpm validate:pipelines
pnpm validate:social-workflow
E2E_API_PORT=3300 E2E_DASHBOARD_PORT=5273 pnpm --filter @myrmecia/dashboard test:e2e
git diff --check
```

E2E 前确认独立端口可用、测试 DB 隔离，并核对 Playwright config 的服务器复用行为。真实 Redis/容器/Provider/MCP 验收不是上述命令默认承诺的结果，分别记录。源码/build、fixtures、真实浏览器、真实集成、远程 CI、push/merge 是不同状态。

## 7. Risks & Assumptions

- **RISK-001**: Core 提取可能漏掉 research/发布权限/Skill 业务分支。先有 fixtures 和治理 parity，逐个路径迁移，禁止大文件一次性改写。
- **RISK-002**: Copilot SDK 内部 loop 不接受宿主相同边界。以 capability probe 和真实接口为准；不支持则延迟消息并明确提示，不模拟 resume。
- **RISK-003**: 新 journal 与原执行 ledger/数据库 records 双写可能不一致。session append、projection cursor、inbox application 和 claim 提交使用同 DB 事务；跨外部系统无法事务化时明确 unknown。
- **RISK-004**: 内容脱敏可能破坏精确上下文恢复。保留 source/hash 与不恢复标记；不能为了可重建而存秘密或隐藏推理。
- **RISK-005**: 工具 metadata 错标只读会导致副作用。未知默认排他，可信 allowlist、参数复核、MCP server limit 和写 journal 共同防护。
- **RISK-006**: hard budget 有在途/延迟 usage 风险。dispatch 前预留，unknown 计费明确阻断或走已批准的非 USD 限额；不承诺外部供应商账单严格零超额。
- **RISK-007**: 规范日志是单一请求历史，不是万能 exactly-once。远端接口缺幂等键/查询 API 时只能人工 reconciliation。
- **RISK-008**: 新 DB migrations 和 consumer 兼容存在版本风险。先测试旧副本，保留 reader 和 additive schema，回滚不能删除新历史。
- **RISK-009**: Docker 可选后端不是所有工具的统一 sandbox。远程 MCP、宿主浏览器、第三方服务另有边界；平台无法 enforcement 时明确拒绝。
- **RISK-010**: 原控制平面 epic 与此计划重复实施。TASK-003 是前置 gate；共用服务先查存在性，不修改原持久 Task Contract 或声称补齐其所有 AC。
- **ASSUMPTION-001**: 用户选择保留自研 TS Runtime 和现有产品内容；借鉴结构，不强制引入 Pi/DeepSeek Harness 运行依赖。
- **ASSUMPTION-002**: 当前源码中的 CrewAI 移除继续保留；其验证报告是历史局部回归，后续 Core 重构需重新验证。
- **ASSUMPTION-003**: 用户已批准完整实施，按阶段依赖从 0 开始推进；未验证任务保持 No。授权不包含提交/推送/发布。
- **ASSUMPTION-004**: 打包/签名/Windows 安装验收按用户此前方向暂不纳入；桌面类型检查仅用于防止共享契约回归，不代表打包验收。

## 8. Related Specifications / Further Reading

- 本仓库 `plan/agent-runtime-hardening-20261006.md`：已有 run-state、checkpoint、MCP 和 acceptance 安全边界；文中的 Python 说明以后续移除记录为准。
- 本仓库 `plan/implementation-agent-control-plane-v1.md`、`plan/agent-control-plane-v1.task.json`：五项控制平面目标及 12 项验收标准，保持原记录不变。
- 本仓库 `plan/remove-crewai-runtime-20261007.md`、`artifacts/remove-crewai-verification-20261007.md`：TS-only 内置运行时基线和已验证/未验证范围。
- Pi 参考源码快照：repository `earendil-works/pi`，commit `592fb57b70e34a7f1011f3d7f20b556dce17c321`。参考 `packages/agent/src/agent-loop.ts`、`types.ts`、`packages/coding-agent/src/core/compaction/compaction.ts`、`session-manager.ts`，以及独立 `packages/durable/README.md`。Core 与 durable package 的职责不可混称。
- DeepSeek Harness 参考源码快照：repository `deepseek-ai/deepseek-harness`，commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。参考 `packages/core/agent-loop/src/{agent,inbox,tool-calls}.ts`、`packages/core/session/README.md`、`packages/shell/bash-sandbox/README.md`。仅作为先前源码分析的固定快照，不宣称始终为远程最新版本。
- 外部参考没有加入依赖，没有在本轮安装/执行；工程验收以 Myrmecia 当前实现和证据为准。
