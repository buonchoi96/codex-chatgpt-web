# Day-10 live browser recovery and bulk composer repair

Goal remains ACTIVE; all175 PLAN/GOAL requirements remain in scope. Baseline Web main@73b628d and Swift main@30d3fe4 retain their dirty worktrees. The two verified Luna/high children completed and were closed in the previous checkpoint; this work is owned by main. No resumed child, new identity, branch, commit, push, production configuration or installer change is involved.

## Live evidence before the latest repair

- `output/day10-env-live-attempt-20261015.log`: actual isolated Web reply DAY10_ENV_READY (Markdown escaped underscores), one accepted task Send, INLINE, no ZIP, required Native2 selected before Send. Broker completion fence committed, turn settled and retired. This is a real DEV/browser response, not an installed native compact ACK. The displayed258400 compact target is not proof of272K model recall; transport telemetry separately reported its account/transport budget.
- `output/day10-compact-live-failed-20261015.json`: owned interactive DEV session29131 accepted one initial Send, then failed detached assistant/user binding. Existing diagnostic showed TOKEN_STORED in the rendered reply. No compact/follow-up/resend was issued. `/exit` returned terminal0 and cleaned the owned CLI. The rendered reply was not successfully routed as an accepted adapter result.
- `output/day10-live-chain-20261015.json` and matching log: fresh owned harness with300 explicitly inert assistant-history notes, source browser-worker SHA438fc8eb…; initial accepted Send1 failed the same binding guard. No retained follow-up or compact stage ran. Terminal exit1, driver/tunnel-transport cleanup completed. This FAIL is preserved rather than replaced by a later attempt.
- DEV descriptor was observed changing externally from PID12688 to12820. Main did not restart it. The new development profile, Full DEV configuration, MCP readiness and fresh lease were independently validated before the next owned fixture.

No screenshot was attached to the composer. Existing local browser diagnostic images were used only to inspect the failure; that does not prove the Web model received pixels and does not enable observer image mode.

## Repairs and strict ownership invariants

The first fixture reproduced generation-only acknowledgement followed by a user bubble carrying the selected Native2 mention. Pre-Send integrity verification now captures the exact semantic draft with connector identities, separately from canonical prompt text. It does not trim later user text, accept prefixes, fold meaningful whitespace or infer ownership from a display index.

Further RED fixtures exposed two missing cases: the same logical group can remount after the old physical wrapper disappears, and paragraph layout can differ between editor and user bubble. A fallback shell's structural user-role identity is not an actual user acknowledgement. Until a real acknowledgement/proof exists, every post-baseline user is checked even if that role identity appeared in the shell. Reattachment refreshes the physical locator even when the logical key is unchanged. Foreign content, changed connector identity, extra users, surviving separate old groups and lost history remain rejected by their existing guards.

`submitted-input-projection.ts` is a shared, self-contained browser DOM reader. It preserves original text, spaces, explicit line/paragraph boundaries, blank lines, Unicode and literal source; ignores only known UI decorations; keeps connector text and identities; rejects ambiguous user bubbles/targets; and never mutates the live editor or uses CSS layout text as authority. No original Codex message, turn ID, filesystem grant or native source provenance is invented. Privacy-safe binding diagnostics contain counts and booleans, never prompt/connector-path text.

The formerly skipped headless composer regression exposed native insertText stalling on5000 lines in all four old/modern and empty/stale cases. The original full payload and all assertions are retained, now with separate case names. Disposable probe500/1500/5000-line escaped insertion took44/48/143ms respectively, exact readback, one retained connector and zero script nodes (one sample per size; NOT a percentile benchmark or model latency). At1000+ lines, the editing helper now inserts only escaped text with fixed paragraph/BR boundaries as one native editing operation. Literal user HTML never becomes active markup, and complete canonical readback remains mandatory before Send. This does not alter INLINE/ZIP selection, context-window limits or capability authority.

## Verification checkpoint

- RED: first rendered-draft ownership test; three same-key/paragraph cases; canonical-integrity layout dependency; all four original5000-line insertions timed out45s. Timed-out runs are FAIL, not PASS; Bun closed only headless browsers spawned by those fixtures.
- Intermediate corrected browser suite180 pass/1400 assertions/5files, followed by stricter projection/remount work.
- Latest semantic source regression:189 pass/0 fail/1437 assertions/6files/72.05s (`output/day10-binding-final-v2-regression-20261015.log`). Original whitespace/foreign-owner negatives remain enforced. Type-only literal argument and CommonJS fixture-import repairs followed; final typecheck PASS (`output/day10-binding-final-v2-typecheck-green-20261015.log`), and projection unit suite6 pass/27 assertions after the import repair.
- No full `bun run verify` retry. Both historical safety incidents remain PENDING_RECEIPT_RECONCILIATION, original wire/call/trace IDs unknown. They were neither executed nor resolved by these browser fixtures.

The v2 live attempt is now terminal FAIL (owned exec96024, exit1), trace0d8a96797dcf. Exactly one initial Send was accepted; no retained, compact or post-compact stage ran. Diagnostic counts show the rendered body was collapsed:10184 characters versus40863 canonical/40882 verified draft, with the selected connector matching. Both owned driver and transport cleanup completed. The report and log are retained separately from later attempts.

## Full-body disclosure and final fixture evidence

The repair permits one scoped native `Show more` disclosure only when a unique shorter user body and compatible connector are present. Its unique visible button must be outside task content, non-submit, and not an implicit form submission. The attempt flag is set before dispatch. Afterwards the complete expanded body and connector identity are re-read and compared; a changed tail, ambiguous button, content-owned button or submit control still fails. A prefix/length is diagnostic only and never grants response ownership. The gesture cannot issue a task Send.

The draft proof also decodes editor whitespace only for the entire canonical suffix already verified before Send. Intentional original NBSP remains exact; symmetric whitespace equivalence was rejected after a negative regression exposed lost NBSP. Explicit BR boundaries are preserved by the shared reader in both canonical integrity and user matching.

- Latest product-source suite initially194 pass/1 timeout/1465 assertions (`output/day10-binding-final-v3-regression-complete-20261015.log`). The timeout was the existing Windows Bun promise rejection matcher waiting over browser I/O. An explicit await plus Error assertion preserves the negative branch; its focused rerun passed1 test/26 assertions. The earlier failed batch remains FAIL.
- Final six-file regression after that test-only correction: **195 pass,0 fail,1465 assertions,68.94s**, exact owned exec15245 terminal exit0; `output/day10-binding-final-v4-regression-20261015.log`.
- Final runtime typecheck PASS, exact owned exec39736 terminal exit0; `output/day10-binding-final-v4-typecheck-20261015.log`.
- Frozen source SHA256: browser-worker `13b37230b4dfb43cafef44a32d8fc8d26b796e9f39458622878b02c544618d0e`; projection `9340c1f93f8617a601238a4b0d5a0785dc42c5afd8ec247b9216b5397fa13828`.

## Live v3: initial/retained/compact passed, post-compact failed

`output/day10-live-chain-v3-20261015.json`/`.log`, exact owned exec50792 terminal exit1. Initial traceaaf755225516 expanded once from10184 to40882 characters, then matched the entire verified draft and connector; expected reply matched,0tool calls. Retained tracedf611814a031 returned the original random token with RETAINED_DELTA, one Send, no ZIP,0tool calls. Compact trace71ff18e42708 completed structured handoff and the harness accepted5 replacement items. Post-compact epoch trace089d1b543c39 accepted one INLINE Send, then failed whole-body comparison:9657 observed versus9584 verified draft, first divergence5873. All stages had at most one accepted Send each and no ZIP; no post-failure resend. Both owned driver/transport cleanup completed.

This is a preserved overall FAIL. The compact receipt proves DEV canonical replacement only; native app-server installation was NOT TESTED. A successful rendered reply was not accepted through the adapter after the last binding failure.

## JSON lexical transport repair after v3

Main's first read-only probe stopped because the default surface was not the failed fixture; the second stopped because a logical tab ID is not its random surface ID. Neither performed input or a new Send. Launcher log independently recorded this exact trace's `browser.failed_tab_preserved`/terminal event; descriptor then had exactly home plus one turn surface. The final read-only probe matched the fixture's random marker SHA before inspecting structure. It read only that preserved DEV user bubble and disconnected CDP; no page/tab/Launcher close, focus action, disclosure, screenshot attachment, native action or resend occurred. Privacy-safe node/count evidence is `output/day10-binding-dom-probe-20261015.json`; no full task/capability text is written there.

The body is rich-text user content. Its first divergent character is a backslash before `<environment_context>`. There are45 slash-before-angle sequences and14 each of two-/three-backslash runs. That supports a rich-text escaping hypothesis for the73 extra characters; length arithmetic alone is not ownership proof. The repair deliberately keeps the strict full-text comparator. It extends the existing JSON Unicode encoding in `withoutRetiredTurnHandles`: encode literal slash pairs first, then escaped quotes, angle tags and existing backticks. One JSON parse recovers the exact original strings/keys, including Windows/UNC paths, literal `\\u003c` and `\\u0060`, quotes, code, Unicode and lone surrogates. Original native requests/instructions/path authority remain unchanged. Archive selection still measures actual encoded transport bytes; no new ZIP subsystem or fixed threshold is introduced.

- RED: new context-JSON round-trip/lexer test failed on raw angle tags (`output/day10-json-lexer-red-20261015.log`); additional quoted-source assertion failed on escaped quote (`output/day10-json-quote-red-20261015.log`).
- Final JSON transport/usage/multipart/archive/retained regression: **102 pass,0 fail,746 assertions,7 files,29.71s**, exec33289 terminal exit0; `output/day10-json-final-regression-20261015.log`.
- Final typecheck PASS, exec55339 terminal exit0; `output/day10-json-final-typecheck-20261015.log`.
- Prompt SHA256 `70910f58761bd412fe5218fddbe95a5dac6228cc5459fe1c61c7cba74415993b`; browser worker/projection unchanged from the195-test proof above.

## Collected v4 terminal receipt

Single fresh owned live v4 is **PASS_FOR_DEV_PROTOCOL_ONLY**, exact exec45642 collected terminal **exit0**. Report/log: `output/day10-live-chain-v4-20261015.json`/`.log`; durable sanitized receipt: `../day10-live-browser-receipt.json`. The finalizer independently verified all three frozen source hashes before writing the receipt.

| Stage | Trace | Collected result |
| --- | --- | --- |
| Initial | 445ed99adcce | Expected reply matched;0tool calls; one accepted INLINE Send, no ZIP |
| Retained follow-up | 71c38cb5d06f | Original random continuity token matched;0tool calls; one accepted RETAINED_DELTA Send, no ZIP |
| Compact | ab75720f9073 | Structured handoff completed; harness accepted canonical replacement history; one accepted Send, no ZIP |
| Post-compact epoch | 73cdee5bcc72 | Expanded once from10178 to10198 characters; exact complete draft/connector comparison passed; original token matched;0tool calls; one accepted INLINE Send, no ZIP |

Both driver and transport cleanup completed. Final broker was settled/retired with0pending/queued/delivered tools,0active MCP requests and completionCommitted true. Four accepted submissions total correspond to four distinct conditional stages, each exactly one; none is a retry of an ambiguous accepted turn. The retained follow-up stayed on its proven retained conversation; post-compact was a fresh checkpoint epoch. Earlier v1/v2/v3 FAIL receipts remain preserved. This one fresh passing chain supports the specific browser ownership/JSON lexical repair; it is not a latency percentile benchmark.

Source is local/uncommitted. No production Launcher/backend/MCP/global config, Git refs or user PLAN was changed. **Native Codex app-server installation ACK and272K effective recall remain NOT TESTED**; DEV protocol success must not promote all ENV/REPLAY/COMPACT requirements to PASS. Remaining SAFE, archive/watchdog/steering, native2–8 overlap, UIA/OCR/CV/readiness and CPU AUTO gates remain open. Observer image mode remains disabled; no composer screenshot fallback.
