# Backend performance implementation plan

**Goal:** Retain healthy native follow-ups and reduce context, observation, and recovery overhead without changing safety or exactly-once semantics.

**Architecture:** Extend existing conversation leases and canonical checkpoints. Browser proof is captured at a completed response and checked before any suffix submission; invalid proof retires the lease. Deterministic evidence supplements semantic checkpoints, with full canonical fallback on any mismatch.

**Spec:** User attachment `Pasted text.txt`, with `SKILLS.md` governing the live CLI lane.

**Constraints:** Work on main; preserve unrelated WIP; no force push. Reuse running dev:live. Real tests use GPT-5.6 Sol High through dev:codex. Preserve native approvals and submission ambiguity fences. Generic telemetry contains counts and timings only.

## Tasks

- [ ] Baseline: record SHA 20296a5ac3b8327c6660e3607b992f91ee0c37c0; run focused suites and live CLI baseline; inspect current benchmarks.
- [ ] Retention: modify conversation-key.ts, index.ts, browser-worker.ts and browser-host.cjs. Prove canonical ancestry, page/document/account identity, terminal state and absence of foreign messages; retain Luna by epoch; test invalidation and fresh fallback.
- [ ] Compaction: extend enhanced recovery checkpoints and handoff with deterministic provenance and validated delta input. Test prefix corruption, incomplete tools, identity mismatch, exact literals; benchmark 200K/500K/900K histories.
- [ ] Computer Use: extend native-computer-use.ts with bounded observation revisions and fresh structured proof; invalidate on actions, errors and external changes. Test operation counts and unsafe stale state.
- [ ] Policy/telemetry: reduce prompt and tool duplication with retained authoritative rules; add safe phase metrics and token benchmarks.
- [ ] Recovery: inspect submission phase fences and broker journal; add functional fault injection and fix any duplicate replay or lost result.
- [ ] Browser mode: test low-risk spellcheck/cosmetic changes and retain existing idle throttling. Investigate archive thresholds and warm pooling only using measured evidence.
- [ ] Verification/report: focused suites, typechecks, full verify, launcher build, real CLI follow-up/browser/CU samples with cleanup. Review entire diff, commit logical groups, push main, inspect Actions, commit performance report.

## Review focus

Manual user messages and same-page navigation must invalidate retained history. A completed assistant with an uncertain prior send is not a healthy follow-up. Tool arguments alone never prove successful reads or side effects. External UI changes can happen without a bridge action. Partial checkpoint corruption must fall back to canonical history.

## Execution notes

User explicitly requests autonomous execution, so additional design approval stages are omitted. Independent code slices were delegated using dispatching-parallel-agents; the parent owns integration and live tests. The first test command matched an ignored baseline copy as well as the current suites; its 530-pass aggregate is not an authoritative baseline and is excluded from the report. Subsequent commands use explicit ./tests paths. Unrelated untracked SKILLS.md and the native-operation-safety plan are preserved.

The user owns further compaction checkpoint/provenance changes. The parent integrates prepareCompactionInput into fresh and ordinary no-tools runtime preparation, retains canonical ownership/handoff input, and preserves canonical archive transport for normal recovery only. Further prepareRecoveryInput hooks remain pending and must not be invented or overwrite the owned modules.
