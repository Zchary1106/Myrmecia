# Myrmecia Electron Desktop MVP（v1）

## 架构与生命周期

桌面端位于 `packages/desktop`（`@myrmecia/desktop`）。Electron **不**在主进程内嵌 Express：主进程先显示本地 splash/诊断页，再使用系统 Node.js 启动独立子进程 `server/dist/index.js`。子进程传入空闲的 `127.0.0.1` 端口、`DB_PATH=<userData>/myrmecia.db`、`SERVE_DASHBOARD_DIR` 和运行资源目录；其工作目录与 task workspace 均位于可写的 `userData`，只读安装资源只用于读取 server、Dashboard、agent 和模板文件。健康检查 `GET /health` 成功后，才创建并载入同源 Dashboard 窗口。这样 Dashboard 的相对 `/api/v1` 与 `/ws` 请求仍然同源。

启动从 3000 起有限范围探测端口，绝不终止占用端口的其他程序。每次启动会生成随机健康令牌，只有带令牌的 `GET /health` 才会确认该端口上的服务确实是本次拉起的 server，避免端口竞争时误载入无关本地服务。标准输出与错误输出写入 `<userData>/logs/server.log`。子进程异常退出会回到 splash，用户可重试或退出；退出时先只向该子进程发 `SIGTERM`，等待后才对该 PID 发 `SIGKILL`。应用使用 singleton lock。

## 安全边界

- Dashboard 窗口采用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，没有 preload。
- splash 同样采用严格设置，CommonJS preload（Electron sandbox 的兼容格式）只通过 `contextBridge` 提供启动状态、重试、退出、模型配置与 doctor IPC；不提供文件、shell、环境变量或密钥读取。
- 导航只允许当前 `http://127.0.0.1:<port>`；仅 HTTP(S) 外部导航会交给系统默认浏览器，其他协议会被阻止。
- `SERVE_DASHBOARD_DIR` 未设置时服务端行为完全不变。设置后，静态文件与 SPA fallback 在 API/auth 路由之后、全局错误处理之前注册，并明确避开 `/api`、`/auth`、`/health`、`/metrics`、`/ws`。

## 资源、配置与打包

开发模式从仓库的 `packages/shared/dist`、`packages/server/dist`、`packages/dashboard/dist`、`agents/`、`templates/` 和 `packages/python-runtime/` 读取。打包模式用 electron-builder `extraResources` 将它们分别放在 `resources/server`、`dashboard`、`agents`、`templates`、`python-runtime`；`stage-resources.mjs` 先构建 shared/server/dashboard，再以 `pnpm deploy --prod` 生成仅供打包的 `packages/desktop/.stage/server`。它同时写入构建 Node 的版本、ABI、平台和架构元数据；启动时会拒绝不匹配的系统 Node，防止 `better-sqlite3` 发生原生 ABI 崩溃。electron-builder 默认忽略 `extraResources` 内的 `node_modules`，所以 `after-pack.mjs` 会在签名前将 staged 的生产依赖显式复制到 `resources/server/node_modules`。这避免把 server 的 `better-sqlite3` 按 Electron ABI 重编译：它由系统 Node.js 执行，随 deploy 的 Node 依赖一起使用。

```bash
pnpm dev:desktop          # 构建 server/dashboard，启动 Electron
pnpm --filter @myrmecia/desktop typecheck
pnpm package:desktop      # stage + electron-builder
```

用户数据（SQLite、日志与工作区）均在 Electron `userData`，不会写入安装目录。每次启动都会先显示 Provider 选择页，可选择 **GitHub Copilot**、**DeepSeek** 或通用 OpenAI-compatible Provider；保存的配置只会预选相应 Provider，不会绕过选择页直接启动。Copilot 使用本机已登录的 Copilot CLI/SDK 凭据，不保存 GitHub Token，也不要求 API Key；DeepSeek 默认直连 `https://api.deepseek.com` 和 `deepseek-v4-flash`，其 API Key 仅在 Electron 主进程使用系统凭据库加密后保存于 `runtime-config.json`，不暴露给 Dashboard。Copilot 启动时使用账号自适应的 `auto` 模型，进入 Dashboard 后可在 Models 页面发现并切换当前账号实际可用的模型；用户需先在本机完成 Copilot GitHub 登录并具有有效订阅。配置 JSON 损坏或凭据无法解密时，splash 会回到可编辑的恢复状态，允许用户直接覆盖配置。若 Linux 缺少受支持的凭据库，应用拒绝保存 API Key，并提示通过环境变量提供。`MYRMECIA_DESKTOP_USER_DATA` 可为测试或受控部署指定单独的绝对用户数据目录。`MYRMECIA_NODE_PATH` 可指定系统 Node 可执行文件；否则从继承的 `PATH` 和常见系统安装位置寻找 `node`。`MYRMECIA_PYTHON_PATH` 可指定 Python 可执行文件；未指定时 Windows 按 `py -3`、`python`、`python3` 依次探测，其他系统使用 `python3`。doctor 检查 Node、Python 和 `crewai/litellm/yaml`；Python 检查为可选，不阻止仪表板启动，也不提供不透明的 pip 安装按钮。

## v1 限制

安装包**不捆绑** Node.js 或 Python：需要系统 Node.js 20+，且 Node ABI、平台和架构必须匹配该安装包随附的 `desktop-runtime.json`（启动诊断会明确报告不匹配）。使用 GitHub Copilot SDK 时，Node.js 还必须为 20.19+ 或 22.12+。由于 server 带有原生 Node 模块，electron-builder 的 `beforePack` 会拒绝跨 OS 或跨架构构建；发布构建必须在每个目标系统/架构的 CI runner 上分别生成。Python agent runtime 还需要 `python3` 及 `packages/python-runtime/requirements.txt` 中的依赖。首次启动时间取决于现有 server 初始化；当前 MVP 仅支持本机 HTTP 回环地址、没有自动更新和没有跨机器服务模式。
