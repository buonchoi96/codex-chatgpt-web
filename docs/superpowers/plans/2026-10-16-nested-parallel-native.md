# Nested native parallel execution

Approved scope comes from GOAL bounded2–8 native commands and PLAN parallel execution. Current direct-native mapping is implemented; nested exec gateway currently rejects every parallel batch because its command schema is unverified.

Main owns this slice. Discover only exact exec_command/shell_command registry descriptors through one locally generated, nonce-bound native exec inventory. Interpret only a constrained native TypeScript declaration grammar; require a single preferred interface, supported command/options types and no unfulfilled required arguments. Unrecognized, missing or ambiguous declarations fail before command dispatch. Never infer shell timeout semantics from yield time.

Validate the whole batch before dispatch. Each independent read uses its own generated native gateway invocation and rechecks the exact descriptor text before invoking the selected tool. Preserve native sandbox/approval, stable-owner capacity8, session and uncertain-dispatch accounting, metadata/media and no retries. No production config or launcher changes.

Verification: RED tests for schema discovery/mapping and nested parallel path, malformed/ambiguous/missing schema and schema rotation, then focused regression/typecheck. A separate actual-native fixture must establish real child-process overlap; broker fixture concurrency alone is not native execution acceptance. Initial scope excludes shell writes, opaque or interactive commands, approval-requiring requests and unrelated agent lifecycle repair.

Implementation checkpoint, 2026-10-16: metadata-only discovery, constrained declaration parsing, whole-batch argument validation and per-invocation descriptor guards are implemented. The final parser also rejects a second unsupported complex declaration instead of accepting an apparently unique flat declaration. The five-file regression passed114 tests/438 assertions, current typecheck passed, and Sartre independently reviewed the relevant source and retested37 focused cases/260 assertions. See `../day10-nested-parallel-receipt.json` for current source hashes and exact logs.

The isolated actual-native fixture dispatched two distinct `exec_command` calls, but both CreateProcess requests were rejected by native policy. No successful native process-overlap result is claimed. Case8 was not attempted; neither rejected hash command was retried through another tool, quoting style or sandbox. The raw policy receipt and pending review are retained in `../day10-native-parallel-policy-receipt.json` and `../day10-safety-blockers.json`.
