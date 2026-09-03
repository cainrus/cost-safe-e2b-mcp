#!/usr/bin/env node
// cost-safe-e2b-mcp — a fork of @e2b/mcp-server (v0.2.3).
//
// Derived from https://github.com/e2b-dev/mcp-server, Copyright 2023 FoundryLabs, Inc.,
// licensed under the Apache License 2.0. Modifications are listed in NOTICE.
//
// Why a fork: the stock server does `Sandbox.create()` then never kills it, so
// every run_code call leaks a sandbox alive for the SDK default ~5 min (billed).
// This version:
//   • KILLs the sandbox immediately after each run (finally block)         → no leak
//   • sets a hard timeout backstop via E2B_TIMEOUT_MS (default 300000 ms)   → hung calls die
//   • optional custom template via E2B_TEMPLATE (the repo-baked dev image)
//   • forwards E2B_SANDBOX_<NAME> server env vars into the sandbox as <NAME>
//     (so a runtime git token/key can be injected without baking it into an image)
import { Sandbox } from "@e2b/code-interpreter";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import dotenv from "dotenv";
dotenv.config();

const TEMPLATE = process.env.E2B_TEMPLATE || null;
const TIMEOUT_MS = parseInt(process.env.E2B_TIMEOUT_MS || "300000", 10);
const FORWARD = Object.fromEntries(
  Object.entries(process.env)
    .filter(([k]) => k.startsWith("E2B_SANDBOX_"))
    .map(([k, v]) => [k.slice("E2B_SANDBOX_".length), v]),
);

const toolSchema = z.object({ code: z.string() });

const server = new Server({ name: "e2b", version: "1.0.0" }, { capabilities: { tools: {} } });
server.onerror = (e) => console.error("[MCP Error]", e);
process.on("SIGINT", async () => { await server.close(); process.exit(0); });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "run_code",
    description:
      "Run Python code in a fresh, secure E2B sandbox (Jupyter Notebook syntax). " +
      "The sandbox is created per call and KILLED right after — state does NOT " +
      "persist between calls, so each snippet must be self-contained." +
      (TEMPLATE ? ` Template: ${TEMPLATE}.` : ""),
    inputSchema: zodToJsonSchema(toolSchema),
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "run_code")
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
  const parsed = toolSchema.safeParse(request.params.arguments);
  if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, "Invalid run_code arguments");
  const { code } = parsed.data;

  const opts = { timeoutMs: TIMEOUT_MS, ...(Object.keys(FORWARD).length ? { envs: FORWARD } : {}) };
  let sandbox;
  try {
    sandbox = TEMPLATE ? await Sandbox.create(TEMPLATE, opts) : await Sandbox.create(opts);
    const { results, logs } = await sandbox.runCode(code);
    return { content: [{ type: "text", text: JSON.stringify({ results, logs }, null, 2) }] };
  } finally {
    if (sandbox) {
      try { await sandbox.kill(); }
      catch (e) { console.error("[e2b] sandbox.kill() failed (will die on timeout):", e?.message || e); }
    }
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
