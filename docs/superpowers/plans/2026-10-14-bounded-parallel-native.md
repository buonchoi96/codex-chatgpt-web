# Bounded parallel native commands

Authority: user root `PLAN.md` section 3D. Main implements this slice; existing Luna children retain their assigned probe/observer files. No production installation, connector restart, commit or push.

Historical reference inspected by immutable commit `9cbe7aec2ee9121c1b6f5316fa7103c5a2849367`; fetched objects without changing a branch or FETCH_HEAD. Port the shared 2–8 contract, not the archival file or old safety/retry behavior.

1. Add real SDK/broker regressions for direct and reserved ABI, an eight-request barrier, ordered mixed results, invalid sizing/escalation/compound commands, per-owner capacity, retirement and cancellation. Observe RED before source changes.
2. Add strict command/batch schemas and a bounded per-binding executor in `parallel-native-commands.ts`. Admit a conservative set of literal single-purpose reads; unsupported or mutable commands use the ordinary serial interface. Preserve native approvals. Retain original MCP results per child and image blocks in the aggregate; never retry uncertain children.
3. Integrate `codex_parallel_exec` and reserved `codex.control.parallel_exec` through one executor in `mcp-server.ts`. Keep existing public tool descriptions unchanged for cache compatibility; add turn-local guidance only. Use existing command dispatch and current gateway metadata framing.
4. Independently run focused tests and types; ask the existing readonly Luna supervisor to review. Source tests prove request overlap, not actual harness execution concurrency. Actual isolated model/native read-only smoke and all PAR-P0 gates remain open until measured.

Review focus: a safety failure cannot clear original errors or trigger another route; capacity belongs to the bound owner rather than one MCP request; all child results must settle before lease release; no new task during compaction; no image base64 in aggregate text.

Ruling: restrict initial parallel admission to recognized literal reads instead of trusting model-declared independence. This may reject legitimate analyses, which remain available through serial `codex_exec`; it prevents introducing parallel mutable/shared-session operations without an effects contract.

Status: source and SDK/broker request-overlap regressions implemented locally; actual native overlap and full PAR acceptance remain open. Capacity covers native sessions and uncertain receipts within the MCP server process and uses a stable broker command owner across capability rotations. It is not yet an authoritative aggregate across separate MCP server processes.

Turn-local prompt guidance now requires the current connector to advertise the direct tool or confirm reserved support; it keeps UI input, mutation, approvals and dependencies serial, retains every child receipt/session and forbids replay/interface switching after uncertainty or refusal. It is absent from manual and control-only turns. Existing cached public tool definitions remain unchanged except the explicit new parallel extension.

Independent main checks: 182 tests / 704 assertions across viewer, prompt, parallel capacity/executor and selector; later viewer deadline/fragment-leak follow-ups are separate checks. Real eight-native-process barrier, matched timing, late receipt reconciliation after retirement, full effects admission and mixed observer coexistence remain open.
