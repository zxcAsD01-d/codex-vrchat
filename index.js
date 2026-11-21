import { grepWithDeadline, enumerateUnity, collectSourceFindings, collectFileFindings } from "./lib/runtime.js";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createStore, answer, findCorpusRoot } from "./lib/search.js";
import { rankFindings, ruleInventory } from "./lib/lint.js";
import { readPage } from "./lib/docs.js";
import { buildIndex, lookup } from "./lib/api-table.js";
import {
  planProject,
  applyProject,
  summarize,
  ScaffoldError,
} from "./lib/project-scaffold.js";
import {
  FILTER_FIELDS,
  validateFilters,
  filterIndex,
  facet,
  describeLibraries,
} from "./lib/metadata.js";
import {
  BRIDGE_TEMPLATES,
  classifyProcess,
  decodeLockfilePid,
  detectCommandLineEvidence,
  detectProjectEvidence,
  inspectLicense,
  renderReport,
} from "./lib/unity-status.js";


const maxPages = 4;
const charBudget = 3200;
const NO_CORPUS_TEXT = "安装包缺少语料目录。请重新安装完整的 Codex VRChat 插件。";
const packageRoot = dirname(fileURLToPath(import.meta.url));
const dataDir = join(packageRoot, "data");

let manifest = null;
let apiIndexCache = null;
/** Provenance of the API table (its `source` page), kept for the tool's footer. */
let apiTableMetadata = null;

/**
 * The API availability index, built once from the build artifact.
 *
 * Returns null when the artifact is absent, so the tool degrades to an explicit
 * "table unavailable" answer instead of throwing.
 */
function ensureApiIndex() {
  if (apiIndexCache !== null) return apiIndexCache;
  const file = join(dataDir, "api-table.json");
  if (!existsSync(file)) return null;
  const table = JSON.parse(readFileSync(file, "utf8"));
  apiTableMetadata = table;
  apiIndexCache = buildIndex({
    types: (table.types ?? []).map((type) => ({
      ...type,
      members: (type.members ?? []).map((member) => ({
        raw: member.raw,
        name: member.name,
        kind: member.kind,
        params: [],
      })),
    })),
  });
  return apiIndexCache;
}

/**
 * One store per installed package. There is no workspace key: the corpus
 * belongs to the bundle, so every session in this process shares it.
 */
let store = null;

/**
 * Build (once) the retrieval store over the bundle's own corpus.
 *
 * The corpus is part of the plugin body, so a miss means the install is
 * incomplete — not that the user opened the wrong folder. The tools still work
 * (red lines come from `data/`), but retrieval must say so explicitly instead of
 * returning an empty digest that reads as "the library has nothing on this".
 */
function storeFor() {
  if (store === null) {
    // The PACKAGE root comes from this module's own URL — that is the "outside"
    // part, which must adapt to wherever the package was installed. The "inside"
    // part (which subdirectory holds the corpus) is this library's own layout and
    // stays declared in CORPUS_ENTRY, so a second library cannot leak into it.
    store = createStore(dataDir, findCorpusRoot(packageRoot));
  }
  return store;
}

/**
 * Build metadata — read once so the prompt can state provenance from the build
 * rather than from hardcoded text.
 */
function ensureManifest() {
  if (manifest === null) {
    manifest = JSON.parse(readFileSync(join(dataDir, "manifest.json"), "utf8"));
  }
  return manifest;
}


function scanReport(all, scanned, skipped, minSeverity) {
  const findings = rankFindings(all, minSeverity);
  const lines = [];

  if (scanned.length === 0) {
    lines.push("没有可扫描的文件。");
  } else if (findings.length === 0) {
    lines.push(`扫描 ${scanned.length} 个文件，在已实现的规则范围内没有发现问题。`);
  } else {
    lines.push(`扫描 ${scanned.length} 个文件，发现 ${findings.length} 处与硬约束冲突：`);
    let currentFile = null;
    for (const finding of findings) {
      if (finding.file !== currentFile) {
        lines.push("");
        lines.push(`◆ ${finding.file}`);
        currentFile = finding.file;
      }
      lines.push(`  L${finding.line} [${finding.severity}] ${finding.title}`);
      lines.push(`      ${finding.evidence}`);
      lines.push(`      依据：${finding.because}`);
      if (finding.alternative !== undefined) lines.push(`      替代：${finding.alternative}`);
    }
  }

  if (skipped.length > 0) {
    lines.push("");
    const shown = skipped.slice(0, 12);
    lines.push(`跳过 ${skipped.length} 项：${shown.join("；")}${skipped.length > shown.length ? " …" : ""}`);
  }

  lines.push("");
  lines.push(
    `已检查规则（${ruleInventory().length} 条，仅可机械判定者）：${ruleInventory()
      .map((rule) => rule.id)
      .join(" / ")}`,
  );
  lines.push("这是报告不是判决：报告干净不代表实现正确，你可以出于明确的视觉/玩法目的忽略其中某几条。");

  return {
    text: lines.join("\n"),
    ok: scanned.length > 0,
    findings: findings.map((f) => ({ ...f })),
    scanned,
    skipped,
  };
}

export function createProject(args, { allowWrite = false } = {}) {
  const options = {
    targetDir: args?.targetDir,
    type: args?.type,
    unityVersion: args?.unityVersion,
    force: args?.force === true,
  };

  let plan;
  try {
    plan = planProject(options);
  } catch (error) {
    if (error instanceof ScaffoldError) {
      const detail = error.detail ?? {};
      const lines = [`未创建（${error.code}）：${error.message}`];
      if (detail.contents) lines.push(`  目标现有内容：${detail.contents}`);
      if (detail.hint) lines.push(`  ${detail.hint}`);
      if (detail.backupPath) lines.push(`  备份位置：${detail.backupPath}`);
      return { text: lines.join("\n"), ok: false, code: error.code, targetDir: plan?.targetDir };
    }
    throw error;
  }

  if (!allowWrite || args?.dryRun === true) {
    return {
      text: [
        `[dry-run] 将创建 ${plan.type} 工程：${plan.targetDir}`,
        `  Unity ${plan.unityVersion} / SDK ${plan.resolvedSdk} 3.x`,
        `  目标状态：${plan.status}${plan.contents ? `（现有内容：${plan.contents}）` : ""}`,
        "将写入：",
        ...Object.keys(plan.files).map((f) => `  ${f}`),
        plan.backupDir ? `将先把原目录备份到：${plan.backupDir}` : "无需备份",
      ].join("\n"),
      ok: true,
      targetDir: plan.targetDir,
      files: Object.keys(plan.files),
      dryRun: true,
      backup: plan.backupDir,
    };
  }

  let result;
  try {
    result = applyProject(plan);
  } catch (error) {
    if (error instanceof ScaffoldError) {
      const detail = error.detail ?? {};
      const lines = [`创建失败（${error.code}）：${error.message}`];
      if (detail.backupPath) lines.push(`  原内容仍保留在：${detail.backupPath}`);
      if (detail.backupRestored === true) lines.push("  已把原目录还原到原位。");
      return { text: lines.join("\n"), ok: false, code: error.code, targetDir: plan.targetDir };
    }
    throw error;
  }

  const nextCommand = `vrc-get resolve -p "${plan.targetDir}"`;
  return {
    text: summarize(plan, result),
    ok: true,
    targetDir: plan.targetDir,
    backup: result.backup,
    files: result.files,
    nextCommand,
  };
}

export const tools = Object.freeze({
  vrchat_kb: {
    description:
      "查询本地 VRChat 创作知识库（Udon/UdonSharp、网络同步、Persistence、Avatar/PhysBone/Shader、Udon API、Quest 平台、设计模式、工程红线）。" +
      "在以下情况调用：要写 UdonSharp 代码、修改或优化 Avatar、配置 Shader、处理同步与持久化、判断某 API 在 Quest 上能否用、不确定某个 VRChat 组件/工具的用法。" +
      "返回的是合并后的完整约束与原文摘录（不是文件路径列表），所以一次调用即够——不要针对同一问题反复查询。",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "自然语言或关键词，例如「Udon 同步变量非 Owner 写入」「physbone 性能上限」「poiyomi quest 变体」。",
      },
      limit: {
        type: "integer",
        description: `最多返回多少页（默认 ${maxPages}）。`,
      },
    },
    async execute(args) {
      const query = typeof args?.query === "string" ? args.query.trim() : "";
      if (query.length === 0) throw new Error("vrchat_kb requires a non-empty query");
      const limit =
        Number.isSafeInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 12) : maxPages;

      // The corpus ships INSIDE this package, so a miss means the installation
      // is incomplete — never that the user opened the wrong folder. Retrieval
      // must say that plainly instead of returning an empty digest that reads
      // as "the library has nothing on this".
      // rather than return an empty digest that looks like "the library has
      // nothing on this".
      const store = storeFor();
      if (store.corpusRoot === null) {
        return { text: NO_CORPUS_TEXT, hit: false, pageCount: 0, routes: [] };
      }

      const result = answer(store, query, { limit, charBudget });
      return {
        text: result.text,
        hit: result.hit,
        pageCount: result.pageCount,
        routes: result.routes,
      };
    },
  },
  vrchat_kb_grep: {
    description:
      "在 VRChat 知识库内搜索，返回按文件分组、带行号的命中行。" +
      "参数与行为对齐内置 grep：pattern / include，命中格式 `path` + `Line N: 内容`。" +
      "拿到行号后用 vrchat_kb_read 读取该处上下文。用于精确定位某个符号、规则编号或关键词。",
    parameters: {
      pattern: {
        type: "string",
        required: true,
        description: "正则表达式（不区分大小写），如 `PropertyToID`、`RULE-LL-\\d+`。",
      },
      include: {
        type: "string",
        description: '按文件名过滤的 glob，如 "*.md"、"{index,limits-and-quirks}.md"。',
      },
    },
    async execute(args, exec) {
      const pattern = typeof args?.pattern === "string" ? args.pattern.trim() : "";
      if (pattern.length === 0) throw new Error("vrchat_kb_grep requires a non-empty pattern");
      const include = typeof args?.include === "string" ? args.include : undefined;
      // The corpus ships inside this package (see `CORPUS_ENTRY`), so this is
      // the same store every session reads — not a per-workspace one.
      const store = storeFor();
      if (store.corpusRoot === null) return { text: NO_CORPUS_TEXT, ok: false, total: 0, matches: [] };
      const result = await grepWithDeadline(pattern, include, exec.signal);
      return { text: result.text, ok: result.ok, total: result.total ?? 0, matches: result.matches ?? [] };
    },
  },
  vrchat_kb_read: {
    description:
      "读取 VRChat 知识库中的单个页面，返回带行号的正文。参数与输出对齐内置 read：" +
      "file_path / offset / limit，行格式 `N: 内容`，末尾给出续读提示。\n" +
      "\n" +
      "**默认跳过页面开头的 YAML 元数据。** 每页都有 title/tags/related 之类的 frontmatter（最多 35 行），" +
      "那不是知识正文。不传 offset 时从正文首行开始，并在末尾注明「跳过了第 1–N 行」，" +
      "要读元数据就显式传 offset=1。\n" +
      "\n" +
      "**行号不会因为跳过而漂移：输出的 N 永远是文件里的真实行号**，" +
      "所以 vrchat_kb_grep 报的 `Line 240` 可以直接用 offset=240 读回同一行。" +
      "两种取数方式（默认跳元数据 / 显式 offset）共用同一套行号，不需要换算。\n" +
      "\n" +
      "路径是库内相对的（可用 vrchat_kb_grep 取得），例如 entities/api/not-exposed.md。" +
      "语料随插件包分发，装在哪不需要你知道；也不接受绝对路径或安装路径。",
    parameters: {
      file_path: {
        type: "string",
        required: true,
        description: "库内页面路径，如 entities/api/not-exposed.md（可省略 .md）。不接受安装路径或绝对路径。",
      },
      offset: {
        type: "integer",
        description:
          "起始行（1-based），引用文件真实行号。**不传则从正文首行开始，自动跳过 YAML 元数据**；" +
          "传 1 则从文件第 1 行读起（含元数据）。",
      },
      limit: {
        type: "integer",
        description: `最多返回行数，默认 200，上限 400。`,
      },
    },
    async execute(args) {
      const filePath = typeof args?.file_path === "string" ? args.file_path.trim() : "";
      if (filePath.length === 0) throw new Error("vrchat_kb_read requires a non-empty file_path");
      // Deliberately NOT defaulting to 1: `readPage` treats an absent offset as
      // "start at the prose", skipping the YAML metadata every page carries.
      // Substituting 1 here would silently undo that and hand the model a block
      // of frontmatter instead of content.
      const offset = Number.isInteger(args?.offset) ? args.offset : undefined;
      const limit = Number.isInteger(args?.limit) ? args.limit : undefined;
      const store = storeFor();
      if (store.corpusRoot === null) {
        return {
          text: NO_CORPUS_TEXT,
          ok: false,
          path: null,
          // Echo the caller's offset only when one was given: reporting "1" for
          // an omitted offset would contradict the tool's own default, which
          // starts at the prose rather than at line 1.
          offset: Number.isInteger(offset) ? offset : null,
          totalLines: null,
          lines: [],
        };
      }
      const result = readPage(store.bodyOf, store.index.map((entry) => entry.path), filePath, offset, limit);
      return {
        text: result.text,
        ok: result.ok,
        path: result.path,
        offset: result.offset,
        totalLines: result.totalLines,
        lines: result.lines,
      };
    },
  },
  vrchat_kb_api: {
    description:
      "查询某个 Unity / VRChat 类型或成员在 Udon 中是否可用（依据 SDK 3.10.3 已暴露清单，80 个类型 / 1253 个成员）。" +
      "传入 `Type`、`Type.Member` 或裸成员名，如 `Component.CompareTag`、`GetComponent`、`Transform`。" +
      "注意：清单只收录**已暴露**成员，所以「未收录」不等于不可用——工具会明确区分「已暴露 / 类型已知但未列 / 完全无数据」三种情况。" +
      "用于判断某个 API 在 Udon 里能不能用，比凭印象可靠。",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "类型或成员，如 `Component.CompareTag`、`GetComponent`、`Transform`、`Physics.SphereCast`。",
      },
    },
    async execute(args) {
      const query = typeof args?.query === "string" ? args.query.trim() : "";
      if (query.length === 0) throw new Error("vrchat_kb_api requires a non-empty query");

      const index = ensureApiIndex();
      if (index === null) {
        return {
          // The table is a derived artifact shipped with the package, so its
          // absence means the install is incomplete — not that the user should
          // run a build. Say what to do, not what a maintainer would do.
          text:
            "API 查表不可用：本安装缺少 `data/api-table.json`（随包分发的派生数据）。\n" +
            "这不是你的操作问题——请重装插件，或检查安装是否被裁剪。",
          verdict: "unavailable",
        };
      }

      const result = lookup(index, query);
      const lines = [];

      // The table is derived from one page of the corpus, so whether that page
      // is readable is worth saying: a hit here with an unreadable source page
      // means a partial install, not that the answer is untrustworthy.
      const store = storeFor();
      const sourcePage = typeof apiTableMetadata?.source === "string" ? apiTableMetadata.source : null;
      const sourceReadable = sourcePage === null ? null : store.bodyOf(sourcePage) !== null;

      if (result.verdict === "exposed") {
        lines.push(`✅ 「${query}」已暴露，可用。`);
        lines.push(`  所属类型：${result.type}`);
        lines.push(`  匹配签名：`);
        for (const overload of result.overloads.slice(0, 12)) lines.push(`    ${overload}`);
        if (result.overloads.length > 12) lines.push(`    …共 ${result.overloads.length} 个重载`);
      } else if (result.verdict === "not-listed") {
        lines.push(`⚠️ 「${query}」未列入已暴露清单——这不等于不可用。`);
        lines.push(`  ${result.reason}`);
        if (Array.isArray(result.siblingMembers) && result.siblingMembers.length > 0) {
          lines.push(`  该类型下列出的成员可作参照：${result.siblingMembers.slice(0, 12).join("、")}`);
        }
        lines.push(`  若要确认，用 vrchat_kb 查该 API 的文档页，或在 Unity 里编译验证。`);
      } else if (result.verdict === "type") {
        lines.push(`📘 「${result.type}」在清单中，暴露率 ${result.exposureRate ?? "未知"}%。`);
        lines.push(`  本页列出 ${result.memberCount} 个已暴露成员（上游声明 ${result.declaredMemberCount ?? "?"} 个）：`);
        for (const member of result.members.slice(0, 25)) lines.push(`    ${member}`);
        if (result.members.length > 25) lines.push(`    …`);
      } else if (result.verdict === "type-and-member") {
        lines.push(`📘 「${query}」既是类型名也是成员名，两种解读都给出：`);
        lines.push(`  ${result.reason}`);
        lines.push(`  作为成员出现在：${[...new Set(result.overloads ?? [])].slice(0, 6).join("、")}`);
        lines.push(`  类型成员（前 12 条）：`);
        for (const member of (result.members ?? []).slice(0, 12)) lines.push(`    ${member}`);
      } else {
        lines.push(`❓ 无数据：「${query}」`);
        lines.push(`  ${result.reason}`);
        lines.push("  这不代表不可用——清单只覆盖 SDK 3.10.3 的已暴露成员。");
      }

      lines.push("");
      lines.push("（依据 entities/api/exposed-types.md，SDK 3.10.3 已暴露清单；未暴露成员无导出数据。）");
      if (sourceReadable === false) {
        lines.push(
          `⚠️ 但该来源页在当前安装里读不到（语料缺少 \`${String(sourcePage)}\`）：` +
            "查表结果仍可用，原文摘录不可用。可能是安装不完整。",
        );
      } else if (sourceReadable === true && sourcePage !== null) {
        lines.push(`要看原文：\`vrchat_kb_read("${sourcePage}")\`。`);
      }
      return { text: lines.join("\n"), verdict: result.verdict };
    },
  },
  vrchat_kb_unity: {
    description:
      "查看本机正在运行的 Unity 编辑器 / Unity Hub 进程、它们对应的项目路径、项目的编辑器版本与锁定情况，" +
      "以及「看起来像 MCP 端点」的本地端口（这是可能性，不是证明）。" +
      "只读。只报告许可证日期和桥接线索。" +
      "装了 unity-mcp-cli 的话，它自带的 status 会给出更细的连接状态。",
    parameters: {
      projectPath: {
        type: "string",
        description: "可选：额外检查某个绝对项目路径的编辑器版本与 lockfile 状态。",
      },
    },
    async execute(args, exec) {
      const outcome = await enumerateUnity(exec.signal);
      if (outcome.error) {
        return { text: "Unity 进程探查失败：" + outcome.error, ok: false, editors: 0, hubs: 0, evidence: 0 };
      }
      const { procs: rawProcs, cli } = outcome.snapshot;
      const diagnostics = outcome.diagnostics;

      const processes = [];
      for (const raw of rawProcs) {
        const classified = classifyProcess({
          pid: Number(raw.ProcessId),
          name: String(raw.Name ?? ""),
          executablePath: raw.ExecutablePath ?? null,
          commandLine: raw.CommandLine ?? "",
        });
        if (classified === null) continue;
        processes.push(classified);
      }

      // Command-line evidence: a process that names MCP arguments, plus the
      // port that SAME line declares. No port sweep happens here.
      const commandEvidence = [];
      for (const process of processes) {
        for (const match of detectCommandLineEvidence(process)) {
          commandEvidence.push({ pid: process.pid, ...match });
        }
        if (process.kind === "mcp-server") {
          commandEvidence.push({
            pid: process.pid,
            bridgeId: process.bridgeId,
            label: BRIDGE_TEMPLATES.find((b) => b.id === process.bridgeId)?.label ?? process.bridgeId,
            evidence: [`进程名 ${process.name}`],
            port: null,
          });
        }
      }

      // Projects: the ones named on a command line, plus an optional explicit one.
      const projects = [];
      const seen = new Set();
      const addProject = (projectPath, lockedByPid) => {
        if (projectPath === null || seen.has(projectPath)) return;
        seen.add(projectPath);
        const normalized = projectPath.replace(/\\/g, "/");
        let editorVersion = null;
        try {
          const versionFile = join(projectPath, "ProjectSettings", "ProjectVersion.txt");
          if (existsSync(versionFile)) {
            const text = readFileSync(versionFile, "utf8");
            const match = /m_EditorVersion:\s*(\S+)/.exec(text);
            editorVersion = match === null ? null : match[1];
          }
        } catch {
          /* an unreadable project is reported without a version */
        }
        const bridgeEvidence = detectProjectEvidence(
          normalized,
          (p) => readFileSync(p, "utf8"),
          (p) => existsSync(p),
        );
        projects.push({ path: projectPath, editorVersion, lockedByPid, bridgeEvidence });
      };

      for (const process of processes) {
        if (process.projectPath === null) continue;
        addProject(process.projectPath, process.kind === "editor" ? process.pid : null);
      }
      if (typeof args?.projectPath === "string" && args.projectPath.trim().length > 0) {
        if (!isAbsolute(args.projectPath)) throw new Error("projectPath 必须是绝对路径");
        addProject(args.projectPath, null);
      }

      // A live lockfile names the editor pid holding a project.
      for (const project of projects) {
        try {
          const lockFile = join(project.path, "Temp", "UnityLockfile");
          if (!existsSync(lockFile)) continue;
          const pid = decodeLockfilePid(new Uint8Array(readFileSync(lockFile)));
          if (pid !== null) project.lockedByPid = pid;
        } catch {
          /* a stale or unreadable lockfile leaves the state unknown */
        }
      }

      // The license is checked on every run: an expired one makes Unity refuse
      // to open a project and fail builds, with errors that point at the project.
      // Only the DATE fields are read — the .ulf file holds keys and they are
      // never touched.
      const license = process.platform === "win32" ? inspectLicense({
        programData: process.env.ProgramData ?? "C:\\ProgramData",
        exists: (p) => existsSync(p),
        readText: (p) => {
          try {
            return readFileSync(p, "utf8");
          } catch {
            return null;
          }
        },
      }) : undefined;

      const text = renderReport({
        processes,
        projects,
        commandEvidence,
        cliDetected: cli,
        diagnostics,
        license,
      });

      return {
        text,
        ok: true,
        editors: processes.filter((p) => p.kind === "editor").length,
        hubs: processes.filter((p) => p.kind === "hub").length,
        evidence: commandEvidence.length + projects.reduce((acc, p) => acc + p.bridgeEvidence.length, 0),
      };
    },
  },
  vrchat_kb_filter: {
    description:
      "按元数据筛选知识库页面，返回匹配的库内路径与标题（不含正文）。用于「哪些页是 high 可信度」「Quest 相关的 deprecated 页有哪些」" +
      "这类结构化问题——这类词在每页的 YAML 元数据里，用 grep 搜会命中几乎所有页，只有筛选才有意义。\n" +
      "\n" +
      "可筛选字段：type / category / confidence / status / tags / title / path。" +
      "多个字段之间是 AND；tags 给多个值时要求全部命中。字段名拼错会报错并列出可用字段，不会静默返回全部。\n" +
      "\n" +
      "只要 buckets 想看分布（比如「有哪些 category」），把 filters 留空并传 buckets。",
    parameters: {
      filters: {
        type: "object",
        description:
          "筛选条件。例：{\"confidence\":\"high\",\"category\":\"world\"}。可用键：" +
          "type / category / confidence / status / tags（数组）/ title / path。留空=全部。",
        properties: {
          type: { type: "string", description: "entity / concept / governance / navigation / summary" },
          category: { type: "string", description: "world / avatar / api / patterns / platform / rules / hybrid / misc / meta" },
          confidence: { type: "string", description: "high / medium / low" },
          status: { type: "string", description: "active / draft / deprecated" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "标签数组，要求全部命中，如 [\"sync\",\"performance\"]。",
          },
          title: { type: "string", description: "标题子串（大小写不敏感）" },
          path: { type: "string", description: "库内路径子串，如 entities/api" },
        },
        additionalProperties: false,
      },
      buckets: {
        type: "array",
        items: { type: "string" },
        description: "可选：额外返回这些字段的取值分布，如 [\"category\",\"confidence\"]。",
      },
      limit: { type: "number", description: "最多返回条数，默认 40，上限 200。" },
    },
    async execute(args) {
      const store = storeFor();
      if (store.corpusRoot === null) {
        return { text: NO_CORPUS_TEXT, count: 0, paths: [] };
      }

      const filters = args?.filters === undefined ? {} : args.filters;
      const invalid = validateFilters(filters);
      if (invalid !== null) {
        return { text: `筛选条件无效：${invalid}`, count: 0, paths: [] };
      }

      const matched = filterIndex(store.index, filters);
      const cap = Number.isSafeInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 40;
      const shown = matched.slice(0, cap);

      const lines = [];
      const label = Object.keys(filters).length === 0 ? "全部" : JSON.stringify(filters);
      lines.push(`筛选 ${label} → ${matched.length} 页${matched.length > shown.length ? `（列出前 ${shown.length}）` : ""}`);

      if (matched.length > 0) {
        lines.push("");
        for (const entry of shown) {
          const bits = [entry.type, entry.category, entry.confidence, entry.status].filter((x) => x !== null && x !== undefined);
          lines.push(`  ${entry.path}`);
          lines.push(`    ${entry.title}  [${bits.join(" · ")}]`);
        }
        if (matched.length > shown.length) lines.push(`  … 还有 ${matched.length - shown.length} 页`);
      }

      // Buckets answer "what values exist" without the caller guessing and
      // getting an empty result from a misspelled enum.
      const bucketFields = Array.isArray(args?.buckets) ? args.buckets.filter((f) => typeof f === "string") : [];
      for (const field of bucketFields) {
        const unknown =
          !Object.hasOwn(FILTER_FIELDS, field) && !["title", "path"].includes(field) && field !== "tags";
        if (unknown) {
          lines.push("");
          lines.push(`  分布「${field}」：字段不存在。可用：${Object.keys(FILTER_FIELDS).join(", ")}`);
          continue;
        }
        const counts = facet(store.index, field);
        lines.push("");
        lines.push(`  分布「${field}」（${counts.length} 种）：`);
        for (const [value, count] of counts.slice(0, 20)) lines.push(`    ${String(count).padStart(4)}  ${value}`);
        if (counts.length > 20) lines.push(`    … 还有 ${counts.length - 20} 种`);
      }

      lines.push("");
      lines.push("要看正文：把上面的路径交给 `vrchat_kb_read`。");

      return { text: lines.join("\n"), count: matched.length, paths: shown.map((entry) => entry.path) };
    },
  },
  vrchat_kb_list: {
    description:
      "列出当前已加载的知识库及其概况：版本、页数、构建日期、分类与类型分布、可信度分布，" +
      "并提示有多少 draft / deprecated 页（引用前该先看 status）。" +
      "不确定「这里有什么可查」时先调它，比直接检索更省。\n" +
      "\n" +
      "只报告已加载的库；若本安装缺少自带语料，会明说缺少而不是列空。",
    parameters: {},
    async execute() {
      const store = storeFor();
      const text = describeLibraries({
        manifest: ensureManifest(),
        index: store.index,
        corpusRoot: store.corpusRoot,
        dataDir,
      });
      return {
        text,
        libraries: store.corpusRoot === null ? 0 : 1,
        pages: store.corpusRoot === null ? 0 : store.index.length,
      };
    },
  },
  vrchat_kb_scan: {
    description: "扫描已读取的 .cs / .shader 内容，报告 VRChat 硬约束违例。文件或目录批量扫描使用 vrchat-create 技能中的本地 CLI。",
    parameters: {
      sources: { type: "array", required: true, minItems: 1, maxItems: 32, items: {
        type: "object", required: ["path", "text"], additionalProperties: false,
        properties: { path: { type: "string", maxLength: 2048 }, text: { type: "string", maxLength: 262144 } },
      } },
      minSeverity: { type: "string", enum: ["high", "medium", "low"] },
    },
    async execute({ sources, minSeverity = "low" }) {
      return scanSources(sources, minSeverity);
    },
  },
  vrchat_kb_project_new: {
    description: "预演 World 或 Avatar 工程骨架。实建使用 vrchat-create 技能中的本地 CLI。创建后仍需用 VPM 解析 SDK。",
    parameters: {
      targetDir: { type: "string", required: true, description: "绝对目标路径，父目录须已存在。" },
      type: { type: "string", required: true, enum: ["world", "avatar"] },
      unityVersion: { type: "string", description: "Unity 版本，默认 2022.3.22f1。" },
      force: { type: "boolean", description: "已有目录时预演备份路径。" },
      dryRun: { type: "boolean", enum: [true], description: "MCP 始终仅预演。" },
    },
    async execute(args) {
      if (!isAbsolute(args.targetDir)) throw new Error("targetDir 必须是绝对路径");
      return createProject(args);
    },
  },
});


export function pluginStatus(mode = "stats", counts = null) {
  const meta = ensureManifest();
  const store = storeFor();
  const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(meta.builtAt)) / 86_400_000));
  const pages = store.corpusRoot === null ? 0 : store.index.length;
  const rules = ruleInventory().length;
  const lines = [
    "VRChat Creator · 知识库 v" + meta.libraryVersion + " · " + pages + " 页",
    "构建 " + meta.builtAt + "（快照 " + ageDays + " 天）",
    "语料来源提交 " + meta.upstreamCommit,
  ];
  if (mode === "stale") {
    lines.push("快照年龄来自本地构建日期。在线是否有新版需到上游确认。");
  } else {
    lines.push("关键词路由 " + store.routes.length + " 条 · 静态规则 " + rules + " 条");
    lines.push("安装时无全局专家提示注入。创作指南可通过 vrchat-create 按需读取。");
    if (counts !== null) {
      const entries = Object.entries(counts);
      lines.push("当前 MCP 连接调用量 " + (entries.length ? entries.map(([name, count]) => name + " " + count).join(" / ") : "0"));
    }
  }
  if (pages === 0) lines.push(NO_CORPUS_TEXT);
  return { text: lines.join("\n"), ok: pages > 0, pages, ageDays, rules, counts, manifest: meta };
}

function scanSources(sources, minSeverity) {
  const result = collectSourceFindings(sources);
  return scanReport(result.findings, result.scanned, result.skipped, minSeverity);
}

export async function scanPaths(paths, minSeverity = "low") {
  if (!["high", "medium", "low"].includes(minSeverity)) throw new Error("级别必须为 high、medium 或 low");
  const result = await collectFileFindings(paths, process.cwd());
  return scanReport(result.findings, result.scanned, result.skipped, minSeverity);
}
