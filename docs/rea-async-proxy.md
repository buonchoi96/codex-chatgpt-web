# Async REA MCP proxy for slow Ghidra queries (opt-in)

Codex Native2's tool invocation is bound by a **90-second local transport budget** even if Codex's MCP config says tool_timeout_sec = 360. Direct rea-agents calls exceeding the bridge deadline will retire the native binding and close the browser turn. The async proxy splits a slow call into an immediate job receipt and short polls, keeping one persistent rea-agents@6.5.0 backend.

## Windows setup

This is a new **optional MCP command**, not an automatic change to your existing REA installation. Install Bun and use a local clone of this fork. Stop Codex, back up config.toml, and replace only your [mcp_servers.rea] entry with the following (replace the placeholder with your real repository checkout location):

    [mcp_servers.rea]
    command = "cmd.exe"
    args = [ "/d", "/c", "bun", "run", "C:\\absolute\\path\\to\\codex-chatgpt-web\\src\\rea-async-proxy.ts" ]
    startup_timeout_sec = 60
    tool_timeout_sec = 360

Fully exit and restart Codex. The proxy spawns a single persistent backend through cmd.exe /d /c npx -y rea-agents@6.5.0 mcp. Ordinary REA calls are forwarded to that *same* backend, so they share its active binary/session. You must explicitly inspect/reopen the target after switching away from an old already-running direct MCP process; in-flight work from that process is not migrated.

## Workflow

1. Use quick regular REA tools to prepare or inspect the binary.
2. For a slow function query, call rea_async_start with tool = procedure_info and arguments equal to the ORIGINAL procedure_info argument object. For the overview use tool = binary_overview. Only these two read-only tools are eligible, and only if advertised by the actual REA backend.
3. Save the returned job_id and call rea_async_poll using that job_id. If status is running, poll again. If completed or failed, fetch JSON chunks by offset/next_offset until next_offset is null, then reconstruct the original MCP result.
4. Do NOT start a second REA operation while one is running or outcome is uncertain.

The proxy holds at most 24 job receipts, retaining completed results up to 30 minutes (8,000,000 chars maximum). The SDK timeout for the downstream call is 30 minutes; it does NOT change native Codex's 90-second deadline, as start/poll return promptly. After an RPC transport failure, status becomes unknown, which does NOT prove Ghidra stopped. The backend stays locked rather than allowing a competing operation. Before deliberately restarting the proxy, independently reconcile the operation and the target state. A crash or restart loses in-memory job IDs and completed buffers, and does not authorize replay.

To revert, restore your original [mcp_servers.rea] block and fully restart Codex.
