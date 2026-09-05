// The run_code tool, with no transport and no I/O of its own.
//
// server.mjs wires this to stdio and passes the real E2B Sandbox class in.
// Everything here takes its collaborators as arguments, so the test suite can
// hand it a fake sandbox and assert the one property this fork exists for:
// the sandbox is killed after every call, including the calls that throw.
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const TOOL_NAME = "run_code";
export const DEFAULT_TIMEOUT_MS = 300000;
export const SANDBOX_ENV_PREFIX = "E2B_SANDBOX_";

export const toolSchema = z.object({ code: z.string() });

/** Read the server's configuration out of an environment object. */
export function readConfig(env = process.env) {
  return {
    template: env.E2B_TEMPLATE || null,
    timeoutMs: parseInt(env.E2B_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10),
    // E2B_SANDBOX_<NAME> reaches the sandbox as <NAME>, so a runtime token can
    // be injected without baking it into a template image.
    forwardedEnvs: Object.fromEntries(
      Object.entries(env)
        .filter(([key]) => key.startsWith(SANDBOX_ENV_PREFIX))
        .map(([key, value]) => [key.slice(SANDBOX_ENV_PREFIX.length), value]),
    ),
  };
}

/** The ListTools response: one tool, whose description states the no-state trade. */
export function listTools(config) {
  return {
    tools: [{
      name: TOOL_NAME,
      description:
        "Run Python code in a fresh, secure E2B sandbox (Jupyter Notebook syntax). " +
        "The sandbox is created per call and KILLED right after — state does NOT " +
        "persist between calls, so each snippet must be self-contained." +
        (config.template ? ` Template: ${config.template}.` : ""),
      inputSchema: zodToJsonSchema(toolSchema),
    }],
  };
}

/** Options handed to Sandbox.create() for one call. */
export function sandboxOptions(config) {
  return {
    timeoutMs: config.timeoutMs,
    ...(Object.keys(config.forwardedEnvs).length ? { envs: config.forwardedEnvs } : {}),
  };
}

/**
 * Build the CallTool handler.
 *
 * @param {object} deps
 * @param {{ create: Function }} deps.Sandbox  sandbox factory (the E2B SDK class in production)
 * @param {object} deps.config                 as returned by readConfig()
 * @param {Function} [deps.log]                where a failed kill is reported
 */
export function createCallToolHandler({ Sandbox, config, log = console.error }) {
  return async function callTool(request) {
    if (request.params.name !== TOOL_NAME)
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    const parsed = toolSchema.safeParse(request.params.arguments);
    if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, `Invalid ${TOOL_NAME} arguments`);
    const { code } = parsed.data;

    const opts = sandboxOptions(config);
    let sandbox;
    try {
      sandbox = config.template
        ? await Sandbox.create(config.template, opts)
        : await Sandbox.create(opts);
      const { results, logs } = await sandbox.runCode(code);
      return { content: [{ type: "text", text: JSON.stringify({ results, logs }, null, 2) }] };
    } finally {
      // finally, not the happy path: user code throwing is normal, and the
      // sandbox is billed until it dies either way.
      if (sandbox) {
        try { await sandbox.kill(); }
        // A cleanup failure must never replace the caller's result or error;
        // the hard timeout in opts is what collects the sandbox then.
        catch (e) { log("[e2b] sandbox.kill() failed (will die on timeout):", e?.message || e); }
      }
    }
  };
}
