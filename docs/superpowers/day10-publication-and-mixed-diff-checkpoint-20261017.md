# Day-10 P0 checkpoint — native mixed ACK and cancellation publication

Goal remains **ACTIVE**. This checkpoint is additive to all earlier Day-10
receipts. Web `main@cb261f747b4ea01ee8ff8ab4d885796f50ed936f`; Swift
`main@30d3fe4570761943464947894a4e1e0b863b3574`. Both preexisting dirty
worktrees were preserved. No Git references, production services, installed
connector configuration or global runtime settings were changed. No subagent
was created or resumed. Actual GPT-6 Sol (Web) High routing is **UNVERIFIED**.

## Verified local change

`src/adapters/chatgpt-web/screen-observation.ts` previously mutated the
acknowledgable snapshot cache before the final live grant and cancellation
checks. Two deterministic tests in
`tests/screen-observation-publication.test.ts` were RED: after a JSON or
`both` observation was aborted at the final publication boundary, an ACK of
the last successfully returned frame could no longer produce the expected
stable UIA delta. Both received `full` instead of `diff`.

Snapshot mutation is now staged and committed only after the final validation
and cancellation checks. The synchronous commit is followed immediately by
return. The suite is GREEN: **46 pass, 0 fail, 309 assertions** across six
files, including MCP stdio, snapshot/diff, native configuration and privacy
regressions. `bun run typecheck` and `git diff --check` exited **0**.

Evidence: `docs/superpowers/day10-screen-publication-race-20261017.json`;
test log: `output/day10-screen-publication-green-20261017.log`.
The cancellation scenario is a deterministic local fixture, not a real
provider timeout or authenticated Web-model receipt.

## Previously executed native integration reconciled

The existing isolated Swift native + MCP stdio + generated Native2 integration
receipt was independently read, hashed and attached as
`docs/superpowers/day10-native-mixed-diff-20261017.json`. It documents **5**
actual private native observations, **2** full snapshots, **2** mixed semantic
diffs, a chained ACK, stale-ACK fallback, stable UIA identity and per-frame
OCR/CV replacement. All private processes were cleaned up. The raw receipt
remains `output/day10-reader-mixed-chain-1792216765981/results.json`.
This native fixture predates the final-publication fix; it is not a retest
of that fix. The live authenticated Web-model observation gate remains
**NOT RUN** because current outer inventory does not expose
`codex_screen_observe`.

## Safety and remaining limits

`docs/superpowers/day10-scoped-safety-advisory-20261017.json` retains the
**six** supplied, scope-specific `PENDING_SAFETY_REVIEW` records; all six
share the unmapped prerequisite and original refused desktop-observe action.
The notice says its page is complete, but it is advisory only. The current
connector does not advertise an independent `codex_safety_review` function.
No original operation was retried and no status was resolved by inference.

The Swift CPU AUTO source was inspected: `ObserverEngine::analyze()` still
calls `pool_.update_pressure({})`, and the topology code treats ancestor Job
Object limits as unverified. The current single-worker fallback is correct
for this uncertainty. No benchmark or native source patch was claimed.
Pixel-image relay remains **UNAVAILABLE** and observer image mode **DISABLED**.
Web 272K recall, steering/compaction races, native parallel overlap and
actual Web observer E2E remain unverified. There is no evidence justifying
promotion of an entire requirement group.

Full PLAN matrix: **175** requirements = **5 PASS**, **137 PARTIAL**,
**12 BLOCKED**, **21 NOT RUN**. Matrix and state ledger contain additive
references to this phase without changing any status.

## Next safe step

Continue P0-A4 with independently owned cancellation, provider-timeout,
target-generation and response-delivery tests; verify the exact replay and
ACK semantics at MCP response boundaries. Separately measure Windows CPU
capacity and system pressure under a private fixture before considering
multi-worker AUTO allocation. Recheck model-facing observer availability
through the original native inventory; no connection or safety-controller
workaround is authorized.

## Addendum — UTF-8 named-pipe framing regression

A subsequent real private Windows named-pipe regression found the native
reader's per-chunk UTF-8 conversion corrupted split multibyte OCR characters
(`Chào 世界` became `Ch��o 世界`). `NativeReaderPipeProvider` now uses a
streaming `StringDecoder('utf8')`; the NDJSON response retains all characters.
The expanded seven-file suite is **47 PASS, 0 FAIL, 310 assertions**.
Root typecheck and `git diff --check` remain exit **0**. Evidence and exact
hashes are in `docs/superpowers/day10-screen-observer-utf8-framing-20261017.json`.
This exercises a real private Windows named pipe and a synthetic response;
it does not establish a live native WinRT or authenticated Web-model round.

## Later continuation — monotonic frames across all formats and cancel-once

The observer registry now keeps a per-grant published-frame high-water mark
for legacy, compact, both and JSON. It rejects concurrent observations that
arrive out of order, including when no JSON ACK base is cached. New grant
rotation permits a fresh frame/generation epoch. A cancelled future frame ID
100 cannot poison the high-water mark or prevent valid frame 8 after frame 7.
In a private Windows named-pipe test, an aborted read previously caused two
`observer_cancel` requests. A per-observation guard now sends exactly one.

Latest local suite: **55 PASS, 0 FAIL, 344 assertions** across eight files;
root typecheck and Git diff check exit **0**. Exact source hashes and RED→GREEN
evidence: `docs/superpowers/day10-observer-all-formats-frame-order-20261017.json`
and `docs/superpowers/day10-observer-cancel-once-20261017.json`.

A justified attempt to rerun the prior private Swift/Native2 mixed ACK harness
failed **before the first observer call**: `swift.session_status(enable)`
returned `FOCUS_FAILED` for the fixture window. This is a current foreground
precondition failure, with cleanup verified for all owned processes. It does
not prove a screen-observer regression or supply new native integration PASS.
The prior successful native receipt remains separately historical. No repeated
session-enable attempt was made. Observer focus checks were left unchanged.

The 175-requirement matrix remains **5 PASS, 137 PARTIAL, 12 BLOCKED,
21 NOT RUN**. All six advisory-only safety-review prerequisites remain pending.
Next safe focus: native integration only after independently verified
foreground eligibility, source-level target/generation/cancellation checks,
and read-only effective CPU budget and telemetry investigation.

## P0-B addendum — current Windows allocation and matched CPU benchmark

Read-only topology receipt: `docs/superpowers/day10-cpu-live-allocation-matched-bench-20261017.json`.
Windows advertised 12 logical processors, but the observer process reported
6 allowed CPU-set processors. Ancestor Job Object limits remain unverified;
therefore effective capacity is uncertain and AUTO correctly stays at **one
worker**. The conservative fallback is retained.

The native CPU policy tests passed **5/5** and the complete CPU test binary
passed **13/13**. Six alternating-order paired synthetic CV benchmarks (100
measured frames per mode per pair, four ROIs, 1024x768) recorded one active
worker in both single and AUTO. Median paired-run P95 CV join was **4.2625 ms**
for single versus **4.4442 ms** for AUTO; median wall time was **620.8465 ms**
versus **626.042 ms**. These observations show **no verified multiworker
scaling or speedup** and do not establish production OCR/UIA, real foreground
game FPS, or model-facing end-to-end performance. Source, raw measurements,
SHA-256 values, and interpretation are in the referenced receipt.

The full **175-item** matrix remains **5 PASS / 137 PARTIAL / 12 BLOCKED /
21 NOT RUN**, GOAL ACTIVE. Six scoped `PENDING_SAFETY_REVIEW` desktop-observe
prerequisites remain unresolved; neither a refused observation nor any
alternative controller was retried. Production configuration, installations,
running sessions and Git references were not changed for this benchmark.

## P0-A addendum — prompt abort and native reader timeout recovery

The native reader now destroys an outstanding pipe socket on AbortSignal,
preserves the supplied Error reason, and cleans up its abort listener. The
previous private hanging-reader regression reproduced approximately 2.3 s
of delay and now settles in roughly 8 ms. Its native cancellation request
is issued exactly once even when abort and read failure race.

A new private Windows pipe fixture keeps the first reader open until its
transport timeout, verifies exactly one `observer_cancel`, and successfully
reads a second observation through the same provider. The eight-file suite
now reports **57 PASS, 0 FAIL, 351 assertions**. Root typecheck and Git diff
check both exit **0**. Receipt, SHA-256 hashes, and actual test logs:
`docs/superpowers/day10-screen-observer-timeout-recovery-20261017.json`.

This is private pipe evidence, not a real Swift foreground observation or
authenticated Web-model/pixel delivery receipt. Pixel mode stays disabled;
six scoped `PENDING_SAFETY_REVIEW` prerequisites still prohibit retries.
The matrix remains **175 total: 5 PASS, 137 PARTIAL, 12 BLOCKED, 21 NOT RUN**.
No production configuration, installed components, Git refs or active
processes were intentionally changed.

## P0-A addendum — cross-frame receipt provenance and grant rotation

An MCP regression reproduced acceptance of `capture.frame_id=8` or
`sources.ocr.frame_id=8` when the primary native observation published frame
7. The original focused suite was RED (17 pass, 2 fail). The Web observer
registry now validates nested capture frame/generation/viewport/dimensions
and optional DPI as well as paired OCR-source frame/generation metadata before
tree projection and ACK publication. This prevents the model-facing receipt
from claiming incompatible same-frame provenance.

The test fixture now updates default OCR-source frame metadata when an
existing test advances the primary frame. A positive test preserves valid
native-shaped captures. A separate concurrency regression confirms that an
old pending observation rejected after grant rotation cannot replace the new
grant's acknowledged JSON tree. Eight related observer test files are GREEN:
**61 PASS, 0 FAIL, 372 assertions**; `bun run typecheck` and
`git diff --check` both exit **0**. Complete source/test/log SHA-256 evidence:
`docs/superpowers/day10-observer-cross-frame-provenance-20261017.json`.

This is verified local MCP and registry behavior. Real native Swift focus,
authenticated GPT Web semantic interpretation and model-visible pixels remain
unverified. The six scoped `PENDING_SAFETY_REVIEW` prerequisites are preserved
without retry or alternative-controller use. **GOAL ACTIVE**; 175 requirements
remain **5 PASS / 137 PARTIAL / 12 BLOCKED / 21 NOT RUN**. No production
configuration, installation, subagents or Git reference changes were made.

## P0-A addendum — truthful READY requires final-frame semantic evidence

An isolated MCP regression reproduced two cases where a native receipt
was accepted as `READY`: no explicit final-frame semantic proof, and a
contradictory internal `NOT_READY` status. The original focused suite was
RED (**20 PASS, 2 FAIL**). The bridge registry now requires an explicit
readiness request, matching `READY` semantic status, `ui_ready` mode,
`ocr_text_contains` predicate, and the exact final frame/generation before
returning `READY`. Non-READY observations cannot claim `semantic_ready:true`.
Native request and result statuses must match.

Positive UIA/diff, grant-rotation and cancellation fixtures now use
realistic per-frame native readiness receipts. Negative/positive `NOT_READY`
tests cover contradictory and truthful sampling. The eight-file suite is
GREEN: **65 PASS, 0 FAIL, 392 assertions**; typecheck and diff check pass.
Receipt and verified hashes are in
`docs/superpowers/day10-observer-ready-proof-20261017.json`.

These tests prove local MCP validation and preserve the broader observer
requirements as PARTIAL pending real Swift foreground observation and
authenticated Web-model semantic/pixel proof. All six scoped
`PENDING_SAFETY_REVIEW` entries remain unresolved and were not retried.
GOAL stays ACTIVE: **5 PASS / 137 PARTIAL / 12 BLOCKED / 21 NOT RUN**.

## P0-A addendum — native post-OCR ownership/expiry and frame receipts

The real Swift `ReadinessCoordinator` had a cancellation race after its
semantic callback: it could accept `READY` without checking whether the
grant had been revoked, physical cancellation had occurred, or the absolute
deadline had elapsed during OCR. A new native regression reproduced this:
the owner was revoked by the semantic callback, but the old coordinator
returned `READY` and the assertion aborted the test. After the patch,
the coordinator checks cancellation, authorization and deadline after the
callback and before accepting its result. Regressions cover all three
conditions and preserve only previously authorized frames on cancellation.

A separate native case proves the latest captured frame can be newer than
the last accepted frame. Swift's `observe_reader` now keeps bounded capture
metadata indexed by frame/generation and selects the exact final frame's
receipt before publication; it refuses a missing or mismatched receipt.
No new capture or alternate screen controller was added. Native CMake build
and five focused CTest groups passed. Raw logs, file SHA-256 values and
scope limits are recorded in
`docs/superpowers/day10-native-readiness-post-sample-20261017.json`.

These are direct native code and isolated test results. Foreground Swift
observation, authenticated Web-model semantic interpretation and pixel
delivery remain unverified. All six scoped `PENDING_SAFETY_REVIEW` entries
remain unresolved without retry. **GOAL ACTIVE**, unchanged matrix:
**5 PASS / 137 PARTIAL / 12 BLOCKED / 21 NOT RUN**.
