---
goal: "Myrmecia 产品定位、真实交付体验与项目内验收改造"
version: "1.3"
date_created: "2026-09-15"
last_updated: "2026-09-16"
owner: "Myrmecia 维护者"
status: "In progress"
tags: ["design", "positioning", "onboarding", "documentation", "agent-teams", "product-acceptance"]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In_progress-yellow)

**建议保留 Myrmecia 品牌名，收窄首页叙事：从“功能全面的 Agent Ops 平台”，转向“能看清 AI 团队如何完成任务的自托管工作台”。**

本方案只覆盖 Myrmecia 本身：标题与文案、README 信息结构、外部 Agent 能力矩阵、真实交付案例、产品内首次体验、浏览器验收和 E2E。当前不执行用户访谈、外部传播或增长实验；它不是重写产品架构的方案，也不以增加 Agent 数量或堆叠功能作为目标。

**核心问题：Myrmecia 当前是否能清楚、稳定、可核验地完成一个 Agent 团队任务？** 先用项目内真实任务、交互状态、产物和测试证明工作台价值；不以改标题、换封面、页面能打开或 Agent 自报成功作为完成证据。

### v1.3 修订范围

- 只改造和验证 Myrmecia，不修改其他个人项目。
- 保留品牌和描述型标题，增加“协调 Agent、检查实际交付”的待验证卖点。
- JSON→CSV 保留为工程冒烟案例；增加真实仓库缺陷修复案例和单 Agent 对照。
- 新增零安装 Demo、真实任务、产品内 Home、Task Session、结果验收和恢复状态的项目内验收矩阵。
- TASK-013～TASK-018 保持原 ID，但用户访谈、独立发布和增长验证整体移至 On Hold，不阻塞当前项目交付。
- 将外部 CLI 进程取消与重启恢复保留为独立加固轨道；当前项目验收默认使用内置 TypeScript Runtime，不被未采用的外部适配器阻塞。
- 新增 TASK-019，将产品内 Home 首次体验纳入 onboarding，不再只改 README 与 Banner。
- 新增 TASK-020～TASK-022，分别负责项目内验收基线、完整浏览器/E2E 验收和最终完成报告。
- 能力矩阵增加 commit、平台、Runtime 版本、认证方式和验证范围，避免把单机版本检查扩大为完整集成支持。
- 第一阶段已于 2026-09-16 启动：完成当前工作区静态能力审计、CLI 可用性检查、目标测试、定位文档和项目内 onboarding 验收基线；干净基线复核和真实任务仍未完成。

本文档完成不代表改造已经实施。第一阶段处于进行中；发布、真实模型调用和产品代码修改仍需按对应任务获得授权并通过验收门槛。

### 基线与事实边界

- 初始静态调研日期：2026-09-15；本次方案修订日期：2026-09-16，以本机日期为准。
- 本地仓库：`/Users/yadongzhai/MyWork/agent-factory`。
- 初始静态调研时的本地 HEAD：`951883c1dd455f5ed8e413f0d5d004f6e5cebc31`。
- 修订时工作区位于 `codex/release-readiness-e2e`，包含多处未提交代码改动；上述历史 HEAD 不代表全部工作区内容，也不等于远端 main。
- 本次只更新本方案，不切换分支、不覆盖其他工作区文件、不修改 README 或产品代码、不提交、不推送。
- 2026-09-16 已重新审计外部 Agent adapter、Runtime、路由、调度器和相关测试，并写入 `docs/product/integration-capabilities.md`。该审计基于当前脏工作区快照而非干净发布基线；没有运行真实外部 Agent 任务或完整产品测试，实施前仍须在选定 commit 复核。

| 已观察到的现状 | 证据位置（相对仓库根目录） | 改造含义 |
| --- | --- | --- |
| README 标题为 Self-hosted Agent Ops，说明文字同时强调运行、治理、观测、记忆与编排 | `README.md` 首屏 | 改为先讲用户任务，再讲系统能力 |
| 已有免模型 Key 的种子数据演示、GIF 与视频入口 | `README.md` Quickstart、`scripts/demo.sh`、`docs/demo/` | 不重复建设 Demo；突出“示例数据”标签 |
| 已有 JSON→CSV 小项目及独立测试脚本 | `examples/01-json2csv-cli/` | 作为重新验证真实交付的候选，不把旧文件视为新执行证据 |
| 已有外部 CLI profile 和 `LocalCliAgentAdapter.execute()` | `packages/server/src/agents/external-agent-adapters.ts` | 不应笼统写外部 CLI 集成均为未来能力 |
| `LocalCliAgentAdapter.cancel()` 当前为空；`runCommand()` 有超时处理 | 同上 | 超时终止不等于用户取消，需分别标注和验证 |
| README 兼有“协调外部 Agent”和“未来 CLI bridge”措辞 | `README.md` 首屏与 Harness internals | 核对两条集成路径，消除读者可见的歧义 |
| Node badge 写 ≥20，而 package engines 要求更具体 | `README.md`、根 `package.json` | 安装文案应与 engines 同步 |

没有访问、克隆、首次运行等转化基线，因此“定位和首次体验拖累增长”是待验证假设，不能认定为低 Star 的唯一原因。

## 1. Requirements & Constraints

- **REQ-001**: 保留仓库名 `Myrmecia` 与现有包名；本轮不做品牌迁移或 API 命名重构。
- **REQ-002**: 首页主场景统一为“软件任务的 Agent 团队协作”，内容生产与领域知识保留为扩展用例，不删除已有能力。
- **REQ-003**: README 必须区分浏览种子数据与执行真实任务，两条路径分别列出前置条件、产物和验证方法。
- **REQ-004**: 每条外部 Agent 能力声明绑定实现入口、验证级别、限制、验证日期、commit、平台、Runtime 版本、认证方式和验证范围；不得用 CLI 可启动证明全量治理能力。
- **REQ-005**: 真实交付案例保存输入、执行 ID、产物差异、验证日志、实际模型与执行时间；成本不可获取时显示“未知”，不得填零或估算后冒充实测。
- **REQ-006**: 首页英文为主，提供明确的中文入口；任务输入、当前阶段、结果与人工操作在演示中必须可读。
- **REQ-007**: 当前完成标准来自 `docs/product/onboarding-acceptance.md` 的项目内验收；用户访谈和市场验证不属于本轮交付，不得用缺少访谈阻塞代码、文档或 E2E。
- **REQ-008**: 体验分为零安装预览、本地示例数据 Demo、真实任务三级；不得将只读回放描述为在线运行服务。
- **REQ-009**: 项目内验收必须覆盖 Fresh、Demo、Live ready、Live unavailable、Refresh/Restart 五种环境状态，并记录实际 URL、截图、浏览器控制台、测试命令和退出结果。
- **REQ-010**: 完成判断分别记录启动成功、执行对象可见、首次任务创建、对话可读、结果可见、产物可打开、验证证据可检查、失败可恢复和刷新可继续；其中任一项不得由构建成功或 Agent 自报完成替代。
- **SEC-001**: 不展示或提交 Key、私有仓库内容、Cookie、含凭据的服务地址、用户完整环境变量和未经脱敏的日志。
- **SEC-002**: 外部 CLI 的工作目录约束、平台工具策略与操作系统隔离分开说明；不得宣称 in-process policy 等于容器或 OS 级隔离。
- **CON-001**: 不将“首次任务 5 分钟完成”“降低成本”“提升成功率”写成未经测试的承诺。
- **CON-002**: 改标题和重排文档不授权远端 Description 更新、发布视频、push、合并、创建 Release 或启动消耗额度的模型运行。
- **CON-003**: 在当前脏工作区上开始实施前，记录变更归属并由维护者选定基线；禁止 reset、stash 或整文件覆盖他人修改。
- **CON-004**: 不修改其他个人仓库；本轮不联系外部用户、不群发推广、不更新远端宣传渠道、不购买或交换 Star，也不在其他项目 Issues 发布广告。
- **GUD-001**: 用户收益先于技术术语；Agent Ops、Runtime、治理与记忆机制放到后层文档解释。
- **PAT-001**: 使用“实现 → 验证 → 对外声明”顺序，不先承诺能力再补实现。

### 1.1 建议采用的品牌文案

**README H1**

> Myrmecia — Run AI agent teams from one dashboard

**中文标题**

> Myrmecia：在一个工作台里运行和管理 AI Agent 团队

**差异化副标题（待真实案例和项目内验收验证）**

> Coordinate the agents. Inspect the work they deliver.

> 不只看 Agent 说“完成了”，还要看它改了什么、交付了什么、哪些验证通过了。

上述文案只用于已经核实的执行路径，不宣称所有外部 CLI 都具有完整内部审计或独立验收能力。保持标题稳定，先用 TASK-020～TASK-022 验证完整产品路径，不频繁改名寻找热度。

**一句话说明**

> Assign tasks, coordinate specialist agents, inspect execution history, and review results in a self-hosted workspace.

**中文说明**

> 在自托管工作台里分配任务、组织专业 Agent 协作、查看执行记录并审查结果。

**GitHub Description（待授权发布）**

> A self-hosted workspace for AI agent teams: assign tasks, coordinate workflows, inspect runs, and review results from one dashboard.

**首屏三个收益**

1. **Coordinate the work** — Assign a task and follow its handoffs across specialist agents.
2. **Inspect the run** — See execution history, reported outputs, and available verification evidence.
3. **Review the result** — Inspect artifacts and test results before accepting a delivery.

“Govern every tool call”“平台越用越聪明”“完整协调所有外部 Agent”等绝对措辞，改为带运行路径和证据范围的描述。Formerly Agent Factory 移到 About；React、Express、TypeScript 等技术栈徽章移到开发文档。

### 1.2 首页结构

| 顺序 | 区域 | 内容与限制 |
| --- | --- | --- |
| 1 | 品牌与标题 | 保留统一 Banner；采用上述 H1 和一句话说明；只保留 CI、许可证、版本等关键徽章 |
| 2 | 真实任务演示 | 有新执行证据后展示；此前明确使用“Demo data”而不是“Live execution” |
| 3 | 三个核心收益 | 协调工作、查看执行、审查结果；每项对应一个实际界面 |
| 4 | 三级体验入口 | 零安装看预览 / Explore demo / Run a real task；依次注明无需配置、本地示例数据、真实模型与权限；主行动随读者所处阶段保持单一明确 |
| 5 | 一个可复现交付 | 展示输入、Agent 分工、文件差异、测试与限制 |
| 6 | Supported integrations | 区分内置 Runtime 与外部 CLI；链接到能力矩阵 |
| 7 | 架构概览 | 一张概览，不同时叠加所有子系统与执行模式 |
| 8 | 文档与贡献 | 详细配置、模式、领域包、记忆、部署、桌面签名进入专项文档 |

不把长横图塞进三列表格。主任务界面采用全宽；纯截图不加不可验证的状态、成本和完成率。图片提供 alt，视频附文字步骤。README 目标是缩短理解路径，不机械追求固定行数。

零安装预览优先使用已有演示素材加清晰标签、短视频与文字步骤，不要求先开发在线交互回放或新安装平台。只读回放可作为后续候选，未经部署验证不填写在线入口。

### 1.3 能力矩阵规范

矩阵每行必须包含：`capability`、`execution_path`、`implementation`、`verification_level`、`environment_scope`、`evidence`、`limitations`、`verified_on`、`verified_commit`。`environment_scope` 至少记录平台、Runtime/CLI 版本、认证方式和实际验证范围；不适用项明确写 `not_applicable`。

验证级别固定为：`not_implemented`、`implemented_unverified`、`fixture_verified`、`live_verified`。未验证时 evidence 与 verified_on 使用 `null`，不能填入文档创建日。

| 能力 | 当前可作出的结论 | 后续验收 |
| --- | --- | --- |
| 外部 CLI 启动 | 适配源码存在，未在本次运行真实 CLI | 每个公开宣称支持的 profile 独立验证；记录 CLI 版本 |
| 输出收集与退出状态 | `runCommand()` 聚合输出并处理退出码 | stdout、stderr、非零退出、超时、输出截断分别测试 |
| 用户主动取消 | 所检查的本地 CLI adapter 未实现 | 只有进程与任务状态一致终止后才标支持 |
| 超时清理 | 存在 SIGTERM 逻辑 | 检查忽略信号与派生进程情况，不把发送信号视为已清理 |
| CLI 内部工具调用审计 | 不能从 stdout 聚合自动推导 | 按实际协议提供粒度；缺失时标不可观测 |
| 断点恢复 | 不能由持久化日志自动证明 | 区分重新运行与从检查点恢复；验证副作用不重复 |
| 工具策略与隔离 | 内置工具和外部进程边界不同 | 逐路径说明执行层，不扩大安全承诺 |

### 1.4 项目内首次体验验收

`docs/product/onboarding-acceptance.md` 是当前首次体验的唯一完成门槛。它覆盖以下路径：

1. 全新隔离数据库首次进入 Home。
2. `pnpm demo` 的无模型种子数据体验。
3. 已配置模型和内置 TypeScript Runtime 的真实任务。
4. API 在线但模型、MCP 或外部 Agent 不可用的降级状态。
5. 浏览器刷新和服务重启后的任务、Session 与结果恢复。

每条验收必须保留实际 URL、1280px 与 390px 截图、浏览器控制台结果、对应自动化测试和执行 commit。页面能打开、API health 为 OK 或 Agent 返回文本均不能单独判定通过。

产品内必须清楚回答：

- 当前是 Demo、Live ready 还是需要配置；
- 指令将发送给哪个 Agent、Team 或 Workflow；
- 谁正在处理、处于什么阶段；
- 最终回答、产物和测试结果在哪里；
- 失败后可以重试、继续、修改配置还是只能标记未知；
- 如何切换和继续不同 Session。

### 1.5 项目完成指标与停止条件

- Fresh Home、Demo、Live ready、Live unavailable、Refresh/Restart 五种环境分别验收，不从一种状态外推另一种。
- Demo 必须无需模型 Key，不产生模型请求，并在所有相关结果区域显示 `Demo data`。
- 真实任务必须记录 task ID、execution ID、Agent/Team/Workflow、模型、Runtime、输入、产物、测试和最终验收状态。
- Task Session 必须区分用户消息与 Agent 回复，支持可读的流式 Markdown，Tool call 默认折叠，并允许在同一 Session 继续追问。
- 最终结果必须在非技术用户可理解的结果区展示；原始 JSON、日志和技术时间线只能作为展开后的证据。
- 缺少产物、测试、引用或恢复证据时显示 `Not available` 或 `Not verified`，不能留空或由成功状态暗示。
- 浏览器 E2E、服务端测试、前端测试、lint 和 build 分开记录；任何一项失败都保留实际状态。
- 出现凭据泄漏、危险副作用、无法安全终止选定执行路径、数据目录混淆或持续超预算时停止真实任务，先修复再继续。
- 外部 CLI 的未完成取消和恢复能力不阻塞内置 TypeScript Runtime 的首轮验收，但 UI 和文档必须准确标记限制。
- 当前不使用访谈人数、Star、访问量、克隆量或第二次使用作为项目完成指标。

## 2. Implementation Steps

各阶段有明确依赖；此处仅定义顺序，不自动创建任务或委派 Agent。

### Implementation Phase 1

- **GOAL-001**: P0，冻结项目内验收标准，完成执行路径能力事实表、产品定位和三级 onboarding 契约。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在记录的工作区快照创建 `docs/product/integration-capabilities.md`；检查 `external-agent-adapters.ts` 的 `runCommand()`、`LocalCliAgentAdapter.execute()`、`cancel()`、`external-agent-runtime.ts`、调度 worker 与 `runtime-adapter.ts`，按 1.3 的字段逐项填写。源码存在仅记 implemented_unverified。当前脏快照可形成初审，但只有在维护者选定 commit 后复核并更新 `verified_commit` 才能完成。 | 否 | — |
| TASK-020 | 创建 `docs/product/onboarding-acceptance.md`，将 Fresh、Demo、Live ready、Live unavailable、Refresh/Restart 的 Home、首次任务、Task Session、交付证据、失败恢复和持久化要求写成逐项可验证清单；每项指定截图、浏览器、测试或运行证据。 | ✅ | 2026-09-16 |
| TASK-002 | 依赖 TASK-001 初审和 TASK-020。建立 `docs/product/positioning.md`，固定 1.1 文案、目标用户、使用时机、替代方案、安装理由和项目内验证门槛；记录“内置 agent team”不等于“外部 CLI 全流程治理”。市场需求不在本轮验证。 | 否 | — |
| TASK-003 | 依赖 TASK-001。核对 README、`package.json` engines、`scripts/demo.sh` 与启动文档；在 `docs/product/onboarding.md` 写出零安装预览、本地 Demo、真实运行三级路径，列出真实路径的预算、权限与安全终止方式；不传播未经验证的一键命令。 | 否 | — |

**验收门槛：** 每个演示能力有实现位置和验证状态；无“版本检查通过即全功能支持”；能力表消除同一外部 CLI 状态歧义；定位文档的每条主要收益均映射到项目内验收项；README 的正式同步在 Phase 3 完成。

**2026-09-16 启动记录：** 已新增 `docs/product/integration-capabilities.md`、`docs/product/positioning.md` 与 `docs/product/onboarding-acceptance.md`；访谈模板保留在 `docs/product/onboarding-feedback.md` 并标记 On Hold。Codex CLI 和 Claude Code 仅完成本机版本可用性检查；Gemini CLI 与 OpenCode 本机未安装。外部 adapter、route、scheduler 和 Runtime adapter 的 18 项目标测试通过。TASK-001 仍等待选定 commit 后的干净复核；TASK-002 仍等待真实任务和完整项目验收。

### Implementation Phase 2

- **GOAL-002**: P0，将“能看到演示”提升为“能核验一个真实交付”；依赖 Phase 1 和真实运行授权。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 依赖 TASK-002。新建 `docs/product/real-task-case-study.md`：JSON→CSV 保留为工程冒烟验收；主验收案例选择可公开且需要至少两个职责边界的小型 TypeScript 缺陷修复，优先选择“服务端输入校验＋前端错误状态＋回归测试”一类可在 30–90 分钟授权预算内完成的任务。冻结起始 commit、缺陷输入、需求和回归验收命令，记录为何需要任务交接与结果核验。不预先放入修复答案，不为演示人为制造失败。 | 否 | — |
| TASK-005 | 依赖 TASK-004 和 TASK-003 的执行路径安全检查。在授权的模型、预算和隔离目录运行 Myrmecia 案例；首轮默认使用内置 TypeScript Runtime。保留 objective、run ID、实际 Agent/模型/版本、文件差异、产物 SHA-256、测试日志和结果状态。Agent 数量按任务需要决定。原始证据留在未跟踪目录，脱敏后才复制到 `docs/demo/case-study/`。只有明确选择外部 CLI/HTTP 路径且该路径无法安全终止或限制副作用时，才先完成 Phase 4 对应修复；禁止以演示优先绕过。 | 否 | — |
| TASK-016 | 依赖 TASK-004。在单独授权的额度与隔离目录下执行单 Agent 对照；使用同一起始 commit、输入和验收，尽可能保持模型、版本与预算一致，差异必须披露。对照与 TASK-005 分开工作区，互不读取答案。将全部结果写入案例文档；未运行则标未验证，禁止得出更快、更便宜或更可靠的结论。 | 否 | — |
| TASK-006 | 依赖 TASK-005。制作 `docs/demo/myrmecia-real-task.gif` 短预览、案例文档中的完整过程和可复现证据三层内容。围绕任务交接、产物、测试和人工检查讲清安装理由，时间压缩显式标注；只有完成 TASK-016 才引用实测对照，不因单 Agent 更快而删除结果。与种子数据演示分开标注。 | 否 | — |

**验收门槛：** 冒烟案例从空白任务工作区生成新产物，真实修复案例从冻结且未含答案的 commit 开始；实际测试与案例文档一致；模型声称成功或进程退出 0 不足以判定完成。允许保留失败分析，但不能替代成功用例验收。对照未运行时比较结论保持未验证，不对速度、成本或可靠性作比较声明。

### Implementation Phase 3

- **GOAL-003**: P1，完成 GitHub 首页与首次使用路径；依赖 Phase 1，真实案例展示依赖 Phase 2。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | 依赖 TASK-002、TASK-003。按 1.2 重排 `README.md`，新增或同步 `README.zh-CN.md`。将环境变量和部署细节移入 `docs/product/onboarding.md` 或已有专项文档，保留入口；撤除无证据的全量治理、安全和性能承诺。真实案例区域在 TASK-006 前只能使用明确标记的占位说明，不得伪装为已完成案例。 | 否 | — |
| TASK-008 | 依赖 TASK-006。基于实际任务截图更新 `packages/dashboard/public/myrmecia-banner.svg` 与 `docs/demo/` 展示素材；统一副标题，保留品牌字标；在宽屏与窄屏检查图中文字和代码块。 | 否 | — |
| TASK-019 | 依赖 TASK-003、TASK-007。改造 `packages/dashboard/src/components/home/HomeView.tsx` 及其必要的状态组件：明确 Demo/Live、模型与 Runtime 可用性、推荐第一项任务、当前执行对象、结果入口和失败恢复操作。覆盖新数据库、Demo、未配置模型、已配置模型、首次任务成功、首次任务失败和刷新恢复；不得把服务在线显示为模型已可用。 | 否 | — |
| TASK-009 | 依赖 TASK-007、TASK-008 和 TASK-019。在 `docs/product/publication-checklist.md` 保存本地发布就绪清单：README 链接、双语入口、素材、Demo 标签、真实案例证据、浏览器截图、测试、commit、PR、CI 和合并状态分别记录。当前任务只生成并验证清单，不更新远端 Description、Topics、Homepage 或发布帖子。 | 否 | — |

**验收门槛：** 双语入口可用；本地链接和素材完整；Demo 数据不伪装为真实执行；新用户无需先阅读环境变量总表即可找到第一步；进入产品后能区分 Demo/Live、确认执行对象、开始任务并找到交付证据。

### Implementation Phase 4

- **GOAL-004**: 独立 Runtime Hardening 轨道，补齐外部 CLI/HTTP 可控执行的明显缺口；依赖 Phase 1，与当前项目主验收和文案工作分开推进。若维护者明确选择外部路径用于真实任务，对应修复提升为该路径运行前的 P0 门槛；首轮采用内置 TypeScript Runtime 时，本阶段不阻塞项目内验收。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-010 | 在 `external-agent-adapters.ts` 的 `runCommand()` 与 `LocalCliAgentAdapter` 中设计按 run ID 隔离的进程句柄生命周期，使 `cancel()` 可定位目标任务；同时沿外部调度和路由核对取消状态传播。写代码前确定 Windows 与 POSIX 的清理策略，禁止按通用进程名结束用户其他 CLI。 | 否 | — |
| TASK-011 | 依赖 TASK-010。扩展 `packages/server/tests/external-agent-adapters.test.ts` 与 `external-agent-routes.test.ts`：运行中取消、已结束取消、重复取消、超时、忽略终止信号、子进程清理、并行任务互不影响、服务重启后的孤立运行状态。明确 implemented/fixture/live 的差异。 | 否 | — |
| TASK-012 | 依赖 TASK-011。检查 `Tasks.tsx` 与 `TaskSession.tsx` 的外部任务操作：仅为已支持运行路径显示取消；“取消请求已发送”与“已取消”分开；不可观察的子步骤显示未知。刷新后验证状态与服务端一致。 | 否 | — |

**验收门槛：** 用户操作不误伤其他任务；取消后的实际进程、持久状态和界面一致；不支持的平台明确禁用或说明限制。不能因 UI 按钮存在就更新能力矩阵为 live_verified。

### Implementation Phase 5

- **GOAL-005**: P0，完成项目内浏览器、E2E 和交付证据验收，输出可追溯的完成报告；依赖 Phase 2 和 Phase 3。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-021 | 依赖 TASK-005、TASK-007、TASK-008 和 TASK-019。逐项执行 `docs/product/onboarding-acceptance.md`：使用隔离 Fresh DB、Demo DB 和 Live DB，验证桌面 1280px、移动 390px、浏览器控制台、Session 切换、首次任务、继续追问、Markdown/streaming、折叠 Tool call、结果/产物/测试、失败恢复和刷新持久化；为可自动化项新增或扩展 Playwright/Vitest。 | 否 | — |
| TASK-022 | 依赖 TASK-006、TASK-009 和 TASK-021。在 `docs/product/completion-report.md` 记录实施 commit、实际命令、退出码、测试数量、截图、Demo/Live URL、真实 task/execution ID、产物校验、已知限制和未验证项。只有所有 P0 验收通过才把计划标记 Completed；外部 Runtime 独立加固项保持单独状态。 | 否 | — |

**验收门槛：** Fresh、Demo、Live ready、Live unavailable 和 Refresh/Restart 有独立证据；前端测试、服务端测试、E2E、lint、build 与真实任务结果分别通过；完成报告能够从 task ID 追溯到执行、Agent、结果、产物和验证。未通过项必须保留失败状态，不能以截图或文字说明替代。

### Implementation Phase 6

- **GOAL-006**: On Hold，保留未来外部访谈、传播与增长验证任务，但不纳入当前项目完成条件。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-013 | 外部目标用户访谈。当前按维护者决定暂停；`docs/product/onboarding-feedback.md` 仅保留模板，不招募、不联系用户。 | ⏸ | 2026-09-16 |
| TASK-015 | 独立发布实验设计。当前暂停，不创建渠道内容或远端发布计划。 | ⏸ | 2026-09-16 |
| TASK-017 | 对外发布真实案例。当前暂停，不更新远端宣传信息或发布帖子。 | ⏸ | 2026-09-16 |
| TASK-018 | 外部参与者首次使用和回访。当前暂停。 | ⏸ | 2026-09-16 |
| TASK-014 | 增长与复用汇总。当前暂停，不以 Star、访问量或假设数据生成结论。 | ⏸ | 2026-09-16 |

**验收门槛：** 本阶段只有维护者明确重新启用外部验证时才恢复；暂停状态不阻塞 TASK-022 或当前计划的项目内完成状态。

### 14 天项目实施窗口

从维护者批准实际实施之日开始计时，不按本文日期自动启动。时间安排是建议，不覆盖依赖或安全门槛；未获模型额度或干净基线时记录延期。该窗口默认使用内置 TypeScript Runtime；Phase 4 外部 Runtime 加固和 Phase 6 外部验证不计入该窗口。

| 窗口 | 主要行动 | 决策依据 |
| --- | --- | --- |
| D1–D2 | Phase 1：选定基线，复核能力矩阵，完成定位与 onboarding 契约 | 所有公开收益映射到可测试的项目行为 |
| D3–D5 | Phase 2：冻结真实修复案例并运行；额度允许时执行单 Agent 对照 | 有实际 task/execution、产物和验证证据 |
| D6–D9 | Phase 3：README、Home、Task Session、短演示和三级入口改造 | 能区分 Demo/Live、确认执行对象、查看回答和交付 |
| D10–D12 | Phase 5：Fresh、Demo、Live、失败、刷新状态的浏览器与 E2E 验收 | 每个状态有截图、控制台和自动化证据 |
| D13–D14 | 修复验收缺陷，执行全量测试并生成 TASK-022 完成报告 | 所有 P0 通过；剩余限制明确记录 |

## 3. Alternatives

- **ALT-001**: 直接更名为通用 AI Workspace。暂不采用：会增加品牌与链接迁移成本，不能解决真实任务体验和能力边界问题。
- **ALT-002**: 主打“Codex/Claude Code 多开管理器”。暂不作为主定位：外部 CLI 调用已存在，但取消、恢复与内部工具治理需要分层验证；后续可作为专项落地页。
- **ALT-003**: 保持所有场景并列。暂不采用：首页首次理解成本偏高；改为一个核心场景、多个扩展入口。
- **ALT-004**: 仅换标题和 Banner。可作为有限文档交付，但不能宣称完成本方案；真实案例和集成事实表仍是 P0。
- **ALT-005**: 先做外部访谈和增长实验。不采用：当前缺少合适参与者，维护者决定先完成 Myrmecia 自身的真实任务、交互和验收闭环。
- **ALT-006**: 先完成所有外部运行时和在线回放平台再发布。不采用：先验证一个安全、边界明确的路径；新增平台能力必须有实际需求，不以缩短计划为由绕过该路径的安全门槛。

## 4. Dependencies

- **DEP-001**: 维护者选定实施基线并确认现有未提交变更归属；本轮方案不处理这些变更。
- **DEP-002**: 真实任务测试需要获准的模型连接、额度、任务目录和工具权限；不能以读取或保存用户密钥作为前置要求。
- **DEP-003**: 外部 CLI 实机测试需要对应 CLI 已安装且登录状态可用；不得用自动化绕过登录或授权。
- **DEP-004**: Phase 6 若未来恢复，远端发布与用户反馈分别需要发布授权和参与者同意；当前阶段不依赖这两项。
- **DEP-005**: 单 Agent 对照需要额外运行预算及独立工作区。无法满足时保留未验证状态，不发布比较结论，也不将该任务标完成。
- **DEP-006**: 当前不读取或聚合流量数据；Phase 6 若未来恢复，必须单独确认数据权限。

## 5. Files

以下均相对仓库根目录；标注“拟新增”的路径目前不保证存在。

- **FILE-001**: `README.md`、`README.zh-CN.md`（后者不存在时新增）——主标题、双语信息结构、能力边界和三级体验入口。
- **FILE-002**: `docs/product/`——当前范围包含 positioning、integration-capabilities、onboarding、onboarding-acceptance、real-task-case-study、publication-checklist、completion-report；onboarding-feedback 与 launch-experiment 仅为 Phase 6 暂停项。其中 positioning、integration-capabilities、onboarding-acceptance、onboarding-feedback 已于 2026-09-16 创建或更新。
- **FILE-003**: `docs/demo/myrmecia-real-task.gif` 与 `docs/demo/case-study/`（拟新增）——真实任务演示和脱敏证据；与已有 Demo 数据录像分开。
- **FILE-004**: `packages/dashboard/public/myrmecia-banner.svg`——保留字标，更新副标题与视觉重点。
- **FILE-005**: `packages/server/src/agents/external-agent-adapters.ts`——外部进程控制和清理；`runtime-adapter.ts` 为对照检查入口，不预设必须修改。
- **FILE-006**: `packages/server/tests/external-agent-adapters.test.ts`、`packages/server/tests/external-agent-routes.test.ts`——生命周期与接口回归。
- **FILE-007**: `packages/dashboard/src/components/home/HomeView.tsx`、`packages/dashboard/src/pages/Tasks.tsx`、`packages/dashboard/src/components/session/TaskSession.tsx`——首次体验、任务状态和操作呈现；存在未提交改动时逐块确认归属。
- **FILE-008**: `scripts/demo.sh`、根 `package.json`、`examples/01-json2csv-cli/package.json`——核对启动与测试命令的现有事实来源，不预设修改。

## 6. Testing

- **TEST-001**: 文档检查：front matter 可解析、阶段和任务 ID 唯一；最终 README 的本地链接、图片、双语入口不存在断链；不残留作者机器专属安装路径。
- **TEST-002**: 浏览器检查：在实际渲染页面验证桌面 1280px 与移动 390px 宽度；页面无整体横向溢出，长代码块可局部滚动，首屏主图和 Demo 标签可读。保存截图与页面地址。
- **TEST-003**: Demo 检查：无模型凭据的隔离环境执行文档命令；验证加载的为 Demo DB、页面有示例数据提示，且未产生模型请求。检查路径不能修改用户已有数据库。
- **TEST-004**: 真任务检查：JSON→CSV 冒烟覆盖正常对象数组、字段并集、缺字段、CSV 转义、空数组、非法 JSON 和非数组输入。宣传用真实修复案例另行冻结 commit、缺陷输入和回归测试，确认差异仅涉及需求，原缺陷在修复后不再出现且既有测试通过。不能仅运行现成示例测试后声称新任务完成。
- **TEST-005**: 外部进程检查：覆盖 TASK-011 的全部生命周期；fixture 通过后逐平台进行许可范围内的进程验证，再按 profile 进行真实 CLI 验证。
- **TEST-006**: 发布就绪检查：分别记录本地验证、commit、push、PR、CI、merge和页面效果；任一步未完成不得由另一项通过代替。远端 Description、Topics、Homepage 和宣传发布不在当前范围。
- **TEST-007**: 对照检查：核对 TASK-005 与 TASK-016 的输入、起始 commit、验收、模型与预算；不一致项必须披露。缺少对照时检查所有对外文案不存在更快、更便宜或成功率更高的断言；对照更好或更差都不删去。
- **TEST-008**: 项目内交付检查：真实 task/execution 能从输入追溯到 Agent/Team/Workflow、模型、Runtime、对话、结果、产物、测试和人工验收；不存在的证据明确标记未验证。
- **TEST-009**: 范围检查：计划执行产生的产品改动和验收入口均为 Myrmecia；不得新增其他个人仓库改动、外部访谈、跨项目广告或关注者联系任务。
- **TEST-010**: 产品内 onboarding 检查：在新数据库、Demo 数据、未配置模型、已配置模型、首次任务成功、首次任务失败和刷新恢复七种状态下验证 Home；每种状态均能识别 Demo/Live、当前可用执行路径、任务接收者、下一步和结果入口，且不把 API 健康误报为模型或外部 CLI 可用。

以下命令来自当前仓库脚本，供后续实施验证使用；本次文档任务没有执行它们：

```bash
# 在选定基线的仓库根目录执行
pnpm --filter @myrmecia/server test -- external-agent-adapters.test.ts external-agent-routes.test.ts
pnpm lint
pnpm build

# 这里只证明已有案例通过，不证明新 Agent 任务交付
pnpm --dir examples/01-json2csv-cli test
```

真实任务的测试命令必须指向其新产物目录，并写入执行证据；测试通过数按当次结果记录，不沿用 README 的历史数字。

## 7. Risks & Assumptions

- **RISK-001**: 仅更换标题不能解决真实任务交互与交付缺陷；README、Home、Task Session 和后端证据必须一起验收。
- **RISK-002**: CLI 集成状态可能在实施前变化；以选定 commit 的代码、测试和实机证据更新矩阵，不复用过时判断。
- **RISK-003**: 真实案例可能失败或超预算；保留失败记录并缩小范围，不用种子数据补成成功视频。
- **RISK-004**: 录屏、日志和截图可能泄漏凭据；发布前逐件检查、脱敏，删除敏感内容不能以遮挡画面代替清理附件原文。
- **RISK-005**: 当前工作区多人或多任务并行修改；不得把本方案任务与其他开发成果混入同一提交。
- **RISK-006**: 外部进程取消与子进程清理有跨平台差异；测试不可用的平台保持 unverified，不从单平台结果外推。
- **RISK-007**: 缺少外部访谈意味着本轮只能证明产品内部一致性和工程可用性，不能证明市场需求；完成报告必须保留该边界。
- **RISK-008**: 当前 Home、Task Session 和服务端存在未提交改动；实现 onboarding 时必须逐块确认归属，避免覆盖此前聊天、MCP 和恢复功能。
- **RISK-009**: 单一浏览器或单一成功任务可能掩盖失败状态缺陷；必须覆盖验收矩阵中的降级、失败、刷新和恢复路径。
- **ASSUMPTION-001**: 当前优先目标是完成 Myrmecia 的项目内产品闭环，而不是验证获客、Star 增长或长期留存。
- **ASSUMPTION-002**: 品牌保留、软件交付场景优先是本方案的建议默认值；内容 Studio 和领域机制继续可用。
- **ASSUMPTION-003**: 安装、Demo 和真实运行测试预计在干净隔离环境中完成；本地现有服务和用户数据不是试验对象。

## 8. Related Specifications / Further Reading

先读取已有文档，避免重复定义同名概念：

- [定位假设](../docs/product/positioning.md)
- [外部 Agent 能力矩阵](../docs/product/integration-capabilities.md)
- [产品内首次体验验收](../docs/product/onboarding-acceptance.md)
- [暂停的外部访谈模板](../docs/product/onboarding-feedback.md)
- [当前 README](../README.md)
- [产品架构](../docs/ARCHITECTURE.md)
- [API 文档](../docs/API.md)
- [部署说明](../docs/DEPLOYMENT.md)
- [桌面应用说明](../docs/DESKTOP-ELECTRON.md)
- [记忆架构](../docs/MEMORY-ARCHITECTURE.md)
- [JSON→CSV 既有案例](../examples/01-json2csv-cli/README.md)
- [外部 Agent 适配实现](../packages/server/src/agents/external-agent-adapters.ts)
- [外部 Agent 适配测试](../packages/server/tests/external-agent-adapters.test.ts)

**当前第一批实施范围：先完成 Phase 1 的能力事实表、定位和项目内验收契约，再进入 Phase 2 的真实案例、Phase 3 的 README/Home/Task Session 改造和 Phase 5 的浏览器/E2E 完整验收。Phase 4 外部 Runtime 加固独立推进，Phase 6 外部访谈与传播保持暂停。**
