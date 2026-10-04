# GPT‑6.1 Sol High — Backend Maximum-Performance Execution Plan

> Target repository: `buonchoi96/codex-chatgpt-web`
> Target branch: `main` only
> Reviewed GitHub `main` HEAD before writing this plan: `62feff2a80e8b4fb689132f60880ff0e59530958`
> Baseline at that HEAD: CI = success, Windows build = success, Publish main Windows installer = success.
> Execution agent model: **GPT‑6.1 Sol High**
> Required real E2E web-model target: **GPT‑5.6 Sol High (web)**

---

## 0. Mission

Your job is to optimize the **real end-to-end execution speed** of `codex-chatgpt-web` as aggressively as possible without reducing correctness, reasoning quality, context fidelity, safety semantics, or recovery reliability.

The target user experience should feel comparable to a **1.5× fast execution mode** where possible. Do not fake speed by lowering reasoning effort, silently skipping observations, weakening safety checks, dropping context, shrinking timeouts blindly, suppressing errors, removing regression tests, disabling recovery semantics, or claiming completion before real E2E verification.

Highest-priority loops:

1. **Computer Use:** observe → understand changed state → choose next action → execute → re-observe only when necessary.
2. **Browser Use:** DOM/page observation → choose next action → execute → avoid unnecessary visual/browser round trips.
3. **Codex Native/MCP:** dispatch → broker → result → next model/tool decision.
4. **ChatGPT Web transport:** prompt compilation, token estimation, ZIP/context archive generation, attachments, browser DOM observation, helper/launcher IPC.
5. **Model-facing efficiency:** reduce repeated context/tool-description overhead and provide structured deltas without reducing semantics.

All optimization must be **benchmark driven**.

---

# 1. Absolute Git / Branch Rules

## 1.1 First command

The first repository update command must be:

```powershell
git pull -ff-only origin main
```

Do not create a feature branch, scratch branch, fix branch, worktree branch, or temporary remote branch.

All changes must be made directly on:

```text
main
```

After pulling, verify:

```powershell
git branch --show-current
git status --short
git rev-parse HEAD
git rev-parse origin/main
```

Required state:

```text
branch == main
HEAD == origin/main
```

If there are pre-existing uncommitted changes, inspect and preserve them. Do not use destructive cleanup such as `git reset --hard` or `git clean -fd` unless the human explicitly authorizes it.

## 1.2 Commit policy

Commit directly to `main` in small benchmark-backed increments.

Examples:

```text
perf: add backend latency instrumentation
perf: reduce computer-use observe-act latency
perf: make browser observation event-driven
perf: cache canonical prompt compilation
perf: reuse context archive artifacts
perf: coalesce MCP progress frames
test: add performance regression harness
fix: repair <bug discovered by E2E>
```

After every commit:

```powershell
git status --short
git log -1 --oneline
```

Push only `main`. Never create another branch during this task.

---

# 2. Mandatory Tunnel-Continuity Gate — BEFORE Any Performance Change

A source edit under `bun run dev:live` can restart the Responses daemon. Electron-main edits can restart Electron. If the native MCP tunnel is still coupled to those processes, a bad edit can break the active Codex session and prevent recovery.

The repository already contains a tunnel-continuity design:

- `docs/dev-live.md`
- `docs/superpowers/specs/2026-09-29-dev-live-tunnel-continuity-design.md`
- `launcher/electron/live-tunnel-lease.cjs`
- `launcher/scripts/dev-live.cjs`
- `launcher/scripts/dev-live-lifecycle.cjs`
- `launcher/electron/runtime-supervisor.cjs`

Current intended behavior:

- `src/**/*.ts` change → rebuild helper + drain/restart Responses daemon only; Electron/WebContents/tunnel remain alive.
- `launcher/src/**` change → Vite HMR.
- `launcher/electron/**` change → Electron restarts, live-session lease preserves/re-adopts the exact same tunnel identity.

Do not trust the design document alone. Verify the local runtime.

## 2.1 Start the live source runtime

When a real run is required, use PowerShell:

```powershell
bun run dev:live
```

Keep the process visible and retain its logs.

## 2.2 Inspect live runtime ownership

Default live home:

```text
~/.codex-chatgpt-web-live
```

If `CODEX_WEB_GPT_LIVE_HOME` is set, use that exact path.

```powershell
$LiveHome = if ($env:CODEX_WEB_GPT_LIVE_HOME) {
    $env:CODEX_WEB_GPT_LIVE_HOME
} else {
    Join-Path $HOME ".codex-chatgpt-web-live"
}

Get-Content (Join-Path $LiveHome "runtime\launcher-supervisor.json") -Raw
Get-Content (Join-Path $LiveHome "runtime\live-tunnel-handoff.json") -Raw
Get-Content (Join-Path $LiveHome "config.json") -Raw
```

Record:

```text
daemonPid
tunnelPid
tunnelHealthFingerprint
tunnelIdentity
status
```

If `tunnelPid` exists:

```powershell
$State = Get-Content (Join-Path $LiveHome "runtime\launcher-supervisor.json") -Raw | ConvertFrom-Json
Get-Process -Id $State.tunnelPid
Get-Process -Id $State.daemonPid
```

The lease owner PID must also be alive.

## 2.3 Verify `src/**` reload isolation

Record daemon PID and tunnel PID/fingerprint.

While `bun run dev:live` is active, first trigger a watcher event without changing file contents:

```powershell
(Get-Item .\src\server.ts).LastWriteTime = Get-Date
```

If timestamp-only change does not trigger the watcher, use the smallest reversible no-op edit.

Expected:

```text
daemon PID changes
tunnel PID remains unchanged
```

or for a PID-less manager:

```text
tunnelHealthFingerprint remains unchanged
```

Then verify runtime returns to ready and accepts a trivial Codex turn.

If the tunnel disappears, reconnects, changes identity unexpectedly, or the existing Codex session loses tunnel connectivity:

> STOP ALL PERFORMANCE WORK.

Fix tunnel independence first on `main`, rerun focused lifecycle tests, then repeat this live check.

## 2.4 Verify Electron-main reload handoff

Before large `launcher/electron/**` changes:

```powershell
(Get-Item .\launcher\electron\browser-host.cjs).LastWriteTime = Get-Date
```

Expected:

1. `dev:live` waits for `active_http_turns == 0` and `active_browser_turns == 0`.
2. Electron reloads.
3. Same tunnel PID, or same verified health fingerprint for PID-less runtime.
4. New daemon becomes ready.
5. Fresh Codex turn works without reconnecting the tunnel.

If this fails, repair the tunnel handoff before performance work.

---

# 3. Current Performance Architecture From Repo Review

Do not reimplement features already present.

## 3.1 Existing Computer Use fast-path

`src/adapters/chatgpt-web/mcp-server.ts` already has `COMPUTER_USE_FAST_PATH_RULE` and instructs the model to:

- retain persistent `node_repl/@oai/sky`,
- reuse module/app/window/control state,
- prefer structured state over screenshots,
- avoid re-describing unchanged screens,
- use changed/relevant regions when supported,
- batch short deterministic low-risk actions,
- avoid repeated `list_apps`, imports, and discovery.

Regression coverage exists in:

```text
tests/computer-use-fast-path.test.ts
```

Therefore the next phase must optimize the **actual execution pipeline**, not merely add prompt prose.

## 3.2 Existing parallel command path

The repo already supports `codex_parallel_exec` for 2–8 independent command operations. Preserve it and measure whether discovery/routing overhead delays its use.

## 3.3 Existing event-driven MCP progress

`turn-progress.ts` already uses revision-based event notification:

```text
waitForChange()
notify()
recordToolBatch()
recordToolResult()
```

and `launcher-helper-client.ts` forwards progress to the browser helper. Do not regress this into fixed polling.

## 3.4 Browser orchestration still has fixed polling/settle points

Examples include:

- operational viewport polling around 50 ms,
- UI settle delays,
- confirmation loops,
- DOM observation probes,
- broad stage deadlines.

Do not simply lower timeout ceilings. Separate:

```text
maximum failure deadline
```

from:

```text
normal-path latency
```

Make the normal path settle immediately on state/event proof while retaining generous failure deadlines.

## 3.5 Context archive path does synchronous ZIP work

Current archive generation in `browser-worker.ts` uses:

```text
zipSync(entries, { level: 6 })
```

for:

```text
context.txt
manifest.json
images/*
skills/*
```

Archive transport is selected around:

```text
>= 100,000 inline characters
or
>= 4 images
```

This is a prime benchmark target for 200k+ token contexts.

Do not change compression level blindly. Measure CPU build time, compressed size, attachment time, ChatGPT ingestion time, and total submission latency.

---

# 4. Phase 1 — Add Real Latency Instrumentation

Before major optimization, instrument the hot path.

Use `performance.now()` for durations.

Telemetry must contain no prompt text, screenshot bytes, file contents, secrets, account identifiers, or private user data.

## 4.1 Required timing markers

### Turn startup

```text
native request received
adapter entered
account-safety verified
prompt compilation start/end
token estimation start/end
archive build start/end
helper request queued
helper ready
page acquired
```

### Browser submission

```text
temporary chat preparation
model/effort selection start/end
submission baseline
prompt attachment
image/file attachment
send activation
submission accepted
first reasoning/status signal
first visible text
```

### Tool loop

```text
tool request generated
MCP tools/call received
broker enqueue
outer Codex claim
native dispatch
first progress
native completion
broker result ready
MCP reply sent
ChatGPT observes result
next reasoning starts
next tool call emitted
```

### Computer Use

Critical metric:

```text
T_observe_to_next_action
```

Capture:

```text
observe start
structured state ready
screenshot requested?
screenshot complete
screenshot encoded
model receives observation
next action emitted
action dispatch
action complete
next UI transition detected
```

### Browser Use

Critical metric:

```text
T_browser_observe_to_next_action
```

Capture DOM/accessibility observation, screenshot fallback, state transition, and next action timing.

## 4.2 Structured perf events

Example:

```json
{
  "event": "perf.computer_use_cycle",
  "trace": "<safe trace id>",
  "observe_ms": 92,
  "model_decision_ms": 410,
  "dispatch_ms": 14,
  "action_ms": 137,
  "screen_changed": true,
  "screenshot_used": false
}
```

Use a DEV/profiling flag if normal logs would become noisy.

---

# 5. Baseline Scenarios

Run enough samples for p50/p95.

## 5.1 Computer Use

1. Open/minimize/restore native window.
2. Click deterministic toolbar control.
3. Type into a text field.
4. Three low-risk sequential actions.
5. Observe the same unchanged screen twice.
6. Small changed region only.
7. Visual ambiguity requiring screenshot.

## 5.2 Browser Use

1. Click button.
2. Fill + submit form.
3. Navigation.
4. Modal/dialog.
5. SPA DOM update.
6. DOM/accessibility sufficient.
7. Screenshot required.

## 5.3 MCP

1. Fast read-only tool.
2. Computer Use tool.
3. Four independent commands via `codex_parallel_exec`.
4. <100 ms native tool.
5. Multi-second tool.
6. Detached-result path.

## 5.4 Context

1. 20k tokens.
2. ~100k.
3. ~200k.
4. ~500k.
5. 4 images.
6. 20+ images.
7. ZIP context.
8. retry/reconnect reusing same canonical context.

---

# 6. Phase 2 — Computer Use: Minimize Observe → Decide → Act

This is the highest-priority user-visible loop.

## 6.1 Keep native session hot

Investigate repeated:

```text
imports
tool discovery
list_apps
window enumeration
trusted-service initialization
app/window resolution
```

Cache only with explicit invalidation.

Recommended hierarchy:

```text
session
  -> module handle
  -> app identity
  -> window identity
  -> control tree/version
```

Invalidate on app/window/process/layout/control-tree changes.

Never reuse stale coordinates after a layout-changing transition without validation.

## 6.2 Structured-first observation

Decision order:

```text
1. persistent known state
2. structured app/window/control delta
3. accessibility/control tree
4. relevant-region screenshot
5. full-screen screenshot as last resort
```

A screenshot should not be default if structured state already proves focused window/control, bounds, role, value, enabled/checked/selection state.

## 6.3 Observation signature / unchanged-state detection

Create a cheap semantic signature from stable state.

If N+1 is semantically identical to N:

- do not re-describe it,
- do not resend the full screenshot,
- reuse structured state,
- continue from existing working state.

Do not classify visually changed state as unchanged merely because window identity is the same.

## 6.4 ROI screenshot

When visual evidence is necessary:

- capture relevant/changed region when supported,
- preserve enough surrounding context,
- retain DPI/scale and coordinate mapping,
- avoid full desktop capture for tiny targets.

Benchmark visual tokens, image transfer, and action accuracy.

## 6.5 Deterministic low-risk batching

When no branch/confirmation/destructive choice exists, batch a short sequence such as:

```text
focus field
Ctrl+A
type replacement
press Enter
```

instead of observe after every keypress.

Stop batching when state may branch, a modal may appear, the operation is destructive, approval is needed, or target identity is ambiguous.

## 6.6 Safe observation prefetch

After a low-risk action, overlap read-only work when useful:

```text
transition detection
structured state extraction
ROI capture
```

Do not speculatively execute a mutation before current state is known unless the existing deterministic batching contract already authorizes the sequence.

---

# 7. Phase 3 — Browser Use: DOM-First and Event-Driven

## 7.1 Replace hot-path fixed sleeps with state proof

Search for:

```text
setTimeout
polling: 50
100 ms loops
250 ms loops
UI settle waits
```

Classify each as:

```text
required debounce
safety deadline
missing-event workaround
unnecessary fixed sleep
```

Replace missing-event/unnecessary sleeps with:

- `MutationObserver`,
- Playwright locator state,
- response/navigation events,
- URL changes,
- DOM streaming/completion attributes,
- CDP lifecycle events.

Keep large maximum failure deadlines.

## 7.2 Coalesce independent DOM reads

Where reads are truly independent and read-only, use concurrent probes rather than serial protocol calls.

Candidates:

```text
error visibility
stop-button state
response metadata
composer state
URL/title
attachment readiness evidence
```

Measure Playwright protocol-call count before/after.

## 7.3 DOM/accessibility before screenshot

Use screenshots only for canvas, image-only UI, spatial drag/drop, diagrams, or rendered editors where semantic DOM is insufficient.

---

# 8. Phase 4 — MCP / Broker / Helper IPC

## 8.1 Measure line-JSON helper overhead

Measure:

```text
JSON.stringify
pipe write
parse
message bytes
progress-frame frequency
```

Do not replace the transport unless it is measurably material.

## 8.2 Coalesce progress-only frames

`turn-progress.ts` is already event-driven. If revisions are excessively frequent, coalesce only non-semantic progress updates over one event-loop tick or similarly tiny window.

Never coalesce away:

```text
tool batch boundary
tool result
completion fence
abort
compaction request
```

## 8.3 Cache tool discovery by registry fingerprint

Avoid rediscovering the same native surface repeatedly within a valid registry/session.

Invalidate whenever the outer tool registry changes.

## 8.4 Preserve direct fast paths

Benchmark direct native calls against generic `codex_tool_call` gateway. Use direct path where already exposed and safe; retain gateway as compatibility fallback.

---

# 9. Phase 5 — Context / Prompt / Archive Performance

## 9.1 Cache immutable canonical prompt prefixes

Investigate caching:

```text
canonical message prefix
serialized context prefix
token counts
image counts
skill metadata
model-independent historical envelope
```

Never cache live `turn_token`, active recovery identity, latest user request, mutable capability proof, or mutable registry.

## 9.2 Incremental token accounting

Avoid tokenizing the entire unchanged history each turn.

Maintain per-message/prefix counts and verify exact equality against full tokenizer output in tests.

Approximate counts must never bypass hard model/browser limits.

## 9.3 Cache context archive artifact

The archive already has a deterministic digest-derived name.

If canonical `contextText`, image identities/details, and skill identities are unchanged during retry/reconnect, reuse the built archive rather than rerun `zipSync`.

Use bounded LRU/TTL by bytes and entries.

Do not cross security/session boundaries.

## 9.4 Benchmark ZIP strategy

Current:

```text
zipSync(entries, { level: 6 })
```

Benchmark:

```text
level 0
level 1
level 3
level 6
async/off-thread ZIP
artifact cache reuse
```

PNG/JPEG/WebP is already compressed; test whether storing image entries with minimal recompression reduces total E2E latency.

Choose fastest:

```text
turn start -> submission accepted
```

not smallest ZIP.

## 9.5 Move expensive synchronous work off hot event loop only when justified

Candidates:

```text
ZIP
large hashing
large JSON serialization
tokenization
```

First cache/incrementalize. Add worker-thread complexity only if profiling proves it is still material.

---

# 10. Phase 6 — Screenshot / Image Pipeline

## 10.1 Avoid duplicate conversions

Audit paths for repeated:

```text
Buffer -> base64 -> data URL -> parse -> base64 -> Buffer
```

Capture once, hash once, and keep the representation needed by the next boundary.

## 10.2 Deduplicate unchanged screenshots

Use robust visual/semantic signature. Do not deduplicate solely by window identity or timestamp.

## 10.3 Adaptive detail

Use high detail for small text/fine controls/precise coordinates. Test lower-resolution visual state where exact structured bounds already exist.

Measure:

```text
accuracy
retry rate
observe->action latency
```

---

# 11. Phase 7 — Model-Facing Optimization Without Lowering Reasoning

Do not lower user-selected Extra High reasoning as a speed hack.

Optimize the information presented to the model.

## 11.1 Remove duplicated static instructions

Audit repeated Computer Use, command safety, completion, tool discovery, and transport rules across:

- global MCP instructions,
- individual tool descriptions,
- prompt wrapper,
- gateway descriptions.

Consolidate byte-for-byte duplication carefully without losing semantics.

Measure:

```text
input tokens
TTFT
first tool-call latency
tool-selection correctness
```

## 11.2 Structured observation delta

Prefer compact machine-readable state:

```json
{
  "state_id": "...",
  "changed": true,
  "focused_window": "...",
  "focused_control": "...",
  "changed_controls": [],
  "removed_controls": [],
  "added_controls": [],
  "screenshot_ref": null
}
```

instead of verbose full-screen prose every cycle.

## 11.3 Action-oriented tool results

Put decision-critical fields first:

```text
success/failure
new state id
target state
changed control
unexpected modal/error
auxiliary diagnostics
```

Keep full diagnostics for failure/debug mode.

## 11.4 Tool-choice persistence

Once a turn has a proven execution path such as `node_repl + @oai/sky`, preserve a compact execution-state reminder rather than forcing repeated discovery.

---

# 12. Phase 8 — Browser-Worker Hot-Path Audit

Build a benchmark table:

| Stage | p50 | p95 | Protocol calls | Fixed wait? | Event proof? | Optimization |
|---|---:|---:|---:|---|---|---|
| browserPage | | | | | | |
| temporaryChatPreparation | | | | | | |
| effortSelection | | | | | | |
| submissionBaseline | | | | | | |
| promptAttachment | | | | | | |
| fileAttachment | | | | | | |
| send | | | | | | |
| response observation | | | | | | |
| tool-boundary observation | | | | | | |

Existing `browserStageTimeouts` are maximum failure budgets.

Do **not** lower 300–450 second failure ceilings merely to make benchmarks look faster. Make success detection faster instead.

---

# 13. Phase 9 — Warm Paths and Reuse

Investigate reuse of:

```text
browser helper process
Playwright connection
ChatGPT page
selected model/effort proof
retained conversation
tool-registry fingerprint
canonical context digest
archive artifact
tokenizer prefix result
Computer Use session
app/window/control identity
```

Every cache must define:

```text
key
scope
invalidation
maximum lifetime
memory limit
security boundary
```

No unbounded caches.

---

# 14. Phase 10 — Concurrency / Overlap

Draw a dependency DAG for hot paths.

Parallelize independent read-only work such as:

```text
historical context hashing
token counting immutable pieces
independent DOM probes
structured UI state + ROI screenshot
diagnostic metadata collection
independent native reads
```

Never parallelize state-dependent or approval-sensitive mutations.

---

# 15. Mandatory E2E Self-Healing Loop

When E2E discovers a bug/error, do not merely report it.

Use:

```text
observe failure
-> capture minimal evidence
-> root-cause
-> add/fix regression test
-> patch source on main
-> focused test
-> rerun exact failed E2E
-> wider regression
-> commit on main
-> continue optimization
```

Do not keep benchmarking on top of a known correctness defect.

## Failure classes

### Correctness
Wrong click, lost context/image, dropped tool result, premature completion → fix immediately.

### Lifecycle/recovery
Reconnect 5/5, helper lease expiry, helper death, tunnel loss, daemon reload failure → fix immediately.

### Performance
Slow observe cycle, archive CPU spike, duplicate observation, duplicate discovery → benchmark + fix.

### External/service
Real capacity/rate limit/network/account security → do not bypass safety. Harden only safe transient recovery.

---

# 16. Mandatory Real Codex E2E Test — GPT‑5.6 Sol High (web)

This is a required real-user-path validation. The optimization agent executing this plan is **GPT‑6.1 Sol High**, while the real Codex workload used for Browser Use and Computer Use performance validation must include **GPT‑5.6 Sol High (web)**.

The purpose is to test the same path the user actually uses, not only internal unit tests, mocks, or `dev:chat`.

## 16.1 Start Codex from ordinary CMD or PowerShell

Use a normal Windows terminal.

PowerShell:

```powershell
codex
```

CMD:

```cmd
codex
```

For this E2E path, **do not manually start auxiliary Browser Use or Computer Use runtimes before launching Codex**.

Expected lifecycle:

```text
codex
  -> starts/attaches the normal Codex runtime
  -> loads the configured MCP/runtime surfaces
  -> automatically starts or attaches required auxiliary runtimes
  -> exposes Browser Use and Computer Use capabilities
```

This includes runtime/tool surfaces such as:

```text
codex-computer-use-swift
```

when that runtime is part of the currently configured Codex Computer Use stack.

The user should not need to run a separate runtime-launch command before `codex`.

If simply running:

```text
codex
```

does not bring up the required Browser Use / Computer Use runtime stack automatically, treat that as a product/runtime lifecycle bug. Fix it directly on `main`, add regression coverage, and repeat the real CLI test before continuing performance work.

## 16.2 Select the real web model

Inside the ordinary Codex session, select/use:

```text
GPT‑5.6 Sol High (web)
```

The E2E test must exercise the real ChatGPT Web backend path rather than a mocked browser worker or native-API substitute.

Verify that the effective execution configuration corresponds to:

```text
model: GPT‑5.6 Sol
reasoning: High
backend/transport: ChatGPT Web
```

Do not silently fall back to Luna, a native API model, a lower reasoning effort, or a browser-only mock.

## 16.3 Verify runtime auto-start / attachment

Immediately after `codex` starts, verify the expected runtime surfaces are available without manually launching them.

Use the product's normal runtime/MCP inventory path, for example:

```powershell
codex mcp list
```

and/or the in-session native tool inventory.

For Windows process diagnostics, use read-only checks if useful:

```powershell
Get-Process | Where-Object {
    $_.ProcessName -match 'codex|computer|swift'
} | Select-Object ProcessName, Id, Path
```

or from CMD:

```cmd
tasklist | findstr /i "codex computer swift"
```

The exact OS process name may differ from the logical runtime/tool name. Do not fail the test merely because the executable is not literally named `codex-computer-use-swift`; verify that the corresponding configured runtime/tool surface is alive, attached, and callable.

Record, where available:

```text
Codex PID
Responses daemon PID
tunnel PID/fingerprint
browser-helper PID
Computer Use runtime identity
Browser Use runtime identity
tool/MCP registry fingerprint
```

Do not record credentials, tokens, tunnel keys, or account secrets.

## 16.4 Browser Use E2E scenario

From the ordinary `codex` session running **GPT‑5.6 Sol High (web)**, give it a deterministic Browser Use task.

Recommended shape:

```text
Open the configured browser surface, navigate to a deterministic local/test page,
inspect the page, interact with a form/button, verify the resulting DOM state,
and complete the task.
```

Prefer a deterministic local fixture or controlled test page rather than a changing public website.

The test must include:

```text
page observation
DOM/accessibility reasoning
at least one browser action
post-action state verification
```

Measure:

```text
T_browser_observe_to_next_action
time to first browser action
number of DOM observations
number of screenshots
number of tool calls
total task completion time
retries/reconnects
```

Expected fast path:

- use DOM/accessibility state when sufficient;
- do not take screenshots merely because Browser Use exists;
- do not re-observe unchanged state unnecessarily;
- do not rediscover the same browser tool surface repeatedly;
- move to the next action immediately once enough state is proven.

## 16.5 Computer Use E2E scenario

From the same ordinary `codex` session, run a deterministic Windows native-app task using **GPT‑5.6 Sol High (web)**.

Recommended shape:

```text
Open or focus a harmless native app such as Notepad,
inspect its current window/control state,
enter deterministic text,
perform a small low-risk UI action,
verify the resulting state,
then stop.
```

The test must exercise the real configured Computer Use path, including the runtime/tool surface associated with the normal Codex installation, for example the stack that exposes `codex-computer-use-swift`, persistent `node_repl/@oai/sky`, or the current official equivalent.

Do not manually launch the Computer Use runtime first.

Measure:

```text
T_observe_to_next_action
structured-observation latency
screenshot latency when used
action dispatch latency
action completion latency
number of observations
number of screenshots
number of tool-discovery calls
total task time
```

Expected fast path:

- `codex` automatically provides/attaches the Computer Use runtime;
- persistent Computer Use state is reused;
- structured app/window/control state is preferred;
- unchanged screen is not fully re-analyzed;
- screenshot is used only when fresh visual evidence is needed;
- short deterministic low-risk action sequences may be batched;
- imports, `list_apps`, and tool discovery are not repeated without an invalidation reason.

## 16.6 Auto-start lifecycle test across `dev:live` reload

While the ordinary Codex CLI session is active and `bun run dev:live` owns the source runtime:

1. Record current runtime identities.
2. Trigger a safe `src/**/*.ts` source reload.
3. Verify:
   - Responses daemon may restart;
   - tunnel identity remains stable;
   - Codex CLI session remains usable;
   - Browser Use / Computer Use runtimes remain available or automatically reattach;
   - no manual launch of `codex-computer-use-swift` or another auxiliary runtime is required.
4. Run one Browser Use action and one Computer Use action after reload.

Then repeat an Electron-main reload according to the tunnel-continuity section.

A reload that causes the CLI to lose Browser Use / Computer Use registration is a lifecycle regression and must be fixed before continuing.

## 16.7 Reconnect / recovery E2E

Test at least:

```text
browser-helper reconnect
Responses daemon source reload
temporary ChatGPT Web network error
browser page rebind
tool call in progress during a transient backend error
```

After recovery:

- the same logical Codex task must continue;
- Browser Use and Computer Use surfaces must still be callable;
- required auxiliary runtimes must automatically recover or reattach;
- the user must not need to exit Codex and manually restart `codex-computer-use-swift` or another runtime.

Any case that requires manual runtime startup is a failure.

## 16.8 Real CLI pass criteria

The real E2E CLI test passes only when:

```text
1. User opens CMD or PowerShell.
2. User types only: codex
3. Codex initializes/attaches the required runtime stack automatically.
4. GPT‑5.6 Sol High (web) is selected and actually used.
5. Browser Use works end-to-end.
6. Computer Use works end-to-end.
7. Required auxiliary runtime/tool surfaces start or attach automatically.
8. Source reload requires no manual runtime repair.
9. Recovery/reconnect requires no manual runtime repair.
10. Performance telemetry is captured for Browser Use and Computer Use.
```

If any point fails:

```text
reproduce
-> add/update regression test
-> patch main
-> rerun the exact CLI scenario
-> run focused tests
-> bun run verify
-> push main
-> inspect GitHub Actions
```

Only then resume optimization work.

---

# 17. Testing Strategy

## Focused tests

Examples:

```powershell
bun test .\tests\computer-use-fast-path.test.ts
bun test .\tests\browser-worker-contract.test.ts
bun test .\tests\mcp-observation.test.ts
bun test .\tests\launcher-helper-client.test.ts
bun run --cwd launcher test
```

## Real live test

For runtime/browser/MCP/Computer Use behavior:

```powershell
bun run dev:live
```

## Full gate

Before major checkpoint:

```powershell
bun run verify
```

After pushing `main`, inspect GitHub Actions and keep fixing current failures until relevant jobs are green.

Do not disable a test just because it is inconvenient.

For flaky timeout, prove runner-load behavior before widening only the affected test's budget.

---

# 18. Performance Acceptance Criteria

Establish baseline first.

## Primary target

Aim for:

```text
>= 1.5× effective interaction throughput
```

where achievable without correctness loss.

Equivalent rough cycle target:

```text
~33% lower latency
```

or better.

## Computer Use

Target:

```text
p50 observe -> next action: -35% or better
p95 observe -> next action: -25% or better
```

No meaningful increase in wrong-action, extra-observation, retry, or malformed-action safety-block rate.

## Browser Use

Target:

```text
p50 state -> next action: -30% or better
p95 state -> next action: -20% or better
```

## Context archive

For representative 200k+ token multi-image turn, target:

```text
archive build CPU: -40% or better
```

only if archive CPU is actually material.

Most important metric remains:

```text
turn start -> submission accepted
```

---

# 19. Performance Regression Tests

Prefer stable semantic/operation-count tests over fragile tight wall-clock tests.

Good examples:

- no screenshot when structured state is sufficient,
- unchanged observation reuses cached state,
- archive retry reuses cached artifact,
- independent DOM probes execute concurrently,
- unchanged registry is not rediscovered,
- immediate-success path has no fixed sleep.

Use timing reports for benchmarks unless a CI timing threshold has a large safe margin.

---

# 20. Recommended Execution Order

## P0 — Preserve ability to work
- pull `main`,
- verify main/clean state,
- start `bun run dev:live`,
- prove tunnel independence,
- fix tunnel continuity first if necessary.

## P1 — Instrument
- stage timers,
- Computer Use cycle telemetry,
- Browser Use cycle telemetry,
- archive timing,
- baseline report.

## P2 — Computer Use
- persistent state,
- structured-first observation,
- unchanged-state dedup,
- ROI screenshots,
- deterministic batching,
- read-only observation prefetch.

## P3 — Browser Use
- event-driven proof,
- concurrent read-only DOM probes,
- DOM/accessibility-first,
- screenshot fallback.

## P4 — Context/archive
- prefix cache,
- token cache,
- archive artifact reuse,
- ZIP strategy benchmark,
- off-thread work if justified.

## P5 — MCP/IPC
- measure serialization,
- coalesce non-semantic progress if useful,
- cache discovery,
- preserve direct tool fast paths.

## P6 — Model-facing contract compression
- remove redundant static instructions,
- structured deltas,
- action-oriented results,
- preserve GPT‑6.1 Sol High reasoning quality.

## P7 — Cross-path optimization
- DAG,
- overlap independent reads,
- warm caches,
- bounded LRU,
- failure-path checks.

## P8 — E2E self-heal
- real workflows,
- immediately fix every repo bug,
- rerun scenario,
- `bun run verify`,
- push `main`,
- inspect Actions until green.

---

# 21. Things You Must Not Do

Do not:

- create another branch,
- lower model reasoning effort to claim speed,
- disable account-safety,
- bypass a real platform safety classifier,
- blindly retry blocked side-effectful actions,
- remove recovery fences,
- disable tests,
- drop context or images to fake transport speed,
- make archive transport lossy,
- lower timeout ceilings without measuring success-path latency,
- replace event-driven progress with polling,
- add unbounded caches,
- reuse stale UI coordinates after layout changes,
- claim E2E speedup from microbenchmarks alone.

---

# 22. Required Final Deliverables

## Performance report

Include:

```text
baseline commit
final commit
machine/environment
scenario count
p50/p95
before/after
percent improvement
error/retry rate
```

Separate Computer Use, Browser Use, MCP, ChatGPT browser submission, context archive, and overall turn.

## Architecture report

List what changed, why, cache/invalidation behavior, event-driven paths, removed waits, and new telemetry.

## Bug evidence

List every E2E-discovered bug and how it was reproduced, tested, fixed, and retested.

## Tunnel evidence

Include:

```text
tunnel PID/fingerprint before
after src reload
after Electron reload
daemon PID before/after
live readiness proof
```

No secrets.

## Test evidence

Include focused tests, `bun run verify`, GitHub CI, Windows build, and publish workflow if triggered.

## Git evidence

Confirm:

```text
all work occurred on main
no extra branch created
main pushed successfully
working tree clean
```

---

# 23. Definition of Done

The project is complete only when:

- tunnel survives `dev:live` source reloads,
- Computer Use is measurably faster,
- Browser Use is measurably faster,
- no context fidelity regression exists,
- no safety/recovery regression exists,
- E2E-discovered bugs were fixed immediately,
- benchmarks show real E2E gain,
- `bun run verify` passes,
- relevant GitHub Actions pass,
- Windows build/smoke passes,
- working tree is clean,
- every commit is on `main`,
- no extra branch exists because of this work.

Guiding rule:

> **Optimize the time between useful state becoming available and the next correct action being executed.**

Do not optimize merely for fewer lines, lower timeout numbers, smaller logs, or smaller prompts. Optimize the real user-visible control loop.

---

# 24. Execution results — 2026-10-04

This section records observed results; it does not redefine the acceptance criteria above. The complete plan is **partially fulfilled**, with real environment blockers remaining.

Detailed evidence, cache/invalidation contracts, timings, bugs, validation and limitations: [Backend performance execution report](docs/backend-performance-2026-10-04.md).

Implemented directly on main and pushed in logical milestones:
- Live runtime lease ownership guard (`3c39f9b`, rewritten integration of the original local fix).
- Content-free opt-in backend stage/tool telemetry (`9c950c9`).
- Exact tokenizer-scoped bounded chunk caching (`9d2b8aa`).
- Prefix admission for oversized contexts, preserving exact suffix counts (`e3ffc1b`).
- Full-content archive artifact reuse, image-store/text-deflate ZIP strategy, concurrent session reads and DOM/native-progress response wakeup (`3c1567a`).
- Archive eviction coverage and ignored browser capture artifacts (`49fc25c`).
- Final corrections: exact Unicode manifest metadata keys and independently owned token-key storage, including preservation of admitted keys on LRU access. Before/after retained-heap experiment: 116.82 MB -> 0.35 MB. No context or code units dropped.

Measured synthetic/CDP preparation results (not E2E speedup):
- Unique JSON prefix + changing suffix, 1,077,374 exact tokens: p50 637.96 -> 259.24 ms; p95 658.39 -> 269.62 ms; seven warm samples.
- 200k-word archive +20 valid noise PNGs, one initial build and nine retries: p50 507.06 ->24.70 ms; p95 636.48 ->108.88 ms. Archive bytes18456607 ->18452807, all content intact.
- Controlled20ms DOM transition: response wakeup p50 251.06 ->38.16 ms; p95 251.62 ->39.02 ms;20 samples, unchanged250ms fallback.
- Independent session-alert visibility reads: p50 2.384 ->1.692 ms; p95 6.285 ->3.603 ms;50 samples, unchanged401 priority.

Real ordinary `codex`, GPT-5.6 Sol High web, same CLI and local fixture:
- Browser before/after: both5/5 rounds +dialog verified through semantic DOM; zero screenshots. Source and Electron reloads preserved the tunnel, and Browser MCP continued without manually launching auxiliary runtimes.
- Full request duration679.552 ->652.563 s (one sample each). Five browser interaction intervals worsened: p50 11.966 ->28.037 s; p95 12.363 ->96.630 s. Model/bridge gaps and runtime safety rejections dominate; no1.5x E2E throughput claim is justified.
- Successful fill+submit p50/p95627.8/668.7 ->602.0/613.4 ms; verification26.5/36.0 ->18.7/19.8 ms. These five samples do not establish causal model-loop improvements.
- Computer before: native discovery rejected for indeterminate runtime safety status. After reload: @oai/sky discovery and one fresh Notepad launch succeeded, then bind/activate was blocked because the runtime could not confirm the desktop was unlocked (no foreground window). Zero typing, saving, closing, screenshots or minimize/restore followed. Computer Use E2E/latency targets remain unmet; safety checks were preserved.
- Post-metadata source-reload smoke verifiedPERF-FINAL; no repeated Browser actions. A completion-receipt safety rejection required one accepted retry. Final key-storage smoke/evidence is recorded in the report and local validation artifacts.

Validation:
- Relevant focused suites passed, including Unicode, exact token accounting, immutable archive bytes, invalid attachments, bounded eviction, probe priority and observer/progress cleanup.
- Latest local full verify uses pinned Bun1.4.0 and still fails only at two EPERM file-symlink fixture creations; separate launcher suite has one equivalent symlink fixture failure. No tests were skipped to hide these failures and no Windows security setting was changed.
- Rendererbuild/runtimebundle/licenses/relocatable smoke passed; CI/Windows build/installer publish all green at49fc25c. Final revision Actions are inspected after push and recorded separately to avoid a self-referential report commit.
- No branch/worktree, reset/discard or force push was used. Intervening main updates and original WIP were preserved. Generated benchmark/rawCLI evidence remains in ignoredoutput/backend-performance; no private user content is committed.

P0passed; P1implemented with explicit proxy boundaries; P2measurement blocked; P3/P4/P7selected optimizations measured; P5/P6existing safe paths retained where further changes lacked evidence; P8Browser/reload passed, Computer/local fullverify/recovery-fault-injection acceptance remains incomplete. Reasoning remains High and failure/recovery/safety deadlines remain intact.

Final storage-correction evidence: 965root tests passed,22platform skips,2known symlink EPERM failures. The same ordinary GPT-5.6 Sol High web CLI verifiedPERF-OWNED after the final source reload; zero Browser action blocks/retries/screenshots. Live owner59024 remained; daemon160264 ->114024, samee5d543f0...fingerprint, readiness3.037s. Final revision CI/build/publish results are reported after push; the report does not claim those results before completion.

Post-unlock continuation (2026-10-04): ordinary Codex selected GPT-5.6 Sol Web High and retained the existing live tunnel. Native discovery, fresh Notepad launch/bind/activate and structured observation succeeded after a normal retry; the first launch/read took972.294/373.411ms. A capacity interruption and CLI restart invalidated REPL bindings, requiring documented recovery. A later fresh owned Notepad acceptedPERF-1 exactly once, verified from its accessibility document Value and Document text block; optional document_text/focused_element fields were absent. The E2E check was corrected to distinguish missing fields from missing content, with no duplicate input. The later refocus/refresh returned an unknown outcome and stopped input. Five-round Computer E2E, minimize/restore and causal speedup remain unestablished. Full verify was rerun:965pass,22skip,2sameEPERM symlink fixture failures. CI, Windows build/smoke and installer publish all passed at the final implementation revisionb7ed23d. Detailed native timings, interruptions and remaining acceptance gaps are recorded in the report; these observations do not relax the original Definition of Done.

Final read-only recovery after the failed refocus established the native blocker: `window id 6298442 was not found. Current windows: []` (27.930ms), with no nested cause. The cause of window disappearance was not established; no assertion of a still-locked desktop is made. Computer result is1/5lines verified,0screenshots, no repeated input/save/close/discard. No additional optimization was committed without evidence; this continuation adds observed acceptance results and repeats verification, while preserving the existing implementation and all safety/recovery deadlines.

Subsequent user-requested Native Full Access retest: launcher config/state enabled and fresh Codex policy confirmed `approval_policy=never`, `sandbox_policy.type=danger-full-access`, and `permission_profile.type=disabled`. Computer initial structured state passed, but its next click was rejected by OpenAI indeterminate-safety review before execution; 0/5 lines in this retest. Independent Browser 5/5 markers plus dialog passed after correcting workload/API errors and recovering a capacity interruption; no screenshots. Five marker rounds were batched in one Playwright call, so local 32–59 ms totals are not model-loop speedup evidence. The launcher setting explanation now states its native-policy scope and external/Windows checks. Full results and unchanged acceptance gaps: [Native Full Access retest](docs/native-full-access-2026-10-04.md).
