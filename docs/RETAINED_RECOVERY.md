# Persistent conversation proof and same-tab recovery

The adapter reuses a retained conversation only when canonical native-thread
ancestry, completed assistant outcome, model/effort/mode/connector identity and
the launcher's independently verified physical conversation agree. It sends the
incremental user content and required native capability context. Unverifiable
continuity uses the existing complete canonical context/ZIP transport.

The version-1 proof ledger lives in the configured runtime directory, uses atomic
durable updates, expires after 30 minutes, and caps at 512 records/512 KiB. It
contains identities and hashes, not transcript, credentials or capability tokens.
Malformed, changed, expired, missing and oversized proofs produce typed reuse
misses. Reopening a tab alone does not prove its history. Identical DOM remounts
can preserve semantic proof; intervening foreign turns invalidate it.

Recovery verifies the currently owned response, conversation URL, document,
assistant/user identity and composer. The existing watchdog combines browser
progress with broker claims, receipts, native processes, subagents and approval
state. Silence alone cannot stop a task. Unknown background activity, pending
approval and explicit refusals prevent automatic recovery.

When safe, recovery fences new native dispatch before Stop, checks that Stop took
effect and the composer is ready, then sends an incremental continuation in that
conversation. Dispatch resumes only after verified submission. Both helper and
daemon must acknowledge the exact recovery phase; an older parent fails closed
before Stop. A partial stopped answer is never a successful canonical final.
Ambiguous Stop/Send acknowledgement and terminal refusal states are not retried.
There are at most two browser recovery attempts, plus a durable eight-attempt
native-turn budget across helper replacements.

Mutating native operations get durable hash-only ownership/outcome receipts before
dispatch and after completion. During recovery, accepted in-memory results are
returned without repeating the operation. Prior daemon ownership, incomplete or
corrupt receipts, exhausted budgets and ambiguous outcomes require reconciliation.
The ledger is bounded at 1,024 entries/512 KiB and never reconstructs private tool
results from hashes. A stale exclusive lock is not broken automatically.

Browser-only routes do not acquire tool authority. Safety refusals, permission
boundaries, authentication and rate limits retain their existing behavior.
The current bun run dev:live workflow remains Desktop-only; older architecture
text describing a parallel DEV CLI lane is not a current source contract.
