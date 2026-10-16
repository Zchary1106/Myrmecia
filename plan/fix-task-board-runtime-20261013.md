# 看板试用暴露的运行链路修复

用户批准先修复问题，再继续原任务 `task_4aeb307d`。保持原 spec、独立
验收脚本及失败历史；不代写看板，不改账号/全局配置/预算，不发布 Git。

## Context Map

| 文件（相对 packages/server） | 修改范围 |
| --- | --- |
| src/models/copilot-provider.ts | 为每次 complete 捕获并恢复 AsyncLocalStorage 上下文，包含工具/事件回调；不换 client 或关闭租约 |
| src/agents/ts-agent-loop.ts | 工具 dispatch 之前的异常保存成配对收据、终态错误和安全预算释放；保留原门禁 |
| src/routes/tasks.ts | 同一会话继续继承有效 completionCriteria，包括 needs-input / debug followup 路径 |
| src/testing/test-report.ts | 识别测试 case 数，零执行、全跳过和缺失测试覆盖不能当验证通过；非测试 build/lint 不受影响 |
| src/testing/task-test-authorization.ts | fixed npm test 收据区分实际命令成功与验证结果，不改退出码；绑定/租约/到期仍有效 |
| src/agents/completion-gate.ts | test_command 同样不能把空测试当 outcome pass |
| src/pipelines/quality-loop.ts | 先验证实现输入；Review 输入准备失败不留下 pending 子任务 |
| src/artifacts/execution-artifact-indexer.ts | 恢复验证时按持久化 mandatory artifact criteria 采集当前不可变快照，不要求重写文件；保留路径/配额/工作区和执行归属门禁 |
| src/workspace/workspace-reconciliation.ts | 正式租约恢复提交后通知内存队列，不让已释放目录的 queued 任务永久等待；保留失败工具 unknown 收据，不自动重放 |
| src/skills/workspace-file-read.ts、tool-sandbox.ts | 长源码使用可继续、校验哈希、有限大小的 file_read 分页；短文件兼容、原工具权限/路径/DLP 不变，避免头尾摘要导致反复读取耗尽预算 |
| src/agents/self-healing.ts | Copilot SDK token_budget 为终态，不自动重试重复消耗原预算；正常临时失败仍可按既有策略恢复 |
| ../shared/src/test-execution.ts、index.ts | 前后端共用的实际测试执行判定 |
| ../dashboard/src/components/common/StructuredTaskResult.tsx | 空测试/缺失覆盖/未完整流式结果不显示绿色完成，保留真实退出码 |

## Dependencies

- AsyncLocalStorage snapshot / 外部 SDK shared transport 的异步资源边界。
- 工具 registry、workspace lease、run fence、拒绝收据、budget dispatched 状态。
- createTask、execution context、continuation、typed completion verification。
- scoped host QA / TestReport / immutable Review 输入，现有质量 child task 区分。

## Tests

- copilot-budget：共享模拟 transport 下顺序不同请求各自上下文，仍 fail closed on expired fence。
- ts-agent-loop-completion：工具前置 gate 抛错，配对收据、终态和未 dispatch 预算释放。
- task-continuation：继续任务继承原 criteria，不修改旧 execution 或借其他会话 criteria。
- test-report / task-test-authorization / completion-gate：zero tests / all skipped /
  missing coverage / real positive / failing tests / non-test commands。
- reliability-quality-gate integration：失败输入和 Review 准备错误不残留 pending。
- execution-artifacts：未修改必需文件的新快照、缺失产物仍失败、runtime 伪造 criteria /
  workspace / execution、敏感路径和符号链接不可绕过。
- workspace-storage：拒绝/重复恢复不通知，成功审计事务提交后才通知队列一次。
- 真实 Node/npm 回归：npm `@1.0.0 test` 版本横幅不应被识别成 `0 test`，
  真实 9 项与真正 zero-test 分开验证。
- Reviewer：完整、有限的变更快照，超过内容/文件配额则在宿主明确失败，
  不截断代码后误派 Dev 反复补证据；保持执行 token 预算和 DLP 门禁不变。
- 长文件分页：逐页重建含转义/Unicode 的原文，源码变化拒绝、参数和输出
  配额边界、原工具权限/路径/敏感文件/符号链接门禁。
- SDK 预算停止：SelfHealing 和内存/BullMQ 队列不重新开启预算已耗尽任务。
- 原真实看板：same session、Agent 自己生成实现、真实 QA/Review、固定 16 case，
  最后 localhost 5181 浏览器操作。

## Reviewed risks / references

范围已与当前源码、上一轮 HTTP/SQL 证据和离线 callback 复现核对。
无 DB schema/依赖/配置变更。保留大量已有脏改动；不使用更高预算、不开放
任意 shell、不通过重启绕过 lease。完整测试完成后才开始真实模型运行，
运行期间不再修改 src 触发重载。

## Acceptance checkpoints

- [x] 红测复现并完成针对性修复。
- [x] 全量后端 / 构建 / 差异检查：最终 1175 passed、6 skipped；
  前端 240 passed，shared/server/dashboard 构建成功。
- [x] 原看板会话真实重跑与 QA / Review：最新 task_c201932e done，
  criteria 3/3 passed，npm test 11/11，宿主 QA passed，Reviewer approved。
- [x] 外部固定 16 case、3 项异常与1项存储验证、最终页面交互验收。
- [x] 新报告、截图、临时授权撤销、旧失败历史和未交付步骤保留。

交付证据见
`artifacts/task-board-e2e-20261013.rBsv9M/runtime-fix-and-development-20261014.md`。
只证明受控试用；SDK 内层效率、调用后预算上报/超阈值、host_policy 非
OS 沙箱和示例无鉴权/单进程的边界仍保留，不宣称生产或无人干预交付。
