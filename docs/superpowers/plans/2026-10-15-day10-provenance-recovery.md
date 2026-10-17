# Day-10 reset: authoritative checkpoint and provenance repair

Latest contract: attachment `f529255e-fa33-46d7-b68d-3477c519c841/pasted-text-1.txt` (supersedes `98fc1ad6-c7ae-49e1-8a98-d12124c10186`). Root Web PLAN exists and was read end to end; SHA256 `8da926d072316ea9402bacd2ba63039d05bbe85239bb58198dbb4cc104328585`. Root GOAL.md is absent. Do not manufacture it or overwrite the user plan.

Later browser repair and live receipts are in [Day-10 live browser recovery](2026-10-15-day10-live-browser-recovery.md). Its current focused suite195 tests/1465 assertions and typecheck pass; live/native acceptance boundaries remain explicit there. Historical failed runs below are retained as historical evidence, not the latest source acceptance.

Web baseline is actual `main@73b628d4641e1e5c5830b18663ef6dcfce8eae51`, initially clean. The expected `a92c086` ancestry is present. Swift remains separate `main@30d3fe4570761943464947894a4e1e0b863b3574` with preserved dirty/untracked source/design/test changes. No new branch, commit, push, production restart, configuration or MCP registration change occurred. Prior implementation is now partly in the pulled Web checkpoint; old dirty-tree descriptions are historical.

Machine-readable checkpoints: `../day10-state-ledger.json`, `../day10-plan-matrix.json`, `../day10-safety-blockers.json`. Matrix statuses retain the full acceptance scope. PARTIAL/fixture evidence is not live PASS.

## Latest integrated checkpoint after explicit Luna spawn and updated GOAL

Authoritative goal is now attachment `f529255e-fa33-46d7-b68d-3477c519c841/pasted-text-1.txt`, read in full. It adds literal Luna payload examples; it does not require a third probe identity. Current tool accepts model/effort strings and fork_context:false, with no task_name/fork_turns fields. User's explicit request authorized safe fresh replacement after the prior pair's proven terminal cleanup. Maxwell (coding) and Pascal (read-only supervisor) were allocated gpt-6-luna/high, independently verified at session_meta1/turn_context6 before nonce-gated tasks, then rechecked after completion: one Luna/high context each, no resume/send_input. Both closed with completed receipts. Main remains native gpt-6.1-sol/high. Exact IDs, files, payload/context receipts and current zero-active inventory are in the state ledger and `output/day10-current-model-proof-20261015.json`. Earlier mismatch is still MODEL_OVERRIDE_NOT_PRESERVED_ON_RESUMED_FOLLOWUP, not failure of an initial explicit Luna spawn.

Native installation recovery is now implemented in `native-compaction-provenance.ts`, reusing the canonical rollout locator and a bounded backward scan of the newest native `compacted` record. It binds current thread/turn/model, actual native effort, canonical checkpoint payload/owner and native retained-source identity/completeness. It rejects newer conflicting installations, incomplete newest retained sources, altered content and concurrent native turn/checkpoint changes. Only readable v1/transparent canonical ocx1 v2 summaries qualify; opaque native summaries remain unsupported. The real historical native records establish schema availability, not a new live Web/native ACK.

Authenticated historical user instruction content now reaches cold prompt compilation with original item/turn IDs and an explicit historical origin. Canonical request bytes remain unchanged. Later genuine steering wins and retains the authenticated predecessor. Historical user-image content uses normal structured context transport; it is not a screenshot observer fallback. Supervisor reproduced73 tests/281 assertions before the final effort follow-up. Its review note led main to RED3 missing/invalid native-effort cases, then a fix requiring an actual native effort witness even when the request omits a preference. No requested effort/default is invented; explicit requested effort must match.

The runtime blocked-operation ledger already existed at baseline4a82a5e; the earlier checkpoint's NOT IMPLEMENTED description was incorrect. Main hardened it against incomplete/unknown resolutions that could disappear from pending work, concurrent overwrite through an exclusive fail-closed write lock, duplicate observation records, malformed/oversized state and omitted freeform input. Persistence failure is now an explicit additional unresolved MCP receipt while preserving original error/content/metadata/image evidence and retiring turn authority. No automatic retry or execution is added. Maxwell added five bounded validation/capacity/legacy regressions:11 pass/53 assertions. Per-requirement goal review across turns, remaining denial classifications, safe review authorization and live end-to-end acceptance remain PARTIAL. A stale/busy lock fails visibly and requires review; no lock is forcibly removed.

User identified two separate historical 2026-10-14 incidents in `Pasted text(20261014-155918).txt`: file-read diagnosis4219–4223 and `bun run verify`8455–8461; shorter153656 export also reports the read. Both are separately PENDING_RECEIPT_RECONCILIATION / SAFETY_STATUS_UNDETERMINED. Requested older session model Sol Web High is unverified runtime data. Exact wire/call/trace/thread IDs and original execution remain null.27 Oct14 rollouts/23 matching repository sessions yielded zero exact standalone raw refusal receipts under inspected schemas; quoted/embedded occurrences were not promoted to evidence. Exact exports were not found in the searched locations. This does not prove their absence elsewhere. User prohibits retry of those operations; none was retried after clarification. Later valid verify receipts are separate partial coverage and do not establish original blocked execution or a successful full gate.

Final source checks after integration:

- Typecheck PASS (`output/day10-final-source-typecheck-20261015.log`).
- Native provenance/environment/retained tests171 pass,0 fail,684 assertions/4 files/11.12s (`output/day10-native-safety-final-20261015.log`).
- MCP/ledger/image/parallel/broker tests146 pass,2 skip,0 fail,637 assertions/11 files/18.78s (`output/day10-ledger-mcp-accepted-20261015.log`).
- Explicit socket-I/O awaits retain all transport assertions. Two broad runs and one isolated matcher repro stalled on Windows Bun; exact owned PID/creation/command identities8928/23356/25644 were checked before stop, exit1 and NOT PASS. Fresh lifecycle15 pass/2 skip/58 assertions and final integrated run passed. No production transport change was made to address these fixture stalls.
- Earlier full verify1297 pass/72 skip/2 EPERM symlink failures/9643 assertions/114 files/216.13s; exit1. This predates the latest safety/effort patches and is not relabeled current-source full PASS. It was executed before the user's no-retry clarification; not rerun.
- Private relocatable runtime build passed before latest safety/effort edits. Its smoke log records RELOCATABLE_RUNTIME_SMOKE_OK; original handle96916 is no longer retained. This is a pre-safety bundle, not a final-source installation or live model test. No installer was run and no current-source packaging completion is claimed.

All175 matrix requirements remain inventoried. Live ENV/REPLAY/COMPACT, remaining SAFE, actual272K clamp/recall, one-Send/archive/steering/watchdog, real2–8 native overlap, Swift UIA/OCR/CV/readiness, CPU AUTO/load benchmarks and model-visible pixel proofs remain incomplete. Image mode stays disabled. Swift dirty worktree, user DEV Launcher, production, configuration and MCP registration are preserved; no new branch/commit/push. The sections below retain the preceding checkpoint history and are superseded where this latest section differs.

## Actual models and lifecycle

Main native context line9615: `gpt-6.1-sol/high`, actual parent `01a13140-303e-72b0-b4cd-5f1d10ad9fa2`. Fresh children were explicitly spawned with `gpt-6-luna/high/fork_context:false`, the supported equivalent of no inherited turns. Main verified native session_meta line1 (exact child ID and parent, null agent role) and turn_context line6 before publishing nonce-bound tasks:

| Fixed role | Child | Native ID | Actual context throughout work | Terminal receipt |
| --- | --- | --- | --- | --- |
| Coding/implementation | Beauvoir | 01a13e65-2945-7953-a650-acbdbd6dbb20 | one context, Luna/high | completed; close returned completed |
| Read-only research/test supervisor | Heisenberg | 01a13e65-2c28-7410-ba2f-f504be1a6f91 | one context, Luna/high | completed; close returned completed |

Native files are under `E:/Codex/sessions/2026/10/15/`, uniquely identified by those IDs. No send_input/resume was used. At checkpoint, zero active owned children. Earlier Harvey/Chandrasekhar handles returned not_found after reset; no work was replayed. Harvey's earlier usage-limit failure is not proof of current unavailability: current limits allowed fresh allocations, and native metadata independently confirmed both.

Prior Gibbs/Sagan resumed-follow-up drift remains proven and unresolved in runtime: initial Luna/high became Sol/high. See the 2026-10-14 audit for exact parent payload lines and child contexts. The current spawn schema explicitly advertises Luna/high. Read-only current config has default `chatgpt-web/gpt-6-sol`, high, multi_agent enabled and max_depth2; no local config/agent directory or named role override was found. No config was changed. Default config alone does not identify effective child allocation. stop_agent is not an exposed tool; close_agent is terminal cleanup, not a fabricated resumable pause. Unsupported/unsafe lifecycle tests remain NOT RUN/BLOCKED.

## Changes and independent review

Missing trusted environment now throws typed `TRUSTED_CWD_MISSING_OR_UNVERIFIED`. Missing current instruction throws `CURRENT_TURN_USER_REVISION_MISSING`; missing/conflicting turn identity throws `REPLAY_PROVENANCE_UNVERIFIED`. All are nonretryable invalid-request errors. HTTP replay preflight returns400 before browser adapter construction, including repeated identical bad requests. No goal fragment, shell cwd, ZIP, summary prose or unrelated historical instruction supplies authority.

Standalone native v1 compaction can have canonical source items without a live replay turn. Its dedicated canonical-source preflight remains authoritative; inability to derive an optional replay trace does not reject that protocol. Regression fixtures for ordinary native responses now supply actual fixture turn identity and message items; assertions remain strict. No generic production provenance bypass was added.

Beauvoir repaired cached authority: persisted JSON is diagnostic data, never a filesystem grant after restart or after an unrelated current verification. Only verified same-process entries can carry authority, subject to bounded capacity, expiry and current metadata constraints. Current native rollout remains the recovery authority. Main found and fixed two further RED cases: malformed workspace declarations and sliding expiry renewed merely by cache reads. Network authorization, corrupt-cache backup, fresh tools and native lineage checks remain enforced.

Heisenberg independently reviewed canonical-source/settlement paths and reproduced focused tests. Remaining replay root cause: completed checkpoint registry is process-local and scoped by thread, turn, model and effort. Restart/rebind loses that key. A completed browser response is not a separate native installation ACK; a later canonical request with the exact matching summary and valid ownership is required evidence. Durable authenticated/native-history recovery is still open. Do not persist unsigned authority and call it proven.

## Verification and boundaries

- Main initial provenance RED:3 failures; then focused GREEN.
- Main HTTP/provenance/compaction/lifecycle:75 pass,544 assertions.
- Main harness+screen+HTTP/provenance regression:187 pass,1378 assertions,51.08s before the final two cache-review fixes.
- Main final cache/environment/provenance review:94 pass,397 assertions, including both additional RED/GREEN cases.
- Supervisor environment+accepted-source recovery:89 pass; server compaction25 pass; selected settlement/progress1+2 pass. Its broader IPC run stalled; only its own process was stopped, and that run is not counted PASS.
- Main typecheck passed before final cache-review changes; the full verify run covers the final source and must be collected before claiming a final full gate.

Collected final checks:

- Main final typecheck PASS; Launcher typecheck PASS.
- Full `bun run verify`: FAIL at repository tests:1266 pass,72 skip,6 fail,9569 assertions,1344 tests/113 files/220.85s. Two failures are Windows EPERM while creating disposable symlink fixtures. Four others exposed old mock fixtures lacking canonical native identity; ordinary Responses Lite/prediction fixtures now carry canonical metadata/message IDs, and explicitly malformed/unattributed requests assert400 with zero adapter constructions. The focused corrected set then18 pass/86 assertions. The whole suite was not rerun after these fixture-only edits; do not relabel the previous full run as green or as only two failures.
- Launcher tests:391 pass,4 skipped,1 fail across396 tests; the failure is the same Windows symlink privilege limitation in an owned Temp fixture. No production config was touched and no OS privilege setting was changed to force green.
- `git diff --check` PASS. Builds/packaging later in verify were not reached; no new installer/CI/live native compaction proof is claimed.

Additional native ACK investigation: the real parent rollout contains eight historical native `compacted` events (lines1144,2449,3701,4881,6224,7564,8593,9407), each with compaction_response_id, replacement history, identified user items, resume metadata and a usage record. This proves durable native compaction witnesses exist in this session history. It does not prove the new recovery patch consumed those witnesses or that a Day-10 DEV compact installed a new summary. Next recovery work should match the actual current canonical summary/owner to authenticated native history and source identity, rather than treating an unsigned bridge JSON cache as provenance.

Read-only DEV status reports launcher PID12688, full dev-harness, MCP ready, isolated unused Codex route and no Responses listener. No new model/browser Send, UI action, old scenario replay or restart was performed. Earlier CDP timeout did not authorize restart. Production continuity is preserved by non-interference, not inferred from DEV health.

Safety checkpoint retains the two user-reported earlier refusals as unresolved pending exact tool/receipt reconstruction. Transcript occurrences in source/tests/read_thread outputs are not direct safety refusals and must not be promoted into fabricated incidents. No retry or alternate controller was used. Full per-requirement runtime review remains open; baseline already contained MCP refusal persistence, since hardened as described in the latest checkpoint above.

Observer image mode remains disabled. Existing same-frame OCR/CV/private-reader results are historical, not proof of model-visible pixels, semantic readiness or new Day-10 live acceptance. Remaining work includes authenticated continuation/native ACK, persistent runtime blocker ledger, all live ENV/REPLAY/COMPACT gates, then the unchanged archive/parallel/observer/readiness/UIA/OCR/CV/CPU acceptance matrix.
