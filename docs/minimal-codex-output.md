# Minimal visible Codex output (custom fork)

This fork intentionally limits **bridge-originated** Codex progress text:

- Show concise public reasoning summaries already visible in the ChatGPT Web response.
- Show the browser-verified final answer/completion result.
- Do not forward generic browser commentary such as "Preparing visual testing" or
  "Finalized the benchmark" as additional Codex output text.
- Do not inject a separate "Computer Use: <title>" commentary line before each
  `computer_use_swift` invocation.
- When Codex explicitly requests `hideThinkingSummary`, do not expose a
  reasoning summary through the bridge.
- Keep actual tool-call events, arguments, results, safety approvals, cancellation,
  and completion receipts fully functional.

## What this does **not** hide

Codex itself owns the UI for its native tool-call cards and safety/approval
prompts. This bridge cannot guarantee those built-in UI elements are hidden
without client support. The custom policy only removes **extra bridge-originated
progress text**, and never changes tool execution or bypasses authorization.

The bridge does not provide access to private chain-of-thought. Only public
reasoning summaries returned through supported channels are displayed.

## Regression

`bun test tests/visible-output-policy.test.ts` checks suppression of
generic commentary while permitting public reasoning and respecting
`hideThinkingSummary`.

`bun run verify` runs the repository's full validation before installer packaging.

The Windows installer is built from the exact commit under the
`Build v5.0.8 Fresh E Drive Windows` workflow; an installer built from an
older commit will not contain this change.
