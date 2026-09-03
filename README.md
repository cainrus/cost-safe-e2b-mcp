# cost-safe-e2b-mcp

An MCP server that runs Python in an [E2B](https://e2b.dev) sandbox and **kills the sandbox after
every call**.

It is a 69-line fork of [`@e2b/mcp-server`](https://github.com/e2b-dev/mcp-server) v0.2.3, which
creates a sandbox per `run_code` call and never kills it. The official server was archived on
2026-04-16 with a deprecation notice, so the leak it ships with is now permanent.

## The problem

The stock server calls `Sandbox.create()` and returns. Nothing ever calls `kill()`. The sandbox
stays alive — and billed — until the SDK's default timeout expires, about five minutes.

That cost is invisible in normal use: the tool returns the right answer, the agent moves on, and
the sandbox keeps running behind it. An agent loop that calls `run_code` twenty times in a session
leaves twenty sandboxes idling. Nothing in the tool output says so.

I found this by reading the upstream source while setting the server up, not from a bill.

## The fix

```js
try {
  sandbox = await Sandbox.create(opts);
  const { results, logs } = await sandbox.runCode(code);
  return { content: [{ type: "text", text: JSON.stringify({ results, logs }, null, 2) }] };
} finally {
  if (sandbox) {
    try { await sandbox.kill(); }
    catch (e) { console.error("[e2b] sandbox.kill() failed (will die on timeout):", e?.message || e); }
  }
}
```

Three decisions in that block are deliberate:

- **`finally`, not the happy path.** User-supplied code throws and times out; that is its normal
  behaviour, not an edge case. The sandbox has to die either way.
- **A kill failure is logged, never thrown.** Cleanup must not replace the tool result the caller
  is waiting for. If the kill fails, the hard timeout below is what collects the sandbox.
- **`E2B_TIMEOUT_MS` (default 300000) is a backstop, not the mechanism.** Relying on a timeout
  alone is exactly the upstream behaviour this fork exists to remove.

## What changed versus upstream

| | `@e2b/mcp-server` v0.2.3 | this fork |
|---|---|---|
| Sandbox lifetime | until the SDK timeout (~5 min), billed | killed immediately after each call |
| Timeout control | SDK default | `E2B_TIMEOUT_MS`, default 300000 |
| Custom template | not supported | `E2B_TEMPLATE` |
| Secrets into the sandbox | baked into the template image | `E2B_SANDBOX_<NAME>` forwarded at runtime as `<NAME>` |
| State between calls | incidental, from the leak | none, and the tool description says so |

The last row is the honest trade. Because the sandbox dies after each call, state does not survive
between calls and every snippet must be self-contained. The tool description tells the model this,
so it stops writing snippets that depend on a previous cell.

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `E2B_API_KEY` | yes | — | E2B API key, read by the SDK |
| `E2B_TIMEOUT_MS` | no | `300000` | Hard sandbox timeout, in milliseconds |
| `E2B_TEMPLATE` | no | — | Custom sandbox template id |
| `E2B_SANDBOX_*` | no | — | Forwarded into the sandbox with the prefix stripped |

## Usage

```jsonc
// claude_desktop_config.json / any MCP client
{
  "mcpServers": {
    "e2b": {
      "command": "node",
      "args": ["/path/to/cost-safe-e2b-mcp/server.mjs"],
      "env": { "E2B_API_KEY": "..." }
    }
  }
}
```

Exposes one tool, `run_code`, taking a single `code` string.

## License

Apache-2.0, inherited from upstream. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) — the
latter lists every modification made to the original work.
