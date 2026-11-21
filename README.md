# Codex VRChat

面向本地 Codex 的 VRChat 创作插件。插件包含离线知识库、Udon API 查表、源码扫描、Windows Unity 状态探测、World 和 Avatar 工程骨架，以及六项原有技能和新的 `vrchat-create` 入口。

## 安装

将插件 ZIP 解压到长期保留的位置，或克隆已包含迁移提交的仓库。安装和使用需要本地 Codex 与可从其环境访问的 **Node.js 20 或以上**。语料、索引、技能和测试都在包内，解压后即可安装。

在解压后的插件根目录运行以下命令。在 Windows PowerShell、macOS 和 Linux 上都可以用同一组命令。

```sh
codex plugin marketplace add .
codex plugin add codex-vrchat@vrchat-creator
```

也可以先添加 marketplace，然后重新打开 Codex，在插件目录的 **VRChat Creator** 来源下选择 **VRChat Creator** 并安装。安装后在新会话问「列出 VRChat 知识库版本和覆盖范围」，应能调用 `vrchat_kb_list`。如果 MCP 未启动，检查在运行 Codex 的主机上执行 `node --version`，以及 Codex 的 MCP 启动日志。命令行安装记录在 Codex 配置中，可通过下列命令移除。

```sh
codex plugin remove codex-vrchat@vrchat-creator
codex plugin marketplace remove vrchat-creator
```

## 功能

| 需求 | Codex 入口 |
|---|---|
| 查 VRChat 概念或限制 | `vrchat_kb`，返回命中页与摘录 |
| 搜索并引用原文行号 | `vrchat_kb_grep` 与 `vrchat_kb_read` |
| 判断 Udon API 暴露情况 | `vrchat_kb_api`，当前包依据 SDK 3.10.3 摘录 |
| 查看分类、标签和可信度 | `vrchat_kb_filter` 与 `vrchat_kb_list` |
| 诊断 Unity 进程、项目锁和许可证 | `vrchat_kb_unity`，支持 Windows。桥接线索可用于后续连接验证 |
| 扫描 C# 和 Shader | `vrchat_kb_scan` 接收已读取的源码正文，`cli.mjs scan` 接收文件与目录路径 |
| 从零创建 World 或 Avatar 工程 | `vrchat_kb_project_new` 预演，`cli.mjs project-new --apply` 写入骨架 |
| 查看版本、快照日期与用量 | `vrchat_kb_status`，或 `cli.mjs stats` / `stale` |
| 启用原专家工作流 | 搜索并选用 `codex-vrchat:vrchat-create`，或在会话里明确要求使用它 |

`vrchat-create` 按任务加载原有红线、覆盖地图、领域约束和创作流程。World 有 `vrchat-world`、`design-modular-vrchat-world`、`build-vrchat-world`、`coordinate-transform-audit`。Avatar 有 `inspect-vrchat-avatar-project`。VPM 包管理用 `vrc-get-cli`。

### 终端使用

在插件根目录执行示例。若从 Unity 项目执行，用 `cli.mjs` 的绝对路径。

```sh
node cli.mjs stats
node cli.mjs stale
node cli.mjs scan -- "/path/to/project/Assets"
node cli.mjs project-new --type world -- "/path/to/new-world"
node cli.mjs project-new --type world --apply -- "/path/to/new-world"
vrc-get resolve -p "/path/to/new-world"
```

工程目标的父目录须已存在。`--type avatar` 可创建 Avatar 骨架。已有目标需要 `--force`，旧目录移到同级备份。恢复时先把新工程改名，然后把备份改回原名。默认 Unity 版本为模板使用的 `2022.3.22f1`，可以用 `--unity-version` 指定，打开工程前请核对项目和 SDK 的约束。工程初始化后需解析 VPM 依赖，再由 Unity 补全项目设置。

Unity 场景实时操作需要额外连接符合当前项目的 Unity MCP 桥。技能记录的证据层级也适用于离线诊断。当前 MCP 用量范围是单个连接。原宿主的输入框监控、跨会话账本、精确注入 token 与重复查询提示属于宿主界面或事件能力，在 Codex 版中以按需工作流、快照统计和连接调用量替代。

## 开发与来源

```sh
npm run build
npm test
npm run test:codex
```

构建从仓库内固定来源生成 `data/`。更新上游时同步更新 `upstream.json` 的提交及许可文件，再重建并提交派生数据。参见[架构与验证](docs/vrchat-kb-architecture.md)。

改编自 VRChatCN-Kipfel/dsh-vrchat，保留 [MIT 许可](LICENSE)。固定语料、World 技能、Avatar 技能的来源和提交由 `upstream.json` 记录，许可分别在各自目录内。
