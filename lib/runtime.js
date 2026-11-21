
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { extname, join, resolve } from "node:path";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { lintSource } from "./lint.js";

export function grepWithDeadline(pattern, include, signal) {
  if (pattern.length > 512 || (include?.length ?? 0) > 256) throw new Error("搜索表达式过长");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./grep-worker.mjs", import.meta.url), { workerData: { pattern, include } });
    const finish = (error, result) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(new Error("搜索已取消"));
    const timer = setTimeout(() => finish(new Error("搜索超时。请缩小范围或改用简单的表达式。")), 3500);
    worker.once("message", (value) => finish(null, value));
    worker.once("error", finish);
    worker.once("exit", (code) => finish(new Error("搜索进程退出，状态 " + code)));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

const processScript = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
  '$p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -like "Unity*" -or $_.Name -like "*mcp*" } | Select-Object ProcessId, Name, ExecutablePath, CommandLine)',
  '$cli = [bool](Get-Command unity-mcp-cli -ErrorAction SilentlyContinue)',
  '[pscustomobject]@{ procs = $p; cli = $cli } | ConvertTo-Json -Depth 4 -Compress',
].join("\n");

async function runPowerShell(command, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawn(command, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", processScript], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => { child.kill(); finish({ error: "调用已取消" }); };
    const timer = setTimeout(() => { child.kill(); finish({ error: command + " 查询超时" }); }, 15000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (text) => {
      stdout += text;
      if (stdout.length > 2_000_000) {
        child.kill();
        finish({ error: "进程快照超过输出上限" });
      }
    });
    child.stderr.resume();
    child.once("error", (error) => finish({ error: error.code ?? command + " 启动失败", code: error.code }));
    child.once("close", (exitCode) => {
      if (exitCode !== 0) return finish({ error: command + " 进程查询失败，退出码 " + exitCode });
      try {
        const snapshot = JSON.parse(stdout.trim());
        if (!Array.isArray(snapshot.procs)) throw new Error("missing process list");
        finish({ snapshot, diagnostics: { exitCode, stdoutChars: stdout.length, rawProcs: snapshot.procs.length } });
      } catch {
        finish({ error: command + " 返回了无效的进程快照" });
      }
    });
  });
}

export async function enumerateUnity(signal) {
  if (process.platform !== "win32") return { error: "本机进程和许可证探测当前支持 Windows" };
  const result = await runPowerShell("pwsh.exe", signal);
  if (result.code !== "ENOENT") return result;
  return runPowerShell("powershell.exe", signal);
}

const MAX_FILES = 200;
const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 6;
const PRUNE = new Set(["node_modules", ".git", "library", "temp", "obj", "logs", "build", "packages"]);
const scannable = (path) => [".cs", ".shader"].includes(extname(path).toLowerCase());

export function collectSourceFindings(sources) {
  const scanned = [];
  const skipped = [];
  const findings = [];
  for (const { path, text } of sources) {
    if (!scannable(path) || Buffer.byteLength(text) > MAX_BYTES) {
      skipped.push(path + "（仅支持 256 KB 以内的 .cs / .shader）");
      continue;
    }
    findings.push(...lintSource(path, text));
    scanned.push(path);
  }
  return { scanned, skipped, findings };
}

export async function collectFileFindings(paths, cwd) {
  const result = { scanned: [], skipped: [], findings: [] };
  const seen = new Set();
  let visited = 0;
  let capped = false;
  async function visit(path, depth) {
    if (result.scanned.length >= MAX_FILES || visited >= 10000) {
      capped = true;
      return;
    }
    visited++;
    if (depth > MAX_DEPTH) {
      result.skipped.push(path + "（超过目录层级上限）");
      return;
    }
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        result.skipped.push(path + "（跳过符号链接或目录联接）");
      } else if (info.isDirectory()) {
        const entries = await readdir(path, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
        for (const entry of entries) {
          if (PRUNE.has(entry.name.toLowerCase())) continue;
          if (entry.isDirectory() || (entry.isFile() && scannable(entry.name))) {
            await visit(join(path, entry.name), depth + 1);
            if (capped) break;
          }
        }
      } else if (info.isFile() && scannable(path) && info.size <= MAX_BYTES) {
        const canonical = await realpath(path);
        if (seen.has(canonical)) return;
        seen.add(canonical);
        const scan = collectSourceFindings([{ path, text: await readFile(path, "utf8") }]);
        result.scanned.push(...scan.scanned);
        result.skipped.push(...scan.skipped);
        result.findings.push(...scan.findings);
      } else {
        result.skipped.push(path + "（仅支持 256 KB 以内的常规 .cs / .shader）");
      }
    } catch (error) {
      result.skipped.push(path + "（无法读取：" + (error.code ?? error.message) + "）");
    }
  }
  for (const path of paths) {
    await visit(resolve(cwd, path), 0);
    if (capped) break;
  }
  if (capped) result.skipped.push("达到扫描范围上限，剩余文件未检查");
  return result;
}
