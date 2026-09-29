# ChatGPT Web Safety Guard and Performance Design

## Purpose

Improve reliability and measured throughput for GPT-5.6 Sol (Web) High through Codex while preserving command safety, sandboxing, browser verification, and account protection. Establish a hard automation stop for account-security and anti-bot signals before further live Web testing. Optimize only bottlenecks supported by comparable measurements.

## Existing evidence and constraints

- The repository was clean on `main` at `86a2d6cfd5d55c28ce204f2bad872475ec754bf7`, matching `origin/main`.
- The source-live launcher already owns port 4178 and is running. Reuse it; do not replace or terminate the user's runtime.
- Baseline checks completed: `bun test ./tests` passed 907 tests with 22 skipped; `bun run launcher:test` passed 363 with 4 skipped; both root and launcher typechecks passed. The root suite required command-scoped `CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=0` because the user's diagnostic setting made one screenshot-free fake fail when diagnostics attempted a screenshot. The isolated test passed with diagnostics disabled.
- The code already includes Computer Use fast-path guidance, parallel command execution, long-command yield/poll rules, decision-latency logging, and browser DOM response caching. Historical Computer Use latency lacks model/effort labels and is not a valid GPT-5.6 Sol High baseline.
- `BrowserHost` currently detects an explicit Cloudflare backend challenge (`403` plus `cf-mitigated: challenge`) but may reload ChatGPT when idle. `ChatGptAccountSafety.trigger("account_security")` currently drains active work before reaching `HARD_STOP`. The authenticated loopback browser-control server, persistent launcher state store, browser-state IPC, and daemon safety file are available integration points.
- Real Codex desktop testing has not begun: activation of the captured Codex window failed twice, including the one permitted refresh/retry. No prompt was sent and no security trigger was observed. Do not claim a real-model baseline until the requested GPT-5.6 Sol (Web), High route is actually exercised.

## Goals

1. Detect clear account-security, CAPTCHA, anti-bot, and repeated reauthentication signals without interacting with or solving them.
2. Stop current and future project-managed ChatGPT Web automation immediately after a trigger, persist that stop across restarts, and require a deliberate user resume.
3. Ensure recovery, reconnect, and retry code cannot silently restart ChatGPT Web traffic after a security stop.
4. Measure Computer Use, Browser Use, command scheduling, and end-to-end latency under comparable conditions; make only evidence-led performance changes.
5. Run the requested regression and advanced scenario matrix, then push only after the final gates pass.

## Out of scope

- CAPTCHA solving, challenge clicking, fingerprint or proxy changes, user-agent spoofing, session multiplication, or any other attempt to evade a security control.
- Broad prompt/schema/cache rewrites without before/after evidence.
- Disabling command safety, sandboxing, validation, or meaningful UI transition checks.
- Treating a simulated test or an unlabeled historical trace as the real-model benchmark.

## Architecture

### Authority and persisted state

`BrowserHost` is the detection authority and owns the durable launcher-side security latch. The existing launcher state store will validate a versioned `automationSecurity` record containing a paused flag, monotonically increasing revision, a finite reason/signal code, and detection/resume timestamps. It will not persist page text, prompt content, cookies, or screenshots.

The daemon mirrors a detected latch into `ChatGptAccountSafety` as `HARD_STOP` with reason `account_security`. Unlike duration/rate-limit draining, this reason transitions directly to `HARD_STOP`; no captured trace remains authorized to continue browser work. Before admitting a routed turn, and at the shared MCP dispatch boundary, the daemon reconciles against the authenticated launcher status. An unreachable or invalid status fails closed. A daemon-side hard stop is cleared only after a later launcher revision records an explicit manual resume.

### Detection and immediate stop

The detector runs on the owned ChatGPT/OpenAI browser surface and its relevant response/navigation events. It recognizes:

- An HTTP 403 from a ChatGPT backend URL with `cf-mitigated: challenge`.
- Known CAPTCHA/challenge markers or explicit security phrases such as “suspicious activity detected,” “unusual activity,” and “verify you are human,” read from a bounded page observation on an allowed origin.
- At least three same-origin authentication redirects within 60 seconds, indicating a repeated reauthentication loop.

A lone 401/403, ordinary signed-out state, or generic use of “verify” does not trigger the guard. Detection records only a finite signal code, HTTP status where applicable, timestamp, and trace ID for correlation.

On detection, `BrowserHost` must persist the latch first, disarm Cloudflare recovery, cancel active browser-owned turns/leases, reject new automatic and manual automation requests, and publish the paused state. It must not reload, navigate, probe authentication, submit a prompt, or retry the triggering request. The user may inspect and resolve the visible page manually; the application itself performs no challenge action.

### Daemon and transport behavior

Extend the existing bearer-token-protected loopback control API with a status read. Turn-start, session-inspection, manual-start, and other browser-work routes return a typed, non-retryable `chatgpt_account_safety_stop` response while paused. Cleanup/release operations remain available so active leases can be safely retired. The adapter preserves this typed error through Browser Worker, broker, and SSE paths; it must not translate it into a recoverable browser error, reconnect continuation, retry, or new subagent Web turn.

The daemon checks the guard before admitting routed turns and before dispatching MCP tool calls. Once the stop is observed, the active Web response is cancelled and the current task receives a terminal safety-stop result. No further MCP call from that stopped response is dispatched. Local launcher diagnostics and export remain available outside that response.

### User-visible warning and manual resume

Add an explicit paused warning to the launcher browser state and UI. It identifies that ChatGPT Web automation is paused and gives the signal category and detection time. A clearly labeled “I resolved this; resume automation” action requires explicit confirmation. Its IPC handler clears the launcher latch and increments its revision; it does not navigate, reload, inspect, or contact ChatGPT. The daemon reconciles the newer resume revision and acknowledges its mirrored hard stop. A new Web turn still requires a separate user-initiated task.

## Performance measurement and optimization

Run matched before/after scenarios on GPT-5.6 Sol (Web), High, with the model and effort recorded in the report. Keep prompts, target app/site, machine, runtime, and task steps fixed. Capture:

- Computer Use observation-to-next-action latency: median, p90, maximum, and outliers.
- Browser multi-step action-cycle duration, tool round trips, and redundant DOM/screenshot/navigation observations.
- Independent command batch wall time, actual concurrency, and tool round trips.
- Long-running command yield interval, poll count, and completion time.
- E2E duration and any reconnect, stall, broker retirement, safety block, or lost result.

Audit the 20 engineering areas in the request, including prompt/schema overhead, image and structured-state cost, caches/delta observations, deterministic batching, transport deadlines, broker/SSE behavior, retry/poll cadence, subagent aggregation, context growth, and hot reload. Preserve existing fast paths unless evidence indicates a defect. Change the narrowest repo-controlled cause demonstrated by the measurements; if the model or desktop transport dominates, report that limitation without claiming a product speedup.

## Verification plan

1. Add focused regression tests before or alongside implementation for detector signals and false positives, immediate cancellation, no reload/retry, durable state, typed error propagation, daemon admission/MCP blocking, fail-closed sync, launcher warning, and manual resume with zero ChatGPT network requests.
2. Run the existing root and launcher suites, typechecks, `bun run verify`, launcher build, and source-live reload checks.
3. Run the 10 requested advanced scenarios: parallel read/audit, long command session, Computer Use decision latency, repeated unchanged UI, multi-step Browser Use, mixed tools, subagent stress, command-safety compatibility, completion receipt, and end-to-end stress. At least seven must complete; any omitted suite needs a specific external blocker and evidence.
4. Use a new Codex chat with GPT-5.6 Sol (Web), High for real-model scenarios. If the requested desktop route remains inaccessible, document that as an external blocker; do not silently substitute a different model, effort, or route.
5. If a security trigger appears, stop Browser/Computer/Chrome automation immediately, preserve local evidence, export full diagnostics only if that export is local and safe, report `PAUSED_SECURITY_TRIGGER`, and do not push.
6. Push `main` only after all required gates pass, the working tree/diff are reviewed, and no temporary diagnostics or sensitive artifacts are staged.

## Acceptance criteria

- A recognized security signal creates a durable launcher latch and immediate daemon `HARD_STOP`.
- No new or retried ChatGPT Web request is made after detection; active managed work is cancelled and no recovery loop runs.
- The warning is visible and the only reset path is an explicit human action that sends no ChatGPT request.
- False-positive tests cover normal login and isolated 401/403 states; fail-closed behavior covers unavailable/corrupt safety state.
- Before/after performance metrics are comparable and accurately labeled; no metric is fabricated. A measurable repo-controlled improvement is made, or evidence identifies the external bottleneck.
- Regression, build, dev-live, real-model, and advanced-suite gates are reported exactly; push occurs only after the final gate passes.

## Operational reporting

Use the task status `PAUSED_SECURITY_TRIGGER` whenever a real account-security signal appears. Otherwise report unmet external test access as a blocker without weakening the safety requirements. Include root causes, before/after metrics, advanced test results, guard behavior, changed files, exact commands, Git state, and only concrete remaining risks.
