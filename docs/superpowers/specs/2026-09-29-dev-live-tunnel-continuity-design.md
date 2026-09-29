# dev:live Tunnel Continuity Design

## Goal

Keep the configured native MCP tunnel process ready across source-launcher Electron restarts during one `dev:live` session. Patching `launcher/electron/**` may still restart Electron so the new main-process code is loaded, but it must not stop and reconnect the tunnel. Renderer-only changes continue through Vite HMR, and `src/**` changes continue to restart only the Responses daemon while leaving the tunnel running.

The scope is the managed development session. A normal `dev:live` shutdown still stops the runtime and restores the previous Codex route. This is not a promise that an external tunnel service or network remains healthy during an outage.

## Current behavior

`launcher/scripts/dev-live.cjs` watches runtime source and launcher Electron source separately. Runtime-source changes drain and shut down the Responses daemon. Electron-source changes restart the whole source launcher. Electron's `requestQuit()` calls `RuntimeSupervisor.shutdown()`, which stops both the daemon and the tunnel. The next Electron process then reacquires the tunnel. A compile or startup failure during that gap can leave Codex without its configured connection.

The native runtime manager already exposes tunnel identity and readiness checks. `RuntimeSupervisor.startTunnel()` can adopt a healthy configured tunnel, while stale-owner recovery normally stops a tunnel whose prior Electron owner has exited. A narrow live-reload handoff can use these existing checks without moving the tunnel implementation into a new service.

## Chosen architecture

### Live-session lease

The long-lived `dev:live` parent writes a private lease under its isolated live home. The lease contains a version, the parent PID, a random session identifier, and creation time. It contains no account token, prompt, or browser data. The lease is considered active only when its shape is valid and its parent PID is still running.

The lease exists for the whole `dev:live` session. On a normal parent shutdown, `dev-live` removes the lease before terminating Electron. That ordering makes Electron perform the existing full runtime shutdown and prevents the tunnel from being left behind.

### Electron restart handoff

Before an Electron-source restart, `dev-live` drains the local Responses daemon and waits for both active-turn counters to reach zero. If the idle deadline expires, it resumes the daemon and leaves the current Electron process running. It does not repeatedly restart the app against an active turn.

When Electron handles a quit while the live-session lease is active, the supervisor stops the daemon but preserves the configured tunnel. It persists enough ownership state for the next Electron process to validate the same tunnel. It stops its in-process monitor during exit; the native tunnel manager remains responsible for keeping the service alive during the short handoff interval.

On startup, the new supervisor may reuse the tunnel only when the lease is active, the previous owner is no longer running, and the configured tunnel identity reports an unambiguous healthy runtime. If the native manager reports a PID, adoption requires the same PID. If it does not, adoption requires the same SHA-256 fingerprint of a verified loopback health endpoint. In both cases, the supervisor verifies that the native inventory contains exactly one entry for the configured alias and exact tunnel ID, checks local readiness and MCP transport, starts its monitor, and then starts the daemon. A missing PID without a saved endpoint fingerprint cannot authorize an ordinary reload.

### Failure handling

- A malformed, expired, or dead-owner lease disables preservation and falls back to current safe shutdown/recovery behavior.
- A healthy tunnel with neither a verifiable PID nor a previously saved endpoint fingerprint is not adopted.
- If daemon restart fails after tunnel adoption, the supervisor keeps monitoring the tunnel and reports launcher startup failure; it does not silently stop a healthy tunnel.
- If tunnel health fails, existing tunnel recovery remains authoritative.
- Normal app/`dev:live` exit without an active handoff lease stops the runtime as before.

## Alternatives considered

1. **Skip Electron restarts.** It protects runtime connections but leaves changed Electron main-process code inactive, so it cannot support this repository's watcher semantics.
2. **Move all runtime ownership into a new guardian process.** It provides a permanent owner independent of Electron, but requires a new authenticated IPC protocol and migration of daemon/tunnel lifecycle. That is larger than the observed reload gap.
3. **Preserve and re-adopt the healthy tunnel during `dev:live` reloads (selected).** It reuses native runtime health and ownership checks, changes only the source-live lifecycle, and preserves normal shutdown behavior.

## Scope and interfaces

- `launcher/scripts/dev-live.cjs`: create/validate/remove the session lease, wait for idle before Electron restart, and wait for the new source launcher to report ready before declaring the handoff complete.
- `launcher/electron/main.cjs`: pass the active lease decision into runtime shutdown.
- `launcher/electron/runtime-supervisor.cjs`: add a preserve-tunnel shutdown path and a lease-gated, health-verified adoption path for the next Electron process. When the manager omits the PID, persist only a hash of the verified loopback health endpoint.
- `launcher/tests/dev-live.test.cjs`, `launcher/tests/runtime-supervisor.test.cjs`: cover lease lifetime, idle gating, stable tunnel PID, matching-identity adoption, invalid-lease fallback, and normal stop.

No general production/packaged-launcher behavior changes. The feature is enabled only when the isolated `dev:live` parent owns a valid lease.

## Validation and acceptance

1. In focused supervisor tests, a simulated Electron reload keeps the same configured tunnel PID or the same verified health endpoint when the manager omits the PID. The replacement supervisor adopts and monitors the exact alias/tunnel ID without issuing a tunnel stop/connect command.
2. A normal `dev:live` shutdown removes the lease first and continues to stop both daemon and tunnel.
3. A dead-owner or malformed lease cannot authorize adoption.
4. An Electron-source reload with active turns waits; if the idle deadline is exceeded, it resumes the daemon and does not restart Electron.
5. Root and launcher typechecks, focused tests, full suites, launcher build, and `bun run verify` pass before the implementation is copied into the source-live checkout.
6. Source-live remains healthy throughout isolated implementation. Before its final integration, its turn counters must be zero; validate the new source on the integrated runtime before any model test.

## Relationship to the approved account-safety guard

This is an additive `dev:live` lifecycle requirement. The previously approved account-safety design remains authoritative: no real GPT-5.6 Web test runs until the persisted fail-closed guard is integrated and verified. If a new real account-security signal appears, stop automation and report `PAUSED_SECURITY_TRIGGER`.
