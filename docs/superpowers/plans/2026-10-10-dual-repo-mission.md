# Dual repository mission implementation plan

**Goal:** Implement the complete root AGENTS.md contracts in both authorized repositories.
**Architecture:** Preserve the current adapter/broker and TypeScript stdio/native IPC v2 boundaries. Extend existing canonical and physical proofs; use explicit grants and native handle validation for Swift operations.
**Spec:** Both root AGENTS.md files and the user-provided goal objective.
**Execution:** Main agent implements, integrates, tests and owns Git. Luna High researches read-only; one fresh Sol Web agent per independent backend test, sequentially with verified cleanup.

## Constraints and review focus

- Keep unrelated WIP intact; main only, no force/reset or new branch.
- Never persist credentials, raw capabilities or transcript in the retention proof ledger.
- Browser ownership, authentication, canonical ancestry, model/effort/mode/connector checks remain mandatory.
- Tool activity and approval pending suspend recovery; ambiguous mutating effects cannot replay.
- Swift roots require final opened-handle identity; no arbitrary shell, process takeover or debug-port scanning.
- Preserve physical ESC, input cleanup and independent priority IPC.
- Account/refusal boundaries are terminal; observed model claims alone are not tool receipts.

## Tasks

- [x] Inspect both worktrees, instructions, current architecture, scripts and workflows.
- [x] Invoke the exact requested Luna High research reviewer; retain its actual spawn receipt.
- [x] A1: durable versioned bounded canonical proof ledger, typed misses, privacy/corruption/expiry/restart regressions; integrate with adapter.
- [x] A1: semantic physical proof tolerating identical rerenders while detecting intervening foreign turns; integrate launcher tests.
- [x] A2: bounded same-tab Stop/Continue state machine, current-response stop/composer verification, progress/approval checks, receipt reconciliation, no partial canonical final; integrated regressions.
- [x] B: versioned additive wire contract, explicit grant registry and operation journal; native path/security kernels and all 12 typed tools, honest annotations.
- [x] B: libgit2/search/process/CDP integration with pinned license evidence; ownership/cancellation/bounds tests through real stdio and dedicated native pipe.
- [ ] Capture baseline and patch p50/p95 evidence with equivalent fixtures; retain limitations and absent live coverage.
- [ ] Run local verify/typecheck/package/smoke and Swift TS/native/E2E tests without affecting production sessions.
- [ ] Run A-001 through A-012 using independent fresh Web test agents; record result and verified agent/session cleanup after every case.
- [ ] Review scoped diffs, remote state, commit/push separately to main, verify relevant CI URLs/jobs/artifacts.
- [ ] Requirement-by-requirement completion audit and delivery report including both HEADs and blockers.

## Initial evidence and rulings

- A baseline HEAD a91c58b; B baseline HEAD 46783d1. Both on main.
- Existing A untracked AGENTS.md, SKILLS.md, 2026-10-05 plan and compaction-provenance.ts are user WIP. B AGENTS.md and latest-results.json are modified user WIP.
- A SKILLS.md contains retired CLI lane and old-model instructions; root AGENTS.md/current package.json take precedence.
- Bun on PATH is 1.4.2; required verification runtime is 1.4.0 and must be located before release claims.
- Swift baseline npm test: 16 passed, zero failed (2026-10-10).
- Ruling: execute the user-specified architecture in place on main; redundant skill approval/worktree steps would conflict with the explicit mission and developer autonomy instructions.

## Delivery checkpoint

A implementation and focused regressions pass; full Windows suites have existing
symlink-permission failures. Runtime bundle smoke passes; installer smoke timed
out. A-001 attempts lacked a native completion receipt; A-002–012 remain NOT RUN.
See docs/RETAINED_VALIDATION.md for exact agent cleanup and measurement boundaries.

B feature commit 2919c96 was pushed separately to main. Windows/Ubuntu TypeScript
CI passed; initial native configuration failed. The failure reproduced with local
MSVC and a policy-scope fix makes the same standard probes pass. Relevant native
CI is being rerun. Interactive GUI/physical-ESC gates and unmeasured benchmarks
remain outstanding; see the companion SCOPED_VALIDATION.md. No goal-complete or
full release-acceptance claim is made.
