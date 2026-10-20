# /goal PURSUING: transport overflow -> native /compact safety gate

Date: 2026-10-20. Status: **BLOCKED ON NATIVE GOAL-LIFECYCLE SUPPORT**.
This is an implementation specification, not proof of automatic recovery.

## Reproduction

Two production Web turns failed pre-Send after immutable canonical context outgrew
the observed Plus Web budget:

- 78,468 canonical tokens > 71,808 account budget.
- 117,926 canonical tokens > 71,808 account budget (also above the 81,807 text-message budget).

Neither ZIP nor verified multipart increases the measured account's canonical
recall. Do not increase the declared Web account budget or erase canonical history
to force a Send. Native Codex's 272K/258K settings remain unchanged.

## Why the previous PR #44 is insufficient

PR #44 mapped a proven canonical Web overflow to a streamed Responses
`context_length_exceeded` error, without changing the native binary. Tests
asserted the event format and unchanged input, but did **not** execute a native
auto compact or inspect persisted thread-goal status.

In the current openai/codex core source, normal
`CodexErrorDetails::ContextWindowExceeded` is returned from
`try_run_sampling_request`; only a guarded review-budget path performs
`run_auto_compact` on this error. Normal step errors go through
`emit_turn_error_lifecycle`.

In the current openai/codex goal runtime,
`stop_active_goal_for_turn(TurnError)` transitions an Active goal to
**Blocked**. Merely leaving `<goal_context>` text untouched does not preserve
the native goal's persisted status. Thus a proxy-only failure reclassification
cannot assert the user's essential `PURSUING` invariant.

## Required native implementation (upstream/installed Codex owner)

1. Introduce a **structured and authenticated** canonical-Web-budget overflow
   error (with exact measured numbers and original native execution revision).
   This is distinct from account quota, tool-safety denial, image/attachment
   failure, browser composer failure or a generic retryable network error.
2. Inside the same native turn, **before** recording the failure/turn-error goal
   lifecycle, require exact original thread, goal ID, goal status Active,
   current turn revision, native instruction ownership, and no changed goal
   mutation. Other goal states must remain untouched.
3. Quiesce current browser owner and external broker calls. Verify tool result
   settlement, no unacknowledged side effects, and preserve PENDING_SAFETY_REVIEW
   and BLOCKED_BY_SAFETY evidence. Never replay the same action or resend an
   already-accepted browser prompt.
4. Trigger exactly one native `run_auto_compact` / `thread/compact/start`
   through the installed native session owner, using native canonical context
   with immutable tool/user/system/goal metadata. Do NOT synthesize a new user
   message, invoke a shell `codex compact`, or send `/compact` as model text.
5. Only after native confirms **durably installed** compaction in the same
   thread, verify the unchanged goal ID and Active status and resume exactly
   one automatic goal turn through the native goal continuation dispatcher.
   Report PURSUING only from that authoritative goal-state readback.
6. If a compact cannot fit the Web budget even after authorized history
   reduction, if a native operation is still live, if provenance changes, or
   if the compact fails, **fail closed**. Do not mutate the goal to Complete,
   create a replacement goal, or loop retries. Surface the explicit blocker;
   keep any deferred goal continuation inert pending an eligible native review.
7. Persist an at-most-once recovery key (thread, source revision, goal ID,
   compaction epoch). A second overflow with the same key must not recursively
   compact. Treat shutdown/restart as a recovery case requiring native durable
   receipts, not a new implicit authority.

## Required validation before calling this feature fixed

- Native installed-process E2E, not only transport mocks, at both overflow
  sizes (78,468 and 117,926 vs 71,808).
- After the overflow: exactly one native compact is requested, one durable
  compaction installation is witnessed; native goal readback shows **Active**
  (display `/goal: PURSUING`) with the **same** goal ID and objective.
- Exactly one automatic next goal turn and no duplicate tool or browser Send.
- Negative cases: missing native thread/goal proof, orphaned broker tool,
  in-flight approvals, unsafe action, stale revision, changed goal status,
  already-compacting, noncompactable single-message overflow, recursion, and
  process restart. Any failure must not claim a successful compact.
- Compare trace IDs and native compaction/goal receipts. `response.failed`
  with `context_length_exceeded` is **not** an acceptance receipt.

## Current implementation scope

The Web bridge does not own the native Codex thread-goal state machine or
`thread/compact/start` RPC. No proxy-only implementation can enforce this
native lifecycle invariant. Revert the unverified PR #44 signalling behavior
until the native owner implements the recovery path above; preserve the
previous independent browser watchdog and verified recovery checkpoint work.
