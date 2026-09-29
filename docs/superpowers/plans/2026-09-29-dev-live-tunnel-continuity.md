# dev:live Tunnel Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Keep the configured native MCP tunnel healthy across Electron source reloads during a dev:live session, including native managers that do not report an OS PID.

**Architecture:** The long-lived dev:live parent writes a private PID-bound lease. Electron shutdown preserves the tunnel only while that lease is valid; the next RuntimeSupervisor validates the exact configured tunnel identity and adopts either its observed PID or a stable fingerprint of its verified loopback health endpoint. Normal dev:live shutdown removes the lease before Electron exits.

**Tech Stack:** Bun/Node.js, CommonJS, Electron, native tunnel manager, Node test runner.

**Spec:** docs/superpowers/specs/2026-09-29-dev-live-tunnel-continuity-design.md

## Global Constraints

- The lease contains no account token, prompt, or browser data.
- A lease is valid only while its owner PID is alive and its record shape is valid.
- During the first upgrade from an already-running legacy dev:live parent, the Electron side may resolve the lease at its live core-home runtime path only when `CODEX_WEB_GPT_LIVE_MODE=1`; an explicit lease path always takes precedence.
- A lease PID alone never authorizes adoption; configured tunnel identity and health must confirm it.
- Normal app/dev:live shutdown without an active lease stops the daemon and tunnel.
- Electron reload waits for both active turn counters to reach zero; on deadline, resume the daemon and leave Electron running.
- Keep renderer HMR and src-only daemon reload behavior intact.

## Review Focus

- Malformed or stale lease: safe recovery; never authorize adoption.
- Different configured tunnel identity: never adopt the observed process.
- No PID: require the saved endpoint fingerprint, unique local alias, exact configured tunnel ID, ready local health, and MCP verification.
- No PID and no prior fingerprint: defer Electron reload and keep the current owner running.
- Active turns at reload time: preserve current Electron or resume on timeout.
- Normal dev:live shutdown: remove lease first, then stop runtime normally.

---

### Task 1: Live-session lease

**Files:**
- Create: launcher/electron/live-tunnel-lease.cjs
- Create: launcher/tests/live-tunnel-lease.test.cjs
- Modify: launcher/scripts/dev-live.cjs
- Test: launcher/tests/dev-live.test.cjs

**Interfaces:**
- Export createLiveTunnelLease(path, ownerPid, sessionId, now), readLiveTunnelLease(path), isLiveTunnelLeaseActive(path), and removeLiveTunnelLease(path).
- Lease version is 1; ownerPid is a positive safe integer; sessionId is 32 lowercase hex characters; createdAt is canonical ISO-8601.

- [x] Write tests for round-trip, malformed JSON/shape, invalid timestamp, dead owner PID, private atomic write, and removal.
- [x] Run node --test launcher/tests/live-tunnel-lease.test.cjs; confirm expected missing-module failures.
- [x] Implement helpers using the existing atomic private-file writer and processRunning helper.
- [x] Create the lease before Electron launch, pass CODEX_WEB_GPT_LIVE_TUNNEL_LEASE to Electron, and remove it before Electron termination on parent shutdown.
- [x] Extend dev-live tests to pin lease creation, environment propagation, and removal ordering; run both focused test files.

### Task 2: Supervisor preserve and adopt

**Files:**
- Modify: launcher/electron/runtime-supervisor.cjs
- Test: launcher/tests/runtime-supervisor.test.cjs

**Interfaces:**
- RuntimeSupervisor.liveTunnelHandoffActive() validates the configured lease.
- shutdown accepts preserveTunnel?: boolean.

- [x] Add tests proving preserve shutdown issues no tunnel stop command, records the observed tunnelPid, stops the daemon, and leaves ordinary shutdown unchanged.
- [x] Run focused supervisor tests and confirm preserve/adoption failures.
- [x] Implement preserveTunnel in graceful shutdown: stop monitoring and daemon, retain native tunnel, persist ownership state.
- [x] Add lease-gated stale-owner recovery: require a live lease, exited prior Electron owner, matching configured tunnel identity, healthy unambiguous PID, and verified MCP transport before adoption.
- [x] Add negative tests for dead/malformed lease, ambiguous PID, unhealthy tunnel, and mismatched identity; rerun focused tests.

### Task 3: Electron reload lifecycle

**Files:**
- Modify: launcher/electron/main.cjs
- Modify: launcher/scripts/dev-live.cjs
- Test: launcher/tests/dev-live.test.cjs
- Test: launcher/tests/runtime-supervisor.test.cjs

**Interfaces:**
- Main passes preserveTunnel from RuntimeSupervisor.liveTunnelHandoffActive().
- dev-live requires active_http_turns === 0 and active_browser_turns === 0 before Electron restart.

- [x] Add tests for idle restart, timeout compensation via admin resume, and no restart while turns remain active.
- [x] Implement idle gating; if health is unavailable or the deadline expires, keep Electron running and restore daemon admission.
- [x] Wire main-process shutdown to preserve the tunnel only for a validated live-session lease.
- [x] Wait for replacement launcher readiness and verify supervisor state retains the same tunnel PID.
- [x] Run focused dev-live and supervisor tests.

### Task 4: PID-less native runtime handoff

**Files:**
- Modify: launcher/electron/runtime-supervisor.cjs
- Modify: launcher/scripts/dev-live-lifecycle.cjs
- Modify: launcher/scripts/dev-live.cjs
- Test: launcher/tests/runtime-supervisor.test.cjs
- Test: launcher/tests/dev-live-lifecycle.test.cjs

**Interfaces:**
- Supervisor state stores only a SHA-256 fingerprint of the verified loopback health endpoint; it never stores the URL or tunnel credentials.
- Handoff accepts a missing PID only when the saved fingerprint, unique local alias, exact configured tunnel ID, health checks, and MCP transport all match.
- dev-live defers reload if neither an OS PID nor a valid prior fingerprint identifies the live tunnel.

- [x] Add tests for PID-less preserve/adopt, endpoint changes, duplicate aliases, tunnel-ID mismatch, and replacement readiness with the saved fingerprint.
- [x] Implement the endpoint-fingerprint identity path and exact local inventory validation.
- [x] Run focused supervisor and lifecycle tests; confirm the handoff issues no tunnel stop/connect (92 pass, 1 skipped).

### Task 5: Full validation

**Files:** No product files unless validation finds a defect.

- [x] Run bun run launcher:typecheck.
- [x] Run bun run launcher:test (416 pass, 4 skipped).
- [x] Run bun run launcher:build.
- [x] Run bun run verify with ephemeral bun@1.4.0; audits, root and launcher suites, typechecks, builds, bundle validation, and relocatable runtime smoke all passed.
- [x] Confirm the current source-live baseline is healthy with zero active turns before integration.
- [x] Apply the verified handoff code to source-live and recheck health immediately before cutover.
- [x] Validate an Electron/source-live reload with the same tunnel PID.

## Final source-live evidence (2026-09-30)

- The managed tunnel remained at PID `15388` across the approved source-live reloads; the daemon was allowed to restart independently.
- Latest `/healthz`: `status=ok`, daemon PID `2808`, version `6.1.3`, accepting turns, `active_http_turns=0`, `active_browser_turns=0`.
- The relocated-runtime smoke also completed graceful drain, resume, and shutdown successfully. The long-lived `dev:live` process and tunnel were left running.
