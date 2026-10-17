# Bounded continuation: connect the existing observer CLI to generated MCP startup

The user-approved PLAN §3E requires a callable Native2 `codex_screen_observe` with fresh delegated authority and truthful semantic-only output while pixel proof is blocked. Existing `mcp-main.ts` already accepts `--screen-observer-pipe` and `--screen-observer-grant-tool`; `tunnel.ts:mcpCommand` never supplies them. Current AppConfig has no typed, validated way to opt into that startup path. This change connects existing components; it does not activate any running service.

## Design

- Add optional `AppConfig.nativeScreenObserver: {readerPipe, grantWireName}`. Absence preserves current generated commands. Strictly reject null, unknown keys, missing/blank/oversized fields, nonlocal/ambiguous pipe strings and invalid native Swift grant wire names. Do not echo field values in errors.
- Share the pure parser `parseNativeScreenObserverConfig(value: unknown): NativeScreenObserverConfig | undefined` from `src/native-screen-observer-config.ts`. The parser checks shape and syntax without starting a process or connecting to a pipe. Windows endpoint syntax is `\\.\pipe\<ASCII name>_observer_v1` with no path components, whitespace, control characters, quotes or shell syntax. Grant wire format remains the existing `mcp__...__swift_observer_reader_grant`.
- `loadConfig` validates the optional field and keeps a normalized copy. It remains optional in persisted v3 profiles; no migration, default activation or existing profile writes.
- `mcpCommand` appends both existing flags only for Full/automatic/native startup with a valid explicit setting. Manual/Zero Risk and browser-only commands omit observer flags; valid inactive settings can be retained for later mode selection. Reject an active Windows reader on a non-Windows target. Existing Windows/Unix command quoting still owns argument serialization.
- MCP CLI uses the same parser before constructing the existing read-only provider. Keep paired-flag validation, native-only contract and rejection of leftover/duplicate arguments. Registration is not authority: fresh inventory, broker ownership, native grant, lease expiry, epoch, HWND/PID/session and per-call revalidation remain mandatory in the existing server/registry.
- Image mode stays disabled. No new screenshots, input actions, viewer fallback, composer attachments or automatic controller/tunnel launch.

An alternative is continuing to hand-assemble MCP commands. It leaves normal generated startup disconnected from the existing CLI and provides no persisted validation. Automatic discovery is deferred: endpoint discovery is not permission and would introduce unrelated ownership/lifecycle work.

## Ownership and verification

Huygens owns only `src/native-screen-observer-config.ts`, `src/config.ts`, `src/tunnel.ts`, `tests/native-screen-observer-config.test.ts`, plus named round11 output receipts. Main owns the MCP CLI integration and a new stdio test file. Confucius performs source audit and later independent retest, with no source writes.

First reproduce missing generated flags and missing config validation with focused tests; then implement and obtain GREEN. Main reviews source and runs typecheck. Actual private Bun CLI stdio tests check default omission, opt-in tool registration, denial without a fresh grant, and safe-contract/malformed-endpoint rejection. No native controller, Web/model call or production/DEV service mutation is needed for this source integration gate. Live semantic observation remains a separate incomplete gate.

Do not read or run the historical blocked `tests/screen-observation.test.ts`/systematic-debugging pair or full `bun run verify`. No branch/commit, dependency install, config edit, process restart or existing UI replay. Preserve all current source changes and the full175-requirement inventory.
