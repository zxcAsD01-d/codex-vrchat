
import { parseArgs } from "node:util";
import { createProject, scanPaths, pluginStatus, tools } from "./index.js";

const help = [
  "用法",
  "  node cli.mjs stats [--json]",
  "  node cli.mjs stale [--json]",
  "  node cli.mjs scan [--min-severity high|medium|low] [--json] -- <路径...>",
  "  node cli.mjs project-new --type world|avatar [--unity-version 2022.3.22f1] [--force] [--apply] [--json] -- <目标目录>",
  "  node cli.mjs unity [--json] [-- <绝对项目路径>]",
  "project-new 默认预演。--apply 才创建工程。--force 会先备份现有目录。",
].join("\n");

async function main([command, ...args]) {
  if (!command || ["--help", "help", "-h"].includes(command)) {
    console.log(help);
    return;
  }
  const common = { json: { type: "boolean" } };
  const options = {
    stats: common,
    stale: common,
    unity: common,
    scan: { ...common, "min-severity": { type: "string" } },
    "project-new": {
      ...common,
      type: { type: "string" },
      "unity-version": { type: "string" },
      force: { type: "boolean" },
      apply: { type: "boolean" },
    },
  };
  if (!Object.hasOwn(options, command)) throw new Error("未知命令。运行 node cli.mjs help 查看用法。");
  const { values, positionals } = parseArgs({ args, options: options[command], allowPositionals: true });
  let result;
  switch (command) {
    case "stats":
    case "stale":
      if (positionals.length !== 0) throw new Error(command + " 不接受路径");
      result = pluginStatus(command);
      break;
    case "scan":
      if (positionals.length === 0) throw new Error("scan 需要至少一个路径");
      result = await scanPaths(positionals, values["min-severity"]);
      break;
    case "unity":
      if (positionals.length > 1) throw new Error("unity 最多接受一个项目路径");
      result = await tools.vrchat_kb_unity.execute({ projectPath: positionals[0] }, {});
      break;
    case "project-new":
      if (positionals.length !== 1) throw new Error("project-new 需要一个目标目录");
      result = createProject({
        targetDir: positionals[0],
        type: values.type,
        unityVersion: values["unity-version"],
        force: values.force,
      }, { allowWrite: values.apply === true });
      break;
  }
  console.log(values.json ? JSON.stringify(result) : result.text);
  if (result.ok === false) process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(error.message + "\n");
  process.exitCode = 2;
}
