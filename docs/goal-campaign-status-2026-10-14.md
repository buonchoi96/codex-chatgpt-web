# GOAL/PLAN engineering state — 2026-10-14

This is a **partial verification ledger**, not a completed or deployed GOAL campaign. Source working trees had extensive pre-existing uncommitted changes; this work did not reset or publish them. No production browser, launcher, connector or Codex configuration was restarted or edited. No AI subagents were created.

## Runtime/model gate

- Requested main: `gpt-6-sol (web)`, prefer `high`. Native connector call did not expose the selected Codex session's routed model or effort. `MAIN_MODEL_SWITCH_REQUIRED` remains open until the user/model UI proves the selected variant. Do not infer an effort level from the model family.
- Only native command tool was advertised here; the standalone `codex_parallel_exec` was not found by the current turn inventory. Repository implementations and tests do not prove its deployment to this connector.

## Compaction P0 regression evidence

| Gate | State | Evidence / work still needed |
| --- | --- | --- |
| COMPACT-P0-01 canonical source and native `/goal` input | PARTIAL | Typed `COMPACTION_SOURCE_USER_MESSAGE_MISSING` preflight before browser work. Missing `/goal` fragment rejected; tests for authentic source work. Real redacted failure request and current Codex rollout receipts are still needed. |
| COMPACT-P0-02 >15s live-source wait | PASS in fixture | `settleActiveCompactionSource` no longer blindly cancels after 15s. A test first failed on old behavior, then passed after change with a source settling at 35ms against 15ms simulated grace. |
| COMPACT-P0-03 pending tool/approval during timeout | PARTIAL | Deadline now retains a still-active source and returns typed `COMPACTION_SOURCE_STALLED`; outstanding native-invocation and approval scenarios need isolated DEV evidence. |
| COMPACT-P0-04 absent real user | PASS in fixture | Goal fragment + tool-only input rejects typed 409 before adapter work. |
| COMPACT-P0-05 incorrect/missing/interrupted turn IDs | PARTIAL | Existing environment suite checks many interrupted and replay provenance cases; additional exact-failure input required. |
| COMPACT-P0-06 racing compact observers | NOT RUN | Verify exact per-turn epoch handoff/ACK under isolated DEV. |
| COMPACT-P0-07 fallback cannot fabricate source | PASS in fixture | Compaction source preflight precedes fresh-fallback decisions in direct adapter and server paths; isolated browser test still needed. |
| COMPACT-P0-08 retirement/timeout/checkpoint failures | PARTIAL | Source-preserving timeout protection exists, but atomic checkpoint, in-flight tools and operator Stop scenarios remain unverified. |
| COMPACT-P0-09 authenticated post-compact continuation | PASS in fixture | Existing v1/v2 server-compaction tests pass for canonical source IDs. |
| COMPACT-P0-10 real task/thread/goal end-to-end | NOT RUN | No live Web-model DEV `/goal` compaction run or authoritative native ACK collected. |

## Safety blocker ledger

- `src/adapters/chatgpt-web/blocked-operation-ledger.ts`: future observed native safety-status refusals are recorded in a persistent, private JSON ledger under the configured runtime home. Entries contain tool name, argument/scope/owner digests, uncertainty, pending review, and an independent resolution field; no raw arguments, tokens or screenshots are stored. The tool capability remains retired without a backup retry. Resolution requires an explicit reviewer receipt; the receipt text is stored as SHA-256 only.
- `mcp-server.ts` persists on the actual classified safety error before releasing the broker. The integration test observes a single refusal and subsequent rejected tool call, with one durable pending blocker. The original two historical incidents have no recovered per-call receipts and are **not** marked resolved.
- Incident-phrase mismatch uncovered: `tool-failure-classification.ts` previously matched only the OpenAI refusal string *without* its final period. The platform's period-terminated variant is now recognized strictly for true errored content/thrown errors, with a non-matching quoted-prose regression fixture. An error thrown before the broker produces a normal MCP result now also enters the ledger and refuses fallback. The real historical incidents still require native receipts to establish their exact path.
- SAFE-P0-01 persisted data shape: **PASS in fixture**; SAFE-P0-02 safety attribution: **PASS in fixture**; SAFE-P0-03 through SAFE-P0-08 approval, dispatch reconciliation, alternate-workflow authorization, live review and long-running goal persistence: **NOT RUN / PARTIAL**. Ledger's affected GOAL requirement is marked unmapped until an authorized review can associate it with a concrete task; an unmapped item remains open.

## Historical archive reuse ledger

Read-only historical commits inspected with `git show --unified=0` and file lists. Current implementation routes ZIP construction through `src/adapters/chatgpt-web/context-archive.ts`; no second ZIP builder was introduced in this pass.

| SHA | Inspected historical source | Current implementation / interpretation | Verification |
| --- | --- | --- | --- |
| `bc6bfe4` | `browser-worker.ts`, `index.ts`, two recovery tests | Network alert ownership and recovery paths remain subject to browser DOM proof; avoid blind cherry-pick over locally changed browser worker. | NOT RUN live DOM |
| `c5978d4` | `browser-worker.ts`, `index.ts`, recovery tests | Page-level retry-alert and archive-preserving fallback ideas reviewed; no cherry-pick. | PARTIAL fixture recovery |
| `3c1567a` | `browser-worker.ts`, `turn-broker.ts`, `bounded-cache.ts`, archive/perf tests | Current `context-archive.ts` adapts bounded immutable ZIP caching and SHA-keyed content framing. | `archive-cache.test.ts` PASS |
| `49fc25c` | `.gitignore`, archive cache eviction test | Current cache fixture covers changed inputs and eviction, not a new duplicate cache. | `archive-cache.test.ts` PASS |
| `b7ed23d` | `bounded-cache.ts`, `browser-worker.ts`, token cache tests | Unicode image metadata and cache bounds preserved in current archive module. | `archive-cache.test.ts` PASS |
| `c66ce25` | `chatgpt-web-usage.test.ts` | Current archive verifies full historical context beyond an inline wrapper. | `archive-cache.test.ts` PASS; historical exact usage test NOT RUN |

## Verifications completed / limitations

- Main: `bun run typecheck` PASS; `tests/environment.test.ts` **83/83 PASS**; `tests/server-compaction.test.ts` **25/25 PASS**, including typed early refusal; `tests/blocked-operation-ledger.test.ts` + `tests/safety-tool-retirement.test.ts` **5/5 PASS**; `archive-cache`, `transport-selector`, `unified-context-policy` **17/17 PASS**; five compaction/recovery/parallel/screen files **42/42 PASS**. These are unit/integration fixture tests, **not** end-to-end model visual proof.
- Entire combined `environment + retained-compaction` suite stalled during a test fixture and its **own test session** was interrupted; this is **NOT PASS**. The focused long-source test passed. Retry the stalled suite only after diagnosing live fixture handles; do not infer a production failure from a hung test alone.
- Swift sibling repo: `npm run build` PASS; `npm test` **66 + 4 PASS**; native `cmake --build native/build --parallel 4` PASS; `ctest --test-dir native/build --output-on-failure` **11/11 PASS**. These do not prove GUI/game input, the Web model receiving pixels or native UIA/OCR end-to-end.
- Still outstanding: Web-model randomized direct+nested image proof; isolated native Swift/MCP/Win32 UI test; real 272K/258,400 boundary in routed Web model; authentic multi-megabyte history/archive acknowledgment; first-send single physical-attachment proof; same-tab Stop/recovery p95; baseline/CPU AUTO performance; real terminal compact commit; and untouched user-state invariants outside the test fixtures.

The goal stays active until every explicit requirement has authoritative evidence. Do not mark remaining tasks DONE based on successful fixtures alone.
