// Tests for the one property this fork exists for: the sandbox is created per
// call and killed right after, including when the call throws.
//
// No network and no E2B_API_KEY: the handler takes its Sandbox factory as an
// argument, and every test here passes a recording fake instead of the SDK.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import {
  DEFAULT_TIMEOUT_MS,
  TOOL_NAME,
  createCallToolHandler,
  listTools,
  readConfig,
  sandboxOptions,
} from "../lib/run-code-tool.mjs";

const RESULT = { results: [{ text: "42" }], logs: { stdout: ["42"], stderr: [] } };

/**
 * A stand-in for the E2B Sandbox class that appends every operation to one
 * ordered log, so "killed after the run" is checkable as a sequence.
 */
function fakeSandboxFactory({ onCreate, onRunCode, onKill } = {}) {
  const calls = [];
  const Sandbox = {
    async create(...args) {
      calls.push({ op: "create", args });
      if (onCreate) await onCreate(...args);
      return {
        async runCode(code) {
          calls.push({ op: "runCode", code });
          if (onRunCode) return onRunCode(code);
          return RESULT;
        },
        async kill() {
          calls.push({ op: "kill" });
          if (onKill) return onKill();
          return true;
        },
      };
    },
  };
  return { Sandbox, calls, ops: () => calls.map((c) => c.op) };
}

const callRequest = (args) => ({ params: { name: TOOL_NAME, arguments: args } });
const silent = () => {};

function harness({ env = {}, ...fakes } = {}) {
  const fake = fakeSandboxFactory(fakes);
  const logged = [];
  const config = readConfig(env);
  const callTool = createCallToolHandler({
    Sandbox: fake.Sandbox,
    config,
    log: (...args) => logged.push(args.join(" ")),
  });
  return { ...fake, config, callTool, logged };
}

describe("readConfig", () => {
  it("defaults to no template, a 300000 ms timeout and no forwarded envs", () => {
    const config = readConfig({});
    assert.equal(config.template, null);
    assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.deepEqual(config.forwardedEnvs, {});
  });

  it("reads E2B_TEMPLATE and E2B_TIMEOUT_MS", () => {
    const config = readConfig({ E2B_TEMPLATE: "custom-image", E2B_TIMEOUT_MS: "1500" });
    assert.equal(config.template, "custom-image");
    assert.equal(config.timeoutMs, 1500);
  });

  it("forwards only E2B_SANDBOX_* vars, with the prefix stripped", () => {
    const config = readConfig({
      E2B_SANDBOX_GIT_TOKEN: "forwarded",
      E2B_API_KEY: "not forwarded",
      E2B_TEMPLATE: "not forwarded",
      PATH: "not forwarded",
    });
    assert.deepEqual(config.forwardedEnvs, { GIT_TOKEN: "forwarded" });
  });
});

describe("listTools", () => {
  it("exposes exactly one tool, run_code", () => {
    const { tools } = listTools(readConfig({}));
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "run_code");
  });

  it("declares an input schema requiring a code string", () => {
    const [tool] = listTools(readConfig({})).tools;
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.properties.code.type, "string");
    assert.deepEqual(tool.inputSchema.required, ["code"]);
  });

  it("tells the model that state does not persist between calls", () => {
    const [tool] = listTools(readConfig({})).tools;
    assert.match(tool.description, /KILLED right after/);
    assert.match(tool.description, /does NOT\s+persist between calls/);
  });

  it("names the configured template, and says nothing when there is none", () => {
    const [withTemplate] = listTools(readConfig({ E2B_TEMPLATE: "custom-image" })).tools;
    assert.match(withTemplate.description, /Template: custom-image\./);
    const [without] = listTools(readConfig({})).tools;
    assert.doesNotMatch(without.description, /Template:/);
  });
});

describe("run_code sandbox lifecycle", () => {
  it("creates a sandbox, runs the code, then kills it — in that order", async () => {
    const h = harness();
    await h.callTool(callRequest({ code: "print(42)" }));
    assert.deepEqual(h.ops(), ["create", "runCode", "kill"]);
    assert.equal(h.calls[1].code, "print(42)");
  });

  it("returns the sandbox results and logs to the caller", async () => {
    const h = harness();
    const response = await h.callTool(callRequest({ code: "print(42)" }));
    assert.equal(response.content.length, 1);
    assert.equal(response.content[0].type, "text");
    assert.deepEqual(JSON.parse(response.content[0].text), RESULT);
  });

  it("kills the sandbox when the code throws, and propagates that error", async () => {
    const boom = new Error("SyntaxError in user code");
    const h = harness({ onRunCode: () => { throw boom; } });
    await assert.rejects(h.callTool(callRequest({ code: "1/0" })), (err) => err === boom);
    assert.deepEqual(h.ops(), ["create", "runCode", "kill"]);
  });

  it("uses a fresh sandbox per call instead of reusing one", async () => {
    const h = harness();
    await h.callTool(callRequest({ code: "a = 1" }));
    await h.callTool(callRequest({ code: "print(a)" }));
    assert.deepEqual(h.ops(), ["create", "runCode", "kill", "create", "runCode", "kill"]);
  });

  it("has nothing to kill when the sandbox never came up", async () => {
    const boom = new Error("E2B is down");
    const h = harness({ onCreate: () => { throw boom; } });
    await assert.rejects(h.callTool(callRequest({ code: "print(42)" })), (err) => err === boom);
    assert.deepEqual(h.ops(), ["create"]);
  });

  it("logs a failed kill instead of throwing it at the caller", async () => {
    const h = harness({ onKill: () => { throw new Error("kill timed out"); } });
    const response = await h.callTool(callRequest({ code: "print(42)" }));
    assert.deepEqual(JSON.parse(response.content[0].text), RESULT);
    assert.equal(h.logged.length, 1);
    assert.match(h.logged[0], /sandbox\.kill\(\) failed/);
  });

  it("lets the original error through when the kill fails too", async () => {
    const boom = new Error("SyntaxError in user code");
    const h = harness({
      onRunCode: () => { throw boom; },
      onKill: () => { throw new Error("kill timed out"); },
    });
    await assert.rejects(h.callTool(callRequest({ code: "1/0" })), (err) => err === boom);
    assert.match(h.logged[0], /sandbox\.kill\(\) failed/);
  });
});

describe("sandbox creation options", () => {
  it("passes the hard timeout to every sandbox", async () => {
    const h = harness({ env: { E2B_TIMEOUT_MS: "1500" } });
    await h.callTool(callRequest({ code: "print(42)" }));
    assert.deepEqual(h.calls[0].args, [{ timeoutMs: 1500 }]);
  });

  it("passes the template as the first argument when one is configured", async () => {
    const h = harness({ env: { E2B_TEMPLATE: "custom-image" } });
    await h.callTool(callRequest({ code: "print(42)" }));
    assert.deepEqual(h.calls[0].args, ["custom-image", { timeoutMs: DEFAULT_TIMEOUT_MS }]);
  });

  it("forwards E2B_SANDBOX_* vars into the sandbox, and omits envs when there are none", () => {
    assert.deepEqual(sandboxOptions(readConfig({ E2B_SANDBOX_GIT_TOKEN: "t" })), {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      envs: { GIT_TOKEN: "t" },
    });
    assert.deepEqual(sandboxOptions(readConfig({})), { timeoutMs: DEFAULT_TIMEOUT_MS });
  });
});

describe("request validation", () => {
  it("rejects an unknown tool without touching a sandbox", async () => {
    const h = harness();
    await assert.rejects(
      h.callTool({ params: { name: "run_shell", arguments: { code: "ls" } } }),
      (err) => err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.deepEqual(h.ops(), []);
  });

  it("rejects missing or non-string code without touching a sandbox", async () => {
    const h = harness();
    const invalid = [{}, { code: 42 }, { code: null }, undefined];
    for (const args of invalid) {
      await assert.rejects(
        h.callTool(callRequest(args)),
        (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams,
      );
    }
    assert.deepEqual(h.ops(), []);
  });
});

describe("packaging", () => {
  const source = (name) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

  it("keeps the E2B SDK out of the tool module, so tests need no API key", () => {
    assert.doesNotMatch(source("lib/run-code-tool.mjs"), /@e2b\/code-interpreter/);
  });

  it("keeps server.mjs parseable (the check the CI job used to run on its own)", () => {
    const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
    assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", serverPath]));
  });
});
