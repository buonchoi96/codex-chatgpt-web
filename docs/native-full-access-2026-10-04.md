# Native Full Access retest — 2026-10-04

The launcher live configuration and persisted launcher state now both have `nativeFullAccess=true`. A fresh ordinary `codex` selected GPT-5.6 Sol Web High. Its recorded environment confirms `approval_policy=never`, `permission_profile.type=disabled`, and `sandbox_policy.type=danger-full-access`.

Before enabling the launcher flag, the real Codex configuration already contained the managed `never`/`danger-full-access` assignments. The preceding post-unlock CLI also recorded that same effective policy. Consequently this retest changes the launcher's managed preference; it does not establish a newly unrestricted native execution environment relative to the earlier workload.

## Enabling and verification

The documented setup preflight passed. Direct CLI setup persisted the flag and native policy, then returned `EADDRINUSE` while trying to restart the daemon already owned by the launcher. That command is recorded as failed, not as a successful complete launcher transaction. The existing `dev:live` reload mechanism subsequently reloaded the owner safely while idle: owner 15768→1348, daemon 34960→116228, ready in **5.166 s**. Tunnel identity/hash and fingerprint `61d52dbe1923e88c8b21607f6e25fbd150a3f2314a7699279b2f2e5671292675` were identical across this controlled reload. Launcher state was reread and confirmed enabled; the existing Codex session was closed and a fresh normal CLI opened.

Focused existing regressions passed with zero failures: pinned Bun 1.4.0, Native Full Access installs `never` plus `danger-full-access` and restores the exact prior policy; Node launcher test, the production setting uses the setup transaction and remains unavailable in the isolated DEV profile. These are two focused tests, not a full-suite pass. Launcher typecheck and production build passed after the description change. The latest local full verify remains 965 pass / 22 skip / 2 symlink-fixture EPERM failures, as detailed in the performance report.

## Actual retest results

Computer Use through configured `node_repl`/`@oai/sky`: import 442.7 ms, discovery 37.3 ms, fresh Notepad launch 805.5 ms, post-launch inventory 27.4 ms, bind/activate 140.8 ms, initial structured state 429.1 ms. The returned unique Untitled window was unmodified, zero characters, with text editor focus verified in its accessibility tree. The next click was rejected before native execution with `This tool call was blocked by OpenAI because we couldn't determine the safety status of the request.` The model stopped the dependent Computer workload: **0/5 typed lines**, 0 screenshots, minimize/restore not reached. No user document/save/close/discard or native input retry followed. This is a platform safety-review outcome despite the verified full-access native policy.

The independent Browser fixture loaded through configured Playwright MCP. Initial failures were tool argument validation (`target` missing), then `ReferenceError: performance is not defined` in the Playwright code sandbox; these are workload/API errors, not safety rejections. The web model then returned `Selected model is at capacity` after 265.285 s. On continuation the prior fixture tab was no longer available; the workload inspected current tabs/state and navigated the fresh test context to the same local fixture. No auxiliary runtime was manually launched.

After using semantic role locators and supported `Date.now()` timing, Browser **5/5** marker rounds and dialog open/close passed, 0 screenshots. Every marker separately verified input value plus `Applied: PERF-ACCESS-N`. The five rounds were batched inside one Playwright invocation, so they do **not** include five model-decision intervals or per-round broker latency.

| Marker | Fill ms | Apply ms | Verify ms | Local total ms |
|---|---:|---:|---:|---:|
| PERF-ACCESS-1 |16|37|6|59|
| PERF-ACCESS-2 |23|22|6|51|
| PERF-ACCESS-3 |10|26|6|42|
| PERF-ACCESS-4 |7|28|6|41|
| PERF-ACCESS-5 |8|20|4|32|

Dialog local timing: open 29 ms, close 35 ms; visible/hidden states verified. Final DOM field/status showed PERF-ACCESS-5 and the dialog was hidden. The Browser continuation took 269.720 s including model, transport, context recovery and reporting; the local 45 ms average is not full-task throughput. Different APIs/batching, failed calls and a capacity interruption prevent attributing these numbers to Native Full Access or claiming causal performance gains.

## Patch scope and remaining boundary

The setting's description is corrected in all five existing locale copies to distinguish native Codex sandbox/approval policy from ChatGPT tool safety review and Windows desktop/UAC checks. Native Full Access is enabled and its policy is verified; there is no demonstrated missing native-policy propagation to patch. A launcher preference cannot change the observed external safety classification. The patch therefore improves the setting's explanation; it does not claim to make rejected Computer actions executable. No desktop guard, recovery deadline, platform-review check or Windows security setting was weakened.

Ignored local evidence under `output/backend-performance/`: `native-full-access-preflight.log`, `native-full-access-apply.log`, `native-full-access-reload.json`, and `native-full-access-results.json`; private raw CLI history is retained locally. Preparation gains and remaining overall acceptance criteria remain in [the backend report](backend-performance-2026-10-04.md). CI, Windows build/smoke and installer publish all passed for the previous report commit `eb797cd`; final copy/report revision Actions are checked after push.
