# Backend performance execution report — 2026-10-06

The tested changes retain healthy Luna and Sol follow-ups, validate canonical ancestry and physical browser ownership, reduce verified compaction input, and reduce repeated Computer Use evidence payloads. The broader acceptance criteria remain partially met: cumulative passive recovery/provenance hooks are being supplied separately by the user, native GUI execution could not be verified, and repository verification is blocked by an unpatched upstream advisory. No approval, account, submission ambiguity, tool delivery, or stale-coordinate gate was weakened.

## Revisions and reproduction

- Baseline: `20296a5ac3b8327c6660e3607b992f91ee0c37c0`, synchronized from the target fork's `main` before implementation.
- Implementation revision: `5dedc92c658bda7cddb1ec7102eaee49a073eda4` (compaction `49e6086`, runtime/retention/CU `94b4ace`, dependency/contract fixes `5dedc92`). The report commit follows that revision; it cannot contain its own SHA.
- Windows 11, build 26200, Intel Core i5-12450H. Final verification and synthetic benchmarks use Bun 1.4.0 from an isolated stable installation; the global Bun 1.4.2 installation remains unchanged.
- Real CLI scenarios use the existing `dev:live` runtime through `bun run dev:codex -- exec`, model `chatgpt-web/gpt-5.6-sol`, reasoning `high`, isolated CLI lane and connector. A WebSocket 426 followed by successful HTTP completion is expected fallback behavior.
- Reproduce local comparisons with `bun run scripts/bench-tool-policy.ts`, `bun run scripts/bench-compaction-input.ts`, and `bun run scripts/bench-computer-observation.ts`. Each script describes its scope and excludes model latency from local timings.
- Safe numeric results and verification logs are preserved under ignored `output/backend-performance-2026-10-06/`. Full debug bundles remain local and are not committed. Neither screenshot content nor raw account/session cookies enter the report or generic performance sink.

The first baseline test invocation accidentally matched an ignored baseline checkout in addition to current tests. Its aggregate 530-pass count is excluded. Authoritative subsequent commands use explicit `./tests` paths.

## Retained follow-ups

The adapter now commits an ancestry proof at the final canonical tool round. This bounded, memory-only proof survives per-request adapter factories and binds the canonical message prefix, current system policy and final assistant answer. Resume accepts only the exact terminal answer immediately after that committed prefix, followed by a new suffix. Newly inserted user/tool evidence cannot be skipped even when a later assistant answer matches. Restart, eviction, changed prefix, changed policy, unknown ancestry or expiry requires fresh canonical context.

Physical reuse separately checks the chat URL, document lifetime, navigation generation, terminal/composer state, transcript hash, monotonic transcript mutation revision and authenticated session-cookie fingerprint. A manual turn that appears and then disappears through virtualization still changes the mutation revision. Cookies are hashed in the launcher and never logged. Model/effort selection and connector binding remain revalidated by the browser worker before every Send. An invalid proof retires the idle tab; active recovery retains its existing phase and ownership fences. Concurrent lease/close/helper replacement cannot publish stale retention after asynchronous proof capture.

Luna now uses the healthy thread/model/effort/profile/compaction-epoch key across ordinary native turns. Durable checkpoints remain fresh-surface fallbacks. Only a verified retained suffix bypasses full history transport; uncertain state fails closed.

Two Sol CLI follow-up pairs completed with the same physical tab. In the final pair, the launcher recorded one creation followed by one `browser.tab_reused`. These are individual observations, not statistical or causal end-to-end speedup claims.

| Final pair, same native chat | Initial turn A | Healthy follow-up B |
|---|---:|---:|
| New automatic surfaces | 1 | 0 |
| Temporary-chat navigation checkpoints | 1 | 0 |
| Composer draft characters at attachment completion | 38,321 | 11,789 |
| Acquisition → Send accepted, diagnostic checkpoints | 37.940 s | 32.908 s |
| Acquisition → response visible | 38.328 s | 33.345 s |
| Browser-owner start → end | 52.792 s | 50.222 s |

Draft character counts are physical composer counts, including the compiled wrapper; they are not UTF-8 byte counts or canonical usage tokens. The exact context bytes resent and time to first reasoning were not separately captured. A stale connector pill on B triggered safe reselection on the same owned page. The earlier pair measured 37.064 s / 33.500 s browser-owner durations with the same reuse evidence.

The original shell-marker smoke completed at baseline, with one 276 ms native command. The identical final command completed in 242 ms and produced the verified marker, but overlapped source-live reloads and is excluded from timing comparisons. No claim about overall shell-task acceleration follows from those command durations. Browser Use smoke and the post-firewall native retry stopped on required-model capacity errors. Successful real retention evidence preceded those failures; all failed scenarios were cleaned up.

## Compaction input and canonical handoff

`startRuntime` calls the existing `EnhancedRecoveryCheckpointStore.prepareCompactionInput(canonicalParsed)` for compaction requests. Both fresh structured fallback and ordinary no-tools compaction consume its prepared full/delta input. Ownership, native identity, and final `canonicalizeCompactionHandoff` continue to use the original canonical parsed request. The retained route already canonicalizes its result. Fresh fallback explicitly canonicalizes against original input.

Normal recovery keeps the existing canonical archive transport rule. Compaction excludes that override so a proved delta actually reaches the model. Ordinary no-tools compaction buffers raw model text, first verifies its Markdown equality against the completed browser answer, and only then appends canonical evidence. Canonicalizing earlier was reproduced as an equality failure and repaired.

The current v2 store validates parsed and raw tool-result prefixes, thread/model/family/effort/epoch, complete tool-result boundaries, ledger integrity, durable entry integrity and expiry. Legacy, corrupt, changed or ambiguous state returns original full input. Historical tool images refuse textual delta replacement. Instruction-bearing user/developer/agent messages remain protected.

The current deterministic ledger binds parsed calls/results and raw transport identities/hashes, pending/result/error states, explicitly evidenced command execution state, small exact arguments and opaque literals. Explicit returned line ranges require matching returned line counts and `truncated:false`; neither requested ranges nor a successful shell exit proves a complete file read. It is capacity bounded and supplements the semantic narrative with an evidence appendix. A model-authored replacement appendix is rejected.

| Synthetic target | Full tokens / bytes | Prepared delta tokens / bytes | Local proof p50 / p95 |
|---|---:|---:|---:|
| 200K | 199,971 / 1,277,595 | 20,680 / 129,872 | 3.428 / 5.365 ms |
| 500K | 499,677 / 3,193,019 | 50,717 / 321,424 | 7.807 / 9.398 ms |
| 900K | 899,278 / 5,746,875 | 90,743 / 576,784 | 14.480 / 16.114 ms |

Each synthetic history has a completed 90% prefix and 10% new evidence. Seven warmed proof samples are measured; p95 is the slowest sample. These figures measure serialized input, exact token estimation and local proof work. They do not measure source-settle time, ChatGPT compaction generation, handoff submission or total compaction latency. The 1,952-byte handoff preserved both canonical calls, paths and opaque probes in these fixtures. No approximately 1M-token real-model compaction timing was established.

Functional adapter tests prove the reduced input reaches both runtime paths despite an archive-scale original history, while the final handoff retains original call/path/sentinel evidence and the exact newest requirement. Separate tests preserve `src/probe.ts` lines 11–13, `EXACT_SENTINEL_8A`, `0f8c2aa37b`, pending requirement `PROBE_PENDING_A7`, and newest requirement `LATEST_REQUIREMENT_B9`; they reject corrupt range/summary data and each identity/raw-prefix mismatch.

The user owns additional checkpoint proof/provenance changes. `prepareRecoveryInput` is not yet present, so cumulative passive checkpoint input has not been integrated or claimed complete. The user's unconnected `compaction-provenance.ts` work is preserved for that integration. The current ledger does not claim to reconstruct every file fact, file revision, successful edit/validation or full GUI state from a hash. Detailed provenance and authoritative cumulative semantics remain pending. Existing source settlement, one-shot handoff, work-tool blocking, bounded deadlines and physical-owner retirement were preserved; grace constants were not shortened without evidence.

## Computer Use

Finite generated `node_repl` programs retain official `@oai/sky` safety checks. Observation IDs, state/action revisions, target identity and a tool/environment generation bind a bounded accessibility cache. Each requested observation still captures fresh native structured state without a screenshot. Only exact equality plus the caller's acknowledged prior observation ID permits a compact reply; an unknown ID receives full fresh evidence. Equality covers the whole returned structured state and canonical content as well as its hash. Pixels are explicitly outside the equality claim.

Actions, errors, changed target/focus/text, unavailable evidence and generation changes invalidate comparisons. Native actions dispatch once. The only added sequence is exact-window activation followed by fresh structured observation; it does not chain typing, confirmation, saving or destructive operations. The cache is bounded to 16 entries, 1 MiB total and 256 KiB per entry, and reset with native session/environment changes. A delayed import or old operation cannot overwrite or delete a newer generation; concurrent initialization within one generation shares one import.

| Synthetic fresh observation workload | Before bytes/reply | After bytes/reply | Before p50 / p95 | After p50 / p95 |
|---|---:|---:|---:|---:|
| Unchanged 128-byte document | 279 | 362 | 0.001652 / 0.002760 ms | 0.007835 / 0.015833 ms |
| Unchanged 64 KiB document | 65,687 | 362 | 0.044326 / 0.059425 ms | 0.086425 / 0.114556 ms |
| 64 KiB, external edit every ten observations | 65,687 | 6,932 mean | 0.039036 / 0.055796 ms | 0.085372 / 0.131990 ms |

Thirty samples × 200 cycles per scenario, after 200 warmup cycles. Both versions performed 6,000 fresh captures, zero screenshots/actions/retries, one lifetime import and one lifetime window lookup per scenario. Current compact replies occurred 6,000 / 6,000 / 5,400 times respectively. This reduces large unchanged output by 99.45%, but **increases local CPU cost**, and small observations become larger. It is a payload optimization; native capture, IPC, safety classification, model decision, tool-result → next-action latency and end-to-end GUI time are excluded. No GUI speedup is established.

The first real native attempt loaded `@oai/sky` but failed app discovery with native pipe unavailable, OS error 2. No Notepad action or marker verification occurred. After the user allowed two Bun processes through Windows Firewall, a retry reached the required Sol model but ended on capacity errors before native app discovery. That retry cannot establish whether the pipe blocker was resolved. No safety bypass was attempted.

## Policy, browser mode and telemetry

| Sol High native policy measurement | Baseline | Current |
|---|---:|---:|
| Advertised MCP tools | 15 | 12 |
| Serialized tool-schema tokens | 4,023 | 3,508 |
| Compiled transport tokens | 2,030 | 2,016 |
| MCP instruction tokens | 1,570 | 1,493 |

Three deprecated Windows CU stub names are filtered only from new `tools/list` responses. Cached clients can still call their registered compatibility handlers and receive the existing precise error. Equivalent completion/instruction-priority rules remain after duplicate sentences are removed. The observation schema grew to support proof-bound repeats and the finite sequence; the overall schema still shrank. History/checkpoint/latest-turn counts are workload dependent; synthetic compaction counts are above, and native usage totals are not presented as physical retransmission sizes.

Automatic turn views disable spellcheck while preserving sandboxing, account verification, streaming, connectors and active background execution. Existing idle throttling remains. No semantic network resource blocking, broad Chromium switches, reduced reasoning effort, lower archive threshold or warm pool was introduced without measured evidence.

Actual new phase emitters cover retained acquisition/verification, suffix compilation, delta preparation, fresh navigation, model verification, connector/attachment preparation, network rebind, native structured observation and actions. Connector verification includes the attachment stage rather than an isolated connector-only duration. Acquisition failures also close their timing record. The expanded allowlist reserves further compaction/GUI/rebind stages; allowlist membership alone does not mean a phase was emitted or measured. The sink accepts finite numeric counts/timings and booleans only, rejects getters/proxy failures and secrets, hashes trace identity, remains opt-in and stops at 8 MiB. Existing broker decision telemetry remains a result-to-next-tool proxy, not direct model-only timing.

## Recovery and review

Existing phase-aware recovery was retained after functional/contract inspection. Before accepted submission, bounded preparation/rebind can rebuild. After semantic acceptance, observation recovers against the owned surface and never blindly resends. Delivered tools retain their journal identity and detached result; polling replaces redispatch. Existing network Retry ownership/progress fences remain.

Regression coverage includes:

- Pre-submit attachment failure and bounded rebind; Send-stage rejection and ambiguous/accepted submission evidence; accepted stalled DOM followed by MCP delivery with no resend.
- Missing/remounted assistant identity and rejection of extra foreign user turns; frontend red delivery errors and one-time ownership-gated Retry rules.
- Delivered invocation transport timeout, result completion while detached and draining completed detached results before subsequent dispatch/compaction.
- Helper replacement only after prior process exit; live-helper exclusivity and heartbeat ownership.
- Compaction source stalls/interruption, reconnect without a second handoff message, one-shot capability identity, cancellation and fresh-fallback physical settlement.
- Retained transcript/session/navigation/manual-turn invalidation, connector refresh, effort mismatch before Send, canonical answer/policy mismatch, closed-tab/new-helper completion races.
- CU manual text/focus changes, state-changing actions, failures, native session generations, delayed initialization, stale identities and malformed observation evidence.

These cases establish zero duplicate submission/dispatch or lost completed result in their tested scenarios; they are not a claim that all possible real transport faults were injected. Some older checks inspect source contracts and are distinguished from live browser fault injection. Review checked bounded cache storage, leases, asynchronous ownership, canonical boundaries, exact evidence and observer detachment. The new race and early-canonicalization failures were reproduced and fixed with focused tests.

## Verification and CI

Final pinned root suite: **1,063 pass, 22 skip, 2 fail**, 1,087 tests in 84 files, 7,585 assertions, 150.41 s. Both failures are the file-symlink privilege failures described below. Final launcher suite: **442 pass, 4 skip, 1 fail**, 447 tests, 9.169 s; its only failure has the same symlink privilege cause. Typechecks pass. The complete `verify` command remains blocked at audit before it reaches these independently executed checks.

- Root and launcher typechecks pass with pinned Bun 1.4.0.
- Focused CU suites: 36 pass, 0 fail; physical retention/launcher suites: 124 pass, 0 fail; compaction input integration: 2 pass, 0 fail; checkpoint proof: 3 pass, 0 fail; cross-factory Sol retained/fresh and Luna retained follow-ups: 3 pass, 0 fail.
- Launcher UI build, runtime bundle, third-party notice generation and relocatable runtime smoke pass. The release smoke prints `RELOCATABLE_RUNTIME_SMOKE_OK`.
- Root audit passes after `proxy-addr` 2.0.7 → 2.0.8. Launcher lockfile also updates `source-map-js` to 1.2.2 and `http-cache-semantics` to 4.3.0.
- `bun run verify` still fails at launcher audit: `sprintf-js@1.1.3`, [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), reached through Electron and electron-builder's global-agent/roarr chain. Audit reports no published fixing version. No new ignore or security-gate bypass was added.
- Local Windows cannot create the file symlinks required by two root route-compensation tests and one launcher runtime-compensation test (`EPERM`). These failures are reported, not silently skipped.
- Baseline [CI run 37416180416](https://github.com/buonchoi96/codex-chatgpt-web/actions/runs/37416180416) already failed on `proxy-addr@2.0.7` across all three verification platforms; actionlint passed. The final push/run is inspected separately and does not inherit a passing status from that baseline.

Every real scenario invokes cancel-all in both lanes, closes test browser tabs, and verifies settlement. The existing source runtime and tunnel are reused. Final cleanup and readiness are recorded with the final CI result. Unrelated `SKILLS.md` and native-operation-safety plan work remain outside the task commits; user-owned unfinished provenance work is also preserved.
