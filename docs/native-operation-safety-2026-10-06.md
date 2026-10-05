# Native operation safety patch — 2026-10-06

## Initial state

Main at `5872958383f3bec758ede069a0c7da4b8791d72b`; ff-only pull was up to date.
`git diff --check` passed before edits. The initial file-reading shell command
preceded discovery of the attachment's first-command requirement; no edit occurred.
Untracked native-operation modules/tests were existing WIP. They were inspected,
integrated and verified. `SKILLS.md` and the old untracked implementation plan are
preserved outside the commit.

## Evidence and implementation

Executable regressions reproduced these defects before routing changes:

- Generated exec gateways emitted nested content while losing `isError`.
  An explicit native rejection returned `isError=undefined`.
- A fixed independent inspection pair remained a compound shell request.
- Exact direct capability inventory hits still dispatched nested discovery.
- The finite native observation/action contracts were absent.
- Generated framing could rewrite identical marker-like text inside a caller's
  command; framing now changes only its own generated suffix.
- The Responses parser joins text-only result blocks, and recovery appends a
  checkpoint instruction. Exact-last-block framing missed the error marker;
  the broker now removes the exact nonce suffix from any text block.

The broker now records queued/delivered/completed/blocked events with operation
intent, requested capability, selected route, registry fingerprint, elapsed time
and native safety evidence. Arguments, code, text, window identifiers, screenshots,
credentials and argument fingerprints are not included. Delivery proves only
delivery to Codex; native invocation, side effects and foreground remain unknown
unless the native result supplies evidence. Local intent is diagnostic only.

Nested error flags cross the gateway through a fresh invocation-specific failure
marker; successful ordinary marker-like output cannot impersonate it. Framing is
applied only to the generated suffix, never caller arguments. Explicit native
safety failures with preserved native status remain errors. Identical rejected representations are retained
for the turn and returned without redispatch, ignoring command transport tuning.
No automatic safety retry, reclassification or mutation replay is introduced.
Changed requests still pass native safety gates. Detached-result handling,
completion fences and account-safety dispatch guards remain authoritative.

Bare direct `function_call_output` / `custom_tool_call_output` has an upstream
limitation: Codex serializes only the result body, omitting internal success
metadata. A failed operation and a successful read of an error example can have
identical wire text. The bridge preserves that text and reports safety evidence
as unavailable; it does not fabricate `isError` from arbitrary output. Therefore
the rejection ledger covers proven error results and nonce-framed gateways,
not unflagged direct failures. No automatic retries are introduced on either path.
This was verified against the primary
[Codex protocol serializer](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs).

Only 2–8 exact fixed independent probes can split into separate native command
calls. Quoted paths, redirections, shell operators, variables, dependent commands,
approval parameters and TTY requests retain their original representation.

Native Windows observations are finite `list_apps`, `list_windows`, and
`window_state` operations; actions are `activate_window` and `type_text`.
Only previously enumerated exact app/window identities are accepted. Native Sky
owns foreground and locked-desktop checks; typing performs its own activation.
Observations disable screenshots and never activate. Actions remain mutation
capable. Arbitrary JavaScript is never exposed through the read-only contract.
The stable `codex_tool_call` ABI supports cached connector catalogs.

Persistent Sky module/window bindings survive ordinary calls. Registry changes,
native resets, observed window closure, stale references and connection failures
invalidate bindings. UI observations and foreground are not cached as authority.
Successful nested catalog pages reuse the same binding/registry, with bounds and
a 60-second expiry. Tool searches/resets and changed environments invalidate them.
Broad namespace searches continue discovering deferred sibling capabilities.

## Verification

- Focused regressions initially: 24 pass. Final focused lifecycle/transport
  checks: 66 pass, 1 existing platform skip, 0 fail (67 tests across 9 files).
  A basename-filter invocation accidentally selected
  the archived baseline harness, which expected the old connector ABI; the final
  invocation uses explicit `./tests/...` file paths.
- Root suite after all code changes: 1,000 pass, 22 skip, 2 fail (1,024 tests).
  Both failures are Windows `EPERM` creating file symlinks in
  `tests/codex-integration.test.ts` (shared-config preservation and compensation).
- Launcher: 434 pass, 4 skip, 2 fail. The source-live contract test still asserts
  that the default home literal is in `dev-live.cjs` after it moved into
  `dev-live-lanes.cjs`; the checkpoint test hits Windows symlink `EPERM`.
- Both root and launcher typechecks pass.
- `bun run verify` stops at the version gate: repository pins Bun 1.4.0,
  installed Bun is 1.4.2. Later verify stages are not claimed as passing.
- All four failing tests and the version gate reproduced independently in an
  untouched `git archive HEAD` extracted under ignored `output/`.
  No tests were disabled, no platform settings or version pins changed.
- Independent review reproduced the parser/checkpoint defect, verified its fix,
  and found no remaining actionable P0–P2 issues. Its 16 narrow checks passed;
  direct-status ambiguity remains a documented transport limitation.

## Real CLI smoke and environment limits

Both real runs use `bun run dev:codex -- exec` and print
`model: chatgpt-web/gpt-5.6-sol` plus `reasoning effort: high`.
The WebSocket 426 correctly falls back to HTTP.

The Notepad smoke checked the process, launched one Notepad (PID 13936), and
verified the process. Activation, typing and marker verification were blocked by
missing native Computer Use capability, not by an observed classifier rejection.
`bun run dev:codex -- mcp list` confirms the isolated CLI home has no MCP servers.
No shell-based UI emulation or configuration changes were used to bypass this.

The source daemon watcher does not restart long-lived MCP workers. The first
worker was older than the patch; only the idle isolated CLI tunnel was refreshed.
A second read-only smoke reached the new stable reserved Computer Use control
and returned `This turn has no native node_repl capability or exec gateway;
discover Computer Use first`. No native app action was dispatched or retried.
Thus the new route is live, but end-to-end native desktop behavior is unverified.

The Activity full-debug export implementation was used to produce ignored local
`output/native-safety-smoke-debug-final.zip` (364 files, 11,523,132 bytes,
20,302 sanitized log records). The earlier export is also retained locally.
The export contains local diagnostics; it is not committed or uploaded.

Desktop and CLI health both confirm distinct connector, tunnel alias, tunnel
fingerprint and broker fingerprint. Desktop remained running during CLI worker
refresh. Smoke tabs are closed after each run and health is checked for zero
active HTTP/browser turns. No active smoke turn remained to cancel; no orphaned
smoke tool/MCP request remained. The authenticated home surface remains available.
The final CLI worker refresh is healthy and ready with the completed source;
both lanes are accepting turns with zero active HTTP/browser turns, and the only
remaining browser tab is the authenticated home surface.

Local smoke logs: `output/native-safety-smoke.log` and
`output/native-safety-smoke-refreshed.log`. Trace IDs were `5ca494117e5d` and
`3ae9898b8bdb`, respectively. Both test tabs were closed through the launcher's
existing browser-tab API.

## Performance scope

There are no new native screenshots, unconditional UI observations, retry sleeps,
extra foreground activations or repeated imports per valid session. Fixed reads
remain concurrent; catalog reuse removes native discovery calls. Added overhead
is local hashing/normalization and redacted lifecycle logging. A native desktop
latency benchmark remains unavailable because this CLI has no native CU surface.

## Changed files

- `src/adapters/chatgpt-web/mcp-server.ts`: routing, finite schemas, inventory reuse.
- `src/adapters/chatgpt-web/turn-broker.ts`: redacted telemetry, proven rejection retention.
- `src/adapters/chatgpt-web/native-operation.ts`: intent, conservative splitting,
  semantic fingerprints, error framing and safety diagnostics.
- `src/adapters/chatgpt-web/native-computer-use.ts`: finite persistent native Sky programs.
- `tests/native-operation.test.ts`, `tests/native-operation-routing.test.ts`,
  `tests/native-computer-use.test.ts`: regression coverage.
- `tests/chatgpt-web-harness.test.ts`: intentional connector ABI assertions and
  direct inventory expectations.
- This evidence record.
