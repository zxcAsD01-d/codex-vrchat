
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tools, pluginStatus } from "../index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "data", "manifest.json"), "utf8"));
const scripts = [
  "selftest", "api-table-selftest", "docs-selftest", "lint-selftest", "metadata-selftest",
  "new-tools-selftest", "project-scaffold-selftest", "unity-status-selftest", "license-selftest",
  "index-corpus-check", "line-number-check", "lineending-check", "evidence-falsepositive-check",
  "number-provenance-check", "number-provenance-selftest",
];
for (const script of scripts) {
  const result = spawnSync(process.execPath, [join(root, "tools", script + ".cjs")], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, String(result.error ?? result.stdout + result.stderr));
  console.log(script + " · " + result.stdout.trim().split("\n").at(-1));
}

for (const entry of readdirSync(join(root, "skills"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = join(root, "skills", entry.name, "SKILL.md");
  const contents = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  assert.ok(contents.startsWith("---\nname: " + entry.name + "\n"));
  for (const match of contents.matchAll(/\]\(([^)]+)\)/g)) {
    const rel = match[1].split("#")[0];
    if (rel && !/^(?:\w+:|\/)/.test(rel)) assert.ok(existsSync(resolve(path, "..", rel)), entry.name + ": " + rel);
  }
}
console.log("Skill entrypoints and local links checked");

const fixture = mkdtempSync(join(tmpdir(), "VRChat Codex 测试 "));
const call = (name, args) => tools[name].execute(args, {});
const run = (...args) => {
  const result = spawnSync(process.execPath, [join(root, "cli.mjs"), args[0], "--json", ...args.slice(1)], { cwd: fixture, encoding: "utf8" });
  assert.ok(result.stdout, String(result.error ?? result.stderr));
  return { ...JSON.parse(result.stdout), exitCode: result.status };
};
const source = "using System.IO;\npublic class Example {}";
try {
  const digest = await call("vrchat_kb", { query: "Udon 同步变量 非 Owner" });
  assert.equal(digest.hit, true);
  assert.equal((await call("vrchat_kb", { query: "rust cargo pipeline" })).hit, false);
  const grep = await call("vrchat_kb_grep", { pattern: "RequestSerialization", include: "*.md" });
  assert.ok(grep.total > 0);
  const { path, lineNumber } = grep.matches[0];
  const read = await call("vrchat_kb_read", { file_path: path, offset: lineNumber, limit: 1 });
  assert.equal(read.lines[0].number, lineNumber);
  assert.match(read.lines[0].text, /RequestSerialization/i);
  assert.equal((await call("vrchat_kb_read", { file_path: "../../package.json" })).ok, false);
  assert.equal((await call("vrchat_kb_api", { query: "Transform.position" })).verdict, "exposed");
  assert.equal((await call("vrchat_kb_api", { query: "Transform.__no_member__" })).verdict, "not-listed");
  assert.ok((await call("vrchat_kb_filter", { filters: { category: "world" }, buckets: ["status"], limit: 5 })).count > 5);
  assert.equal((await call("vrchat_kb_list", {})).pages, manifest.pageCount);
  assert.equal(pluginStatus("stats").pages, manifest.pageCount);
  assert.ok(pluginStatus("stale").ageDays >= 0);
  const findings = await call("vrchat_kb_scan", { sources: [{ path: "Assets/Example.cs", text: source }] });
  assert.ok(findings.findings.some((item) => item.rule === "notexposed-system-namespace"));

  const target = join(fixture, "World 工程");
  const dryRun = await call("vrchat_kb_project_new", { targetDir: target, type: "world" });
  assert.equal(dryRun.dryRun, true);
  assert.equal(existsSync(target), false);
  assert.equal(run("project-new", "--type", "world", "--", "World 工程").dryRun, true);
  assert.equal(existsSync(target), false);
  assert.equal(run("project-new", "--type", "world", "--apply", "--", target).exitCode, 0);
  const vpm = (dir) => JSON.parse(readFileSync(join(dir, "Packages", "vpm-manifest.json"), "utf8"));
  assert.ok(Object.hasOwn(vpm(target).dependencies, "com.vrchat.worlds"));
  assert.equal(run("project-new", "--type", "avatar", "--apply", "--", target).exitCode, 1);
  const marker = join(target, "important.txt");
  writeFileSync(marker, "keep original bytes");
  const forced = run("project-new", "--type", "avatar", "--force", "--apply", "--", target);
  assert.equal(forced.exitCode, 0);
  assert.ok(Object.hasOwn(vpm(target).dependencies, "com.vrchat.avatars"));
  const recovered = join(fixture, "Recovered World");
  renameSync(forced.backup, recovered);
  assert.equal(readFileSync(join(recovered, "important.txt"), "utf8"), "keep original bytes");
  assert.ok(Object.hasOwn(vpm(recovered).dependencies, "com.vrchat.worlds"));
  const assets = join(target, "Assets");
  mkdirSync(join(assets, "Library"));
  writeFileSync(join(assets, "Example.cs"), source);
  writeFileSync(join(assets, "Library", "Ignored.cs"), source);
  const scanned = run("scan", "--", assets);
  assert.equal(scanned.exitCode, 0);
  assert.equal(scanned.scanned.length, 1);
  assert.deepEqual(scanned.findings.map((item) => item.rule), findings.findings.map((item) => item.rule));
  if (process.platform === "win32") {
    const unity = run("unity", "--", target);
    assert.equal(unity.exitCode, 0, unity.text);
    assert.match(unity.text, /2022\.3\.22f1/);
  } else {
    assert.match((await call("vrchat_kb_unity", {})).text, /Windows/);
  }
  console.log("PASS · KB, API, source scan, CLI project creation, force backup and recovery, Unity status");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
