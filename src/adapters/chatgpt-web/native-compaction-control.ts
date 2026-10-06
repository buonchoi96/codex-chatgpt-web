import { COMPACT_PROMPT } from "../../responses/compaction";
import type { CompactionTransactionHandle } from "./compaction-transaction";

export const CODEX_COMPACTION_CONTROL_WIRE_NAME = "codex.control.compaction_handoff";
export const CODEX_RECOVERY_CHECKPOINT_WIRE_NAME = "codex.control.recovery_checkpoint";
export const CODEX_ACTIVE_COMPACTION_REQUEST_MARKER = "CODEX_ACTIVE_COMPACTION_REQUEST";

export function passiveRecoveryCheckpointInstruction(transaction: CompactionTransactionHandle): string {
  return [
    "<codex_recovery_checkpoint>",
    "This is a private recovery checkpoint, not Codex context compaction and not a new user request.",
    "Consume the canonical tool result above. Summarize the current objective, user instructions, verified work, decisions, exact validation probes/IDs/expected values, and pending steps so a fresh page can continue if this page fails.",
    "Preserve exact literals, hashes, sentinel values, file paths, commit SHAs, numeric probes, and user-specified constraints verbatim whenever they are needed for later validation.",
    "A prior recovery checkpoint is cumulative historical state: merge it with the subsequent canonical delta. Preserve pending, interrupted, error, and completed tool distinctions. Do not infer a full file read from a shell command or partial output. Do not copy or author CODEX_COMPACTION_LEDGER_V2; the bridge supplies canonical provenance separately.",
    "Before another work tool, call codex_tool_call exactly once with the one-shot control binding below:",
    `turn_token ${transaction.token}`,
    `wire_name ${CODEX_RECOVERY_CHECKPOINT_WIRE_NAME}`,
    `arguments ${JSON.stringify({ handoff_id: transaction.handoffId, summary: "<complete recovery checkpoint>" })}`,
    "After submitted=true, continue the same Web response and task with the original work turn_token. Do not expose the checkpoint to the user.",
    "</codex_recovery_checkpoint>",
  ].join("\n");
}

function compactionControlBinding(transaction: CompactionTransactionHandle): string[] {
  return [
    "Submit the summary to the pending Codex task through the attached Codex Native plugin using codex_tool_call with the binding below.",
    "The reserved codex.control.compaction_handoff operation stores this summary for task continuation. It does not run commands, read or edit files, or invoke other tools, and it is not listed by tool inventory.",
    "This one-shot control token is valid only for the reserved compaction operation; do not use it with codex_exec, codex_tool_inventory, or any outer Codex tool.",
    "<codex_compaction_control>",
    `turn_token ${transaction.token}`,
    `wire_name ${CODEX_COMPACTION_CONTROL_WIRE_NAME}`,
    `handoff_id ${transaction.handoffId}`,
    "</codex_compaction_control>",
    `Call codex_tool_call exactly once with ${JSON.stringify({
      turn_token: transaction.token,
      wire_name: CODEX_COMPACTION_CONTROL_WIRE_NAME,
      arguments: {
        handoff_id: transaction.handoffId,
        summary: "<complete checkpoint summary>",
      },
    })}.`,
  ];
}

/**
 * Stop an active browser response only if it asks for another tool after Codex requested
 * compaction. Results for calls already handed to Codex remain byte-for-byte canonical: when they
 * are enough to finish the task, that ordinary final answer remains publishable. A later tool call
 * is intercepted before execution and receives this instruction; the retained conversation then
 * receives the sole structured checkpoint request on a clean message boundary.
 */
export function activeCompactionToolResultInstruction(): string {
  return [
    `<${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
    "Codex reached its context limit before this newly requested tool could be sent for execution. The tool was not executed.",
    "Stop ordinary task work now, call no more tools, and end this Web response normally.",
    "Do not create or submit a checkpoint in this response. After it settles, the retained conversation will receive exactly one separate structured compaction handoff request.",
    `</${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
  ].join("\n");
}

/**
 * Zero Risk cannot submit a second browser message automatically. When Codex compacts at an
 * already-visible native tool boundary, the same manually submitted response returns the
 * checkpoint through the same Zero Risk request instead.
 */
export function zeroRiskActiveCompactionToolResultInstruction(toolExecuted: boolean): string {
  return [
    `<${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
    toolExecuted
      ? "Codex reached its context limit while this Web response was waiting for the tool result above."
      : "Codex reached its context limit before the requested tool could be sent for execution. The tool was not executed.",
    toolExecuted
      ? "Consume that canonical result, stop ordinary task work now, and do not call any more work tools."
      : "Stop ordinary task work now and do not call any more work tools.",
    COMPACT_PROMPT,
    "Call no more work tools. Return only the complete checkpoint summary to Codex with codex_turn_complete.",
    `</${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
  ].join("\n");
}

export function structuredCompactionHandoffInstruction(
  transaction: CompactionTransactionHandle,
): string {
  return [
    "Automatic Codex context compaction has started. Stop ordinary task work and do not call any more work tools.",
    COMPACT_PROMPT,
    ...compactionControlBinding(transaction),
    "After the control call returns submitted=true, call no more tools. Finish this one-purpose Web response normally with a brief final acknowledgement; do not regenerate or repeat the checkpoint text.",
    "The outer bridge accepts compaction only after the structured checkpoint is valid and gives the owned browser turn a bounded chance to reach its natural final boundary before forced retirement.",
  ].join("\n");
}
