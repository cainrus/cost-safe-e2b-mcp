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
//
// This file is stdio wiring only. The tool itself lives in lib/run-code-tool.mjs,
// which takes the Sandbox class as an argument so the test suite can drive it
// without an E2B_API_KEY or a network.
import { Sandbox } from "@e2b/code-interpreter";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import { readConfig, listTools, createCallToolHandler } from "./lib/run-code-tool.mjs";
dotenv.config();

const config = readConfig(process.env);

const server = new Server({ name: "e2b", version: "1.0.0" }, { capabilities: { tools: {} } });
server.onerror = (e) => console.error("[MCP Error]", e);
process.on("SIGINT", async () => { await server.close(); process.exit(0); });

server.setRequestHandler(ListToolsRequestSchema, async () => listTools(config));
server.setRequestHandler(CallToolRequestSchema, createCallToolHandler({ Sandbox, config }));

const transport = new StdioServerTransport();
await server.connect(transport);
