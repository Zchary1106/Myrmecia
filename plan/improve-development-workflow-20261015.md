# 开发 Agent 的设计与交付闭环

日期：2026-10-15。用户要求：优化当前 Agent，解决只有局部功能、缺少完整系统设计、
UI 无设计以及重复探索耗尽预算的问题。

## 本轮范围与安全边界

工作区：独立的 `development-workflow-20261015` worktree。
分支：codex/development-workflow-20261015。
从主工作区 HEAD 49d8a872a0b7442f7e6b116a6995f910ce2279e7 建立，机械复制了
既有 tracked 脏改动及 23 个必要的未跟踪源码/文档文件，保留当前修复基础；
没有复制 .env、数据库、工作区产物或任务状态。

主后端 tsx watch 正在运行，重载会自动恢复 8 条既有 queued 任务。
后续只读 API 列表还包含一条历史未分配 queued 任务；切换前需重新
核对整个队列，不能只按初次观察的 8 条盲目处理。
本轮不改动主目录、不停止其服务、不调度这些任务、不改变账号/模型/预算/
权限，也不提交或推送。上线激活之前，需要用户确认队列处理和切换窗口。
WorkAgent 提交工具发现为 0；本轮使用本地计划、回归和证据，不声称 WorkAgent 托管。

## 证据与根因

- agents/dev.md 仅 analyze → write_tests → minimal implement → refactor，
  缺少用户流程、模块/数据/接口设计、UI 状态与视觉验收。
- Copilot 路径不走 SkillExecutor，各种工具实际发生在 SDK 内层循环，
  单纯增加 frontmatter 步骤并不能形成运行时门禁。
- 既有中间件只能拦截连续三个完全相同调用；换页/换目录的只读探索不受限。
- 前一轮真实试验三次预算停止；一个 UI 返回值缺陷被 Reviewer 发现，
  初始测试漏掉“失败后成功重试清除反馈”。不能把测试 exit 0 当成产品就绪。

## Context Map

| 文件 | 角色 | 本轮变更 |
| --- | --- | --- |
| agents/dev.md | 默认 Dev Skill | 区分系统开发、小改动和只读任务；设计与交付规范 |
| agents/development-workflow.ts（server src 下） | 新增纯策略与校验模块 | 任务分型、结构化设计 schema、安全的产物校验、探索守卫 |
| agents/agent-prompt.ts | 所有 Skill 的最终系统提示 | 追加适用的开发交付协议，覆盖 DB Skill 但不扩大工具权限 |
| agents/execution-middleware.ts | 通用工具运行链 | 设计先于业务写入，探索预警/停止、完成前产物检查 |
| agents/ts-agent-loop.ts | Copilot/标准/分步工具结果入口 | 向模型回传宿主指导；验证请求跳过写代码流程，保留真正只读 Skill |
| agents/agent-runtime.ts | 执行结束前的统一验证 | 非 needs_input 开发交付调用新门禁 |
| agents/self-healing.ts | 自动重试判定 | 新门禁终态不盲目自动重跑 |
| docs/DEVELOPMENT-DELIVERY.md | 用户说明 | 设计门禁、证据层级、限制与激活说明 |

直接依赖：Task/AgentDefinition、原 read-before-write/权限/预算中间件，
已有质量审查、产物收集、空测试验证保持原义。使用现有 zod，无新依赖。

测试：新增 development-workflow.test.ts 与设计 fixture；扩展
agent-prompt、execution-middleware、self-healing、agent-runtime、
ts-agent-loop 回归。runtime-v2-baseline 的暂停 fixture 改为从已持久化
execution 取得 taskId，消除对无关 Skill 匹配 await 的时序依赖；
仍保持原暂停/恢复/不重复读取的全部断言。运行 completion/quality-loop
与全量构建测试。

映射已按现有源码自审。无数据库迁移、无公开 API 破坏；
仅系统/UI 新建任务有更严格交付要求。增量、只读、内部 QA/Review 不受
设计文件要求影响。heuristic 只决定交付流程，不授予权限。

## 验收标准

- [x] 大系统任务必须先写符合 schema 且绑定 taskId 的系统设计；
      涉及 UI 的新建/重设计必须有 UI 设计，不以一段 prose 冒充设计。
- [x] 修改代码与 Shell 前有设计门禁，缺失/无效设计有明确恢复说明；
      保留原授权和 read-before-write 门禁。
- [x] 完成前实际校验设计及声明的源文件，缺失、空文件、越界、
      symlink 或陈旧 taskId 不能通过。
- [x] 小修复/验证/人工继续任务不因历史完整系统需求被误判；
      不强制纯后端产生 UI。
- [x] 连续探索 6 次给出模型可见指导，12 次明确停止；
      只有真实成功写入才能重置，失败补丁和重复测试不算进展。
- [x] 新错误不自动重试；日志/ledger 区分设计通过、源码存在与
      测试/浏览器/视觉验收，不能声称产品视觉已验收。
- [x] 新增负向与集成回归、既有相关回归、全量测试/构建通过。
- [x] 主工作区文件、服务和既有排队任务状态不变。

## 当前验证记录

- 已完成 7 个相关测试文件、149 项定向测试（包括真实工具执行/
  SDK 回调与统一 Runtime 入口；模型响应使用 fixture，不是实际模型任务）。
- 共享包、后端、前端构建通过；前端 240 项测试通过。
- 完成问候/缓存、纯后端、组件库不会误免除 UI、部分文档授权不扩权、
  当前追问、陈旧设计、并发探索、假进展、设计缺失、声明源码缺失、
  只读分步恢复和原暂停边界的回归。
- 测试启动使用现有服务同版本 Node 25.9.0；没有重编译或改动主依赖。
  独立 server/dashboard 的依赖目录保留相对链接，使 workspace shared
  解析到本工作区的独立构建。临时依赖备用 symlink 已移除，避免扫描
  第三方依赖自身的测试；没有改动 Vitest 的测试排除规则。
- 普通增量提示不加入 taskId，避免破坏既有无工具精确缓存；
  需要设计的任务才绑定准确 ID。
- 最终全量后端回归：163 个文件、1252 项通过、6 项跳过、0 失败。
  前端：22 个文件、240 项通过、0 失败。共享/后端/前端构建均成功。
- 激活仍未执行；不把本地门禁和 schema 验证当作真实系统/视觉验收。
- 只读检查确认主 HEAD 未变、原服务 PID 未变、health=ok、
  原 8 条任务仍为 queued，另有一条历史未分配 queued；running 列表为空。
  激活 delta 只包含本轮 17 个文件，对 13 个既有文件逐个比对了主目录
  与 baseline 的 SHA-256；`git apply --check` 通过，未实际应用。

## 明确保留的后续边界

本轮实现提供者无关的宿主设计/交付门禁和探索约束，不冒充已把 Copilot
改成真正的逐阶段独立 SDK 请求调度。该调度涉及 checkpoint、预算和恢复
边界，须单独验证。浏览器/截图能力也不由 Prompt 凭空获得；
没有运行浏览器和视觉审查时必须标注未验证。

完整系统设计的语义质量、设计美观和生产安全不能被 schema 自动证明。
本轮不声称已经可无人值守开发完整产品；新版本需在安全切换后再做真实试用。
