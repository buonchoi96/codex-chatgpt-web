# Parallel Command Stable ABI Follow-up Plan

## Goal

Allow GPT-5.6 Sol Web High to run independent native commands concurrently when the current connector omits the bridge's `codex_parallel_exec` tool, without weakening command safety or changing the default sandbox.

## Evidence

- Real CLI trace `ff90ad3713d3` accepted the browser send at 21:41:26 +07 and ended at 21:43:26 +07 after the response-stalled-60s checkpoint.
- The visible final response and full-debug screenshot record `Codex tool is not available in this turn: codex_parallel_exec`; no command output was produced.
- The current `codex_tool_call` dispatcher treats unknown wire names as outer native tools and only has reserved routes for completion, compaction, recovery, and output controls.
- `codex_parallel_exec` already implements the desired 2–8 command validation, separate native calls, `Promise.all`, elapsed timing, and default-sandbox behavior.
- The completion stable-ABI fallback passed in a later GPT-5.6 Sol High CLI run, so `codex_tool_call` is callable on the connector that omits the direct parallel wrapper.

## Design

Add the reserved wire name `codex.control.parallel_exec` to the native `codex_tool_call` dispatch. Validate its arguments with the same schema used by the direct tool and delegate to one shared executor. Document the fallback in native MCP instructions, the `codex_tool_call` description, and the system prompt. Keep the direct tool annotations and sandbox behavior unchanged; do not add elevated permissions or a serial fallback.

## Tasks

- [x] Export and inspect full-debug evidence after cancelling the stalled turn; confirm daemon counters return to zero.
- [x] Add a lifecycle regression that calls the reserved route, rejects an undersized batch, observes two queued native calls together, and checks no sandbox escalation fields are added.
- [x] Confirm the regression fails before implementation.
- [x] Extract one shared schema and parallel executor for direct and stable-ABI calls.
- [x] Add the reserved route and connector fallback instructions.
- [x] Run focused MCP lifecycle and parallel transport tests.
- [x] Run `bun run verify` with Bun 1.4.0 and preserve the live tunnel PID.
- [x] Re-run the real CLI parallel suite on `chatgpt-web/gpt-5.6-sol` High; all eight read-only operations returned in one parallel batch and the completion receipt was accepted.
- [x] Continue the remaining advanced real-model suites and final integration gates; document external CLI blockers and verify the final source-live state before integration.

## Final evidence (2026-09-30)

- Full verification ran as `npm exec --yes --package=bun@1.4.0 -- bun run verify` and exited 0, including the relocated runtime smoke.
- The final GPT-5.6 Sol Web High CLI run dispatched all eight read-only operations concurrently; every command exited 0, native batch telemetry reported `parallel=true` and `command_count=8`, and the completion receipt was accepted. The CLI turn exited 0. Its JSONL trace is `C:\Users\Long-PC\AppData\Local\Temp\codex-web-sol-high-parallel-8-receipt-2026-09-30.jsonl`.
- The first receipt attempt used an invalid state value and was rejected; the corrected `state=complete` receipt was accepted with no remaining actionable requirements.
- The live source daemon returned to `active_http_turns=0` and `active_browser_turns=0`. Tunnel PID `15388` remained unchanged across the verified source reloads.
- Tests requiring native Computer Use, Browser Use, subagent aggregation, or their combined E2E flow remain externally blocked as detailed in `docs/superpowers/plans/2026-09-29-chatgpt-web-safety-guard.md`.
