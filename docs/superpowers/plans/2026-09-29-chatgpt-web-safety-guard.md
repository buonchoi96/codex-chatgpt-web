# ChatGPT Web Account-Safety Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Detect account-security challenges in Launcher, persist a fail-closed latch, and stop current and future ChatGPT Web work until explicit manual resume.

**Architecture:** BrowserHost detects and persists finite signals, then cancels exact active trace IDs. An authenticated loopback status endpoint lets the daemon mirror the latch into ChatGptAccountSafety; the daemon checks before routed turns and each MCP invoke, cancels affected responses, and propagates a non-retryable typed error. Launcher UI shows the signal and requires explicit confirmation to resume.

**Tech Stack:** Electron CommonJS, TypeScript, Bun tests, Node test runner, React launcher UI.

**Spec:** docs/superpowers/specs/2026-09-29-chatgpt-web-safety-performance-design.md

## Global Constraints

- Never reload, navigate, probe authentication, submit, retry, or solve a detected challenge.
- Persist only finite signal, revision, detection/resume timestamps, and safe correlation metadata; never persist page text, prompt, cookies, or screenshots.
- Invalid, missing, or unreachable launcher status fails closed.
- Account-security signals enter immediate HARD_STOP; no captured trace remains authorized.
- Only a newer explicit launcher resume revision can clear a launcher-derived daemon hard stop.
- Do not run real GPT-5.6 Web tests until the integrated safety guard passes.
- A new real account-security signal stops automation and is reported as PAUSED_SECURITY_TRIGGER.

## Review Focus

- Invalid persisted latch: normalize to paused and reject automation.
- Unreachable or malformed status: reject before turn admission and MCP enqueue.
- Same/stale resume revision: retain daemon hard stop.
- Signal during active response: cancel exact traces and terminate that response.
- Manual mode: status checks inspect no page DOM; resume sends no ChatGPT request.

---

### Task 1: BrowserHost detection and persistent stop

**Files:**
- Modify: launcher/electron/browser-host.cjs
- Modify: launcher/electron/main.cjs
- Test: launcher/tests/browser-host.test.cjs
- Test: launcher/tests/runtime-supervisor.test.cjs

**Interfaces:**
- automationSecuritySignalForPage({ url, text }) returns a finite signal or null.
- BrowserHost.automationSecurityStatus() returns a validated record or fail-closed invalid-state record.
- BrowserHost.triggerAutomationSecurity(signal, context) persists first, cancels exact active traces, blocks admissions, and publishes state.

- [x] Test explicit Cloudflare backend challenge, account warning, CAPTCHA/human challenge, trusted-origin scope, bounded text, false-positive verification copy, and third same-origin auth redirect.
- [x] Test persistence-before-cancel, exact cancellation, no reload/auth probe, invalid stored state, and automatic/manual gates; run focused tests and confirm expected RED results.
- [x] Implement finite validation, page/response/redirect detection, durable latch, targeted cancellation, and automatic/manual gates; remove idle Cloudflare recovery reload/probing.
- [x] Run BrowserHost and RuntimeSupervisor tests (launcher suite: 410 pass, 4 skipped).

### Task 2: Authenticated status and typed client errors

**Files:**
- Modify: launcher/electron/control-server.cjs
- Modify: src/launcher-browser-host.ts
- Modify: src/adapters/chatgpt-web/browser-worker.ts
- Test: launcher/tests/control-server.test.cjs
- Test: tests/launcher-browser-host.test.ts

**Interfaces:**
- GET /v1/automation-security/status uses the existing bearer token and returns { automationSecurity } without reading preferences.
- readLauncherAutomationSecurityStatus(path, timeoutMs?) validates a finite record and throws non-retryable LauncherAutomationSecurityStatusUnavailableError on transport/shape failure.
- LauncherAccountSafetyStopError preserves code chatgpt_account_safety_stop, retryable false, and optional finite signal.

- [x] Test authenticated status, unauthorized denial, invalid records, and typed 409 stop propagation; confirm expected RED results.
- [x] Implement the authenticated route and strict client validator.
- [x] Preserve typed stop through turn and manual control and BrowserWorker; do not convert it to a retryable network failure.
- [x] Run focused control-server and client tests.

### Task 3: Daemon hard stop and MCP dispatch boundary

**Files:**
- Modify: src/adapters/chatgpt-web/account-safety.ts
- Modify: src/adapters/chatgpt-web/turn-broker.ts
- Modify: src/adapters/chatgpt-web/index.ts
- Test: tests/account-safety.test.ts
- Test: tests/turn-broker-lifecycle.test.ts
- Test: existing ChatGPT Web adapter integration test

**Interfaces:**
- trigger(account_security, activeTraceIds) persists immediate HARD_STOP and returns unique trace IDs for cancellation.
- reconcileLauncherAutomationSecurity(record: unknown): boolean fails closed; only a newer explicit resume revision clears a launcher-derived stop.
- TurnBroker.setDispatchGuard((traceId) => void | Promise<void>) runs before an MCP invoke is queued.

- [x] Test immediate hard stop, exact trace capture, newer explicit resume, invalid status, and MCP rejection before enqueue; confirm expected RED results.
- [x] Implement persisted immediate HARD_STOP, revision reconciliation, and the dispatch guard.
- [x] Check launcher status before every Launcher-backed routed turn and every MCP invoke; cancel active traces and revoke broker calls when blocked.
- [x] Map status-unavailable and account-stop errors to non-retryable adapter responses and prevent reconnect/retry of the stopped response.
- [x] Run focused account-safety, broker, and adapter tests.

### Task 4: Launcher warning and explicit resume

**Files:**
- Modify: launcher/src/types.ts
- Modify: launcher/src/App.tsx
- Modify: launcher/src/i18n.ts
- Modify: launcher/electron/preload.cjs
- Modify: launcher/electron/main.cjs
- Test: launcher/tests/renderer-wiring.test.cjs
- Test: launcher/tests/state.test.cjs

**Interfaces:**
- BrowserState.automationSecurity contains the finite persisted record.
- LauncherApi.resumeAutomationSecurity() performs only a local state-store resume after renderer confirmation.

- [x] Test warning fields, confirmation, newer revision, and no browser navigation/probe/request; confirm expected RED results.
- [x] Implement localized warning with signal and detection time plus explicit “I resolved this; resume automation” confirmation.
- [x] Implement IPC that resumes only an active latch, updates BrowserHost, and publishes the newer revision.
- [x] Run launcher renderer/state tests and launcher typecheck.

### Task 5: Integrated verification and model-test gate

**Files:** No product files unless a verification defect requires a fix.

- [x] Run root and launcher focused tests.
- [x] Run bun run typecheck and bun run launcher:typecheck.
- [x] Run bun run test, bun run launcher:test, bun run launcher:build, and bun run verify with bun@1.4.0.
- [x] Confirm the current source-live baseline is healthy and both active turn counters are zero before integration.
- [x] Verify latch detection, typed stop, and explicit resume locally without sending a real model prompt.
- [x] After the guard gates passed, run the separately approved GPT-5.6 Sol High CLI test matrix; record unavailable outer tools and upstream router failures as external blockers below.
- [ ] On a new real security signal, stop automation and report PAUSED_SECURITY_TRIGGER; collect no further ChatGPT diagnostics.

### Real GPT-5.6 Sol Web High CLI matrix (2026-09-30)

The model returned the requested exact response after the source patch. The initial `Selected model is at capacity` response was retried after the user-requested five-minute wait; the retry succeeded. No account-security signal was observed.

| Test | Result | Evidence |
| --- | --- | --- |
| 1. Parallel read/audit | PASS | Eight connector commands completed through the parallel ABI. The earlier baseline stalled for 60 seconds because `codex_parallel_exec` was not exposed; the run duration for the successful eight-command case was not retained. |
| 2. Long-running command | PASS | A 35-second command yielded a session, was polled, and exited 0. |
| 3. Computer Use decision latency | BLOCKED | The CLI turn did not expose a working native `node_repl`/`@oai/sky` path. `codex-computer-use-swift.exe` was running, but its process alone did not provide a callable CLI tool. No latency sample was available. |
| 4. Repeated unchanged UI | BLOCKED | Same missing native Computer Use capability as Test 3; no comparable UI observations were available. |
| 5. Browser multi-step | BLOCKED | The CLI did not provide a usable Browser provider/tab identifier for the requested ChatGPT Web browser actions. |
| 6. Mixed Browser + Computer + shell | BLOCKED | Browser and native Computer Use capabilities were unavailable in that CLI surface; shell-only coverage does not satisfy this scenario. |
| 7. Subagent stress | BLOCKED (upstream CLI) | Three subagents were started, then `codex_core::tools::router` logged `agent ids must be non-empty`; the parent did not aggregate results. Four turns were cancelled and health returned to 0/0. Full local evidence: `C:\Users\Long-PC\Documents\codex-web-gpt-full-debug-subagent-stress-2026-09-29.zip` (not shared). |
| 8. Command safety | PASS | Four independent read-only commands completed concurrently; 4 succeeded, 0 failed, in 3,924 ms. |
| 9. Completion receipt | PASS | The same run accepted its completion receipt after all four command results arrived. |
| 10. End-to-end stress | BLOCKED (external capabilities) | The required Browser and Computer Use steps are unavailable through the CLI surface (Tests 3–6), and the subagent aggregation dependency failed upstream (Test 7). It was not run as a partial shell-only substitute. |

The combined trace for Tests 8–9 is `C:\Users\Long-PC\AppData\Local\Temp\codex-web-sol-high-capacity-retry-8-9-2026-09-29.jsonl`. The post-patch real-model smoke trace is `C:\Users\Long-PC\AppData\Local\Temp\codex-web-sol-high-post-patch-2026-09-30.jsonl` and ended with exit code 0. The full repository verify passed with Bun 1.4.0. A matched Computer Use or Browser latency comparison could not be produced because the required outer CLI tools were unavailable; do not claim a measured speedup for those paths.
