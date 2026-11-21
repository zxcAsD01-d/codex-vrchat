# Codex VRChat 架构与验证

插件根目录是安装和打包单位。`plugin.json` 提供身份和 UI 元数据，`.agents/plugins/marketplace.json` 提供本地与 Git marketplace 条目。`mcp.json` 声明 Agent Plugins stdio MCP 服务，`.mcp.json` 提供 Codex 兼容配置。兼容配置用 `cwd: "./"` 从安装根启动服务。技能统一位于 `skills/<name>/SKILL.md`。

`server.mjs` 负责 MCP 初始化、工具发现、参数验证、调用取消和结果编码。`index.js` 负责整合检索、API、扫描、工程计划和状态。`lib/` 保留词法准入与路由、API 查表、行号、元数据、lint 和 Unity 诊断逻辑。语料文件按需从 `VRChat-Agent-Creator-Library/` 读取。正则搜索有独立 worker 和时限。

工程计划通过 MCP 查看。实建和路径扫描通过 `cli.mjs`，可使用 Codex 的项目工作目录执行命令。工程实建在同一父目录暂存，并在提交前重新核对目标，对已有目录保留独立备份。知识库工具的路径作用域限于索引内的语料。Unity 探针通过 PowerShell 查询 Windows 的只读信息，输出许可日期与桥接证据摘要。

`tools/build-knowledge.mjs` 从固定语料与 `content-src/` 生成派生文件。版本随快照记录。上游文件作为普通文件进入 Git，便于 marketplace、源码归档和 ZIP 安装获取完整文件。`upstream.json` 记录上游提交。运行与构建只依赖 Node.js 内置模块。

## 验证命令

| 命令 | 验证内容 |
|---|---|
| `npm run build` | 重建索引、域指南、关键词路由、API 表和 manifest |
| `npm test` | 上游核心回归、技能入口和链接、检索与行号、项目预演、落盘、强制备份与恢复、目录扫描、Unity 探测 |
| `npm run test:codex` | 用隔离的 Codex 配置真实安装 marketplace 和插件，经 Codex app-server 检查技能和调用 MCP 工具 |

测试已覆盖 SDK 3.10.6 的 World/Avatar 样本包解析，以及 World 静态审计脚本。Unity 编辑器打开、导入、Build & Test 和上传需要独立的运行时验收。
