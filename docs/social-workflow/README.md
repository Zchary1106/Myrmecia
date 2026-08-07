# 三平台社媒工作流

该工作流共享“选题证据包”和“内容核心包”，随后分为三条生产线：

- 抖音：以 9:16 视频为主；
- 小红书：明确选择图文（3:4）或视频（9:16）；
- 公众号：长图文、HTML 与 900x383 封面。

## 安全顺序

1. 选题证据包 → 内容核心包；
2. 三条生产线并行创作；
3. 确定性合规检查 + 语义审核 → 人工审核材料；
4. 真人 Gate 持久化审批人、时间与内容哈希；
5. 媒体生成 → `media.inspect` QA → 发布预检；
6. 再次人工确认后发布；
7. 失败补偿与持久化 48/72/168 小时效果回流任务。

## 结构化产物

- `content-package.schema.json`：内容核心包
- `compliance-rules.yaml`：自动初筛规则
- `preflight-result.schema.json`：发布前检查
- `publish-result.schema.json`：发布结果
- `content-run-snapshot.schema.json`：审计快照
- `performance-report.schema.json`：效果监控
- `publishing-schedule.schema.json`：多账号排期记录

## 运行时保护

- 设置了 `output_schema` 的阶段会使用 JSON Schema 校验真实输出。
- 设置了 `output_policy` 的阶段如果不满足条件，将进入 `review/blocked`，不会继续发布。
- `requires_approval` 阶段只接受服务端记录的真人审批；LLM 输出不能冒充审批记录。
- 三个平台分支在依赖满足时并行启动，fan-in 阶段接收所有直接依赖的完整输出。
- 图片和视频必须位于 Pipeline workspace 内，才能被 QA 与发布工具访问。

## 人工审批与排期

- 使用 `gateMode="manual"` 创建 `Social Content Three Lanes` 模板。运行时会在阶段完成后暂停；操作员必须审阅并通过 Gate。
- 含真实发布工具的“发布执行”阶段还需要明确 `confirmPublish=true`，平台发布工具不会在未确认时执行。
- `schedule_at` 使用 ISO 8601 格式并写入 `publishing-schedule.schema.json`；预检必须检查同一账号、同一平台、相近时间窗口内的草稿或排期冲突。

## 健康检查与 CI

```bash
pnpm validate:social-workflow
pnpm health:social-workflow
```

健康检查只验证本地配置、工具授权与可选 ComfyUI 可达性；它不会登录账号、读取 Cookie 或执行发布操作。

## 运维 API

- `GET/POST /api/v1/social-workflow/schedules`
- `GET /api/v1/social-workflow/schedules/conflicts`
- `PATCH /api/v1/social-workflow/schedules/:id/status`
- `GET/POST /api/v1/social-workflow/monitor-jobs`
- `GET/PUT /api/v1/social-workflow/compliance-rules`

排期、监控任务和规则版本均按 workspace 隔离并持久化到数据库。
