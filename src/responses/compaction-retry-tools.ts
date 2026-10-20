/**
 * Preserve native tool declarations supplied in the SAME incoming Responses request
 * during a browser prompt-too-long compaction retry. No cross-turn cache, tool
 * synthesis, or capability borrowing is allowed.
 *
 * Codex responses_lite uses both:
 *   - input additional_tools for directly advertised tool declarations
 *   - historical tool_search_output for deferred tools discovered by native Codex
 *
 * The parser already treats both as the active request's tool inventory. The
 * compaction output summarizes task history and excludes both forms. Preserve
 * their original *wire items* verbatim, rather than guessing schemas from tool
 * names or authorizing tools based on an LLM-generated summary.
 */
type WireItem = Record<string, unknown>;

function record(value: unknown): value is WireItem {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAdditionalTools(value: unknown): value is WireItem & { type: "additional_tools"; tools: unknown[] } {
  return record(value) && value.type === "additional_tools" && Array.isArray(value.tools);
}

function isToolSearchOutput(value: unknown): value is WireItem & { type: "tool_search_output"; tools: unknown[] } {
  return record(value) && value.type === "tool_search_output" && Array.isArray(value.tools);
}

function toolSearchCallId(value: WireItem): string | undefined {
  const id = value.call_id ?? value.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function restoreSameRequestAdditionalTools(
  originalInput: unknown,
  compactedOutput: readonly unknown[],
): {
  input: unknown[];
  restoredItems: number;
  restoredSpecs: number;
  restoredSearchOutputs: number;
  restoredSearchSpecs: number;
} {
  // A browser-generated compact summary is data, never a source of new tool
  // capabilities or historical tool-search receipts.
  if (compactedOutput.some(value => record(value) &&
    (value.type === "additional_tools" || value.type === "tool_search_output"
      || value.type === "tool_search_call"))) {
    throw new Error("Compaction output cannot advertise native tools or tool-search receipts");
  }
  const original = Array.isArray(originalInput) ? originalInput : [];
  const nativeSideband = original.filter(isAdditionalTools);
  const discoveryResults = original.filter(isToolSearchOutput);
  const searchCallIds = new Set(discoveryResults
    .map(toolSearchCallId)
    .filter((id): id is string => id !== undefined));
  // Only the original, already-executed tool_search_call paired with a returned
  // tool_search_output is included. Never issue or recreate a search call.
  const searches = original.filter(item => record(item) &&
    item.type === "tool_search_call"
    && searchCallIds.has(toolSearchCallId(item) ?? ""));
  const preserved = original.filter(item => nativeSideband.includes(item)
    || discoveryResults.includes(item) || searches.includes(item));
  return {
    input: [...structuredClone(preserved), ...compactedOutput],
    restoredItems: nativeSideband.length,
    restoredSpecs: nativeSideband.reduce((sum, item) => sum + item.tools.length, 0),
    restoredSearchOutputs: discoveryResults.length,
    restoredSearchSpecs: discoveryResults.reduce((sum, item) => sum + item.tools.length, 0),
  };
}
