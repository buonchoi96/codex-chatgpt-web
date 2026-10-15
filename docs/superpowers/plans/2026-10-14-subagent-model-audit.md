# Actual child-model audit and preserved handoff

User requested this audit before further P0 delegation. All session files were read-only. No production Launcher/MCP/config change, Git ref change, working-tree reset or UI replay occurred.

## Observed requested versus allocated models

| Child | Requested at spawn | First native turn | Later native turns | Disposition |
| --- | --- | --- | --- | --- |
| Gibbs, 01a13860-79ec-7fa0-885f-8c709d7bbc84 | gpt-6-luna / high / fork_context:false | gpt-6-luna / high | gpt-6.1-sol / high (5 context records) | Closed; existing source and receipts preserved |
| Sagan, 01a13860-b472-7770-b9bf-81819d042f56 | gpt-6-luna / high / fork_context:false | gpt-6-luna / high | gpt-6.1-sol / high (7 context records) | Closed; reviews and artifacts preserved |
| Herschel, 01a1399b-1210-7533-8d77-126a45e6aa18 | gpt-6-luna / high / fork_context:false | gpt-6-luna / high; collaboration model also Luna | No follow-up/resume dispatched | Verified initial-turn implementer |
| Anscombe, 01a1399b-acea-7fd2-9cca-3fa77a9e63b4 | gpt-6-luna / high / fork_context:false | gpt-6-luna / high; collaboration model also Luna | No follow-up/resume dispatched | Verified initial-turn read-only supervisor |
| Rawls, 01a1399f-daeb-7340-9f9b-59bac47c05c8 | gpt-6-luna / high / fork_context:false | gpt-6-luna / high | No follow-up/resume dispatched | Current verified initial-turn implementer |

The live tool schema uses `fork_context:false`, not `fork_turns:"none"`. Fresh child history contains only injected environment and the model-allocation validation prompt before the handoff; it did not inherit the parent task transcript.

## Exact provenance

Parent: `E:/Codex/sessions/2026/10/13/rollout-2026-10-13T00-54-13-01a13140-303e-72b0-b4cd-5f1d10ad9fa2.jsonl`.

- Line 6466: Gibbs actual spawn payload explicitly passes `model:"gpt-6-luna",reasoning_effort:"high",fork_context:false`; line 6470 returns the Gibbs ID.
- Line 6475: same explicit fields for Sagan; line 6478 returns the Sagan ID.
- Line 6566: both original children closed.
- Line 6631 at 03:17:44.599Z: Gibbs `resume_agent({id})` followed by `send_input({target,message})`; neither exposes/passes a model override.
- Line 6651 at 03:19:01.854Z: same resume/follow-up pair for Sagan.
- Parent first turn_context, line 7: `gpt-6.1-sol/high` (all 19 audited parent contexts use that model/effort).

Gibbs: `E:/Codex/sessions/2026/10/14/rollout-2026-10-14T10-06-49-01a13860-79ec-7fa0-885f-8c709d7bbc84.jsonl`.

- Line 1: actual parent lineage, nickname Gibbs, provider openai, native CLI 0.162.0-alpha.17.2, agent_role null.
- Line 6 at 03:06:51.651Z: Luna/high initial turn.
- Line 232 at 03:17:59.449Z: first Sol/high turn, after the resume/follow-up pair.
- Lines 414, 597, 625, 885: subsequent Sol/high context records, including the CPU implementation phase. Earlier descriptions that all these phases ran as Luna were unverified and are corrected by this audit.

Sagan: `E:/Codex/sessions/2026/10/14/rollout-2026-10-14T10-07-04-01a13860-b472-7770-b9bf-81819d042f56.jsonl`.

- Line 1: actual parent lineage, nickname Sagan, provider openai, same native CLI, agent_role null.
- Line 6 at 03:07:10.223Z: Luna/high initial turn.
- Line 206 at 03:19:15.191Z: first Sol/high turn, after its resume/follow-up pair.
- Lines 339, 416, 541, 556, 624, 649: Sol/high later context records.

Fresh Herschel: `E:/Codex/sessions/2026/10/14/rollout-2026-10-14T15-50-26-01a1399b-1210-7533-8d77-126a45e6aa18.jsonl`, session_meta line 1, Luna/high turn_context line 6.

Fresh Anscombe: `E:/Codex/sessions/2026/10/14/rollout-2026-10-14T15-51-06-01a1399b-acea-7fd2-9cca-3fa77a9e63b4.jsonl`, session_meta line 1, Luna/high turn_context line 6.

## Configuration and causal limits

Read-only selected settings from `E:/Codex/config.toml`: line 4 default model `chatgpt-web/gpt-6-sol`; line 5 effort high; line 108 multi_agent true; line 112 max_depth 2. No named agent-role/model/config_file overrides were found there; standard agent directories and repository-local .codex/config.toml were absent. The global default differs from this parent thread's actual Sol model, so it is not evidence of the child allocation by itself.

Initial explicit spawn overrides were honored. The mismatch appears on the first turn following resume plus follow-up and matches the parent model. Native implementation source for those lifecycle operations is not available in these workspaces; the audit cannot distinguish which of the two operations resets effective settings or prove an internal root cause. Record **MODEL_OVERRIDE_NOT_PRESERVED_ON_RESUMED_FOLLOWUP**, not a false claim that initial spawn never supported Luna.

The same records change `collaboration_mode.settings.model` from Luna to Sol while `reasoning_effort` remains high: Gibbs lines6/232 and Sagan lines6/206. This corroborates an effective turn-setting change rather than only a display-label change.

The current tool's advertised model list omits Luna, but actual fresh spawns accept it and native first-turn metadata confirms it. Availability-list omission therefore does not establish unsupported allocation. No production role configuration was changed to compensate.

## Correction and handoff

Closed wrong-model children before assigning new work. Their completed CPU/frame foundations, tests, prior reviews and all dirty-tree changes remain in place. Newly resumed old children were still pending_init and received no new P0 task when closed.

Created two fresh children with a validation-only initial prompt. Main independently inspected session_meta and turn_context before writing an authorized handoff JSON into the ignored workspace output directory. Each child receives its implementation/read-only scope within that same verified initial turn. No resume/send_input is used for task handoff. This is a verified local coordination correction, not a permanent runtime configuration fix. Recheck every subsequent turn_context; an unverified or changed model must not receive work.

Herschel owns frame CV cancellation/truncation receipts and targeted tests. Anscombe owns read-only offline OCR capability research/probe. Main owns native delegated-reader/session authority, controller integration and final acceptance. At handoff: exactly two active children, both verified Luna/high; older Gibbs/Sagan are shut down. No nested agents.

Correction to that initial handoff: Herschel stopped without implementation because it compared the app's current workspace/parent chat ID against the child ID. That UI/root identifier is not the native child identity. Herschel was closed while still Luna; no code/tests had started. Rawls replaces it with an explicit nonce gate validated against the native child session_meta, not app list_threads. Rawls transcript is `E:/Codex/sessions/2026/10/14/rollout-2026-10-14T15-55-40-01a1399f-daeb-7340-9f9b-59bac47c05c8.jsonl`, session_meta line 1 and Luna/high turn_context line 6, verified before its task file was published. Current active pair: Rawls + Anscombe. This identity-gate correction is separate from the resumed-child model mismatch.

Outstanding P0: reader lease, state-aware final-frame observation, UIA/OCR/CV fusion/tree, Native2 codex_screen_observe/advisory, actual eight-command native overlap and receipt retirement, archive/readable fallback and live recovery/steering acceptance. Image mode remains disabled; no screenshot composer fallback.

## Verified work and latest lifecycle

Rawls also stopped without work: it parsed the handoff's transcript path string as transcript JSON rather than opening that file. This was a handoff-consumer mistake, not a model allocation failure. Main removed redundant child-side transcript verification; native model verification remains independently performed by main before publishing each nonce-bound task file. No resumed/follow-up turn was used.

- Laplace `01a139a4-04eb-7432-b75b-e049e7bafb40`: actual Luna/high in its only turn_context, line 6 of `E:/Codex/sessions/2026/10/14/rollout-2026-10-14T16-00-13-01a139a4-04eb-7432-b75b-e049e7bafb40.jsonl`. Implemented typed CV cancellation/deadline/truncation and tests. Completed and closed.
- Anscombe: actual Luna/high in its only turn_context, line 6 of its transcript above. Successfully performed offline Windows OCR recognition of an original generated bitmap, en-US only, no package identity; source native worker activation remains unverified. Completed and closed.
- Raman `01a139a5-6459-7522-83e4-877f1c60520e`: actual Luna/high at native line 6. Review stopped because the handoff's relative paths were resolved in Web rather than Swift. No source changes. Main corrected subsequent handoffs to absolute paths; Raman closed.
- Ramanujan `01a139b0-366f-7a13-8e46-a850f45eed73`: actual Luna/high in its only turn_context, line 6 of `E:/Codex/sessions/2026/10/14/rollout-2026-10-14T16-13-32-01a139b0-366f-7a13-8e46-a850f45eed73.jsonl`. Implemented direct/reserved parallel field validation. Main still audits the nested-gateway limitation; no live native overlap claim. Completed and closed.
- Nietzsche `01a139b0-38cc-77d3-824c-61a153d45d42`: actual Luna/high in its only turn_context, line 6 of `E:/Codex/sessions/2026/10/14/rollout-2026-10-14T16-13-32-01a139b0-38cc-77d3-824c-61a153d45d42.jsonl`. Reviewed and independently compiled/ran reader/frame tests using absolute Swift paths. Completed and closed.

All observed context records for these actual work phases remain Luna/high; this is stronger evidence than the initial payload alone. At the latest phase boundary there are **zero active child agents**, with main integrating and independently verifying results. This does not imply runtime resume semantics have been repaired. New phases must use fresh explicit allocation and native metadata verification; never assume a resumed thread retains its model.

Preserved P0 progress: native controller source now issues/revokes default-off reader grants from native attached snapshots, binds epoch/geometry/DPI/session/consumer/viewport, checks session and integrity, and revokes on detach/Escape. No public screen observer/reader endpoint is advertised as available yet. Private native build passed and main pure CTest passed 3/3 (CPU/frame/reader). Readable archive fallback, nested parallel schema discovery, actual overlap, observation/readiness/UIA+native OCR integration and model-loop acceptance remain open.

Final main verification after native feature/ownership checks: private build PASS and CTest4/4 (CPU0.29s, existingnative+default-off reader0.93s, frame0.08s, reader0.07s). Web mapper review corrected unnecessary rejection when both exec and legacy shell are advertised: native exec remains preferred, duplicate chosen interfaces fail closed. Focused parallel/capacity/image/safety90 tests307 assertions PASS; final typecheck PASS. The nested-gateway parallel path remains a capability-discovery integration gap, not accepted as a complete feature. No actual native eight-process overlap or model pixel rerun occurred in this audit.

## Further initial-turn allocation and work

All children below were actually spawned with `model:"gpt-6-luna",reasoning_effort:"high",fork_context:false`. Main inspected native session_meta line1 (matching child UUID/parent lineage, role null) and turn_context line6 before publishing its nonce-bound task. Every inspected context for completed work remained Luna/high. No resume/send_input assigned these phases. Exact transcripts are discovered by UUID under E:/Codex/sessions/2026/10/14.

| Child | Native child ID | Work/disposition |
| --- | --- | --- |
| Kuhn | 01a139ca-5209-79a3-9e73-56d200e269e3 | Swift TS owner-scoped grant/revoke; completed/closed |
| Pauli | 01a139ca-5821-7971-b593-c85d3751d964 | Actual C++20 WinRT OCR activation and original bitmap recognition; completed/closed |
| Russell | 01a139ce-3de6-7f42-954a-a9fd8a262a76 | Independently found target-capacity leak and obsolete ROI publication; main fixed with regression; completed/closed |
| Fermat | 01a139d4-0974-7e41-8702-a3eef62b0544 | reader_ bearer prefix, historical sanitation/archive rejection; completed/closed |
| Locke | 01a139d4-0af5-7432-ae47-dcbdfd7f53af | Reproduced late grant/receipt cleanup/expired bookkeeping defects; completed then handle missing after runtime continuation |
| Ohm | 01a13a8f-2a04-7cc0-8b74-66a32a1c4fb6 | Native persistent private OCR helper/tests; completed/closed |
| Helmholtz | 01a13a8f-2b77-72a2-88e4-ac91f08a669b | Stopped due unnecessary child-side model check; no work; closed |
| Ampere | 01a13a93-2a1f-7b40-bbbf-530436140232 | Independently reproduced TS lifecycle37tests/build; completed/closed |
| Lorentz | 01a13a9c-edd7-7d41-82fc-4f0bf8a7e253 | Failed to execute JSON task after gate; no review; closed |
| Faraday | 01a13aa9-c246-7da3-be70-7b1082aa46ef | Added three uncertainty/late-detach regressions; completed/closed |
| Schrodinger | 01a13aa9-c3a9-77f2-872f-ce261499edd3 | Reviewed Native2 binding/retirement and found undeclared payload publication; main strict-schema regression fix; completed/closed |

Main verified the last pair after completion: each has exactly one native turn_context, line6, Luna/high. At this phase boundary there are **zero active children**; all known tests/process handles are terminal and private GUI/native fixtures closed. Fresh pairs are required for later phases. Runtime resume-model semantics were not repaired or changed in config.

The gate prompt now explicitly says to execute its JSON task field, not finalize at gate validation, and that main owns model metadata verification. Handoff-consumer failures are separate from allocation: those stopped children also recorded Luna/high. No work was redirected to an unrequested Sol child.

Native6/6 CTest passed, including OCR real recognition and deadline while a private helper stopped reading raw BGRA. Swift full npm test66+4 passed. Web regression202tests1151assertions passed (before final privacy-schema change); strict privacy fix then9observertests35assertions/typecheck passed. Actual private Swift stdio/native reader produced same-frame OCR/CV, genuine separately timed UIA and no encoded images. A second real Native2 MCP in-memory/provider integration returned that tree in exactly one codex_screen_observe call; this was not a Web-model pixel test. Detailed artifacts/gates are in the observer CPU plan. All source and user changes remain preserved; HEAD/branches/production config unchanged.
