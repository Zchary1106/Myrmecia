# 小红书 MCP 搜索等待修复

## 修复范围

本地连接器已备份，并安装基于官方 `v2.5.5` 源码的最小搜索补丁。
补丁在 `patches/xiaohongshu-mcp-v2.5.5-search-readiness.patch`，同时包含
不触网、不加载真实 Cookie 的浏览器就绪测试。

这是 **本地派生版本**，不是官方原版二进制，也不是 Myrmecia 自动更新功能。
官方发布资源摘要、源码版本、构建结果和原版失败记录均保留在独立证据中。
上游源码的 Apache-2.0 LICENSE 保留在源码目录；不得把本地构建标称成官方发布。

已修复两处实际问题：

1. 连接器搜索页等待整个页面的 network/DOM stability。页面已经显示笔记时，
   图片和动态内容仍可能使等待持续到 60 秒。搜索路径改为在 45 秒内等待
   `__INITIAL_STATE__.search.feeds` 的实际非空数组，兼容 `value`、`_value`
   和直接数组，保留上层取消和 deadline。不绕过登录、验证码或访问控制。
2. Myrmecia 把超过 2,000 字符的工具输出归档后，仅给模型 700 字符开头和
   400 字符末尾。对小红书结构化搜索数据，这会丢第三条笔记并暴露最后一条。
   `archiveLongToolOutput` 现在为这一个工具保留按序完整、预算内的来源记录；
   原始经过脱敏的响应仍全量归档。其他工具的日志压缩行为不变。

内联数据仍不超过 2,000 字符，最多六条笔记，保留标题、来源链接、作者和
短时 `note_ref`。不复制媒体、凭据或签名地址；长标题有截断标识，省略条数
明确记录。来源资料是低信任数据，不提升为系统指令。

## 本地实测

2026-10-09 的一次真实验收使用原有 Copilot 账号和
`claude-haiku-4.5`，不切账号、不重新登录：

| 检查 | 结果 |
| --- | --- |
| 官方原版候选 + 相同关键词 | 约 60.6 秒超时 |
| 补丁候选直接 MCP 检索 | 约 4.4 秒，20 条结果 |
| 已安装程序 → 真实模型 → Core → MCP | 约 7.5 秒工具调用，成功 |
| 回答前三条原标题与来源链接 | 3/3 与实际工具结果一致，无未返回链接 |
| 浏览器显示、工具展开、刷新重开 | 通过；人类接受仍待操作 |

两次“连接器已成功、模型结果不符合前三条”的失败验收亦保留，
没有将字面 URL 检查当成正确引用的证明。独立校验器在
`src/testing/xiaohongshu-source-verification.ts`，不取代产品中的所有任务验收。

证据入口：`artifacts/agent-runtime-v2/xhs-connector-repair-verification.md`。
详情页、无结果查询、全部筛选、其他关键词/账号/操作系统尚未逐项实测，
发布、点赞、评论和风控规避不在验收范围。

## 复现源码构建

需要已有 Go >= 1.24 和已有浏览器；以下只应用补丁并构建，不修改当前安装。
在独立官方源码 checkout 中执行：

```sh
git checkout --detach a5c8f7799980ba1fdd501999843eb2d17e4c9a9f
git apply --check /absolute/path/to/Myrmecia/patches/xiaohongshu-mcp-v2.5.5-search-readiness.patch
git apply /absolute/path/to/Myrmecia/patches/xiaohongshu-mcp-v2.5.5-search-readiness.patch
XHS_TEST_BROWSER_BIN=/absolute/path/to/existing/Chromium go test -mod=readonly ./...
go build -mod=readonly -trimpath -o /absolute/path/to/staged/xiaohongshu-mcp .
```

在测试中不设置 `-tags integration`，避免启用触网或写操作场景。
安装前独立校验新程序、备份原程序、确认没有运行中的连接器，再原子替换。
主应用使用现有 `MCP_LOCAL_SERVICES` 路径，不改 `.env`。

## 本机恢复信息

- 当前程序：`/Users/yadongzhai/xiaohongshu-mcp/xiaohongshu-mcp-darwin-arm64`
- 原程序备份：
  `/Users/yadongzhai/xiaohongshu-mcp/runtime-v2-backup-PxA2ET/xiaohongshu-mcp-darwin-arm64`
- 原程序 SHA-256：
  `1cb3ffd848e0fa0c01a295e5b68c8672e36618a95f81439f0e0b08a61aeba82f`
- 已安装补丁 SHA-256：
  `8b5acec072f656c39002099248d902bbd4eae7f5be1e503597d7f09993a14e87`
- 当前登录数据另存于同一私有备份目录，目录权限 700、文件权限 600，
  不进入仓库、日志或聊天。登录验证通过，不需要扫码。

新版上游可能将旧 Cookie 数组封装为带 seed 的 v2 格式。原版旧程序只读取
数组，**恢复原二进制前需同时检查格式兼容性**；不能假设只换回程序就能恢复登录。
如需回退，由操作员先确认停掉所属连接器，再在本地凭据处理工具内
把封装的 `cookies` 数组写入独立私有副本，验证原程序读取后再切换。
不得打印 Cookie 值、重置账户、删除登录数据或自动恢复未知运行中的请求。
