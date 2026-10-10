# Retention and recovery validation — 2026-10-10

Baseline HEAD: `a91c58b`. Desktop-only dev:live and existing authentication,
approval and mode boundaries were preserved. Unrelated untracked AGENTS.md,
SKILLS.md, the 2026-10-05 plan and compaction-provenance.ts are excluded.

## Local checks

| Check | Result |
| --- | --- |
| Required Bun runtime | 1.4.0 |
| Frozen root and launcher installs | Passed |
| Root and launcher dependency audits | Passed |
| Final root typecheck | Passed |
| Focused retention/recovery/native progress/routing tests | 226 passed across 8 files |
| Final helper lifecycle/phase compatibility | 7 passed; real helper IPC with browser fixture |
| Final full root suite | 1,137 passed, 43 skipped, 2 failed across 96 files |
| Root failures | Existing codex-integration symlink fixtures: Windows EPERM |
| Final launcher typecheck | Passed |
| Final launcher suite | 446 passed, 4 skipped, 1 failed; existing setup-checkpoint symlink EPERM |
| Final runtime bundle and relocated-runtime smoke | Passed; RELOCATABLE_RUNTIME_SMOKE_OK |
| Windows package artifact | Installer and blockmap produced |
| Installer smoke | Failed: silent installation timed out after 120 seconds; no packaged-launch PASS |

The aggregate verify script stops at the root symlink failures. Later launcher
and runtime checks are executed separately and must not be reported as aggregate
verify success. Cross-platform and packaged acceptance still need relevant CI.
Installer SHA-256:
`d33f80d334d46c97f8da19e4b26dc9944ef87733fd4c44553a70f2f55d31f480`.

## Live backend matrix

The supported exact test model was `chatgpt-web/gpt-6-sol`, High. The exposed
runtime did not support fork_turns/task_name; fork_context=false was used.
Tests were sequential and used fresh agents. No model substitution occurred.

| Case | Result and evidence |
| --- | --- |
| A-001 fresh response, original | FAIL/INCONCLUSIVE: DOM final boundary without accepted native completion receipt; continuation controls unavailable |
| A-001-R1 after URL proof correction | FAIL/INCONCLUSIVE: two accepted same-tab recovery sends, no native tool calls or accepted completion receipt; chatgpt_completion_receipt_missing |
| A-002 same-tab follow-up | NOT RUN; receipt-capable connector session required |
| A-003 multiple follow-ups in one chat | NOT RUN |
| A-004 large retained context without ZIP | NOT RUN |
| A-005 controlled network interruption | NOT RUN |
| A-006 stall without pending tool | NOT RUN |
| A-007 stall with active native tool | NOT RUN |
| A-008 browser-helper restart | NOT RUN |
| A-009 corrupt/missing proof fallback | Live NOT RUN; local regressions passed |
| A-010 no repeated mutating tool | Live NOT RUN; local broker/journal regressions passed |
| A-011 safety/approval refusal | Live NOT RUN; local guards passed |
| A-012 routing/backend compatibility | Live NOT RUN; local routing regressions passed |

Original test agent: `01a12272-6906-7f80-a207-2f58bbe9ad4d`, trace
`7b075ed24d6c`. Retry agent: `01a1228b-c3b2-7622-ab89-7057a4f13acd`,
trace `c47172b24c31`. Both were explicitly closed, and subsequent waits returned
not_found. Main closed the exact test-owned tabs, released retained leases,
invalidated their proof, and verified no owned tabs or broker activity remained.
The retry broker retired with pending/queued/delivered/MCP/detached counts zero,
and completionCommitted=false. Shared production services and account login were
left intact. Main did not edit installed connector configuration.

The retry screenshot's model narrative reported "Session terminated". There was
no corresponding native tool-call/error receipt, so this does not establish a
connector/server root cause. The daemon PID stayed constant through the retry.
An earlier restart happened after its error, not before it.

The first exact Luna attempt was admitted and then failed with server_overloaded
"Selected model is at capacity". One bounded diagnostic Luna attempt completed.
Both were closed and release verified; neither is Web backend validation.

## Performance evidence

The reproducible bench-retained-proof.ts compares baseline in-memory proof resume
against durable proof resume, with 100 samples and synthetic canonical content.

| Canonical fixture | Baseline p50/p95 ms | Durable patch p50/p95 ms | Ledger bytes |
| --- | --- | --- | --- |
| 64 messages, 67,048 bytes | 0.0957 / 0.1471 | 0.1312 / 0.2878 | 455 |
| 2,048 messages, 2,150,288 bytes | 2.7147 / 4.2927 | 3.0027 / 4.0250 | 457 |

This measures canonical proof resume only. Browser, upload, ZIP, model latency,
reuse success rate and live recovery p50/p95 remain NOT MEASURED. It does not
establish a supported token window or an end-to-end speedup. Mission completion
and release acceptance remain pending the live matrix and outstanding checks.
