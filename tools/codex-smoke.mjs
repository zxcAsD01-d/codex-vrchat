
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url)));
const expectedManifest = JSON.parse(readFileSync(join(root, "data", "manifest.json"), "utf8"));
const fixture = mkdtempSync(join(tmpdir(), "Codex VRChat smoke "));
const codex = process.env.VRCHAT_TEST_CODEX_EXE ?? "codex";
const env = { ...process.env, CODEX_HOME: join(fixture, "config") };
mkdirSync(env.CODEX_HOME);
const cwd = fixture;
let server;
function command(...args) {
  const result = spawnSync(codex, args, { cwd, env, encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, JSON.stringify(args) + "\n" + String(result.error ?? result.stderr));
  return result.stdout;
}

try {
  console.log(command("--version").trim());
  console.log(command("plugin", "marketplace", "add", root, "--json").trim());
  const installed = JSON.parse(command("plugin", "add", "codex-vrchat@vrchat-creator", "--json"));
  console.log("Installed: " + installed.pluginId);
  assert.ok(readFileSync(join(installed.installedPath, ".mcp.json"), "utf8").includes("vrchat-kb"));
  const pluginPath = join(root, ".agents", "plugins", "marketplace.json");
  server = spawn(codex, ["app-server", "--listen", "stdio://"], {
    cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let stderr = "";
  server.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-30000); });
  const lines = createInterface({ input: server.stdout });
  const pending = new Map();
  let nextId = 0;
  function send(method, params) {
    const id = ++nextId;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(method + " 超时\n" + stderr));
      }, 20000);
      pending.set(id, (packet) => {
        clearTimeout(timer);
        if (packet.error) rej(new Error(method + " " + JSON.stringify(packet.error)));
        else res(packet.result);
      });
      server.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  lines.on("line", (line) => {
    const packet = JSON.parse(line);
    const callback = pending.get(packet.id);
    if (!callback) return;
    pending.delete(packet.id);
    callback(packet);
  });
  await send("initialize", { clientInfo: { name: "vrchat-smoke", title: "VRChat smoke", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  server.stdin.write('{"method":"initialized"}\n');
  const plugin = await send("plugin/read", { marketplacePath: pluginPath, pluginName: "codex-vrchat" });
  const pluginSkills = plugin.plugin?.skills ?? plugin.skills;
  assert.ok(Array.isArray(pluginSkills), JSON.stringify(plugin).slice(0, 1400));
  assert.deepEqual(pluginSkills.map((entry) => entry.name.split(":").at(-1)).sort(), [
    "build-vrchat-world", "coordinate-transform-audit", "design-modular-vrchat-world", "inspect-vrchat-avatar-project", "vrc-get-cli", "vrchat-create", "vrchat-world",
  ]);
  console.log("Codex plugin/read: all seven skills detected");
  const thread = await send("thread/start", { cwd, ephemeral: true, approvalPolicy: "never" });
  const status = await send("mcpServerStatus/list", { threadId: thread.thread.id });
  const mcp = status.data?.find((entry) => entry.name.includes("vrchat-kb"));
  assert.ok(mcp, JSON.stringify(status).slice(0, 1500) + "\n" + stderr);
  assert.equal(Object.keys(mcp.tools).length, 10, JSON.stringify(mcp).slice(0, 1400) + "\n" + stderr);
  console.log("Codex mcpServerStatus/list: ten tools loaded from " + mcp.name);
  const call = (tool, args) => send("mcpServer/tool/call", { threadId: thread.thread.id, server: mcp.name, tool, arguments: args });
const data = await call("vrchat_kb_api", { query: "Transform.position" });
  assert.equal(data.structuredContent?.verdict, "exposed", JSON.stringify(data));
  const list = await call("vrchat_kb_list", {});
  assert.equal(list.structuredContent?.pages, expectedManifest.pageCount, JSON.stringify(list));
  const digest = await call("vrchat_kb", { query: "Udon 同步变量 非 Owner" });
  assert.equal(digest.structuredContent?.hit, true, JSON.stringify(digest));
  const grep = await call("vrchat_kb_grep", { pattern: "RequestSerialization" });
  assert.ok(grep.structuredContent?.total > 0, JSON.stringify(grep));
  const first = grep.structuredContent.matches[0];
  const page = await call("vrchat_kb_read", { file_path: first.path, offset: first.lineNumber, limit: 1 });
  assert.equal(page.structuredContent?.lines[0].number, first.lineNumber, JSON.stringify(page));
  const filter = await call("vrchat_kb_filter", { filters: { category: "world" }, limit: 2 });
  assert.equal(filter.structuredContent?.paths.length, 2, JSON.stringify(filter));
  const scanned = await call("vrchat_kb_scan", { sources: [{ path: "Example.cs", text: "using System.IO;" }] });
  assert.ok(scanned.structuredContent?.findings.length > 0, JSON.stringify(scanned));
  const targetDir = join(cwd, "干跑 World");
  const project = await call("vrchat_kb_project_new", { targetDir, type: "world" });
  assert.equal(project.structuredContent?.dryRun, true, JSON.stringify(project));
  assert.equal(existsSync(targetDir), false);
  const unity = await call("vrchat_kb_unity", {});
  assert.equal(unity.structuredContent?.ok, process.platform === "win32", JSON.stringify(unity));
  const stats = await call("vrchat_kb_status", { mode: "stats" });
  assert.equal(stats.structuredContent?.pages, expectedManifest.pageCount, JSON.stringify(stats));
  assert.equal((await call("vrchat_kb_read", { file_path: "../../outside" })).isError, true);
  assert.equal((await call("vrchat_kb_scan", { sources: [{ path: "X.cs" }] })).isError, true);
  console.log("Codex mcpServer/tool/call: all ten tools and invalid input checked");
} finally {
  if (server) {
    const closed = new Promise((resolve) => server.once("close", resolve));
    server.stdin.end();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 800).unref())]);
    server.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 800))]);
  }
  try { rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (error) { console.error("Cleanup: " + error.message); }
}
