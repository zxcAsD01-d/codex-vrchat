
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { tools, pluginStatus } from "./index.js";

const { name, version } = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));
const definitions = {
  ...tools,
  vrchat_kb_status: {
    description: "查看语料版本、构建时间、快照年龄、规则数量及当前 MCP 连接的工具调用次数。",
    parameters: { mode: { type: "string", enum: ["stats", "stale"] } },
    execute: ({ mode }, { counts }) => pluginStatus(mode, counts),
  },
};
const catalog = Object.entries(definitions).map(([name, definition]) => {
  const parameters = Object.entries(definition.parameters);
  const required = parameters.filter(([, schema]) => schema.required === true).map(([key]) => key);
  const properties = Object.fromEntries(parameters.map(([key, { required, ...schema }]) => [key, schema]));
  return {
    name,
    description: definition.description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
});
const schemas = new Map(catalog.map((tool) => [tool.name, tool.inputSchema]));
const versions = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);

function validate(value, schema, field) {
  const types = {
    object: value !== null && typeof value === "object" && !Array.isArray(value),
    array: Array.isArray(value),
    string: typeof value === "string",
    boolean: typeof value === "boolean",
    number: Number.isFinite(value),
    integer: Number.isSafeInteger(value),
  };
  if (!types[schema.type]) throw new Error(field + " 类型应为 " + schema.type);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(field + " 不在支持的值中");
  if (schema.type === "string" && value.length > (schema.maxLength ?? 8192)) throw new Error(field + " 超长");
  if (schema.type === "array") {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 200)) throw new Error(field + " 数量越界");
    value.forEach((item, i) => validate(item, schema.items, field + "[" + i + "]"));
  }
  if (schema.type === "object") {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new Error(field + " 缺少 " + key);
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties, key)) validate(child, schema.properties[key], field + "." + key);
      else if (schema.additionalProperties === false) throw new Error(field + " 不支持字段 " + key);
    }
  }
}

const send = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
const fail = (id, code, message) => send(id, { error: { code, message } });
const active = new Map();
const counts = Object.create(null);
let initialized = false;

async function dispatch(message) {
  const id = message?.id;
  if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") {
    fail(id ?? null, -32600, "Invalid Request");
    return;
  }
  const { method, params } = message;
  if (id === undefined) {
    if (method === "notifications/cancelled") active.get(params?.requestId)?.abort();
    return;
  }
  if (method === "initialize") {
    const requested = params?.protocolVersion;
    if (typeof requested !== "string") return fail(id, -32602, "Missing protocolVersion");
    initialized = true;
    return send(id, {
      result: {
        protocolVersion: versions.has(requested) ? requested : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name, version },
      },
    });
  }
  if (method === "ping") return send(id, { result: {} });
  if (!initialized) return fail(id, -32002, "Server not initialized");
  if (method === "tools/list") return send(id, { result: { tools: catalog } });
  if (method !== "tools/call") return fail(id, -32601, "Method not found");
  const toolName = params?.name;
  if (!schemas.has(toolName)) return fail(id, -32602, "Unknown tool");
  if (active.size >= 12) return fail(id, -32000, "Too many concurrent calls");
  const controller = new AbortController();
  active.set(id, controller);
  try {
    const args = params.arguments === undefined ? {} : params.arguments;
    validate(args, schemas.get(toolName), "arguments");
    if (toolName !== "vrchat_kb_status") counts[toolName] = (counts[toolName] ?? 0) + 1;
    const value = await definitions[toolName].execute(args, { signal: controller.signal, counts: { ...counts } });
    const { text, ...data } = value;
    const result = { content: [{ type: "text", text }], structuredContent: data };
    if (value.ok === false) result.isError = true;
    if (!controller.signal.aborted) send(id, { result });
  } catch (error) {
    if (!controller.signal.aborted) send(id, { result: { isError: true, content: [{ type: "text", text: error.message }] } });
  } finally {
    active.delete(id);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  if (line.length > 9_000_000) return fail(null, -32600, "Request too large");
  try {
    void dispatch(JSON.parse(line)).catch((error) => {
      process.stderr.write("VRChat MCP: " + error.message + "\n");
    });
  } catch {
    fail(null, -32700, "Parse error");
  }
});
