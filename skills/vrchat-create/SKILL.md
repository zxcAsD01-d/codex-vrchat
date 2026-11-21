---
name: vrchat-create
description: VRChat 创作模式。用于从目标到交付的 World、Avatar 或 Shader 工作，以及本插件的工程预演、源码扫描和安装自检。单次 API 或组件查询可直接用知识库工具。
---

# VRChat 创作模式

- 确认 World、Avatar 或 Shader 范围、目标平台和本机 Unity/SDK 版本。已有项目先以项目记录为准。Windows 上用 MCP 的 `vrchat_kb_unity` 查看进程和许可证。实时编辑另行验证 Unity MCP 桥、活动场景、编译状态和目标对象。
- 看 [通用硬约束](../../data/t0-core.txt)。按需读 [World](../../data/t1-world.txt)、[Avatar](../../data/t1-avatar.txt)、[Shader](../../data/t1-shader.txt) 或 [覆盖地图](../../data/domain-map.txt)。从零做概念、资产和工程时读 [创作工作流](../../data/persona-prefix.txt) 的相关小节。
- World 分流到 `vrchat-world`，Avatar 审计交给 `inspect-vrchat-avatar-project`，包管理用 `vrc-get-cli`。外部工具参考 [随包推荐表](../vrchat-world/docs/RECOMMENDED_OPEN_SOURCE_SKILLS.md)。
- 通过 `vrchat_kb` 找证据，`vrchat_kb_api` 查 SDK 暴露表，`vrchat_kb_grep` + `vrchat_kb_read` 对齐原文行号。报告中注明依据的知识库或 SDK 版本。分别记录静态检查、Editor 连接、SDK 构建和运行时结果。

## 工程与路径扫描

`cli.mjs` 位于本文件向上两层的插件根目录。把下面的 `<插件根目录>` 替换为从本技能实际路径解析出的绝对位置。通过 Codex 的终端工具执行，使用项目所在工作目录。

```text
node "<插件根目录>/cli.mjs" project-new --type world -- "<目标路径>"
node "<插件根目录>/cli.mjs" project-new --type world --apply -- "<目标路径>"
node "<插件根目录>/cli.mjs" scan -- "<源文件或目录>"
```

`avatar` 创建 Avatar 工程。先看预演结果，用户要求创建时用 `--apply`。有旧目标且用户确认备份后再用 `--force`。随后用 `vrc-get` 或 VPM 管理器解析 SDK，再用实际 Unity 打开确认。对单个已读文件可以直接把内容交给 MCP 的 `vrchat_kb_scan`。

## 状态

`vrchat_kb_status` 的 `stats` 和 `stale` 模式显示版本、构建年龄、规则数量和当前 MCP 连接的调用次数。也可运行 `node "<插件根目录>/cli.mjs" stats` 或 `stale`。
