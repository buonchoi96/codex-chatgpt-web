# Integrated async MCP tool gateway (no per-server proxy configuration)

All MCP tools available in a native Codex turn are handled by the existing in-app \`codex_tool_call\` bridge. Its normal broker deadline is 90 seconds; the old direct path can fail when REA/Ghidra or another provider executes longer than that.

## Automatic operation

The bridge's in-app MCP gateway automatically applies an 8-second fast-path to **namespaced MCP tools**, regardless of provider:

- **Fast tools:** \`codex_tool_call\` returns the original structured MCP result.
- **Slow tools:** instead of waiting for the native 90-second response ceiling, \`codex_tool_call\` returns \`{"status":"pending","job_id":"native_job_...","poll_with":"codex_tool_poll","tool":"..."}\`. The **original single native invocation keeps running**.
- Use `codex_tool_poll` with the SAME `turn_token` and `job_id`. For an installed Native2 connector whose registry has not refreshed, call the existing `codex_tool_call` with `wire_name="codex.control.async_poll"` and `arguments={"job_id":"native_job_...","offset":0}`. Repeated polls do not invoke the external MCP tool again. If completed or failed, \`chunk\` contains a JSON-serialized original MCP result; use \`next_offset\` until null and reconstruct it.
- For known slow tools, \`codex_tool_start\` bypasses the 8-second fast wait and immediately returns a receipt; it accepts the original exact \`wire_name\`, \`arguments\` or \`input\`. Works for every currently authenticated MCP namespace.

No changes to \`[mcp_servers.rea]\`, \`[mcp_servers.*]\`, \`startup_timeout_sec\`, or \`tool_timeout_sec\` are necessary. No separate REA child process, duplicated login, or proxy configuration is introduced. Existing MCP connections and their state are used **as-is**.

## Authorization and concurrency

The original native broker, current Codex tool registry, sandbox/approval flow, and turn token remain authoritative. Job IDs are random, in-memory receipts, scoped to the *exact native turn*. Results never migrate across main-agent or subagent turns or token rotations.

At most one async operation per same-turn backend namespace may be active at once. Different MCP providers may run independently when their tools are directly advertised; tools resolved through one shared native exec gateway serialize through that gateway's existing exclusive command-capacity policy. Errors, vanished browser sessions, and broker retirement DO NOT authorize replay of a dispatched operation.

When a native call reports an unverified outcome, the namespace remains locked; the job reports \`unknown\` and \`retryable:false\`. Do not use a new route or replay to bypass the unknown state. The original operation might still be running.

Up to 128 terminal receipts are cached, at most 8,000,000 serialized result characters per receipt. Results can be read in chunks of at most 12,000 characters. Terminal receipts expire after 30 minutes. Restarting the bridge loses these in-memory receipts and never proves underlying work stopped.

## Integration details

This is implemented inside \`src/adapters/chatgpt-web/mcp-server.ts\` and \`native-async-tools.ts\`, not as a new third-party MCP service. Other built-in native commands (e.g. \`codex_exec\`) retain their own session/poll semantics and their existing safety controls. Reserved compaction/recovery actions and agent wait tools retain their special execution policies.

Use the fork's current installer or launcher build containing this feature; **no manual MCP config change is needed**. The earlier stand-alone \`rea-async-proxy.ts\` is optional and should not be installed to use the integrated path.

The installed Native2 `codex_tool_call` interface also accepts reserved `codex.control.async_start` with structured arguments `{wire_name,arguments?,input?}` if `codex_tool_start` is not in the tool registry. These operations are checked against the native turn token and are never listed as external MCP tools.
