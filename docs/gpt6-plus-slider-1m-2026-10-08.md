# Experimental GPT-6 Sol Plus: 1.05M catalog with launcher slider — 2026-10-08

## Behavior

For the visible `chatgpt-web/gpt-6-sol` route on **Plus**, Medium and High (also Extra High only when explicitly available) now share the calibrated Codex catalog context used by legacy Web models:

- `context_window` and `max_context_window`: `1_117_022` (calibrated *raw* Codex values).
- `effective_context_window_percent`: `94`, yielding **1,050,000 declared effective tokens**.
- `auto_compact_token_limit`: computed by the *existing persisted launcher setting* `autoCompactPercent` using a 1,048,576-token nominal reference, rounded down to 1K.
- Default `autoCompactPercent`: **26** in `defaultConfig()` and launcher state, yielding **272,000 tokens**. Explicit user selections are preserved and take effect after restarting Codex.

| Slider | Auto-compaction |
| --- | ---: |
| 5% | 52,000 |
| 26% (default) | 272,000 |
| 95% (maximum slider setting) | 996,000 |

The slider's existing **5–95%** safety range is unchanged; it is a percentage of a nominal 1.05M-token window and does not permit compaction at the hard context boundary. Codex also imposes a 90% raw-window clamp; 90% of 1,117,022 exceeds 996K, so even the maximum supported slider setting is not clipped.

This replaces the previous fixed **320K raw / 304K effective / 272K auto-compact** experiment. Other profiles remain unchanged: GPT-6 Instant on Plus, GPT-6 Pro-account and Bigger Context profiles, and the existing GPT-5.6/Luna catalog context. The GPT-6 Plus reasoning browser composer stays at its measured **500,000-character limit**; changing Codex's catalog does not change transport limits.

## Safety and validation

**Only the local Codex bridge catalog is being extended.** OpenAI has not independently verified a 1.05M effective GPT-6 Plus Web backend window. A large Codex context meter, an elevated slider, or a successful multipart upload does not prove that the ChatGPT Web model actually retained the input. If the server rejects or truncates accumulated context, adjust the slider downward and inspect the transport/retention issue; don't claim the account has a larger backend entitlement.

Regression coverage:

```powershell
bun test ./tests/chatgpt-web-models.test.ts ./tests/model-catalog.test.ts
bun run typecheck
```

An end-to-end Plus GPT-6 test should probe retention and compaction around 80K, 272K, and progressively higher values before accepting the full catalog claim. This is not an authorization to bypass product, platform, or safety limits.
