/**
 * Preserve only native tool declarations explicitly supplied by the SAME
 * Responses request during a browser prompt-too-long compaction retry.
 *
 * Codex responses_lite carries tool definitions as input additional_tools
 * items, not necessarily as top-level body.tools. Compaction summarizes task
 * history and discards these sideband items; it does not revoke their authority
 * for the already active outer Codex turn. Never load tools from another turn,
 * a checkpoint, or untrusted compaction output.
 */
function isAdditionalTools(value: unknown): value is { type: "additional_tools"; tools: unknown[] } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as { type?: unknown }).type === "additional_tools"
    && Array.isArray((value as { tools?: unknown }).tools);
}

export function restoreSameRequestAdditionalTools(
  originalInput: unknown,
  compactedOutput: readonly unknown[],
): { input: unknown[]; restoredItems: number; restoredSpecs: number } {
  if (compactedOutput.some(value => value && typeof value === "object" && !Array.isArray(value)
    && (value as { type?: unknown }).type === "additional_tools")) {
    throw new Error("Compaction output cannot advertise new native tools");
  }
  const sideband = Array.isArray(originalInput)
    ? originalInput.filter(isAdditionalTools) : [];
  return {
    input: [...structuredClone(sideband), ...compactedOutput],
    restoredItems: sideband.length,
    restoredSpecs: sideband.reduce((sum, item) => sum + item.tools.length, 0),
  };
}
