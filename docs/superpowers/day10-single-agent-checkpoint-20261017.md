# Day-10 single-agent P0 checkpoint — 2026-10-17

Goal remains **ACTIVE**. This phase read `C:\Users\Long-PC\Documents\GOAL.md` and reconciled local worktrees and historical receipts. Current Web `main@e124aa08cfe6b23d8cb736ff415c6958a1f4798e`; Swift `main@30d3fe4570761943464947894a4e1e0b863b3574`. Both pre-existing worktrees were preserved. New changes remain uncommitted; no branch, remote ref, production application, MCP registration, service, configuration or credential changed.

Implemented a targeted native screen-tree privacy fix: `tree_format` compact/json/both now publishes the privacy-projected tree without also publishing raw UIA provider nodes that could expose a redacted parent's identity. The legacy omission of `tree_format` preserves the existing raw response. Receipt: `day10-screen-tree-raw-node-privacy-20261017.json`.

Implemented explicit `ack_snapshot_id` + `prefer_diff` for optional JSON tree responses: a caller may receive a bounded UIA provider-identity diff only after acknowledging the latest snapshot under the same native reader grant, with a complete READY source, unchanged generation and viewport, and advancing frame. Missing/stale ACK, grant rotation, mixed OCR/CV, truncated, redacted, ambiguous or partial UIA yields a full snapshot. Older cached-generation frames are rejected, and cross-frame ephemeral tree IDs are never reused in diffs. Receipt: `day10-screen-tree-ack-diff-20261017.json`.

Touched source and test files:

- `src/adapters/chatgpt-web/screen-observation.ts`
- `src/adapters/chatgpt-web/screen-tree-diff.ts` (new)
- `src/adapters/chatgpt-web/mcp-server.ts`
- `tests/mcp-screen-tree.test.ts`
- `tests/screen-tree-diff.test.ts` (new)

Observed RED before implementation (raw node leak: 2 tests failed, and new diff module missing); GREEN final: five targeted Bun pure/MCP/stdio test files, **39 passed, 0 failed, 236 assertions**; root `bun run typecheck` exit 0; `git diff --check` exit 0. Main performed code self-review. No real Web model, external DEV tunnel, current native screen capture or production test was performed in this phase, so these changes remain local-evidence-only acceptance.

PLAN matrix remains exactly **175 requirements: 5 PASS / 137 PARTIAL / 12 BLOCKED / 21 NOT RUN**. New receipts attached to `UI-P0-05`, `VIEW-P0-03`; their status remains PARTIAL. The model's exact Sol/Web/High variant and effort are **UNVERIFIED** because the connected runtime did not expose them. Exactly one main agent used, **zero subagents created**.

Prior P0-A observer generated-startup wiring and isolated MCP semantic READY receipt remain historical evidence. Outstanding: actual Web semantic E2E; mixed native/rendered screen observation with source fidelity; robust lifecycle/ACK/readiness coverage; CPU AUTO measured allocation and scaling; native 2–8 actual overlap under permitted policy; archive/272K account-eligible recall; compaction/steering races and remaining safety provenance. Historical four safety records and all original denied-operation receipts are preserved. Model-visible pixels remain `IMAGE_RELAY_UNAVAILABLE` and observer image mode remains **DISABLED**. No screenshot composer fallback was used.

**Next safe engineering action:** Exercise the new full/ACK/diff contract in an owned isolated native UIA scenario with two genuine frame captures and targeted reconnect/cancellation cases. Only then consider authorized DEV Web-model semantic observation; do not reinstall/restart production or replay historical refused operations. For CPU AUTO, design native-owned measured pressure and throughput inputs before claiming multiworker scaling; the engine currently supplies an empty pressure sample and actual ancestor Job Object allocation is unverified.
